/**
 * Managed Chrome instance lifecycle.
 *
 * Spawns a dedicated Chrome (or Edge as fallback) with `--remote-debugging-port`
 * pointing at a local TaskPilot port, isolated to its own user-data-dir under
 * `~/.taskpilot/chrome-profile/`. Keeping the profile isolated means the user's
 * real Chrome session, cookies, and logins are untouched.
 *
 * `ensureChrome()` is idempotent — returns the existing handle when Chrome is
 * already running and the debug port responds. Otherwise it discovers the
 * Chrome binary, spawns it, polls `/json/version` until the protocol responds,
 * and resolves with the bound port.
 *
 * `stopChrome()` kills the spawned process and clears the cached handle. It is
 * safe to call when Chrome was never started.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { TASKPILOT_HOME } from '@/shared/constants';

export const CHROME_DEBUG_PORT = 9222;
export const CHROME_PROFILE_DIR = path.join(TASKPILOT_HOME, 'chrome-profile');

/**
 * Wait this long for the debug port to come up after spawn. AV scanners +
 * cold Edge profiles can push past 15s on slow Windows boxes; override via
 * `TASKPILOT_CHROME_READY_MS`.
 */
const READY_TIMEOUT_MS = (() => {
  const env = Number(process.env.TASKPILOT_CHROME_READY_MS);
  return Number.isFinite(env) && env > 1_000 ? env : 15_000;
})();
const READY_POLL_INTERVAL_MS = 200;

export interface ChromeHandle {
  port: number;
  binary: string;
  pid: number | null;
  /** Whether THIS process spawned Chrome (vs. attached to an external one). */
  spawned: boolean;
}

let activeHandle: ChromeHandle | null = null;
let activeProcess: ChildProcess | null = null;
/**
 * Module-scope lock so concurrent `ensureChrome()` callers coalesce on a
 * single spawn. Without this, two parallel calls each see `pingDebugPort`
 * fail, both reach `spawn`, and we end up with an orphan Chrome whose exit
 * handler can't reclaim the cached state (the `if (activeProcess === child)`
 * guard fires on the loser).
 */
let pendingEnsure: Promise<ChromeHandle> | null = null;

/* -------------------------------------------------------------------------- */
/*  Binary discovery                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Probe filesystem for a Chromium-family binary, preferring Chrome over Edge.
 * Returns the first match. Throws if nothing is found.
 *
 * Override via the `TASKPILOT_CHROME_PATH` env var — useful for portable
 * installs or non-default locations.
 */
export async function findChromeBinary(): Promise<string> {
  const override = process.env.TASKPILOT_CHROME_PATH;
  if (override) {
    if (await fileExists(override)) return override;
    throw new Error(
      `findChromeBinary: TASKPILOT_CHROME_PATH points to "${override}" which does not exist`,
    );
  }

  const candidates = chromeBinaryCandidates();
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(
    'findChromeBinary: no Chrome / Chromium / Edge binary found. ' +
      'Install Google Chrome, or set TASKPILOT_CHROME_PATH to a chromium-based browser executable.',
  );
}

