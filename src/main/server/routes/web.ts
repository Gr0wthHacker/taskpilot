/**
 * `/api/web/*` routes — search and fetch.
 *
 * Both endpoints sit behind the standard bearer auth and surface the web
 * module's primitives so any client (renderer, CLI, MCP host) can pull in
 * external info without baking provider logic into each callsite.
 *
 * Mounted by `server/index.ts`:
 *     app.use('/api/web', webRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import { fetchUrl, search } from '@/main/web';
import { UrlValidationError } from '@/main/web/fetch';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(20).optional(),
  provider: z.enum(['brave', 'serper', 'duckduckgo']).optional(),
});

const fetchSchema = z.object({
  url: z.string().min(1).max(2_048),
  mode: z.enum(['raw', 'text']).optional(),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
  max_bytes: z.number().int().positive().max(20 * 1024 * 1024).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function webRouter(): Router {
  const router = Router();

  router.post(
    '/search',
    validateBody(searchSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof searchSchema>;
      try {
        const result = await search(body.query, {
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
          ...(body.provider !== undefined ? { provider: body.provider } : {}),
        });
        res.json(result);
      } catch (err) {
        throw new ApiHttpError(
          502,
          'web_search_failed',
          err instanceof Error ? err.message : 'Search failed',
        );
      }
    }),
  );

  router.post(
    '/fetch',
    validateBody(fetchSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof fetchSchema>;
      try {
        const result = await fetchUrl(body.url, {
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          ...(body.timeout_ms !== undefined ? { timeoutMs: body.timeout_ms } : {}),
          ...(body.max_bytes !== undefined ? { maxBytes: body.max_bytes } : {}),
        });
        res.json(result);
      } catch (err) {
        // URL validation rejections (private hosts, bad protocol, embedded
        // creds, redirect to internal) come through as `UrlValidationError`
        // and map to 400. Everything else is an upstream failure → 502.
        if (err instanceof UrlValidationError) {
          throw new ApiHttpError(400, err.code, err.message);
        }
        throw new ApiHttpError(
          502,
          'web_fetch_failed',
          err instanceof Error ? err.message : 'Fetch failed',
        );
      }
    }),
  );

  return router;
}
