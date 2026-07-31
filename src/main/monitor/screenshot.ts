/**
 * Multi-monitor screenshot collector.
 *
 * Uses Electron's built-in `desktopCapturer.getSources({ types: ['screen'] })`
 * + `screen.getAllDisplays()` to grab a full-resolution PNG of EVERY
 * connected display, writes each one under
 * `~/.taskpilot/captures/<ISO-ts>__display-<index>.png`, and returns one
 * {@link ScreenshotResult} per successfully captured display.
 *
 * No native compile, no third-party binary. Runs from the main process
 * timer and never steals focus. `captureScreenshots()` resolves to an
 * empty result on any failure (lock screen, screen capture denied by
 * policy, no displays, electron unavailable, etc.) — the monitor is never
 * allowed to crash on a missed tick.
 *
 * For a single-display setup, this is equivalent to the old single-PNG
 * behavior: one file, one returned result.
 *
 * Test seam: the loader for the Electron module is overridable via
 * {@link __setElectronLoaderForTests}. In production the loader returns
 * the lazy-required electron module; in tests, the unit-test mocks
 * a synthetic `{ screen, desktopCapturer }` pair.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import { generateOpaqueFilename } from '@/main/security/fs-mask';

const CAPTURES_DIR = path.join(TASKPILOT_HOME, 'captures');

/**
 * Per-thumbnail timeout. `desktopCapturer.getSources` shouldn't take more
 * than a few hundred ms on a healthy system; we cap higher to tolerate a
 * busy main process under load.
 */
const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * Hard cap on the number of displays we'll capture per tick. Guards against
 * pathological setups (KVMs, virtualized GPUs reporting dozens of phantom
 * displays). If the user genuinely has more, we capture the first N by the
 * order `screen.getAllDisplays()` returns and log a warning.
 */
export const MAX_DISPLAYS = 4;

export interface ScreenshotResult {
  path: string;
  size_bytes: number;
  captured_at: string;
  /** Stable Electron display id. */
  display_id: number;
  /**
   * Human-readable label, e.g. `"Built-in Retina Display"` or `"DELL U2723QE"`.
   * Falls back to `Display <index>` when Electron doesn't populate it.
   */
  display_label: string;
}

/**
 * Race a promise against a timer. Resolves to `null` if the timer wins so
 * the caller can fall through silently.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Minimal shape we use from Electron's `desktopCapturer` / `screen` modules.
 * Pulled into a tiny interface so this file can be required from tests
 * without dragging in the full Electron typings at import time.
 */
interface DesktopCapturerSource {
  id: string;
  display_id?: string;
  thumbnail: { toPNG(): Buffer; isEmpty?(): boolean };
}

interface ElectronDisplay {
  id: number;
  label?: string;
  size: { width: number; height: number };
  bounds?: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
}

interface ElectronModuleShape {
  desktopCapturer: {
    getSources(opts: {
      types: string[];
      thumbnailSize?: { width: number; height: number };
    }): Promise<DesktopCapturerSource[]>;
  };
  screen: {
    getPrimaryDisplay(): ElectronDisplay;
    getAllDisplays(): ElectronDisplay[];
  };
}

/**
 * Default loader: lazy-require electron only when we're inside an Electron
 * runtime. Returns `null` from plain Node (tests, CLI, MCP) so the monitor
 * treats that tick as "no screenshot".
 */
function defaultElectronLoader(): ElectronModuleShape | null {
  if (!process.versions.electron) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron') as ElectronModuleShape;
  } catch {
    return null;
  }
}

/**
 * Pluggable loader so unit tests can inject a synthetic Electron module
 * without dealing with Node-vs-Electron `require()` resolution quirks.
 * Production code never calls the setter; calling it from a test file
 * mutates a module-scoped binding only used by `captureScreenshots()`.
 */
let electronLoader: () => ElectronModuleShape | null = defaultElectronLoader;

export function __setElectronLoaderForTests(
  loader: (() => ElectronModuleShape | null) | null,
): void {
  electronLoader = loader ?? defaultElectronLoader;
}

/**
 * Find the source whose `display_id` matches the given display id. Returns
 * `null` when no source matches — in multi-monitor mode we must not silently
 * fall back to "some other display" or we'd duplicate captures.
 */