function chromeBinaryCandidates(): string[] {
  const platform = process.platform;
  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 =
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData =
      process.env['LOCALAPPDATA'] ||
      path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  // linux + others
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

export interface EnsureChromeOptions {
  /** Override the debug port. Default 9222. */
  port?: number;
  /** Run Chrome in headless mode. Default false. */
  headless?: boolean;
  /** Additional chrome flags. Appended after the defaults. */
  extraArgs?: string[];
}

/**
 * Ensure a Chrome instance with a CDP-reachable debug port. Returns the cached
 * handle when one is already running; otherwise spawns a new one and waits
 * for the debug port to respond. Concurrent callers share a single spawn
 * via `pendingEnsure`.
 */
export async function ensureChrome(
  options: EnsureChromeOptions = {},
): Promise<ChromeHandle> {
  if (pendingEnsure) return pendingEnsure;
  pendingEnsure = (async () => {
    try {
      return await ensureChromeImpl(options);
    } finally {
      pendingEnsure = null;
    }
  })();
  return pendingEnsure;
}

async function ensureChromeImpl(
  options: EnsureChromeOptions,
): Promise<ChromeHandle> {
  const port = options.port ?? CHROME_DEBUG_PORT;

  // Fast path — we already have a handle and the debug port responds.
  if (activeHandle && activeHandle.port === port && (await pingDebugPort(port))) {
    return activeHandle;
  }

  // Someone else (or a previous run) already left Chrome listening on this port.
  // Adopt the existing instance rather than fighting over the port.
  if (await pingDebugPort(port)) {
    activeHandle = {
      port,
      binary: '(external)',
      pid: null,
      spawned: false,
    };
    return activeHandle;
  }

  await fs.mkdir(CHROME_PROFILE_DIR, { recursive: true });
  const binary = await findChromeBinary();
  const args = buildChromeArgs(port, options);

  const child = spawn(binary, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  activeProcess = child;

  child.once('exit', (code) => {
    // Clear cached handle if the process this module owns dies — next
    // ensureChrome() call will respawn.
    if (activeProcess === child) {
      activeProcess = null;
      activeHandle = null;
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:browser] chrome exited code=${code ?? 'null'}`,
      );
    }
  });
  child.once('error', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[taskpilot:browser] chrome spawn error: ${err.message}`);
  });

  try {
    await waitForDebugPort(port, READY_TIMEOUT_MS);
  } catch (err) {
    // Tear down the half-spawned process so the next call starts fresh.
    await forceKill(child);
    activeProcess = null;
    activeHandle = null;
    throw err;
  }

  activeHandle = {
    port,
    binary,
    pid: child.pid ?? null,
    spawned: true,
  };
  return activeHandle;
}

function buildChromeArgs(port: number, options: EnsureChromeOptions): string[] {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-translate',
    '--disable-features=Translate,InterestFeedContentSuggestions',
    '--disable-component-update',
    // Skip the welcome / what's-new page on profile creation.
    '--disable-search-engine-choice-screen',
    // Restore the last session quietly rather than showing the crash bubble
    // after we kill -9 the process on shutdown.
    '--hide-crash-restore-bubble',
    'about:blank',
  ];
  if (options.headless) {
    args.unshift('--headless=new');
  }
  if (options.extraArgs && options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/*  Readiness                                                                 */
/* -------------------------------------------------------------------------- */

async function waitForDebugPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await pingDebugPort(port)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `ensureChrome: debug port ${port} did not respond within ${timeoutMs}ms`,
      );
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
}

async function pingDebugPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      method: 'GET',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/*  Shutdown                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Kill the spawned Chrome process. No-op if nothing was spawned by this module
 * (e.g. when we attached to an externally-launched instance).
 *
 * Windows gotcha: Node's `child.kill('SIGTERM')` calls `TerminateProcess`
 * — equivalent to SIGKILL on POSIX — so neither the 1s grace nor Chrome's
 * own shutdown handlers ever run. We use `taskkill /T` to walk the whole
 * Chrome process tree (Chrome forks renderer/GPU subprocesses), and only
 * fall back to /F if the soft path fails.
 */
export async function stopChrome(): Promise<void> {
  const proc = activeProcess;
  const handle = activeHandle;
  activeProcess = null;
  activeHandle = null;
  if (!proc || !handle?.spawned) return;
  await forceKill(proc);
}

async function forceKill(proc: ChildProcess): Promise<void> {
  if (!proc.pid) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    return;
  }
  if (process.platform === 'win32') {
    // Walk the tree (/T) with terminate (/F). Without /T, the renderer/GPU
    // subprocesses outlive the parent and hold the user-data-dir lock.
    try {
      await new Promise<void>((resolve) => {
        const tk = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        tk.once('exit', () => resolve());
        tk.once('error', () => resolve());
      });
    } catch {
      /* fall through to Node's kill */
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    /* best-effort */
  }
  // Give the process a beat to settle so a subsequent ensureChrome() doesn't
  // race the port still being in TIME_WAIT.
  await Promise.race([
    new Promise<void>((resolve) => proc.once('exit', () => resolve())),
    sleep(500),
  ]);
}

export function currentHandle(): ChromeHandle | null {
  return activeHandle;
}
