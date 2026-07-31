/**
 * Encrypted persistence of the user's Notion internal-integration token.
 *
 * The token is stored at `~/.taskpilot/notion-token` with 0600 perms.
 * When Electron's `safeStorage` is available (Keychain on darwin, DPAPI
 * on win32, libsecret on Linux) the payload is encrypted with a magic
 * `safe:` prefix. Outside Electron (tests, MCP standalone) it falls
 * back to plaintext with a single `console.warn`.
 *
 * The token is held by the main process ONLY. Nothing here returns the
 * token to a renderer or logs it — `loadToken()` is the lone surface
 * that surfaces the raw secret, and only the Notion client module
 * (also main-only) calls it.
 *
 * Mirrors `src/main/github/storage.ts` and `src/main/slack/storage.ts`
 * so the three integrations feel cohesive.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';

const SAFE_STORAGE_PREFIX = 'safe:';

export const NOTION_TOKEN_PATH = path.join(TASKPILOT_HOME, 'notion-token');

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

export async function saveToken(token: string): Promise<void> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('saveToken: token must be a non-empty string');
  }

  await fs.mkdir(path.dirname(NOTION_TOKEN_PATH), { recursive: true });

  let payload: string;
  const safeStorage = loadSafeStorage();
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const cipher = safeStorage.encryptString(token);
      payload = `${SAFE_STORAGE_PREFIX}${cipher.toString('base64')}\n`;
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        '[notion/storage] safeStorage encrypt failed, falling back to plaintext',
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
        '[notion/storage] safeStorage unavailable on this platform; ' +
          'notion-token will be written as plaintext.',
      );
    }
    payload = `${token}\n`;
  }

  const tmp = `${NOTION_TOKEN_PATH}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, NOTION_TOKEN_PATH);
  try {
    await fs.chmod(NOTION_TOKEN_PATH, 0o600);
  } catch {
    /* non-fatal — Windows chmod is best-effort */
  }
}

export async function loadToken(): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(NOTION_TOKEN_PATH, 'utf8');
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
      throw new Error(
        'notion-token is encrypted but Electron safeStorage is unavailable. ' +
          'Reconnect Notion from Settings → Integrations.',
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
        `Could not decrypt notion-token: ${(err as Error).message}`,
      );
    }
  }

  return trimmed;
}

export async function deleteToken(): Promise<void> {
  try {
    await fs.unlink(NOTION_TOKEN_PATH);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

export async function hasToken(): Promise<boolean> {
  try {
    const stat = await fs.stat(NOTION_TOKEN_PATH);
    return stat.isFile() && stat.size > 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}
