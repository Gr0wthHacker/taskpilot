/**
 * Signed client portal links (T707).
 *
 * Token format: `<linkId>.<expiresAtEpochSeconds>.<signature>` where the
 * signature is base64url(HMAC-SHA256(secret, "portal.v1.<linkId>.<exp>")).
 *
 * A token is valid only when the signature matches, the expiry has not
 * passed, and the `portal_links` row exists, is not revoked and carries the
 * same expiry. Revoking a link sets `revoked_at`; rotating the secret
 * (delete `~/.taskpilot/portal-secret` and restart, or change
 * TASKPILOT_PORTAL_SECRET) invalidates every link at once.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { getSqlite } from '@/main/db';
import { TASKPILOT_HOME, API_PORT } from '@/shared/constants';
import { portalLinkStatus, type PortalLink, type PortalLinkWithUrl } from '@/shared/portal';

const SECRET_FILENAME = 'portal-secret';
const SIG_PREFIX = 'portal.v1';
export const MAX_LINK_DAYS = 365;
export const DEFAULT_LINK_DAYS = 30;

let cachedSecret: Buffer | null = null;

/** Test hook: drop the cached secret so a changed env or file is picked up. */
export function resetPortalSecretCache(): void {
  cachedSecret = null;
}

/**
 * Signing secret. TASKPILOT_PORTAL_SECRET wins (at least 32 chars); otherwise
 * a random 32-byte secret is created once at `~/.taskpilot/portal-secret`
 * with 0600 perms.
 */
export function getPortalSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = process.env.TASKPILOT_PORTAL_SECRET;
  if (env && env.length >= 32) {
    cachedSecret = Buffer.from(env, 'utf8');
    return cachedSecret;
  }
  const file = path.join(TASKPILOT_HOME, SECRET_FILENAME);
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw.length >= 64) {
      cachedSecret = Buffer.from(raw, 'hex');
      return cachedSecret;
    }
  } catch {
    /* create below */
  }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(TASKPILOT_HOME, { recursive: true });
  fs.writeFileSync(file, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  cachedSecret = fresh;
  return fresh;
}

function sign(linkId: string, expSeconds: number): string {
  return crypto
    .createHmac('sha256', getPortalSecret())
    .update(`${SIG_PREFIX}.${linkId}.${expSeconds}`)
    .digest('base64url');
}

export function signPortalToken(linkId: string, expiresAt: string): string {
  const exp = Math.floor(Date.parse(expiresAt) / 1000);
  return `${linkId}.${exp}.${sign(linkId, exp)}`;
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'not_found' | 'revoked';

export type VerifyResult = { ok: true; link: PortalLink } | { ok: false; reason: VerifyFailure };

const TOKEN_RE = /^([A-Za-z0-9_-]{8,64})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export function verifyPortalToken(token: string, now: number = Date.now()): VerifyResult {
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, linkId, expRaw, sig] = m;
  const exp = Number(expRaw);
  const expected = Buffer.from(sign(linkId, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (exp * 1000 <= now) return { ok: false, reason: 'expired' };
  const link = getPortalLink(linkId);
  if (!link) return { ok: false, reason: 'not_found' };
  if (Math.floor(Date.parse(link.expires_at) / 1000) !== exp) return { ok: false, reason: 'bad_signature' };
  if (link.revoked_at) return { ok: false, reason: 'revoked' };
  if (Date.parse(link.expires_at) <= now) return { ok: false, reason: 'expired' };
  return { ok: true, link };
}

/* -------------------------------------------------------------------------- */
/*  Link records                                                              */
/* -------------------------------------------------------------------------- */

interface LinkRow {
  id: string;
  client: string;
  label: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  created_at: string;
}

function rowToLink(r: LinkRow): PortalLink {
  return { ...r, view_count: Number(r.view_count) };
}

export function getPortalLink(id: string): PortalLink | null {
  const row = getSqlite().prepare('SELECT * FROM portal_links WHERE id = ?').get(id) as LinkRow | undefined;
  return row ? rowToLink(row) : null;
}

/** Base URL for share links. Set TASKPILOT_PORTAL_BASE_URL to the public tunnel or proxy origin. */
export function portalBaseUrl(): string {
  const env = process.env.TASKPILOT_PORTAL_BASE_URL?.trim();
  return (env && env.length > 0 ? env : `http://localhost:${API_PORT}`).replace(/\/+$/, '');
}

export function portalUrlFor(link: Pick<PortalLink, 'id' | 'expires_at'>): string {
  return `${portalBaseUrl()}/portal/${signPortalToken(link.id, link.expires_at)}`;
}

function withUrl(link: PortalLink, now: number): PortalLinkWithUrl {
  return { ...link, status: portalLinkStatus(link, now), url: portalUrlFor(link) };
}

export function createPortalLink(
  input: { client: string; expires_in_days?: number; label?: string | null },
  now: number = Date.now(),
): PortalLinkWithUrl {
  const client = input.client.trim();
  if (!client) throw new Error('client is required');
  const days = input.expires_in_days ?? DEFAULT_LINK_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > MAX_LINK_DAYS) {
    throw new Error(`expires_in_days must be between 1 and ${MAX_LINK_DAYS}`);
  }
  const id = nanoid(16);
  // Whole seconds so the token's exp and the stored value always match.
  const expMs = Math.floor((now + days * 24 * 60 * 60 * 1000) / 1000) * 1000;
  const expiresAt = new Date(expMs).toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO portal_links (id, client, label, expires_at, revoked_at, last_viewed_at, view_count, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 0, ?)`,
    )
    .run(id, client, input.label?.trim() || null, expiresAt, new Date(now).toISOString());
  return withUrl(getPortalLink(id)!, now);
}

export function listPortalLinks(client?: string, now: number = Date.now()): PortalLinkWithUrl[] {
  const rows = (
    client
      ? getSqlite().prepare('SELECT * FROM portal_links WHERE client = ? ORDER BY created_at DESC').all(client)
      : getSqlite().prepare('SELECT * FROM portal_links ORDER BY created_at DESC').all()
  ) as LinkRow[];
  return rows.map(rowToLink).map((l) => withUrl(l, now));
}

export function revokePortalLink(id: string, now: number = Date.now()): PortalLinkWithUrl | null {
  const db = getSqlite();
  db.prepare('UPDATE portal_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(
    new Date(now).toISOString(),
    id,
  );
  const link = getPortalLink(id);
  return link ? withUrl(link, now) : null;
}

export function recordPortalView(id: string, now: number = Date.now()): void {
  getSqlite()
    .prepare('UPDATE portal_links SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?')
    .run(new Date(now).toISOString(), id);
}
