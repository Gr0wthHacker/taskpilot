/**
 * Ambient auto-drain control surface.
 *
 * BUILD 7 — Windows Task Scheduler integration. The actual scheduling is
 * owned by the OS, not by the Electron app: `scripts/setup-auto-drain.ps1`
 * registers a task at `\TaskPilot\AmbientDeliberate` that fires every 5
 * minutes and shells into the user's locally installed Claude Code CLI
 * (which reads its OAuth from the per-user Windows Credential Manager).
 *
 * This module is the thin TS bridge the tray menu uses to:
 *   - check whether the scheduled task is currently registered, so the
 *     menu can show "Enable auto-drain" vs "Disable auto-drain"
 *   - spawn the setup / teardown PowerShell scripts on click
 *
 * We deliberately do NOT poll the scheduled task on a timer — the tray
 * menu rebuilds on its existing 30s `coworkPoll` cadence (see `tray.ts`).
 * The schtasks query is cheap (~30ms) and runs on the main process, so
 * piggybacking on that rebuild is enough.
 *
 * On non-Windows platforms every function in this module is a no-op
 * stub: `isAutoDrainAvailable()` returns false so the tray hides the
 * menu entries entirely.
 */

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lazy-load Electron's `app` only when we actually need
 * `app.getAppPath()` — that way this module is importable from a plain
 * Node test runner (vitest) without dragging Electron's binary entry
 * point through the loader.
 */
function tryGetAppPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getAppPath?: () => string } };
    if (electron && typeof electron.app?.getAppPath === 'function') {
      return electron.app.getAppPath();
    }
    return null;
  } catch {
    return null;
  }
}

/** Task path as registered by `setup-auto-drain.ps1`. */
const SCHEDULED_TASK_PATH = '\\TaskPilot\\';
const SCHEDULED_TASK_NAME = 'AmbientDeliberate';
const SCHEDULED_TASK_FULL = `${SCHEDULED_TASK_PATH}${SCHEDULED_TASK_NAME}`;

/**
 * Locate the scripts/ directory. In dev tray.ts is bundled into
 * `dist/main.cjs` and lives at `<repo>/dist`, so scripts is `../scripts`.
 * In a packaged build, scripts are shipped under
 * `process.resourcesPath/scripts` via `electron-builder.extraResources`.
 *
 * Try a few candidates and use the first that exists. Falls back to a
 * best-guess repo-root path so the failure is loud (the spawned
 * powershell will report "file not found") rather than silent.
 */
function resolveScriptsDir(): string {
  const _filename =
    typeof __filename !== 'undefined'
      ? __filename
      : fileURLToPath(import.meta.url);
  const _dirname =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(_filename);

  const candidates: Array<string | null> = [
    // packaged: resourcesPath/scripts
    process.resourcesPath
      ? path.join(process.resourcesPath, 'scripts')
      : null,
    // dev (bundled): dist/../scripts
    path.join(_dirname, '..', 'scripts'),
    // dev (tsx, src/main/deliberation): up three to repo root
    path.join(_dirname, '..', '..', '..', 'scripts'),
    // app-mounted cwd fallback
    process.cwd() ? path.join(process.cwd(), 'scripts') : null,
    // electron app.getAppPath() — points at the asar root in production
    (() => {
      const appPath = tryGetAppPath();
      return appPath ? path.join(appPath, 'scripts') : null;
    })(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      // Lazy require to avoid a hard fs dependency in places we only need
      // the path string. Synchronous + a single stat is cheap.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      if (fs.existsSync(path.join(candidate, 'setup-auto-drain.ps1'))) {
        return candidate;
      }
    } catch {
      /* try next */
    }
  }

  // Loud fallback so the spawn surfaces a "file not found" the user
  // can act on.
  return candidates.find((c): c is string => typeof c === 'string')
    ?? path.join(process.cwd(), 'scripts');
}

/**
 * Whether the auto-drain feature is available on this platform.
 *
 * Currently Windows-only — the scheduled-task mechanism is OS-specific
 * and the PowerShell scripts use Windows-native cmdlets. macOS/Linux
 * equivalents are tracked in INTEGRATION_NOTES.md.
 */
export function isAutoDrainAvailable(): boolean {
  return process.platform === 'win32';
}

