/**
 * Tests for the multi-monitor screenshot collector.
 *
 * The module exposes `__setElectronLoaderForTests()` so we can inject a
 * synthetic `{ screen, desktopCapturer }` pair without dealing with
 * Node-vs-Electron `require()` resolution. `vi.mock('electron', …)` does
 * not work cleanly here because the source uses lazy `require('electron')`
 * inside a non-Electron Node runtime, and `electron`'s entry point is a
 * stringified binary path — not a module object.
 *
 * Coverage:
 *   - single-display path: one PNG, one ScreenshotResult, behavior matches
 *     the old captureScreenshot() contract.
 *   - multi-display path (2 monitors): two PNGs with distinct filenames
 *     sharing the same ISO timestamp; results in the order returned by
 *     getAllDisplays(); display_id + display_label preserved.
 *   - skip cap: when more than MAX_DISPLAYS displays exist, only the first
 *     MAX_DISPLAYS are captured and skipped_count reflects the overflow.
 *   - one row per display when wired through the persistence loop in
 *     tickScreenshot() — exercised here via the contextObservationsRepository.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import {
  captureScreenshots,
  MAX_DISPLAYS,
  __setElectronLoaderForTests,
} from '@/main/monitor/screenshot';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';

/* -------------------------------------------------------------------------- */
/*  Mock electron module                                                      */
/* -------------------------------------------------------------------------- */

