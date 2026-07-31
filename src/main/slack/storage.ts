/**
 * Encrypted persistence of the user's Slack bot token.
 *
 * The token is stored at `~/.taskpilot/slack-token` with 0600 permissions.
 * When Electron's `safeStorage` is available (macOS Keychain on darwin,
 * DPAPI on win32, libsecret on Linux), the token is encrypted at rest with
 * a magic `safe:` prefix marking the file as ciphertext. Outside Electron
 * (tests, MCP standalone) we fall back to plaintext with a `console.warn`
 * so the user is never silently downgraded without notice.
 *
 * The token is held by the main process ONLY. Nothing in this module ever
 * returns the token to a renderer or logs it — `loadToken()` is the lone
 * surface that surfaces the raw secret, and only the Slack operations
 * module (also main-only) calls it.
 *
 * Mirrors `src/main/github/storage.ts` so the two integrations feel
 * cohesive.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';

/**
 * Magic header that marks a `slack-token` blob as Electron-safeStorage
 * encrypted. Mirrors the convention in `github/storage.ts`.
 */
const SAFE_STORAGE_PREFIX = 'safe:';

export const SLACK_TOKEN_PATH = path.join(TASKPILOT_HOME, 'slack-token');

/* -------------------------------------------------------------------------- */
/*  Electron safeStorage (lazy)                                                */
/* -------------------------------------------------------------------------- */

interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (s: string) => Buffer;
  decryptString: (b: Buffer) => string;
}

function loadSafeStorage(): SafeStorageLike | null {
  if (
    typeof process === 'undefined' ||
    !process.versions ||
    !process.versions.electron
  ) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    return electron.safeStorage ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Persist a Slack bot token to disk.
 *
 * The file is written atomically (tmp + rename) so a crash mid-write can't
 * leave a half-flushed token on disk. When Electron `safeStorage` is
 * available the payload is encrypted; otherwise it's plaintext with a
 * single-line warning to the console.
 */
export async function saveToken(token: string): Promise<void> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('saveToken: token must be a non-empty string');
  }

  await fs.mkdir(path.dirname(SLACK_TOKEN_PATH), { recursive: true });

  let payload: string;
  const safeStorage = loadSafeStorage();
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const cipher = safeStorage.encryptString(token);
      payload = `${SAFE_STORAGE_PREFIX}${cipher.toString('base64')}\n`;
    } catch {
      // safeStorage promised availability but the call failed — fall back to
      // plaintext rather than losing the user's input. Log without echoing
      // the token.
      // eslint-disable-next-line no-console
      console.warn(
        '[slack/storage] safeStorage encrypt failed, falling back to plaintext',
      );
      payload = `${token}\n`;
    }
  } else {
    if (
      typeof process !== 'undefined' &&
      process.versions &&
      process.versions.electron
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        '[slack/storage] safeStorage unavailable on this platform; ' +
          'slack-token will be written as plaintext.',
      );
    }
    payload = `${token}\n`;
  }

  const tmp = `${SLACK_TOKEN_PATH}.tmp`;
  // Owner-only file mode: 0600 — guards against other users on the same box
  // reading the secret.
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, SLACK_TOKEN_PATH);
  // On platforms that don't honor the mode argument to open() (Windows),
  // chmod here is a no-op but harmless.
  try {
    await fs.chmod(SLACK_TOKEN_PATH, 0o600);
  } catch {
    /* non-fatal — Windows fs.chmod throws on some configurations */
  }
}

/**
 * Read and decrypt the stored bot token, or `null` if not present.
 *
 * Plaintext files written before Electron safeStorage was available are
 * still readable for backward compatibility — the prefix sniff falls
 * through to a plain string read.
 */
export async function loadToken(): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(SLACK_TOKEN_PATH, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  const trimmed = raw.replace(/\r?\n+$/, '');
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith(SAFE_STORAGE_PREFIX)) {
    const safeStorage = loadSafeStorage();
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      // Encrypted file but no safeStorage to decrypt it — surface a clear
      // error so the user knows to reconnect rather than silently 401ing.
      throw new Error(
        'slack-token is encrypted but Electron safeStorage is unavailable. ' +
          'Reconnect Slack from Settings → Integrations.',
      );
    }
    try {
      const ciphertext = Buffer.from(
        trimmed.slice(SAFE_STORAGE_PREFIX.length),
        'base64',
      );
      return safeStorage.decryptString(ciphertext);
    } catch (err: unknown) {
      throw new Error(
        `Could not decrypt slack-token: ${(err as Error).message}`,
      );
    }
  }

  return trimmed;
}

/**
 * Delete the persisted token. Safe to call when no file exists.
 */
export async function deleteToken(): Promise<void> {
  try {
    await fs.unlink(SLACK_TOKEN_PATH);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

/**
 * Cheap existence check — does NOT read the file contents.
 */
export async function hasToken(): Promise<boolean> {
  try {
    const stat = await fs.stat(SLACK_TOKEN_PATH);
    return stat.isFile() && stat.size > 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}
