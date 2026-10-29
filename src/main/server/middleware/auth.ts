/**
 * Bearer-token authentication middleware + host-header check.
 *
 * Wave 10 / S8 finding. Every endpoint requires `Authorization: Bearer
 * <token>` except a small allowlist. The token is server-managed (see
 * `@/main/api-auth`); the renderer, CLI, and MCP server all read it from
 * `~/.taskpilot/api-token`.
 *
 * Threat model:
 *   - Stops any *other* local process from talking to the API (CSRF /
 *     "open-port-on-localhost" class attacks).
 *   - The host-header middleware additionally breaks DNS-rebinding: an
 *     attacker page that resolves a public DNS name to 127.0.0.1 still
 *     hits the API with `Host: evil.example` and gets 403'd before any
 *     route handler runs.
 *
 * Allowlist (skips bearer check):
 *   - `GET /api/health` — smoke probe, must always work
 *   - `GET /api/config` — public config (port + paths)
 *   - `/oauth/callback` — Google redirects here without a token
 *   - `/api/webhooks/*` — Agent C webhooks, HMAC-signed instead
 *
 * SSE (`/api/events`) accepts the token via `?token=<token>` query param
 * because the browser EventSource API can't send custom headers.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { API_PORT } from '@/shared/constants';

import { isValidSseToken } from '../sse-tokens';

/* -------------------------------------------------------------------------- */
/*  Bearer auth                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Path prefixes that bypass auth. Match against `req.path` (without query).
 * Anything that starts with these prefixes skips the bearer check.
 *
 * NOTE: comparisons are exact-or-prefixed-with-`/`. We don't use loose
 * `startsWith` so `/api/healthz` doesn't accidentally inherit `/api/health`'s
 * exemption.
 */
const AUTH_ALLOWLIST_EXACT: readonly string[] = [
  '/api/health',
  '/api/config',
];

const AUTH_ALLOWLIST_PREFIX: readonly string[] = [
  // Google redirects the user's browser here directly with `?code=…`. We
  // can't expect the redirect to carry a bearer.
  '/oauth/callback',
  // Wave 10 Agent C — GitHub inbound webhook verifies via HMAC signature
  // instead of bearer. Skip the bearer check; the webhook router
  // enforces its own signature middleware.
  '/api/webhooks/github',
  // Wave 13 Agent M — generic inbound webhooks. Same model as the
  // GitHub route: HMAC over the raw body, per-config secret. The CRUD
  // endpoints at `/api/webhooks/configs/*` are NOT allowlisted — those
  // mutate registry state and must require the bearer token.
  '/api/webhooks/incoming/',
  // T707 client portal. Read-only pages gated by a signed, expiring,
  // revocable token in the path (see `@/main/portal/links`), not the bearer.
  '/portal/',
];

/**
 * Returns true if the request path bypasses auth.
 */
export function isAuthAllowlisted(reqPath: string): boolean {
  if (AUTH_ALLOWLIST_EXACT.includes(reqPath)) return true;
  for (const prefix of AUTH_ALLOWLIST_PREFIX) {
    if (reqPath === prefix.replace(/\/$/, '') || reqPath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Constant-time string compare. Returns false for length mismatches without
 * leaking length via timing.
 */
function safeEqual(a: string, b: string): boolean {
  // crypto.timingSafeEqual requires equal-length buffers; pad the shorter
  // one and still XOR the length flag in at the end so different lengths
  // always return false.
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still do a constant-time op on equal-sized dummies so attackers can't
    // distinguish "wrong length" from "wrong value" via timing.
    const dummy = Buffer.alloc(ab.length);
    crypto.timingSafeEqual(ab, dummy);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Extract a candidate token from the request. Accepts:
 *   - `Authorization: Bearer <token>` header
 *   - `?token=<token>` query parameter (for SSE/EventSource)
 *
 * Returns `null` if neither is present or the header is malformed.
 */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    // Match `Bearer ` (case-insensitive) with one or more spaces.
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (m) return m[1];
  }
  const q = req.query.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/**
 * Build the bearer-auth middleware. The token is captured at construction
 * time so rotation requires a server restart (which is the documented
 * rotation procedure anyway — see AUTH.md).
 */
export function authMiddleware(expectedToken: string): RequestHandler {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    throw new Error('authMiddleware: expectedToken must be a non-empty string');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthAllowlisted(req.path)) {
      next();
      return;
    }

    const candidate = extractToken(req);
    if (!candidate) {
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Missing or invalid API token',
        },
      });
      return;
    }

    // Accept either the bearer token or a live short-lived SSE token.
    // The SSE token path keeps the renderer's `?token=...` URL out of
    // logs/history because the SSE token TTL is 5 minutes and the secret
    // value never overlaps with the long-lived bearer.
    //
    // SCOPE: SSE tokens are events-only. They authenticate GET /api/events
    // and nothing else. A leaked SSE token (the whole point of making it
    // short-lived is that the surface area is small) should never be
    // sufficient to mutate state. Bearer is required for everything else.
    const isBearer = safeEqual(candidate, expectedToken);
    const isSse = !isBearer && isValidSseToken(candidate);
    if (!isBearer && !isSse) {
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Missing or invalid API token',
        },
      });
      return;
    }
    if (isSse && !isSseScopedPath(req.method, req.path)) {
      res.status(403).json({
        error: {
          code: 'sse_token_out_of_scope',
          message:
            'SSE tokens are events-only. Use the bearer token for non-event routes.',
        },
      });
      return;
    }

    next();
  };
}