function pickSourceForDisplay(
  sources: DesktopCapturerSource[],
  displayId: number,
): DesktopCapturerSource | null {
  if (sources.length === 0) return null;
  const wanted = String(displayId);
  return sources.find((s) => s.display_id === wanted) ?? null;
}

/**
 * Capture a single display. Returns `null` on any failure path (empty
 * thumbnail, file write failure, source not found). Never throws.
 */
async function captureOneDisplay(
  electron: ElectronModuleShape,
  display: ElectronDisplay,
  index: number,
  capturedAtIso: string,
): Promise<ScreenshotResult | null> {
  const scale = display.scaleFactor ?? 1;
  const width = Math.max(1, Math.round(display.size.width * scale));
  const height = Math.max(1, Math.round(display.size.height * scale));

  const sources = await withTimeout(
    electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    }),
    CAPTURE_TIMEOUT_MS,
  );
  if (sources === null) return null;

  const source = pickSourceForDisplay(sources, display.id);
  if (source === null) return null;

  let png: Buffer;
  try {
    if (typeof source.thumbnail.isEmpty === 'function' && source.thumbnail.isEmpty()) {
      return null;
    }
    png = source.thumbnail.toPNG();
  } catch {
    return null;
  }
  if (png.length === 0) return null;

  // Opaque filename: cap_<16-hex>.png. The timestamp + display index live in
  // the context_observations row metadata so nothing about *when* or *which
  // display* a file came from leaks via the filename alone. See
  // {@link generateOpaqueFilename} for the hash construction.
  const filename = generateOpaqueFilename(capturedAtIso, index);
  const dest = path.join(CAPTURES_DIR, filename);
  try {
    await fs.writeFile(dest, png);
  } catch {
    return null;
  }

  const label =
    typeof display.label === 'string' && display.label.length > 0
      ? display.label
      : `Display ${index}`;

  return {
    path: dest,
    size_bytes: png.length,
    captured_at: capturedAtIso,
    display_id: display.id,
    display_label: label,
  };
}

export interface CaptureScreenshotsOutcome {
  results: ScreenshotResult[];
  /** Total displays the system reported. Useful for debug logging. */
  total_displays: number;
  /** Displays past {@link MAX_DISPLAYS} that we did not attempt to capture. */
  skipped_count: number;
}

/**
 * Capture a PNG of every connected display. All captures in a single tick
 * share the same `captured_at` timestamp so the caller can group them as a
 * single observation set.
 *
 * Returns an empty outcome when Electron is unavailable, no displays are
 * reported, or every per-display capture failed. Individual display
 * failures are silently dropped — a partial result is preferable to losing
 * the whole tick when one monitor is asleep.
 *
 * Bounded at {@link MAX_DISPLAYS}; overflow is reported via
 * `skipped_count` so the caller can log.
 */
export async function captureScreenshots(): Promise<CaptureScreenshotsOutcome> {
  const empty: CaptureScreenshotsOutcome = {
    results: [],
    total_displays: 0,
    skipped_count: 0,
  };

  const electron = electronLoader();
  if (!electron) return empty;

  await fs.mkdir(CAPTURES_DIR, { recursive: true });

  let allDisplays: ElectronDisplay[];
  try {
    allDisplays = electron.screen.getAllDisplays();
  } catch {
    return empty;
  }
  if (!Array.isArray(allDisplays) || allDisplays.length === 0) return empty;

  const total = allDisplays.length;
  const toCapture = allDisplays.slice(0, MAX_DISPLAYS);
  const skipped = Math.max(0, total - toCapture.length);

  const now = new Date();
  const capturedAtIso = now.toISOString();

  // Capture in parallel — desktopCapturer.getSources is independent per call
  // and each writes to a distinct filename. The CAPTURE_TIMEOUT_MS guard
  // bounds the whole tick even when one display hangs.
  const settled = await Promise.all(
    toCapture.map((display, index) =>
      captureOneDisplay(electron, display, index, capturedAtIso).catch(
        () => null,
      ),
    ),
  );

  const results: ScreenshotResult[] = [];
  for (const r of settled) {
    if (r !== null) results.push(r);
  }

  return {
    results,
    total_displays: total,
    skipped_count: skipped,
  };
}

/**
 * Exported for the retention sweep — never re-export the path constant
 * from another module so the captures directory lives in exactly one place.
 */
export const CAPTURES_DIR_PATH = CAPTURES_DIR;
