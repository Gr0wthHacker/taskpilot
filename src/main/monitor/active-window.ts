/**
 * Active-window collector — Windows.
 *
 * Spawns the cached `get-active-window.ps1` PowerShell script (copied into
 * `~/.taskpilot/scripts/` on first call) and parses its JSON output to
 * return the foreground window's app name + title.
 *
 * Why PowerShell shell-out instead of a native node module (e.g. `get-windows`):
 * TaskPilot already maintains a dual-ABI better-sqlite3 build (one for Node,
 * one for Electron). Adding another node-gyp dependency for a 30s poll loop
 * doubles that pain. A `child_process.spawn('powershell.exe', ...)` is zero
 * compile, zero ABI binding, hidden via `windowsHide: true`, with a hard
 * 1500ms timeout so a hung shell never blocks the monitor's tick.
 *
 * Public surface:
 *   - {@link getActiveWindow}: probe once, return `{ app_name, window_title,
 *     process_path } | null`.
 *   - {@link ensureScriptInstalled}: idempotently writes the .ps1 to
 *     `~/.taskpilot/scripts/`.
 *
 * Non-goals: macOS / Linux support. This module is Windows-only by design;
 * `process.platform !== 'win32'` short-circuits to `null` so callers don't
 * need to guard.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TASKPILOT_HOME } from '@/shared/constants';

const POWERSHELL_TIMEOUT_MS = 1500;
const SCRIPTS_DIR = path.join(TASKPILOT_HOME, 'scripts');
const SCRIPT_NAME = 'get-active-window.ps1';
const SCRIPT_DEST = path.join(SCRIPTS_DIR, SCRIPT_NAME);

const _filename =
  typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(_filename);

/**
 * Locate the bundled script next to this module. In dev it sits at
 * `src/main/monitor/scripts/get-active-window.ps1`; in the tsup CJS bundle
 * the `scripts/` directory is shipped alongside the bundle by the build
 * step. Falls back to the dev path so headless tests can resolve it without
 * a build.
 */
function sourceScriptPath(): string {
  return path.join(_dirname, 'scripts', SCRIPT_NAME);
}

/**
 * Output shape returned by the PowerShell script. Every field is optional
 * because the script returns `{}` on permission errors / lock screen / no
 * foreground window — and we never want the monitor to crash because a tick
 * landed on an unprivileged moment.
 */
export interface ActiveWindowInfo {
  app_name: string | null;
  window_title: string | null;
  process_path: string | null;
}

interface RawScriptOutput {
  app_name?: unknown;
  window_title?: unknown;
  process_path?: unknown;
}

function coerceString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseScriptOutput(raw: string): ActiveWindowInfo | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: RawScriptOutput;
  try {
    parsed = JSON.parse(trimmed) as RawScriptOutput;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const app = coerceString(parsed.app_name);
  const title = coerceString(parsed.window_title);
  const procPath = coerceString(parsed.process_path);
  if (app === null && title === null) return null;
  return { app_name: app, window_title: title, process_path: procPath };
}

/**
 * Copy the bundled .ps1 into `~/.taskpilot/scripts/` if not already there or
 * out of date. Idempotent and cheap — called once per `getActiveWindow()` so
 * a re-installed app picks up a newer script on the next tick.
 */
export async function ensureScriptInstalled(): Promise<string> {
  await fs.mkdir(SCRIPTS_DIR, { recursive: true });
  const source = sourceScriptPath();
  let sourceContent: string;
  try {
    sourceContent = await fs.readFile(source, 'utf8');
  } catch {
    // Bundled script missing — caller will treat the next probe as a no-op.
    return SCRIPT_DEST;
  }
  let existing: string | null = null;
  try {
    existing = await fs.readFile(SCRIPT_DEST, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== sourceContent) {
    await fs.writeFile(SCRIPT_DEST, sourceContent, 'utf8');
  }
  return SCRIPT_DEST;
}

/**
 * Spawn PowerShell with the cached script and return stdout (or `null` on
 * timeout / non-zero exit / spawn error). Output is bounded to 64 KiB; the
 * script's payload is always <1 KiB so anything bigger is treated as garbage.
 */
function runScript(scriptPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    );
    let stdout = '';
    let resolved = false;
    const settle = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), POWERSHELL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 65_536) settle(null);
    });
    child.on('error', () => {
      clearTimeout(timer);
      settle(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? stdout : null);
    });
  });
}

/**
 * Probe the foreground window once. Returns `null` on any failure path —
 * lock screen, UAC-elevated foreground window, PowerShell missing, timeout,
 * non-win32 platform. Never throws.
 */
export async function getActiveWindow(): Promise<ActiveWindowInfo | null> {
  if (process.platform !== 'win32') return null;
  try {
    const scriptPath = await ensureScriptInstalled();
    const raw = await runScript(scriptPath);
    if (raw === null) return null;
    return parseScriptOutput(raw);
  } catch {
    return null;
  }
}