/**
 * SSE tokens may only authenticate the events stream itself. Everything
 * else needs the long-lived bearer. This keeps a leaked 5-min token
 * from being able to mutate state.
 */
function isSseScopedPath(method: string, urlPath: string): boolean {
  if (method !== 'GET') return false;
  // Strip query string; `/api/events?token=...` becomes `/api/events`.
  const path = urlPath.split('?')[0];
  return path === '/api/events' || path === '/events';
}

/* -------------------------------------------------------------------------- */
/*  Host-header check (DNS-rebinding guard)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hostnames (without port) we accept on the `Host` header. The port suffix
 * is checked separately so test boots on ephemeral ports still pass.
 */
const ALLOWED_HOSTNAMES: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
];

/**
 * Parse the Host header into `{ host, port }`. Handles IPv6 bracketed
 * forms (`[::1]:7847`) and bare hostnames without ports.
 */
function parseHost(value: string): { host: string; port: string | null } {
  // IPv6: `[::1]:7847` or `[::1]`
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return { host: value, port: null };
    const host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest.startsWith(':')) return { host, port: rest.slice(1) };
    return { host, port: null };
  }
  // IPv4 / hostname.
  const lastColon = value.lastIndexOf(':');
  if (lastColon === -1) return { host: value, port: null };
  return { host: value.slice(0, lastColon), port: value.slice(lastColon + 1) };
}

/**
 * Build the host-check middleware. Accepts the canonical API port plus any
 * extra ports provided (useful for tests that boot on `port: 0`).
 */
export function hostCheckMiddleware(options: {
  acceptedPorts?: ReadonlyArray<number>;
  /**
   * Public hostnames (e.g. a tunnel or reverse proxy in front of the API)
   * accepted ONLY for `/portal/*`, on any port. Defaults to the
   * comma-separated TASKPILOT_PORTAL_HOSTS env var. Every other path still
   * requires a loopback Host header.
   */
  portalHosts?: ReadonlyArray<string>;
} = {}): RequestHandler {
  const acceptedPorts = new Set<string>(
    (options.acceptedPorts ?? [API_PORT]).map((p) => String(p)),
  );
  const portalHosts = new Set<string>(
    (options.portalHosts ?? (process.env.TASKPILOT_PORTAL_HOSTS ?? '').split(','))
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers.host;
    if (
      portalHosts.size > 0 &&
      typeof raw === 'string' &&
      req.path.startsWith('/portal/') &&
      req.method === 'GET' &&
      portalHosts.has(parseHost(raw).host.toLowerCase())
    ) {
      next();
      return;
    }
    if (typeof raw !== 'string' || raw.length === 0) {
      res.status(403).json({
        error: {
          code: 'invalid_host',
          message: 'Host header does not match',
        },
      });
      return;
    }

    const { host, port } = parseHost(raw);
    if (!ALLOWED_HOSTNAMES.includes(host)) {
      res.status(403).json({
        error: {
          code: 'invalid_host',
          message: 'Host header does not match',
        },
      });
      return;
    }
    // A missing port means the request came in on the default port (80 /
    // 443) — never us. Always 403.
    if (port === null || !acceptedPorts.has(port)) {
      res.status(403).json({
        error: {
          code: 'invalid_host',
          message: 'Host header does not match',
        },
      });
      return;
    }

    next();
  };
}
