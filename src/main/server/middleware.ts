/**
 * Generic Express middleware used by every route module.
 *
 * - `asyncHandler` wraps an async route handler and forwards errors to Express's
 *   error middleware so route bodies can `throw` freely.
 * - `validateBody` / `validateQuery` are Zod-driven validators that 400 on
 *   malformed input with a structured `{ error: { code, message, details } }`
 *   response body.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Wraps an async Express handler so rejected promises propagate to the error
 * middleware instead of crashing the process.
 */
export function asyncHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, unknown>,
>(
  fn: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next): void => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Validation error thrown by `validateBody` / `validateQuery` when the input
 * fails the schema check. The Express error middleware converts these into a
 * 400 JSON response.
 */
export class ValidationError extends Error {
  readonly code = 'validation_error';
  readonly status = 400;
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

/**
 * 400 on invalid bodies. On success, the parsed (and possibly transformed)
 * value replaces `req.body` so downstream handlers see the typed shape.
 */
export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new ValidationError('Invalid request body', result.error.format()));
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Idempotency-Key middleware.
 *
 * Clients that retry the same logical operation (network blip, watchdog
 * restart) can supply an `Idempotency-Key` header. The first response under
 * a given key is captured and replayed verbatim for any retry within the
 * 24h cache window — no duplicate task creation, no double-charged cost.
 *
 * Cache shape: Map<key, {status, body, capturedAt}> with a soft 5k-entry cap
 * and lazy eviction of entries older than TTL on every access. Process-local;
 * a process restart resets the cache (acceptable — the client will retry and
 * the underlying operation is unlikely to repeat at restart).
 *
 * Apply selectively per-route via the returned RequestHandler. Pass-through
 * when the header is absent so endpoints can opt-in without breaking
 * existing callers.
 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_CAP = 5_000;
const idempotencyKeyRe = /^[A-Za-z0-9_-]{8,128}$/;

interface CachedResponse {
  status: number;
  body: unknown;
  capturedAt: number;
}

/**
 * In-flight tracker for the coalescing path. When a request comes in with
 * a key the cache hasn't seen, we mark it in-flight. Subsequent concurrent
 * requests for the same key wait on the in-flight promise instead of
 * re-entering the route handler — they get the first request's response
 * once it completes. Without this two retries arriving at the same time
 * would both run the handler and double-charge the side effects.
 */
interface InFlightEntry {
  /** Resolved with the captured response once the first handler responds. */
  promise: Promise<CachedResponse>;
  /** Number of waiters (debugging only). */
  waiters: number;
  resolve: (r: CachedResponse) => void;
  reject: (e: Error) => void;
}

const idempotencyCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, InFlightEntry>();

function evictExpired(now: number): void {
  for (const [key, entry] of idempotencyCache) {
    if (now - entry.capturedAt > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
  if (idempotencyCache.size > IDEMPOTENCY_CAP) {
    const drop = Math.ceil(IDEMPOTENCY_CAP * 0.1);
    let removed = 0;
    for (const key of idempotencyCache.keys()) {
      idempotencyCache.delete(key);
      if (++removed >= drop) break;
    }
  }
}

function replayCached(res: Response, cached: CachedResponse): void {
  res.setHeader('Idempotency-Replay', 'true');
  res.status(cached.status).json(cached.body);
}

export function idempotency(): RequestHandler {
  return (req, res, next): void => {
    const raw = req.header('Idempotency-Key');
    if (!raw) {
      next();
      return;
    }
    if (!idempotencyKeyRe.test(raw)) {
      next(
        new ValidationError(
          'Invalid Idempotency-Key — expected 8-128 chars, alphanumeric/_/-',
          { received: raw.slice(0, 64) },
        ),
      );
      return;
    }
    const now = Date.now();
    evictExpired(now);

    const cached = idempotencyCache.get(raw);
    if (cached) {
      replayCached(res, cached);
      return;
    }

    // In-flight coalescing. If another concurrent request is already
    // processing this key, await its captured response and replay.
    const pending = inFlight.get(raw);
    if (pending) {
      pending.waiters += 1;
      pending.promise.then(
        (capturedResponse) => {
          replayCached(res, capturedResponse);
        },
        () => {
          // The in-flight handler failed (non-2xx or thrown). Don't cache;
          // pass the second request through so it gets its own chance.
          // Express requires a fresh handler invocation — we can't easily
          // re-enter middleware after awaiting, so respond with 409 and
          // let the client retry.
          res.status(409).json({
            error: {
              code: 'idempotency_in_flight_failed',
              message:
                'The first request with this Idempotency-Key did not produce a cacheable response. Retry.',
            },
          });
        },
      );
      return;
    }

    // First request for this key — mark in-flight, capture the response,
    // resolve the promise on response so waiters can replay.
    let resolveFn: (r: CachedResponse) => void = () => undefined;
    let rejectFn: (e: Error) => void = () => undefined;
    const promise = new Promise<CachedResponse>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // The promise is rejected on every non-2xx or closed response, but it only
    // has a handler when a concurrent duplicate is waiting on it. With no
    // waiter the rejection is unhandled, and Node's default
    // (--unhandled-rejections=throw) takes the whole server process down.
    // Waiters still see the rejection through their own .then() handlers.
    promise.catch(() => undefined);
    const entry: InFlightEntry = {
      promise,
      waiters: 0,
      resolve: resolveFn,
      reject: rejectFn,
    };
    inFlight.set(raw, entry);

    const originalJson = res.json.bind(res);
    let settled = false;
    res.json = (body: unknown): Response => {
      const status = res.statusCode ?? 200;
      const captured: CachedResponse = {
        status,
        body,
        capturedAt: Date.now(),
      };
      if (status >= 200 && status < 300) {
        idempotencyCache.set(raw, captured);
        if (!settled) {
          settled = true;
          entry.resolve(captured);
        }
      } else if (!settled) {
        settled = true;
        entry.reject(new Error(`non-2xx (${status})`));
      }
      inFlight.delete(raw);
      return originalJson(body);
    };
    // Catch the case where the handler errors without ever calling res.json
    // (Express finalizes via the error middleware which writes a different
    // shape). Use 'close' as a backstop so the in-flight entry never leaks.
    res.on('close', () => {
      if (!settled) {
        settled = true;
        entry.reject(new Error('connection closed'));
        inFlight.delete(raw);
      }
    });
    next();
  };
}

/**
 * Test helper — clear caches so a test run gets a fresh slate.
 */
export function _resetIdempotencyForTest(): void {
  idempotencyCache.clear();
  inFlight.clear();
}

/**
 * 400 on invalid query strings. Express stores query as `Record<string, string
 * | string[]>` (we coerce booleans/numbers via the schema). Parsed value
 * replaces `req.query`.
 */
export function validateQuery<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(new ValidationError('Invalid query parameters', result.error.format()));
      return;
    }
    // Express types `req.query` as `ParsedQs`; assigning a parsed object is
    // intentional for downstream handlers.
    (req as unknown as { query: unknown }).query = result.data;
    next();
  };
}
