/**
 * Gmail OAuth2 lifecycle.
 *
 * Gmail piggybacks on the same Google OAuth2 client that the calendar
 * subsystem uses (same `credentials.json`, same redirect URI, same tokens
 * file). Conceptually there is a single Google connection per TaskPilot
 * install; users opt into Gmail by re-running consent with a wider scope
 * set.
 *
 * Lifecycle nuance:
 *  - `startAuthFlow()` (this module) builds an auth URL that asks for the
 *    UNION of Calendar + Gmail scopes. Re-running it from Settings → Gmail
 *    after the user already connected Calendar simply re-grants with the
 *    wider scope set; Google's consent screen tells the user what's being
 *    added.
 *  - The exchange (callback) is shared with calendar — `completeAuthFlow`
 *    in `@/main/calendar/oauth` writes the merged token (including the
 *    granted scopes) to `~/.taskpilot/tokens.json`.
 *  - `isAuthenticated()` here means "tokens exist AND the granted scopes
 *    include at least gmail.readonly". The granted scopes are echoed in
 *    `tokens.scope`.
 *
 * The `send` capability is gated by both the OAuth scope grant AND a user
 * setting (`gmail_send_enabled`). The default is OFF — Claude can draft
 * but the user must explicitly toggle send on before any
 * `POST /api/gmail/messages/send` call succeeds.
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

import * as settingsRepo from '@/main/db/repositories/settings';

import {
  REDIRECT_URI,
  SCOPES as CALENDAR_SCOPES,
  TOKENS_PATH,
} from '@/main/calendar/oauth';
import { CREDS_PATH } from '@/shared/constants';

/* -------------------------------------------------------------------------- */
/*  Scopes                                                                    */
/* -------------------------------------------------------------------------- */

/** Always-on Gmail scopes — read messages, draft replies, manage labels. */
export const GMAIL_BASE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
] as const;

/** Additional scope that lets Claude actually send drafts on the user's behalf. */
export const GMAIL_SEND_SCOPE =
  'https://www.googleapis.com/auth/gmail.send' as const;

/**
 * Compute the full scope set to request at consent time. We always include
 * the Calendar scopes so re-consenting from the Gmail card doesn't strip
 * Calendar access; we toggle in the send scope based on the persisted
 * setting. The user can flip `gmail_send_enabled` later and reconnect.
 */
export function buildScopeSet(opts: { includeSend: boolean }): string[] {
  const out = new Set<string>([...CALENDAR_SCOPES, ...GMAIL_BASE_SCOPES]);
  if (opts.includeSend) out.add(GMAIL_SEND_SCOPE);
  return [...out];
}

/* -------------------------------------------------------------------------- */
/*  Error taxonomy                                                            */
/* -------------------------------------------------------------------------- */

export class GmailNotConfiguredError extends Error {
  readonly code = 'GMAIL_NOT_CONFIGURED';
  constructor(
    message = 'Gmail is not connected. Open Settings → Integrations to connect.',
  ) {
    super(message);
    this.name = 'GmailNotConfiguredError';
  }
}

export class GmailAuthError extends Error {
  readonly code = 'GMAIL_AUTH';
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'GmailAuthError';
    this.status = status;
  }
}

export class GmailApiError extends Error {
  readonly code = 'GMAIL_API_ERROR';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GmailApiError';
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/*  Token persistence (shared with calendar)                                  */
/* -------------------------------------------------------------------------- */

interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
  id_token?: string;
}

interface ClientSecretBlock {
  client_id: string;
  client_secret: string;
}

interface CredentialsFile {
  web?: ClientSecretBlock;
  installed?: ClientSecretBlock;
}

const SAFE_STORAGE_PREFIX = 'safe:';

interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (s: string) => Buffer;
  decryptString: (b: Buffer) => string;
}

