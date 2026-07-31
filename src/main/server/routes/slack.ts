/**
 * `/api/slack/...` routes.
 *
 * Lifecycle endpoints (connect / disconnect / status) plus the operations
 * Claude and the UI need to act on Slack: post messages, list channels,
 * trigger a capture on demand.
 *
 * The bot token is never returned in any response or written to a log
 * line. Routes only return the public `team` shape from `getStatus()` /
 * `connect()`. Errors are mapped to the canonical
 * `{ error: { code, message } }` envelope by the parent error handler.
 *
 * Mounted by `server/index.ts`:
 *
 *     import { slackRouter } from './routes/slack';
 *     app.use('/api/slack', slackRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  SlackApiError,
  SlackAuthError,
  SlackNotConfiguredError,
  SlackRateLimitError,
  connect as slackConnect,
  disconnect as slackDisconnect,
  getStatus as slackGetStatus,
  listChannels,
  postMessage,
} from '@/main/slack';
import {
  captureOnce,
  startCaptureJob,
  stopCaptureJob,
} from '@/main/slack/capture';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

// Slack bot tokens are short (`xoxb-…`, typically <100 chars) but we accept
// up to 2048 to be safe and bound the upload size.
const connectSchema = z.object({
  token: z.string().min(8).max(2_048),
});

// Channel ids and names: `C…`/`G…`/`D…` for ids, plain text for names.
// Tighten the alphabet so unsanitized input can't drive log noise.
const channelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._#-]+$/, { message: 'Invalid channel id or name' });

// Slack message ts: `1701234567.000200`. Optional thread parent.
const threadTsSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+$/, { message: 'Invalid thread ts' });

const postSchema = z.object({
  channel: channelSchema,
  text: z.string().min(1).max(40_000),
  thread_ts: threadTsSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/*  Channel cache                                                             */
/* -------------------------------------------------------------------------- */

interface ChannelCache {
  channels: Awaited<ReturnType<typeof listChannels>>;
  fetchedAt: number;
}

const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1_000;
let channelCache: ChannelCache | null = null;

function invalidateChannelCache(): void {
  channelCache = null;
}

/* -------------------------------------------------------------------------- */
/*  Error translation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Convert any error from the slack module into an `ApiHttpError`. Route
 * handlers wrap their operations and rethrow into this so the central
 * error middleware sees a typed status + code.
 */
function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof SlackNotConfiguredError) {
    return new ApiHttpError(
      401,
      'slack_not_configured',
      'Slack is not connected. Open Settings → Integrations to connect.',
    );
  }
  if (err instanceof SlackAuthError) {
    return new ApiHttpError(
      401,
      'slack_auth',
      err.message || 'Slack rejected the request.',
    );
  }
  if (err instanceof SlackRateLimitError) {
    return new ApiHttpError(
      429,
      'slack_rate_limit',
      err.message || 'Slack rate limit exceeded.',
      err.retryAfter !== null ? { retry_after: err.retryAfter } : undefined,
    );
  }
  if (err instanceof SlackApiError) {
    const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
    return new ApiHttpError(
      status,
      'slack_api_error',
      err.message || 'Slack request failed.',
      err.slackError ? { slack_error: err.slackError } : undefined,
    );
  }
  return new ApiHttpError(
    500,
    'slack_unknown',
    err instanceof Error ? err.message : 'Unknown Slack error',
  );
}

function safe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw toApiError(err);
  });
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function slackRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const status = await safe(() => slackGetStatus());
      res.json(status);
    }),
  );

  router.post(
    '/connect',
    validateBody(connectSchema),
    asyncHandler(async (req, res) => {
      const { token } = req.body as z.infer<typeof connectSchema>;
      const result = await safe(() => slackConnect(token));
      // Boot the background capture loop on first connect — `startCaptureJob`
      // is idempotent so calling it on a reconnect is fine.
      try {
        startCaptureJob();
      } catch {
        /* best-effort */
      }
      invalidateChannelCache();
      res.json({
        connected: true,
        team: result.team,
        bot_user_id: result.bot_user_id,
      });
    }),
  );

  router.post(
    '/disconnect',
    asyncHandler(async (_req, res) => {
      try {
        stopCaptureJob();
      } catch {
        /* best-effort */
      }
      await safe(() => slackDisconnect());
      invalidateChannelCache();
      res.json({ ok: true });
    }),
  );

  router.get(
    '/channels',
    asyncHandler(async (_req, res) => {
      const now = Date.now();
      if (channelCache && now - channelCache.fetchedAt < CHANNEL_CACHE_TTL_MS) {
        res.json({ channels: channelCache.channels, cached: true });
        return;
      }
      const channels = await safe(() => listChannels(500));
      channelCache = { channels, fetchedAt: now };
      res.json({ channels, cached: false });
    }),
  );

  router.post(
    '/post',
    validateBody(postSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof postSchema>;
      const result = await safe(() =>
        postMessage({
          channel: body.channel,
          text: body.text,
          ...(body.thread_ts !== undefined ? { thread_ts: body.thread_ts } : {}),
        }),
      );
      res.json({
        ok: true,
        channel: result.channel,
        ts: result.ts,
        permalink: result.permalink,
      });
    }),
  );

  router.post(
    '/capture-now',
    asyncHandler(async (_req, res) => {
      const result = await safe(() => captureOnce());
      res.json({ ok: true, ...result });
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Test-only helpers                                                          */
/* -------------------------------------------------------------------------- */

export const __testing = {
  resetChannelCache: invalidateChannelCache,
};
