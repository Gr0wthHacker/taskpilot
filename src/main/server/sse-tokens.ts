/**
 * Short-lived SSE tokens.
 *
 * The bearer API token can't be safely passed in the query string of an
 * EventSource URL — it ends up in browser history, server access logs, and
 * proxy caches. To avoid that, the renderer mints a 5-minute SSE token via
 * POST /api/events/token (authenticated normally with the bearer header) and
 * uses THAT token in `?token=` when opening the EventSource.
 *
 * Properties:
 *   - 5 minute TTL (caller can refresh as needed)
 *   - In-memory only; process restart invalidates all tokens
 *   - Lazy eviction on every issue/validate
 *   - Single-use? No — SSE tokens are revalidated on every reconnect, so a
 *     5min window of reuse is intentional.
 */

import { randomBytes } from 'node:crypto';

const TTL_MS = 5 * 60 * 1_000;
const ISSUE_CAP = 1_000; // sanity cap; clients should refresh, not stockpile

interface IssuedToken {
  expiresAt: number;
}

const tokens = new Map<string, IssuedToken>();

function evictExpired(now: number): void {
  for (const [tok, meta] of tokens) {
    if (meta.expiresAt <= now) tokens.delete(tok);
  }
  if (tokens.size > ISSUE_CAP) {
    // Drop oldest 10% so we don't churn when near cap.
    const drop = Math.ceil(ISSUE_CAP * 0.1);
    let removed = 0;
    for (const tok of tokens.keys()) {
      tokens.delete(tok);
      if (++removed >= drop) break;
    }
  }
}

export interface IssuedSseToken {
  token: string;
  expires_at: string;
  ttl_seconds: number;
}

export function issueSseToken(): IssuedSseToken {
  const now = Date.now();
  evictExpired(now);
  const token = `sse_${randomBytes(24).toString('hex')}`;
  const expiresAt = now + TTL_MS;
  tokens.set(token, { expiresAt });
  return {
    token,
    expires_at: new Date(expiresAt).toISOString(),
    ttl_seconds: Math.floor(TTL_MS / 1_000),
  };
}

export function isValidSseToken(candidate: string): boolean {
  if (!candidate.startsWith('sse_')) return false;
  const now = Date.now();
  const entry = tokens.get(candidate);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    tokens.delete(candidate);
    return false;
  }
  return true;
}

export function revokeSseToken(token: string): void {
  tokens.delete(token);
}

/**
 * Testing helper. Reset cache so a test run doesn't see tokens from a prior
 * test. Production code should not call this.
 */
export function _resetSseTokensForTest(): void {
  tokens.clear();
}