/**
 * Status of the registered scheduled task.
 *
 *   - `unavailable`  — not Windows, or schtasks couldn't be invoked
 *   - `unregistered` — schtasks ran but no task at the expected path
 *   - `registered`   — task exists (may or may not be currently running)
 *   - `unknown`      — best-effort check failed; treat as `unregistered`
 *                      for UI purposes but don't claim certainty
 */
export type AutoDrainStatus =
  | 'unavailable'
  | 'unregistered'
  | 'registered'
  | 'unknown';

/**
 * Query the OS for the scheduled task. Synchronous + cached for one
 * second so a tray rebuild that calls this twice in quick succession
 * doesn't fork schtasks.exe twice.
 *
 * Returns 'unregistered' / 'registered' based on `schtasks /Query`
 * exit code: 0 means found, 1 means not found, anything else is
 * 'unknown'.
 */
let cachedStatus: { value: AutoDrainStatus; at: number } | null = null;
const STATUS_CACHE_MS = 1000;

export function getAutoDrainStatus(): AutoDrainStatus {
  if (!isAutoDrainAvailable()) return 'unavailable';

  const now = Date.now();
  if (cachedStatus && now - cachedStatus.at < STATUS_CACHE_MS) {
    return cachedStatus.value;
  }

  let status: AutoDrainStatus;
  try {
    const result = spawnSync(
      'schtasks.exe',
      ['/Query', '/TN', SCHEDULED_TASK_FULL],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      },
    );
    if (result.error) {
      status = 'unknown';
    } else if (result.status === 0) {
      status = 'registered';
    } else if (result.status === 1) {
      status = 'unregistered';
    } else {
      status = 'unknown';
    }
  } catch {
    status = 'unknown';
  }

  cachedStatus = { value: status, at: now };
  return status;
}

/**
 * Force a re-read on the next `getAutoDrainStatus()` call. Call this
 * after invoking setup/teardown so the tray reflects the new state
 * immediately instead of waiting out the 1s cache window.
 */
export function invalidateAutoDrainStatusCache(): void {
  cachedStatus = null;
}

interface SpawnPwshOptions {
  /** Extra script args (e.g. `-Force`). */
  args?: string[];
  /** Called once on exit with the exit code. */
  onExit?: (code: number | null) => void;
}

function spawnPowershellScript(
  scriptName: 'setup-auto-drain.ps1' | 'teardown-auto-drain.ps1',
  options: SpawnPwshOptions = {},
): void {
  if (!isAutoDrainAvailable()) {
    options.onExit?.(null);
    return;
  }
  const scriptsDir = resolveScriptsDir();
  const scriptPath = path.join(scriptsDir, scriptName);

  const baseArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...(options.args ?? []),
  ];

  // Visible window for setup (so the user sees pre-flight output and
  // any `Read-Host` prompts); hidden for teardown (silent removal).
  const visible = scriptName === 'setup-auto-drain.ps1';
  const spawnOpts: SpawnOptions = {
    detached: true,
    stdio: visible ? 'inherit' : 'ignore',
    windowsHide: !visible,
  };

  const child = spawn('powershell.exe', baseArgs, spawnOpts);
  child.on('exit', (code) => {
    invalidateAutoDrainStatusCache();
    options.onExit?.(code);
  });
  child.on('error', () => {
    invalidateAutoDrainStatusCache();
    options.onExit?.(null);
  });
  // Detach so quitting the app doesn't kill the setup script.
  child.unref();
}

/**
 * Spawn `scripts/setup-auto-drain.ps1` in a visible PowerShell window.
 * Returns immediately — we don't await the script (setup includes an
 * interactive prompt + a ~10s claude pre-flight invocation).
 */
export function enableAutoDrain(onExit?: (code: number | null) => void): void {
  spawnPowershellScript('setup-auto-drain.ps1', { args: ['-Force'], onExit });
}

/**
 * Spawn `scripts/teardown-auto-drain.ps1` hidden. Returns immediately.
 */
export function disableAutoDrain(onExit?: (code: number | null) => void): void {
  spawnPowershellScript('teardown-auto-drain.ps1', { onExit });
}

/**
 * Public constants exported for tests + the tray menu.
 */
export const AUTO_DRAIN_TASK_PATH = SCHEDULED_TASK_FULL;
