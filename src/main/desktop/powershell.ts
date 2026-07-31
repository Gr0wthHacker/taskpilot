/**
 * Run a PowerShell script and capture stdout.
 *
 * We shell out instead of pulling in a native input library (nut.js / robotjs)
 * because TaskPilot already manages a dual-ABI better-sqlite3 build and adding
 * another native dep would double the maintenance burden. PowerShell ships
 * with every supported Windows install, so this works out of the box.
 *
 * The script is passed via stdin (not -Command) so quoting + multi-line
 * payloads survive intact. ExecutionPolicy is forced to `Bypass` for the
 * single invocation so users with restrictive defaults don't have to relax
 * their machine-wide policy.
 */

import { spawn } from 'node:child_process';

export interface PsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PsOptions {
  /** Milliseconds. Default 15_000. */
  timeoutMs?: number;
}

/**
 * Throws on non-Windows platforms — desktop input is Windows-only for v1.
 */
export function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error(
      `Desktop input is only supported on Windows in v1 (current: ${process.platform}). ` +
        'macOS/Linux support requires a native input library; see roadmap.',
    );
  }
}

export async function runPowerShell(
  script: string,
  options: PsOptions = {},
): Promise<PsResult> {
  assertWindows();
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 15_000);

  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '-',
  ];

  return new Promise<PsResult>((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Node's child.kill('SIGTERM') on Windows is TerminateProcess on the
      // immediate child only, which routinely leaves powershell.exe alive
      // (it's actually a console host wrapper). taskkill /T walks the tree.
      killProcessTree(child);
      reject(new Error(`runPowerShell: script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : -1,
      });
    });

    // EPIPE if PS dies before we finish writing — convert to a reject rather
    // than an unhandled `error` event on the writer.
    child.stdin.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // Wrap the script with $ErrorActionPreference=Stop AND a try/catch so
    // non-terminating errors (P/Invoke failures, SendKeys exceptions that
    // exit 0 with only stderr) surface as a non-zero exit + populated stderr.
    const wrapped =
      `$ErrorActionPreference = 'Stop'\n` +
      `try {\n${script}\n} catch {\n  Write-Error $_\n  exit 1\n}\n`;
    child.stdin.write(wrapped);
    child.stdin.end();
  });
}

/**
 * Best-effort terminate of a spawned process and its descendants. On Windows
 * this is `taskkill /T /F` (walk tree, force); elsewhere it's SIGKILL.
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* best-effort */
  }
}

/**
 * Throw a typed error when the script failed, otherwise return stdout. Used
 * everywhere we don't care about stderr separately.
 */
export async function powerShellOutput(
  script: string,
  options: PsOptions = {},
): Promise<string> {
  const result = await runPowerShell(script, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `PowerShell script exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}
