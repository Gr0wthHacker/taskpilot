/**
 * Google OAuth2 client setup for TaskPilot.
 *
 * SETUP:
 * -----------------------------------------------------------------------------
 *  1. Go to https://console.cloud.google.com/apis/credentials
 *  2. Create an OAuth 2.0 Client ID. Choose "Desktop app" (preferred) or
 *     "Web application" with `http://localhost:7847/oauth/callback` listed
 *     as an authorized redirect URI.
 *  3. Download the resulting JSON file.
 *  4. Save it to `~/.taskpilot/credentials.json`.
 *     - Both Google Cloud Console export shapes are accepted:
 *           { "installed": { "client_id": "...", "client_secret": "...",
 *                            "redirect_uris": ["..."] } }
 *           { "web":       { "client_id": "...", "client_secret": "...",
 *                            "redirect_uris": ["..."] } }
 *  5. Required scopes (consented automatically during the first OAuth flow):
 *           https://www.googleapis.com/auth/calendar.events
 *           https://www.googleapis.com/auth/calendar.readonly
 *  6. Run `taskpilot cal sync` (or open the Settings view in the app) and
 *     follow the browser link. After granting consent the resulting tokens
 *     are written to `~/.taskpilot/tokens.json`.
 *
 *  SECURITY NOTE: Tokens are stored as plaintext JSON for v1. The file lives
 *  inside the user's home directory under default OS permissions. If the
 *  machine is shared, treat `~/.taskpilot/tokens.json` as a secret. A future
 *  release will encrypt with the OS keychain.
 * -----------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

import { API_PORT, CREDS_PATH, TASKPILOT_HOME } from '@/shared/constants';

import { CalendarAuthError, CalendarNotConfiguredError } from './errors';

/* -------------------------------------------------------------------------- */
/*  Electron safeStorage (lazy)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lazy-load Electron's `safeStorage` so this module remains usable from
 * tests / CLI contexts that don't have Electron in scope. When unavailable
 * (non-Electron host, or Linux without libsecret), token persistence falls
 * back to plaintext with a console warning.
 */
interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (s: string) => Buffer;
  decryptString: (b: Buffer) => string;
}

