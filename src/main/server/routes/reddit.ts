/**
 * `/api/reddit/...` routes.
 *
 * Read-only proxy over Reddit's public JSON API. No upstream auth — the only
 * gate here is TaskPilot's own bearer-token middleware (so a random process
 * on Jack's machine can't enumerate his task targets).
 *
 * The routes intentionally don't expose the full Reddit response shape; we
 * project into the typed summaries from `operations.ts` so the renderer
 * gets a stable contract regardless of upstream churn.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  RedditApiError,
  RedditNotFoundError,
  RedditRateLimitError,
  getPost,
  getSubredditPosts,
  searchSubreddit,
} from '@/main/reddit';

import { ApiHttpError } from '../errors';
import { asyncHandler } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const subredditNameSchema = z
  .string()
  .min(2)
  .max(21)
  .regex(/^[A-Za-z0-9_]+$/, 'Invalid subreddit name');

const postIdSchema = z
  .string()
  .min(1)
  .max(14)
  .regex(/^[a-z0-9]+$/i, 'Invalid post id');

const sortSchema = z.enum(['hot', 'new', 'top', 'rising']);
const timeWindowSchema = z.enum(['all', 'year', 'month', 'week', 'day', 'hour']);
const searchSortSchema = z.enum(['relevance', 'top', 'new', 'comments']);

const listQuerySchema = z.object({
  sort: sortSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  t: timeWindowSchema.optional(),
  after: z.string().min(1).max(64).optional(),
});

const postQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(512),
  sort: searchSortSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  restrict_sr: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional(),
});

/* -------------------------------------------------------------------------- */
/*  Error translation                                                          */
/* -------------------------------------------------------------------------- */

function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof RedditNotFoundError) {
    return new ApiHttpError(404, 'reddit_not_found', err.message);
  }
  if (err instanceof RedditRateLimitError) {
    return new ApiHttpError(
      503,
      'reddit_rate_limit',
      err.message,
      { retry_after_seconds: err.retry_after_seconds },
    );
  }
  if (err instanceof RedditApiError) {
    // 400-class bubble up as 400; upstream 5xx → 502.
    if (err.status === 400) {
      return new ApiHttpError(400, 'reddit_bad_request', err.message);
    }
    if (err.status >= 500 || err.status === 0) {
      return new ApiHttpError(502, 'reddit_api_error', err.message);
    }
    return new ApiHttpError(err.status, 'reddit_api_error', err.message);
  }
  return new ApiHttpError(
    500,
    'reddit_unknown',
    err instanceof Error ? err.message : 'Unknown Reddit error',
  );
}

function safe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw toApiError(err);
  });
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                     */
/* -------------------------------------------------------------------------- */

export function redditRouter(): Router {
  const router = Router();

  router.get(
    '/subreddit/:subreddit/posts',
    asyncHandler(async (req, res) => {
      const sub = subredditNameSchema.safeParse(req.params.subreddit);
      if (!sub.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid subreddit');
      }
      const query = listQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw new ApiHttpError(
          400,
          'bad_request',
          'Invalid query parameters',
          query.error.format(),
        );
      }
      const params: Parameters<typeof getSubredditPosts>[0] = {
        subreddit: sub.data,
      };
      if (query.data.sort !== undefined) params.sort = query.data.sort;
      if (query.data.limit !== undefined) params.limit = query.data.limit;
      if (query.data.t !== undefined) params.t = query.data.t;
      if (query.data.after !== undefined) params.after = query.data.after;
      const result = await safe(() => getSubredditPosts(params));
      res.json(result);
    }),
  );

  router.get(
    '/subreddit/:subreddit/posts/:post_id',
    asyncHandler(async (req, res) => {
      const sub = subredditNameSchema.safeParse(req.params.subreddit);
      const postId = postIdSchema.safeParse(req.params.post_id);
      if (!sub.success || !postId.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid path parameters');
      }
      const query = postQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid query parameters');
      }
      const params: Parameters<typeof getPost>[0] = {
        subreddit: sub.data,
        post_id: postId.data,
      };
      if (query.data.limit !== undefined) params.limit = query.data.limit;
      const result = await safe(() => getPost(params));
      res.json(result);
    }),
  );

  router.get(
    '/subreddit/:subreddit/search',
    asyncHandler(async (req, res) => {
      const sub = subredditNameSchema.safeParse(req.params.subreddit);
      if (!sub.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid subreddit');
      }
      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiHttpError(
          400,
          'bad_request',
          'Invalid query parameters',
          parsed.error.format(),
        );
      }
      const params: Parameters<typeof searchSubreddit>[0] = {
        subreddit: sub.data,
        query: parsed.data.q,
      };
      if (parsed.data.sort !== undefined) params.sort = parsed.data.sort;
      if (parsed.data.limit !== undefined) params.limit = parsed.data.limit;
      if (parsed.data.restrict_sr !== undefined) {
        const restrict =
          typeof parsed.data.restrict_sr === 'boolean'
            ? parsed.data.restrict_sr
            : parsed.data.restrict_sr === 'true';
        params.restrict_sr = restrict;
      }
      const result = await safe(() => searchSubreddit(params));
      res.json(result);
    }),
  );

  return router;
}
