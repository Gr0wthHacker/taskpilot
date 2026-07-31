/**
 * Full-text search route (Wave 17 — search).
 *
 *   GET /api/search?q=...&types=task,decision&limit=50
 *
 * Returns `{ results, total, fts_available }`. The query is sanitized inside
 * the search engine (see `@/main/search`), so a malformed `q` produces an
 * empty result set rather than a 500. `types` is a comma-separated list of
 * entity kinds; unknown kinds are ignored, an empty/absent list means "all".
 */

import { Router } from 'express';
import { z } from 'zod';

import { search } from '@/main/search';
import type {
  SearchEntityType,
  SearchResponse,
} from '@/shared/api-contract';

import { asyncHandler, validateQuery } from '../middleware';

const VALID_TYPES: readonly SearchEntityType[] = [
  'task',
  'decision',
  'execution',
  'attachment',
];

const searchQuerySchema = z
  .object({
    q: z.string().max(500).optional().default(''),
    types: z.string().max(200).optional(),
    limit: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine((v) => v === undefined || Number.isFinite(v), {
        message: 'limit must be a number',
      }),
  })
  .strict();

/**
 * Parse the comma-separated `types` param into a validated list. Unknown
 * tokens are dropped; an empty result means "search all types".
 */
function parseTypes(raw: string | undefined): SearchEntityType[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is SearchEntityType =>
      (VALID_TYPES as readonly string[]).includes(t),
    );
}

export function searchRouter(): Router {
  const router = Router();

  router.get(
    '/',
    validateQuery(searchQuerySchema),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        q: string;
        types?: string;
        limit?: number;
      };

      const q = (query.q ?? '').trim();
      const types = parseTypes(query.types);
      const limit = query.limit;

      const results = q.length === 0 ? [] : search(q, { types, ...(limit !== undefined ? { limit } : {}) });

      // `fts_available` is read lazily off the engine. Import here (cheap) so
      // the response carries the real backend state for the UI.
      const { isFtsAvailable } = await import('@/main/search');

      const body: SearchResponse = {
        results,
        total: results.length,
        fts_available: isFtsAvailable(),
      };
      res.json(body);
    }),
  );

  return router;
}
