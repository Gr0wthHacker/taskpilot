/**
 * `/api/webhooks/...` routes.
 *
 * Inbound webhook receiver for third-party providers. Currently only GitHub.
 *
 * Auth note: this router is intentionally NOT behind the Bearer-token
 * middleware (Agent B owns api-auth). GitHub can't send a Bearer header —
 * authentication happens via the HMAC signature in `X-Hub-Signature-256`
 * against a per-install shared secret stored in the `github_webhook_secret`
 * setting. See INTEGRATION_NOTES.md "Wave 10 — webhook auth allowlist".
 *
 * Body: we re-parse JSON inside the handler from the raw bytes so the HMAC
 * matches what GitHub actually sent. The Express JSON body-parser mounted
 * globally in `server/index.ts` runs first; we still recompute on `req.body`
 * because Express stores the parsed object and we serialize it back. To make
 * signature verification reliable against arbitrary clients, we mount a raw
 * body capture middleware on this router specifically.
 */

import crypto from 'node:crypto';

import { Router, type Request } from 'express';
import express from 'express';

import {
  handleIssuesEvent,
  handlePullRequestEvent,
  type IssuePayload,
  type PRPayload,
} from '@/main/github/webhook-handlers';
import { settingsRepository } from '@/main/db/repositories/settings';

import { ApiHttpError } from '../errors';
import { asyncHandler } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Idempotency cache                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Map of `X-GitHub-Delivery` UUID -> seen-at timestamp (ms). Entries older
 * than `DELIVERY_TTL_MS` are pruned on each insert so the Map can't grow
 * unbounded. In-memory by design: webhook redelivery across restarts is
 * rare enough that doing the work twice is fine, and persistence isn't
 * worth the DB write.
 *
 * TTL was originally 24h, which left a window where a GitHub re-delivery
 * beyond the 24h boundary would be processed twice. Bumped to 7d to match
 * GitHub's documented redelivery window for failed deliveries.
 */
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DELIVERY_CAP = 50_000;
const SEEN_DELIVERIES = new Map<string, number>();

function pruneOldDeliveries(now: number): void {
  for (const [id, ts] of SEEN_DELIVERIES.entries()) {
    if (now - ts > DELIVERY_TTL_MS) {
      SEEN_DELIVERIES.delete(id);
    }
  }
  // Hard cap so a flood of distinct delivery ids can't bloat memory. Drop
  // the oldest 10% in insertion order.
  if (SEEN_DELIVERIES.size > DELIVERY_CAP) {
    const drop = Math.ceil(DELIVERY_CAP * 0.1);
    let removed = 0;
    for (const id of SEEN_DELIVERIES.keys()) {
      SEEN_DELIVERIES.delete(id);
      if (++removed >= drop) break;
    }
  }
}

function isDuplicateDelivery(deliveryId: string): boolean {
  const now = Date.now();
  pruneOldDeliveries(now);
  if (SEEN_DELIVERIES.has(deliveryId)) return true;
  SEEN_DELIVERIES.set(deliveryId, now);
  return false;
}

/**
 * Test-only escape hatch. Clears the in-memory cache so the same delivery
 * id can be re-used between tests without spinning up a new server.
 */
export function __resetWebhookDeliveryCache(): void {
  SEEN_DELIVERIES.clear();
}

/* -------------------------------------------------------------------------- */
/*  HMAC verification                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read the configured webhook secret. Returns null when missing/empty so the
 * caller can 503 instead of letting an unsigned request through.
 */
function readSecret(): string | null {
  try {
    const raw = settingsRepository.get('github_webhook_secret');
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return null;
  } catch {
    return null;
  }
}

/**
 * Constant-time signature compare. GitHub sends `sha256=<hex>`; we compute
 * the HMAC over the raw request body and compare hex-encoded.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // timingSafeEqual throws on length mismatch — guard explicitly.
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, 'utf8'),
      Buffer.from(expected, 'utf8'),
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a router that captures the raw body for HMAC verification. The
 * global JSON parser mounted in `server/index.ts` will already have parsed
 * the body, but we re-mount a raw capture on this router so we control the
 * exact bytes hashed. Order matters — we mount the raw capture BEFORE any
 * route handler.
 */
export function webhooksRouter(): Router {
  const router = Router();

  // Capture the raw body bytes alongside the parsed JSON. The global parser
  // ran first (and consumed the stream), so we run a fresh raw parser here.
  // express.raw is a no-op when the body has already been consumed —
  // we work around this by stashing a JSON.stringify of req.body when raw
  // isn't available.
  router.use(
    '/github',
    express.raw({ type: '*/*', limit: '5mb' }),
    (req, _res, next) => {
      // `express.raw` stores the body as a Buffer on `req.body` when it was
      // the first parser to run; otherwise `req.body` is the previously
      // parsed object. Detect and normalize.
      const body = (req as Request).body;
      if (Buffer.isBuffer(body)) {
        (req as Request & { rawBody?: Buffer }).rawBody = body;
        // Re-parse JSON for the handler.
        try {
          (req as Request).body = JSON.parse(body.toString('utf8'));
        } catch {
          (req as Request).body = {};
        }
      } else if (body && typeof body === 'object') {
        // Reconstruct a canonical raw body. This is not bit-identical with
        // whatever GitHub sent, so signature verification will fail unless
        // the caller didn't run a parser before us. In practice the
        // express.raw above wins because we mount it on this exact path.
        try {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(
            JSON.stringify(body),
            'utf8',
          );
        } catch {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from('', 'utf8');
        }
      } else {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from('', 'utf8');
      }
      next();
    },
  );

  router.post(
    '/github',
    asyncHandler(async (req, res) => {
      // 1. Webhook secret must be configured.
      const secret = readSecret();
      if (!secret) {
        throw new ApiHttpError(
          503,
          'webhook_secret_unset',
          'github_webhook_secret setting is not configured',
        );
      }

      // 2. Verify HMAC signature.
      const signature = req.header('x-hub-signature-256');
      const rawBody =
        (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('', 'utf8');
      const ok = verifySignature(rawBody, signature, secret);
      if (!ok) {
        throw new ApiHttpError(
          401,
          'invalid_signature',
          'X-Hub-Signature-256 did not match',
        );
      }

      // 3. Idempotency check.
      const deliveryId = req.header('x-github-delivery');
      if (typeof deliveryId === 'string' && deliveryId.length > 0) {
        if (isDuplicateDelivery(deliveryId)) {
          res.json({
            ok: true,
            action: 'duplicate',
            note: 'Delivery already processed',
          });
          return;
        }
      }

      // 4. Dispatch by event type.
      const event = String(req.header('x-github-event') ?? '').toLowerCase();
      const payload = (req.body && typeof req.body === 'object'
        ? req.body
        : {}) as Record<string, unknown>;

      if (event === 'pull_request') {
        const result = await handlePullRequestEvent(payload as unknown as PRPayload);
        res.json(result);
        return;
      }

      if (event === 'issues') {
        const result = await handleIssuesEvent(payload as unknown as IssuePayload);
        res.json(result);
        return;
      }

      if (event === 'ping') {
        // GitHub sends a `ping` immediately after the webhook is added.
        res.json({ ok: true, action: 'ping' });
        return;
      }

      // Unknown / unhandled event — ack with 200 so GitHub doesn't redeliver.
      res.json({ ok: true, action: 'ignored', note: `Event "${event}" not handled` });
    }),
  );

  return router;
}
