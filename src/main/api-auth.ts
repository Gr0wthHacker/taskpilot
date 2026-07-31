/**
 * Per-install API authentication token lifecycle.
 *
 * Wave 10 / S8 finding: every endpoint on the local API (except a small
 * allowlist) requires a bearer token. The token is generated at first boot,
 * persisted to `~/.taskpilot/api-token` with 0o600 perms, and read by the
 * renderer, CLI, MCP server, and Claude Code slash commands.
 *
 * The token is 32 random bytes encoded as 64 hex chars. Format is opaque to
 * the rest of the codebase — callers should never parse it.
 *
 * The token MUST never appear in any log line. Any code that logs auth
 * errors should mask the value as `[REDACTED]`.
 *
 * Manual rotation procedure: delete `~/.taskpilot/api-token` and restart the
 * desktop app. The next boot generates a fresh token. See
 * `~/.claude/skills/taskpilot/references/AUTH.md`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';

const TOKEN_BYTES = 32;
const TOKEN_FILENAME = 'api-token';
const TOKEN_MODE = 0o600;

/**
 * Resolve the on-disk path for the token. Uses `TASKPILOT_HOME` so test
 * suites that mock `@/shared/constants` (see `mockTaskpilotPaths`) write
 * the token under their isolated tmpdir.
 */
function tokenPath(): string {
  return path.join(TASKPILOT_HOME, TOKEN_FILENAME);
}

/**
 * Generate a fresh token. 32 random bytes → 64-char lowercase hex.
 */
function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Ensure the directory that holds the token exists. Safe to call repeatedly.
 */
async function ensureHomeDir(): Promise<void> {
  await fsp.mkdir(TASKPILOT_HOME, { recursive: true });
}

/**
 * Write a token to disk with 0o600 perms. On Windows the mode bit is
 * advisory — Node sets it but NTFS ACLs aren't fully equivalent. The file
 * still lives under the per-user home directory which is the real boundary.
 */
async function writeTokenFile(token: string): Promise<void> {
  await ensureHomeDir();
  const p = tokenPath();
  // Write via a unique tmp + rename so a crashed write never leaves a
  // half-truncated file that would force every API caller to fail closed.
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, token, { encoding: 'utf8', mode: TOKEN_MODE });
  await fsp.rename(tmp, p);
  // Best-effort chmod in case the open() flag didn't take (some FS shims).
  try {
    await fsp.chmod(p, TOKEN_MODE);
  } catch {
    /* Windows / non-POSIX FS — ignore. */
  }
}

/**
 * Read the token from disk. Returns `null` if the file is missing or
 * unreadable. Caller decides whether to fall back, generate, or surface a
 * friendly error.
 */
export async function readApiToken(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(tokenPath(), 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Synchronous companion to {@link readApiToken}. Useful in module-init
 * paths where awaiting would require lifting half the module into a
 * lazy-loader. Returns `null` on any error.
 */
export function readApiTokenSync(): string | null {
  try {
    const raw = fs.readFileSync(tokenPath(), 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Read the existing token from disk; if absent, generate one and persist it.
 * Idempotent: repeated calls return the same value as long as the file
 * survives between calls.
 *
 * This is the canonical entry point at server boot.
 */
export async function getOrCreateApiToken(): Promise<string> {
  const existing = await readApiToken();
  if (existing && existing.length > 0) return existing;
  const fresh = generateToken();
  await writeTokenFile(fresh);
  return fresh;
}

/**
 * Replace the on-disk token with a freshly generated one. Returns the new
 * value. Never exposed via HTTP — rotation is a manual filesystem operation
 * documented in AUTH.md.
 */
export async function rotateApiToken(): Promise<string> {
  const fresh = generateToken();
  await writeTokenFile(fresh);
  return fresh;
}

/**
 * Used by log lines that might otherwise echo the token. Always returns the
 * literal string `[REDACTED]`. Exposed so call sites can route every token
 * sighting through one named helper for grep-ability.
 */
export function redactToken(_token: string | null | undefined): string {
  return '[REDACTED]';
}