function loadSafeStorage(): SafeStorageLike | null {
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

async function readClientSecrets(): Promise<ClientSecretBlock | null> {
  try {
    const raw = await fs.readFile(CREDS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as CredentialsFile;
    const block = parsed.installed ?? parsed.web ?? null;
    if (!block || !block.client_id || !block.client_secret) return null;
    return block;
  } catch {
    return null;
  }
}

async function readTokens(): Promise<StoredTokens | null> {
  let raw: string;
  try {
    raw = await fs.readFile(TOKENS_PATH, 'utf8');
  } catch {
    return null;
  }
  if (raw.startsWith(SAFE_STORAGE_PREFIX)) {
    const safeStorage = loadSafeStorage();
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    try {
      const ciphertext = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64');
      return JSON.parse(safeStorage.decryptString(ciphertext)) as StoredTokens;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function writeTokens(tokens: StoredTokens): Promise<void> {
  let payload: string;
  const safeStorage = loadSafeStorage();
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const cipher = safeStorage.encryptString(JSON.stringify(tokens));
      payload = `${SAFE_STORAGE_PREFIX}${cipher.toString('base64')}\n`;
    } catch {
      payload = `${JSON.stringify(tokens, null, 2)}\n`;
    }
  } else {
    payload = `${JSON.stringify(tokens, null, 2)}\n`;
  }
  await fs.writeFile(TOKENS_PATH, payload, 'utf8');
}

/* -------------------------------------------------------------------------- */
/*  State (CSRF tokens for our own startAuthFlow)                             */
/* -------------------------------------------------------------------------- */

const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1_000;

function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

function pruneStates(now: number): void {
  for (const [state, issuedAt] of pendingStates) {
    if (now - issuedAt > STATE_TTL_MS) pendingStates.delete(state);
  }
}

export function takeGmailState(state: string): boolean {
  const now = Date.now();
  pruneStates(now);
  const issuedAt = pendingStates.get(state);
  if (issuedAt === undefined) return false;
  pendingStates.delete(state);
  return now - issuedAt <= STATE_TTL_MS;
}

/* -------------------------------------------------------------------------- */
/*  Scope helpers                                                             */
/* -------------------------------------------------------------------------- */

function parseGrantedScopes(scope: string | undefined): Set<string> {
  if (!scope) return new Set();
  return new Set(scope.split(/\s+/).filter(Boolean));
}

export function isSendEnabledInSettings(): boolean {
  try {
    const raw = settingsRepo.get<unknown>('gmail_send_enabled');
    return raw === true;
  } catch {
    return false;
  }
}

export function setSendEnabledInSettings(enabled: boolean): void {
  settingsRepo.set('gmail_send_enabled', enabled);
}

/* -------------------------------------------------------------------------- */
/*  Public lifecycle                                                          */
/* -------------------------------------------------------------------------- */

export interface GmailStatus {
  connected: boolean;
  email?: string;
  scopes_granted: string[];
  send_enabled: boolean;
}

/**
 * `connected` here means "tokens exist on disk AND the granted scopes
 * include at least one Gmail scope". Just having Calendar tokens isn't
 * enough — the user must have explicitly re-consented with Gmail scopes.
 */
export async function getStatus(): Promise<GmailStatus> {
  const tokens = await readTokens();
  const granted = parseGrantedScopes(tokens?.scope);
  const hasAnyGmailScope = GMAIL_BASE_SCOPES.some((s) => granted.has(s));
  const sendEnabledSetting = isSendEnabledInSettings();
  const sendScopeGranted = granted.has(GMAIL_SEND_SCOPE);

  if (!tokens || !hasAnyGmailScope) {
    return {
      connected: false,
      scopes_granted: [],
      send_enabled: false,
    };
  }

  const status: GmailStatus = {
    connected: true,
    scopes_granted: [...granted].filter((s) => s.includes('gmail')),
    // send_enabled requires BOTH the OAuth scope AND the user opt-in setting.
    send_enabled: sendScopeGranted && sendEnabledSetting,
  };

  // Best-effort: surface the connected email by hitting the profile endpoint.
  try {
    const client = await getAuthedClientUnchecked();
    if (client) {
      const gmail = google.gmail({ version: 'v1', auth: client });
      const res = await gmail.users.getProfile({ userId: 'me' });
      if (res.data.emailAddress) status.email = res.data.emailAddress;
    }
  } catch {
    // Profile lookup is informational only — don't fail status on it.
  }

  return status;
}

/**
 * Build the consent URL. Always requests the union of Calendar + Gmail
 * scopes so existing Calendar grants survive. Send scope is added when
 * `includeSend` is true (driven by the `gmail_send_enabled` user setting).
 */
export async function startAuthFlow(opts: {
  includeSend?: boolean;
} = {}): Promise<{ url: string; redirectUri: string; state: string }> {
  const secrets = await readClientSecrets();
  if (!secrets) {
    throw new GmailNotConfiguredError(
      `credentials.json not found at ${CREDS_PATH}. Place a Google OAuth client there first.`,
    );
  }
  const includeSend = opts.includeSend ?? isSendEnabledInSettings();

  const client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    REDIRECT_URI,
  );

  const state = generateState();
  pendingStates.set(state, Date.now());
  pruneStates(Date.now());

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: buildScopeSet({ includeSend }),
    state,
  });

  return { url, redirectUri: REDIRECT_URI, state };
}

