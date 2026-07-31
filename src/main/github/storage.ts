/**
 * Encrypted persistence of the user's GitHub Personal Access Token.
 *
 * The PAT is stored at `~/.taskpilot/github-pat` with 0600 permissions. When
 * Electron's `safeStorage` is available (macOS Keychain on darwin, DPAPI on
 * win32, libsecret on Linux), the token is encrypted at rest with a magic
 * `safe:` prefix marking the file as ciphertext. Outside Electron (tests, MCP
 * standalone) we fall back to plaintext with a `console.warn` so the user is
 * never silently downgraded without notice.
 *
 * The token is held by the main process ONLY. Nothing in this module ever
 * returns the token to a renderer or logs it — `loadPAT()` is the lone
 * surface that surfaces the raw secret, and only the GitHub operations
 * module (also main-only) calls it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';

/**
 * Magic header that marks a `github-pat` blob as Electron-safeStorage
 * encrypted. Mirrors the convention in `calendar/oauth.ts` so the same
 * decryption shape is used everywhere.
 */
const SAFE_STORAGE_PREFIX = 'safe:';

export const GITHUB_PAT_PATH = path.join(TASKPILOT_HOME, 'github-pat');

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
 * Persist a GitHub PAT to disk.
 *
 * The file is written atomically (tmp + rename) so a crash mid-write can't
 * leave a half-flushed token on disk. When Electron `safeStorage` is
 * available the payload is encrypted; otherwise it's plaintext with a
 * single-line warning to the console.
 */
export async function savePAT(token: string): Promise<void> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('savePAT: token must be a non-empty string');
  }

  await fs.mkdir(path.dirname(GITHUB_PAT_PATH), { recursive: true });

  let payload: string;
  const safeStorage = loadSafeStorage();
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const cipher = safeStorage.encryptString(token);
      payload = `${SAFE_STORAGE_PREFIX}${cipher.toString('base64')}\n`;
    } catch {
      // safeStorage promised availability but the call failed — fall back to
      // plaintext rather than losing the user's input. Log without echoing
      // the token (which is what `console.error` would risk on a bad refactor).
      // eslint-disable-next-line no-console
      console.warn(
        '[github/storage] safeStorage encrypt failed, falling back to plaintext',
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
        '[github/storage] safeStorage unavailable on this platform; ' +
          'github-pat will be written as plaintext.',
      );
    }
    payload = `${token}\n`;
  }

  const tmp = `${GITHUB_PAT_PATH}.tmp`;
  // Owner-only file mode: 0600 — guards against other users on the same box
  // reading the secret.
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, GITHUB_PAT_PATH);
  // On platforms that don't honor the mode argument to open() (looking at you,
  // Windows), chmod here is a no-op but harmless. On POSIX it tightens the
  // permission if the temp file landed with a wider umask.
  try {
    await fs.chmod(GITHUB_PAT_PATH, 0o600);
  } catch {
    /* non-fatal — Windows fs.chmod throws on some configurations */
  }
}

/**
 * Read and decrypt the stored PAT, or `null` if not present.
 *
 * Plaintext files written before Electron safeStorage was available are
 * still readable for backward compatibility — the prefix sniff falls
 * through to a plain string read.
 */
export async function loadPAT(): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(GITHUB_PAT_PATH, 'utf8');
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
        'github-pat is encrypted but Electron safeStorage is unavailable. ' +
          'Reconnect GitHub from Settings → Integrations.',
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
        `Could not decrypt github-pat: ${(err as Error).message}`,
      );
    }
  }

  return trimmed;
}

/**
 * Delete the persisted PAT. Safe to call when no file exists.
 */
export async function deletePAT(): Promise<void> {
  try {
    await fs.unlink(GITHUB_PAT_PATH);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

/**
 * Cheap existence check — does NOT read the file contents.
 */
export async function hasPAT(): Promise<boolean> {
  try {
    const stat = await fs.stat(GITHUB_PAT_PATH);
    return stat.isFile() && stat.size > 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}
