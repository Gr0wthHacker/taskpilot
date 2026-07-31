/**
 * Desktop input — screenshot, mouse, keyboard.
 *
 * Every action runs via PowerShell using .NET Framework primitives that ship
 * with Windows. No native deps, no extra binaries to rebuild.
 *
 * SAFETY:
 *   - All public functions call `ensureDesktopEnabled()` first, which throws
 *     unless the `desktop_input_enabled` setting is true. Default false.
 *   - Coordinates and key inputs are validated before being interpolated
 *     into PowerShell. We never pass user-supplied strings into a script
 *     without quoting them through PowerShell's single-quote string syntax.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { settingsRepository } from '@/main/db/repositories/settings';

import { powerShellOutput, runPowerShell, assertWindows } from './powershell';

/**
 * Hard bounds on absolute screen coordinates. The Windows virtual screen
 * can legitimately span multiple monitors with negative origins, so we
 * accept the full ±65535 range but reject anything past that — values like
 * 1e15 get truncated by SetCursorPos's int cast, which would silently click
 * the wrong spot.
 */
const COORD_BOUND = 65_535;

/* -------------------------------------------------------------------------- */
/*  Settings gate                                                             */
/* -------------------------------------------------------------------------- */

export class DesktopInputDisabledError extends Error {
  readonly code = 'desktop_input_disabled';
  constructor() {
    super(
      'Desktop input is disabled. Enable it by setting `desktop_input_enabled` to true ' +
        'via POST /api/settings or in the GUI. This setting opts in to real keyboard/mouse control.',
    );
    this.name = 'DesktopInputDisabledError';
  }
}

export class DesktopInputUnsupportedError extends Error {
  readonly code = 'desktop_input_unsupported';
  constructor(message: string) {
    super(message);
    this.name = 'DesktopInputUnsupportedError';
  }
}