/**
 * Disconnect Gmail by clearing Gmail-only scopes from the stored token
 * record. If the user has no Calendar scopes either, the tokens file is
 * deleted entirely.
 *
 * We do NOT call Google's revoke endpoint here because doing so would
 * also revoke Calendar — the two share a single refresh_token. Callers
 * who want a full disconnect should call `signOut()` from
 * `@/main/calendar/oauth` instead.
 */
export async function disconnect(): Promise<void> {
  // Always clear the send-enabled setting on disconnect.
  setSendEnabledInSettings(false);

  const tokens = await readTokens();
  if (!tokens) return;
  const granted = parseGrantedScopes(tokens.scope);
  const calendarScopesGranted = CALENDAR_SCOPES.some((s) => granted.has(s));
  // Strip gmail scopes from the stored scope string.
  for (const s of [...GMAIL_BASE_SCOPES, GMAIL_SEND_SCOPE]) granted.delete(s);

  if (!calendarScopesGranted) {
    // Nothing left — wipe the file.
    try {
      await fs.unlink(TOKENS_PATH);
    } catch {
      /* ignore */
    }
    return;
  }
  const nextTokens: StoredTokens = { ...tokens, scope: [...granted].join(' ') };
  await writeTokens(nextTokens);
}

/**
 * Get a fully-authed OAuth2 client suitable for `google.gmail({auth})`.
 * Throws `GmailNotConfiguredError` if Gmail isn't connected, and
 * `GmailAuthError` if the stored tokens can't be loaded.
 */
export async function getOauthClient(): Promise<OAuth2Client> {
  const client = await getAuthedClientUnchecked();
  if (!client) {
    throw new GmailNotConfiguredError();
  }
  return client;
}

async function getAuthedClientUnchecked(): Promise<OAuth2Client | null> {
  const secrets = await readClientSecrets();
  if (!secrets) return null;
  const tokens = await readTokens();
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) return null;

  // Require at least one gmail scope to be granted before handing back a client.
  const granted = parseGrantedScopes(tokens.scope);
  const hasAnyGmailScope = GMAIL_BASE_SCOPES.some((s) => granted.has(s));
  if (!hasAnyGmailScope) return null;

  const client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    REDIRECT_URI,
  );
  client.setCredentials(tokens);
  // Persist refreshed tokens back to disk so the next process doesn't have to refresh.
  client.on('tokens', (next) => {
    void (async () => {
      try {
        const merged: StoredTokens = { ...tokens, ...next } as StoredTokens;
        await writeTokens(merged);
      } catch {
        /* non-fatal */
      }
    })();
  });
  return client;
}

/**
 * Returns true if the granted scopes include `gmail.send` AND the user
 * has flipped on `gmail_send_enabled`. Both gates must be true before
 * any send-on-behalf operation runs.
 */
export async function isSendAllowed(): Promise<boolean> {
  if (!isSendEnabledInSettings()) return false;
  const tokens = await readTokens();
  if (!tokens) return false;
  const granted = parseGrantedScopes(tokens.scope);
  return granted.has(GMAIL_SEND_SCOPE);
}

/* -------------------------------------------------------------------------- */
/*  Test-only                                                                 */
/* -------------------------------------------------------------------------- */

export const __internals = {
  pushState(state: string): void {
    pendingStates.set(state, Date.now());
  },
  clearStates(): void {
    pendingStates.clear();
  },
};