interface MockDisplay {
  id: number;
  label?: string;
  size: { width: number; height: number };
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

interface State {
  displays: MockDisplay[];
  getSourcesCalls: Array<{
    types: string[];
    thumbnailSize?: { width: number; height: number };
  }>;
  pngBytes: Buffer;
  /** Inject a per-source failure: if true, isEmpty() returns true. */
  emptyThumbnail: boolean;
}

let state: State;

function resetState(): void {
  state = {
    displays: [],
    getSourcesCalls: [],
    pngBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    emptyThumbnail: false,
  };
}

resetState();

function buildElectronMock() {
  return {
    screen: {
      getPrimaryDisplay: () => state.displays[0]!,
      getAllDisplays: () => state.displays,
    },
    desktopCapturer: {
      getSources: async (opts: {
        types: string[];
        thumbnailSize?: { width: number; height: number };
      }) => {
        state.getSourcesCalls.push(opts);
        // Return one source per display, each tagged with the matching id.
        return state.displays.map((d) => ({
          id: `screen:${d.id}:0`,
          display_id: String(d.id),
          thumbnail: {
            toPNG: () => state.pngBytes,
            isEmpty: () => state.emptyThumbnail || state.pngBytes.length === 0,
          },
        }));
      },
    },
  };
}

beforeEach(() => {
  resetState();
  __setElectronLoaderForTests(() => buildElectronMock());
});

afterEach(() => {
  __setElectronLoaderForTests(null);
  // Wipe captured PNGs so file-count assertions don't accumulate across tests.
  try {
    const files = fs.readdirSync(PATHS.CAPTURES_DIR);
    for (const f of files) {
      try {
        fs.unlinkSync(`${PATHS.CAPTURES_DIR}/${f}`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir may not exist yet on first run */
  }
});

/* -------------------------------------------------------------------------- */
/*  captureScreenshots() — module-level                                       */
/* -------------------------------------------------------------------------- */

describe('captureScreenshots — single display', () => {
  beforeEach(() => {
    state.displays = [
      {
        id: 1,
        label: 'Built-in Display',
        size: { width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 2,
      },
    ];
  });

  it('returns exactly one ScreenshotResult and writes one PNG', async () => {
    const outcome = await captureScreenshots();
    expect(outcome.results).toHaveLength(1);
    expect(outcome.total_displays).toBe(1);
    expect(outcome.skipped_count).toBe(0);

    const r = outcome.results[0]!;
    expect(r.display_id).toBe(1);
    expect(r.display_label).toBe('Built-in Display');
    // Opaque filenames hide timestamp + display index — captured_at and the
    // display index live in the observation row metadata, not the filename.
    expect(r.path).toMatch(/cap_[a-f0-9]{16}\.png$/);
    expect(r.size_bytes).toBe(state.pngBytes.length);

    expect(fs.existsSync(r.path)).toBe(true);
    const files = fs.readdirSync(PATHS.CAPTURES_DIR);
    expect(files).toHaveLength(1);
  });

  it('uses display.size × scaleFactor for thumbnailSize', async () => {
    await captureScreenshots();
    expect(state.getSourcesCalls).toHaveLength(1);
    expect(state.getSourcesCalls[0]!.thumbnailSize).toEqual({
      width: 3840,
      height: 2160,
    });
  });
});

describe('captureScreenshots — multi-display', () => {
  beforeEach(() => {
    state.displays = [
      {
        id: 10,
        label: 'Internal Retina',
        size: { width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 2,
      },
      {
        id: 20,
        label: 'DELL U2723QE',
        size: { width: 2560, height: 1440 },
        bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
        scaleFactor: 1,
      },
    ];
  });

  it('captures both displays, writes two distinct PNGs sharing the same captured_at', async () => {
    const outcome = await captureScreenshots();
    expect(outcome.results).toHaveLength(2);
    expect(outcome.total_displays).toBe(2);
    expect(outcome.skipped_count).toBe(0);

    const [first, second] = outcome.results;
    expect(first!.display_id).toBe(10);
    expect(first!.display_label).toBe('Internal Retina');
    expect(second!.display_id).toBe(20);
    expect(second!.display_label).toBe('DELL U2723QE');

    expect(first!.captured_at).toBe(second!.captured_at);

    // Both filenames use the opaque format; the per-display distinction is
    // carried by the random-nonce hash, not by an obvious index suffix.
    expect(first!.path).toMatch(/cap_[a-f0-9]{16}\.png$/);
    expect(second!.path).toMatch(/cap_[a-f0-9]{16}\.png$/);
    expect(first!.path).not.toBe(second!.path);

    expect(fs.existsSync(first!.path)).toBe(true);
    expect(fs.existsSync(second!.path)).toBe(true);
  });

  it('falls back to "Display <index>" when label is missing', async () => {
    state.displays = [
      {
        id: 99,
        size: { width: 800, height: 600 },
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        scaleFactor: 1,
      },
    ];
    const outcome = await captureScreenshots();
    expect(outcome.results[0]!.display_label).toBe('Display 0');
  });
});

describe('captureScreenshots — display cap', () => {
  it(`captures only the first ${MAX_DISPLAYS} when more are present, reports skipped_count`, async () => {
    const total = MAX_DISPLAYS + 2;
    state.displays = Array.from({ length: total }, (_, i) => ({
      id: 100 + i,
      label: `Monitor ${i}`,
      size: { width: 1024, height: 768 },
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
      scaleFactor: 1,
    }));

    const outcome = await captureScreenshots();
    expect(outcome.total_displays).toBe(total);
    expect(outcome.skipped_count).toBe(total - MAX_DISPLAYS);
    expect(outcome.results).toHaveLength(MAX_DISPLAYS);
    for (let i = 0; i < MAX_DISPLAYS; i++) {
      expect(outcome.results[i]!.display_id).toBe(100 + i);
    }
  });
});

describe('captureScreenshots — failure modes', () => {
  it('returns an empty outcome when getAllDisplays() returns []', async () => {
    state.displays = [];
    const outcome = await captureScreenshots();
    expect(outcome.results).toEqual([]);
    expect(outcome.total_displays).toBe(0);
    expect(outcome.skipped_count).toBe(0);
  });

  it('returns an empty outcome when electron is unavailable', async () => {
    __setElectronLoaderForTests(() => null);
    state.displays = [
      {
        id: 1,
        size: { width: 100, height: 100 },
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        scaleFactor: 1,
      },
    ];
    const outcome = await captureScreenshots();
    expect(outcome.results).toEqual([]);
    expect(outcome.total_displays).toBe(0);
  });

  it('drops displays whose thumbnail is empty', async () => {
    state.displays = [
      {
        id: 1,
        label: 'A',
        size: { width: 100, height: 100 },
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        scaleFactor: 1,
      },
    ];
    state.emptyThumbnail = true;
    const outcome = await captureScreenshots();
    expect(outcome.results).toEqual([]);
    expect(outcome.total_displays).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Integration: one observation row per display                              */
/* -------------------------------------------------------------------------- */
//
// Mirrors the persistence loop in monitor/index.ts's tickScreenshot(). We
// verify that capturing N displays produces N context_observations rows,
// all sharing the same captured_at, each carrying display metadata.

describe('multi-display row creation (integration via repository)', () => {
  useMockedDb();

  it('creates one row per captured display, all sharing the same captured_at', async () => {
    state.displays = [
      {
        id: 11,
        label: 'A',
        size: { width: 1280, height: 720 },
        bounds: { x: 0, y: 0, width: 1280, height: 720 },
        scaleFactor: 1,
      },
      {
        id: 22,
        label: 'B',
        size: { width: 1920, height: 1080 },
        bounds: { x: 1280, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
      },
    ];

    const outcome = await captureScreenshots();
    expect(outcome.results).toHaveLength(2);

    const sharedCapturedAt = outcome.results[0]!.captured_at;
    const rows = outcome.results.map((shot, i) =>
      contextObservationsRepository.create({
        source: 'screenshot',
        captured_at: sharedCapturedAt,
        screenshot_path: shot.path,
        metadata: {
          size_bytes: shot.size_bytes,
          display_index: i,
          display_id: shot.display_id,
          display_label: shot.display_label,
        },
      }),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.captured_at).toBe(rows[1]!.captured_at);
    expect(rows[0]!.screenshot_path).not.toBe(rows[1]!.screenshot_path);

    expect(rows[0]!.metadata).toMatchObject({
      display_index: 0,
      display_id: 11,
      display_label: 'A',
    });
    expect(rows[1]!.metadata).toMatchObject({
      display_index: 1,
      display_id: 22,
      display_label: 'B',
    });

    const persisted = contextObservationsRepository.list({ source: 'screenshot' });
    expect(persisted).toHaveLength(2);
  });

  it('produces a single row when only one display is present (back-compat)', async () => {
    state.displays = [
      {
        id: 7,
        label: 'Solo',
        size: { width: 1366, height: 768 },
        bounds: { x: 0, y: 0, width: 1366, height: 768 },
        scaleFactor: 1,
      },
    ];

    const outcome = await captureScreenshots();
    expect(outcome.results).toHaveLength(1);

    const shot = outcome.results[0]!;
    contextObservationsRepository.create({
      source: 'screenshot',
      captured_at: shot.captured_at,
      screenshot_path: shot.path,
      metadata: {
        size_bytes: shot.size_bytes,
        display_index: 0,
        display_id: shot.display_id,
        display_label: shot.display_label,
      },
    });

    const rows = contextObservationsRepository.list({ source: 'screenshot' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.screenshot_path).toBe(shot.path);
  });
});