export function ensureDesktopEnabled(): void {
  assertWindows();
  let enabled: boolean | null;
  try {
    enabled = settingsRepository.get<boolean>('desktop_input_enabled');
  } catch (err) {
    // DB not initialized (very early boot, headless MCP started before main
    // wiring) — surface a clean error instead of leaking the sqlite stack.
    throw new DesktopInputUnsupportedError(
      `Desktop input gate check failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
  if (enabled !== true) {
    throw new DesktopInputDisabledError();
  }
}

/* -------------------------------------------------------------------------- */
/*  PowerShell quoting                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Quote an arbitrary string as a PowerShell single-quoted literal.
 * PowerShell single quotes don't expand variables and only need `'` doubled.
 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/* -------------------------------------------------------------------------- */
/*  Screen size                                                                */
/* -------------------------------------------------------------------------- */

export interface ScreenSize {
  width: number;
  height: number;
}

export async function getPrimaryScreenSize(): Promise<ScreenSize> {
  ensureDesktopEnabled();
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Write-Output "$($b.Width)x$($b.Height)"
  `;
  const out = (await powerShellOutput(script)).trim();
  const m = /^(\d+)x(\d+)$/.exec(out);
  if (!m || !m[1] || !m[2]) {
    throw new Error(`getPrimaryScreenSize: unexpected output "${out}"`);
  }
  return { width: Number(m[1]), height: Number(m[2]) };
}

/* -------------------------------------------------------------------------- */
/*  Screenshot                                                                */
/* -------------------------------------------------------------------------- */

export interface ScreenshotResult {
  width: number;
  height: number;
  format: 'png';
  /** Base64-encoded PNG. */
  data: string;
}

/**
 * Capture the primary screen and return it base64-encoded.
 *
 * Bitmap is written to a private tmp dir created via `fs.mkdtemp` so a
 * malicious user on the same machine can't race a symlink at the predictable
 * filename (Math.random() is non-cryptographic; Date.now() narrows the
 * search space). The whole tmp dir is removed in a `finally` regardless of
 * which step threw — so a PowerShell timeout or partial-write doesn't leak
 * bitmaps into %TEMP%.
 */
export async function captureScreen(): Promise<ScreenshotResult> {
  ensureDesktopEnabled();

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `taskpilot-shot-${crypto.randomBytes(8).toString('hex')}-`),
  );
  const tmpPath = path.join(tmpDir, 'screen.png');

  try {
    const script = `
      Add-Type -AssemblyName System.Drawing
      Add-Type -AssemblyName System.Windows.Forms
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
      $bmp.Save(${psQuote(tmpPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose()
      $bmp.Dispose()
      Write-Output "$($b.Width)x$($b.Height)"
    `;
    const out = (await powerShellOutput(script, { timeoutMs: 30_000 })).trim();
    const m = /^(\d+)x(\d+)$/.exec(out);
    const width = m && m[1] ? Number(m[1]) : 0;
    const height = m && m[2] ? Number(m[2]) : 0;

    const buf = await fs.readFile(tmpPath);
    return {
      width,
      height,
      format: 'png',
      data: buf.toString('base64'),
    };
  } finally {
    // rm -rf the private tmp dir regardless of which step threw.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/*  Mouse                                                                     */
/* -------------------------------------------------------------------------- */

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * SetCursorPos + mouse_event flags from user32.dll. We declare them inline
 * each call rather than caching the Add-Type — caching across calls is
 * brittle when PowerShell restarts mid-session.
 */
const USER32_DEFINITIONS = `
  Add-Type @'
    using System;
    using System.Runtime.InteropServices;
    public class TpUser32 {
      [DllImport("user32.dll")]
      public static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")]
      public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
      public const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
      public const uint MOUSEEVENTF_LEFTUP     = 0x0004;
      public const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
      public const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
      public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
      public const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;
    }
'@
`;

function buttonFlags(button: MouseButton): { down: string; up: string } {
  switch (button) {
    case 'left':
      return {
        down: '[TpUser32]::MOUSEEVENTF_LEFTDOWN',
        up: '[TpUser32]::MOUSEEVENTF_LEFTUP',
      };
    case 'right':
      return {
        down: '[TpUser32]::MOUSEEVENTF_RIGHTDOWN',
        up: '[TpUser32]::MOUSEEVENTF_RIGHTUP',
      };
    case 'middle':
      return {
        down: '[TpUser32]::MOUSEEVENTF_MIDDLEDOWN',
        up: '[TpUser32]::MOUSEEVENTF_MIDDLEUP',
      };
  }
}

/**
 * Move the cursor to absolute screen coordinates. (0,0) is the top-left of
 * the primary monitor.
 */
export async function moveMouse(x: number, y: number): Promise<{ x: number; y: number }> {
  ensureDesktopEnabled();
  assertCoord(x, 'x');
  assertCoord(y, 'y');
  const script = `
    ${USER32_DEFINITIONS}
    [void][TpUser32]::SetCursorPos(${x}, ${y})
  `;
  await powerShellOutput(script);
  return { x, y };
}

/**
 * Sanity-check absolute screen coordinates. Negative is legitimate (left-of-
 * primary monitor on multi-display setups), but unbounded values like
 * `1e15` get truncated by SetCursorPos's int cast and click somewhere
 * unrelated.
 */
function assertCoord(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer (got ${value})`);
  }
  if (value < -COORD_BOUND || value > COORD_BOUND) {
    throw new Error(
      `${label} out of range [-${COORD_BOUND}, ${COORD_BOUND}] (got ${value})`,
    );
  }
}

/**
 * Click at the given coordinates with the given button. Performs a full
 * down+up sequence at the same position.
 */
export async function clickAt(
  x: number,
  y: number,
  button: MouseButton = 'left',
): Promise<{ x: number; y: number; button: MouseButton }> {
  ensureDesktopEnabled();
  assertCoord(x, 'x');
  assertCoord(y, 'y');
  const flags = buttonFlags(button);
  const script = `
    ${USER32_DEFINITIONS}
    [void][TpUser32]::SetCursorPos(${x}, ${y})
    Start-Sleep -Milliseconds 30
    [TpUser32]::mouse_event(${flags.down}, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 30
    [TpUser32]::mouse_event(${flags.up}, 0, 0, 0, [UIntPtr]::Zero)
  `;
  await powerShellOutput(script);
  return { x, y, button };
}

/* -------------------------------------------------------------------------- */
/*  Keyboard                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * SendKeys uses a small DSL — `^a` for Ctrl+A, `{ENTER}` for Enter, `{F5}` for
 * F5, etc. We expose the raw string so callers can use it directly. Plain
 * text goes through verbatim with the special characters escaped to keep
 * literal `(` `)` `+` `^` `%` `~` `{` `}` `[` `]` from being interpreted.
 */
export async function sendKeys(
  keys: string,
  options: { raw?: boolean } = {},
): Promise<{ keys: string }> {
  ensureDesktopEnabled();
  if (typeof keys !== 'string' || keys.length === 0) {
    throw new Error('sendKeys: keys must be a non-empty string');
  }
  // ASCII control chars (NUL, BEL, BS, …) and lone CR/LF make SendKeys
  // misbehave — NUL is dropped silently, CR/LF can submit forms unexpectedly.
  // The DSL has explicit `{ENTER}` / `{TAB}` for the legitimate uses.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(keys)) {
    throw new Error(
      'sendKeys: input contains ASCII control characters. ' +
        'Use the {ENTER} / {TAB} / etc. DSL forms instead.',
    );
  }
  if (!options.raw && /[\r\n]/.test(keys)) {
    throw new Error(
      'sendKeys: literal CR/LF not allowed in escaped mode. ' +
        'Use {ENTER} for a newline submission.',
    );
  }
  const payload = options.raw ? keys : escapeSendKeys(keys);
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait(${psQuote(payload)})
  `;
  await powerShellOutput(script);
  return { keys };
}

/**
 * Escape literal text so SendKeys treats it as raw characters rather than
 * its mini-DSL. The set of special chars is documented at:
 * https://learn.microsoft.com/dotnet/api/system.windows.forms.sendkeys
 */
export function escapeSendKeys(text: string): string {
  // Explicit `[` escape (the character class would accept the unescaped form
  // but escaping makes intent unambiguous to readers and tooling).
  return text.replace(/[+^%~(){}\[\]]/g, '{$&}');
}

/**
 * Spawn-only variant useful in tests and for fire-and-forget scenarios.
 * Kept as a named export so future scheduling work can reuse the path.
 */
export async function rawPowerShell(script: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return await runPowerShell(script);
}

/* -------------------------------------------------------------------------- */
/*  Test exports                                                              */
/* -------------------------------------------------------------------------- */

export const __testing = { psQuote, escapeSendKeys };