function loadSafeStorage(): SafeStorageLike | null {
  // Only attempt the import inside Electron's main process. `process.versions.electron`
  // is set only there.
  if (typeof process === 'undefined' || !process.versions || !process.versions.electron) {
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
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

export const TOKENS_PATH = path.join(TASKPILOT_HOME, 'tokens.json');

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

/**
 * The path the local API server exposes the OAuth callback on. The full
 * redirect URI is `http://localhost:<API_PORT>/oauth/callback` and MUST be
 * registered as an authorized redirect URI in Google Cloud Console.
 */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/**
 * Canonical redirect URI derived from the shared `API_PORT`. Always exported
 * so consumers (route mounter, SETUP docs scripts, tests) can reference the
 * single source of truth.
 */
export const REDIRECT_URI = `http://localhost:${API_PORT}${OAUTH_CALLBACK_PATH}`;

const DEFAULT_REDIRECT_URI = REDIRECT_URI;

/* -------------------------------------------------------------------------- */
/*  Types for credentials.json (both shapes)                                  */
/* -------------------------------------------------------------------------- */

interface ClientSecretBlock {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

interface CredentialsFile {
  web?: ClientSecretBlock;
  installed?: ClientSecretBlock;
}

interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
  id_token?: string;
}

/* -------------------------------------------------------------------------- */
/*  Internal state                                                            */
/* -------------------------------------------------------------------------- */

let cachedClient: OAuth2Client | null = null;
let cachedSecrets: ClientSecretBlock | null = null;

/* -------------------------------------------------------------------------- */
/*  OAuth `state` (CSRF) tokens                                                */
/* -------------------------------------------------------------------------- */

/**
 * In-memory map of `state` tokens generated by `startAuthFlow()` to the wall
 * time they were issued at. `completeAuthFlow()` requires the caller to echo
 * the token back. Entries older than `STATE_TTL_MS` are rejected so an
 * abandoned flow can't be replayed indefinitely.
 *
 * Map (not Set) so we can prune by age. The state values themselves are
 * cryptographically random 32-byte hex strings — opaque to the user.
 */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1_000;

function pruneStates(now: number): void {
  for (const [state, issuedAt] of pendingStates) {
    if (now - issuedAt > STATE_TTL_MS) pendingStates.delete(state);
  }
}

function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

function takeState(state: string): boolean {
  const now = Date.now();
  pruneStates(now);
  const issuedAt = pendingStates.get(state);
  if (issuedAt === undefined) return false;
  pendingStates.delete(state);
  if (now - issuedAt > STATE_TTL_MS) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Credentials loading                                                       */
/* -------------------------------------------------------------------------- */

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

async function loadClientSecrets(): Promise<ClientSecretBlock> {
  if (cachedSecrets) return cachedSecrets;

  const parsed = await readJsonFile<CredentialsFile>(CREDS_PATH);
  if (!parsed) {
    throw new CalendarNotConfiguredError(
      `credentials.json not found at ${CREDS_PATH}. See ~/.taskpilot/calendar/oauth.ts SETUP comment.`,
    );
  }

  const block = parsed.installed ?? parsed.web;
  if (!block || !block.client_id || !block.client_secret) {
    throw new CalendarNotConfiguredError(
      `credentials.json at ${CREDS_PATH} is missing client_id/client_secret in "installed" or "web" block.`,
    );
  }

  cachedSecrets = block;
  return block;
}

/**
 * Always use TaskPilot's canonical loopback URI. We deliberately ignore any
 * `redirect_uris` array baked into credentials.json: the user may have
 * registered multiple URIs in Google Cloud Console (e.g. a stale `:8080` or
 * the OOB `urn:ietf:wg:oauth:2.0:oob` flow), but only one of them is paired
 * with our local callback route. Forcing the value here means the URI sent
 * to Google in the auth URL is guaranteed to match the one we exchange the
 * code against — Google rejects the exchange otherwise with `redirect_uri_mismatch`.
 *
 * The user MUST add `REDIRECT_URI` to their OAuth client's authorized
 * redirect list (see SETUP.md). `secrets` is accepted for parity with future
 * logic that may want to peek at it.
 */
function pickRedirectUri(_secrets: ClientSecretBlock): string {
  return DEFAULT_REDIRECT_URI;
}

/* -------------------------------------------------------------------------- */
/*  Token persistence                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Magic header that marks a tokens.json blob as Electron-safeStorage encrypted.
 * The file is base64-encoded ciphertext bytes prefixed with this string. On
 * load we sniff for the prefix and decrypt; older plaintext JSON files are
 * still readable for backward compat.
 */
const SAFE_STORAGE_PREFIX = 'safe:';

async function loadTokens(): Promise<StoredTokens | null> {
  let raw: string;
  try {
    raw = await fs.readFile(TOKENS_PATH, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  // Encrypted path: strip the prefix, base64-decode, and call safeStorage.
  if (raw.startsWith(SAFE_STORAGE_PREFIX)) {
    const safeStorage = loadSafeStorage();
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new CalendarAuthError(
        'tokens.json is encrypted but safeStorage is unavailable. ' +
          'Re-run the OAuth flow to re-write tokens in plaintext.',
      );
    }
    try {
      const ciphertext = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64');
      const plaintext = safeStorage.decryptString(ciphertext);
      return JSON.parse(plaintext) as StoredTokens;
    } catch (err: unknown) {
      throw new CalendarAuthError(
        `Could not decrypt tokens.json: ${(err as Error).message}`,
      );
    }
  }

  // Plaintext fallback (legacy files, or non-Electron hosts).
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

/**
 * Atomic write: temp file + rename. Prevents partial writes from corrupting
 * the on-disk token store if the process dies mid-write.
 *
 * If Electron's `safeStorage` is available we encrypt the JSON blob before
 * writing — on macOS the cipher is keychain-backed, on Windows it's DPAPI,
 * and on Linux it falls back to libsecret when present. Non-Electron hosts
 * (tests, MCP standalone) fall back to plaintext with a warning.
 */
async function saveTokens(tokens: StoredTokens): Promise<void> {
  await fs.mkdir(path.dirname(TOKENS_PATH), { recursive: true });

  let payload: string;
  const safeStorage = loadSafeStorage();
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const cipher = safeStorage.encryptString(JSON.stringify(tokens));
      payload = `${SAFE_STORAGE_PREFIX}${cipher.toString('base64')}\n`;
    } catch (err: unknown) {
      console.error(
        '[calendar/oauth] safeStorage encrypt failed, falling back to plaintext:',
        (err as Error).message,
      );
      payload = `${JSON.stringify(tokens, null, 2)}\n`;
    }
  } else {
    if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
      console.warn(
        '[calendar/oauth] safeStorage unavailable on this platform; ' +
          'tokens.json will be written as plaintext.',
      );
    }
    payload = `${JSON.stringify(tokens, null, 2)}\n`;
  }

  const tmp = `${TOKENS_PATH}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, TOKENS_PATH);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Synchronous best-effort check: are credentials.json AND tokens.json present?
 *
 * This is a quick "should the calendar feature be enabled?" gate used by the
 * HTTP layer to short-circuit endpoints with 503 when the user hasn't set up
 * OAuth yet. It does NOT verify that the tokens are valid; the underlying
 * Google API call will surface that.
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const creds = await readJsonFile<CredentialsFile>(CREDS_PATH);
    if (!creds) return false;
    const tokens = await loadTokens();
    if (!tokens) return false;
    if (!tokens.refresh_token && !tokens.access_token) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a fully configured OAuth2 client.
 *
 * - Throws `CalendarNotConfiguredError` if credentials.json is missing.
 * - Throws `CalendarAuthError` if no tokens are stored (user hasn't completed
 *   the OAuth flow).
 * - Auto-refreshes expired access tokens (handled by the googleapis library
 *   when a refresh_token is present; we persist any refreshed tokens via
 *   the `tokens` event listener).
 */
export async function getOauthClient(): Promise<OAuth2Client> {
  if (cachedClient) return cachedClient;

  const secrets = await loadClientSecrets();
  const redirectUri = pickRedirectUri(secrets);

  const client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    redirectUri,
  );

  const stored = await loadTokens();
  if (!stored || (!stored.refresh_token && !stored.access_token)) {
    throw new CalendarAuthError(
      'No stored OAuth tokens. Run startAuthFlow() and completeAuthFlow(code) to authenticate.',
    );
  }

  client.setCredentials(stored);

  // Persist refreshed tokens so future runs don't need to refresh again.
  client.on('tokens', (next) => {
    void (async () => {
      try {
        const merged: StoredTokens = { ...stored, ...next } as StoredTokens;
        await saveTokens(merged);
      } catch (err: unknown) {
        // Best effort — log but don't crash the calling request.
        console.error('[calendar/oauth] failed to persist refreshed tokens:', (err as Error).message);
      }
    })();
  });

  cachedClient = client;
  return client;
}

/**
 * Build an unauthenticated OAuth2 client and return the consent URL the user
 * should visit. The renderer is expected to open this URL in the system browser
 * via `shell.openExternal`.
 *
 * Returns the URL plus the redirect URI that was used so the renderer can
 * surface the callback target to the user (and so SETUP docs can reference a
 * single source of truth). The local API server registers the matching
 * `GET /oauth/callback` route at boot — if it is not reachable, the user can
 * always fall back to copy-pasting the code into the manual input.
 */
export async function startAuthFlow(): Promise<{
  url: string;
  redirectUri: string;
  state: string;
}> {
  const secrets = await loadClientSecrets();
  const redirectUri = pickRedirectUri(secrets);

  const client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    redirectUri,
  );

  // CSRF protection: Google echoes `state` back to the redirect URI; the
  // callback (and the manual-paste fallback) MUST present it to
  // completeAuthFlow() or the exchange is refused.
  const state = generateState();
  pendingStates.set(state, Date.now());
  pruneStates(Date.now());

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...SCOPES],
    state,
  });

  return { url, redirectUri, state };
}

/**
 * Exchange an authorization code for tokens and persist them.
 *
 * After this resolves, subsequent calls to `getOauthClient()` will return
 * an authenticated client.
 *
 * EDGE CASE: if the same code is submitted twice (e.g. the local callback
 * fires AND the user manually pastes the code), Google returns
 * `invalid_grant`. We swallow that error and treat it as success when valid
 * tokens are already persisted — the first exchange already succeeded.
 */
export async function completeAuthFlow(
  code: string,
  state?: string,
): Promise<void> {
  if (!code || typeof code !== 'string') {
    throw new CalendarAuthError('completeAuthFlow: code is required.');
  }

  // Enforce CSRF protection. If a state token is present (the normal path)
  // it must match one we issued in startAuthFlow(). Missing-state is allowed
  // only when no states are pending — back-compat for callers that never
  // started a flow through us (e.g. importing a code from another tool).
  if (state !== undefined) {
    if (!takeState(state)) {
      throw new CalendarAuthError(
        'OAuth state mismatch — the flow may have expired or been tampered with. ' +
          'Start the connect flow again from Settings.',
      );
    }
  } else if (pendingStates.size > 0) {
    throw new CalendarAuthError(
      'Missing OAuth state. Use the Connect button in Settings to start a fresh flow.',
    );
  }

  const secrets = await loadClientSecrets();
  const redirectUri = pickRedirectUri(secrets);

  const client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    redirectUri,
  );

  let tokens: StoredTokens;
  try {
    const response = await client.getToken(code);
    tokens = response.tokens as StoredTokens;
  } catch (err: unknown) {
    const message = (err as Error).message ?? '';
    // If we're already authenticated, the most likely cause is that the
    // local callback already exchanged this code. Treat as success rather
    // than failing the second submitter.
    if (await isAuthenticated()) {
      return;
    }
    throw new CalendarAuthError(
      `Failed to exchange code for tokens: ${message}`,
    );
  }

  await saveTokens(tokens);

  // Reset cache so the next getOauthClient() reads the fresh tokens.
  cachedClient = null;
}

/**
 * Clear the in-memory cache and delete the persisted tokens file. Useful for
 * "sign out" UI and tests.
 */
export async function signOut(): Promise<void> {
  cachedClient = null;
  cachedSecrets = null;
  try {
    await fs.unlink(TOKENS_PATH);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

/**
 * Test-only: reset cached state. Not part of the public API but useful in
 * sibling modules that mock fs.
 */
export const __internals = {
  reset(): void {
    cachedClient = null;
    cachedSecrets = null;
    pendingStates.clear();
  },
  /**
   * Test-only: insert a synthetic pending state so tests can exercise the
   * `completeAuthFlow(code, state)` happy path without running the full
   * `startAuthFlow()` (which would hit the credentials file).
   */
  pushState(state: string): void {
    pendingStates.set(state, Date.now());
  },
};
