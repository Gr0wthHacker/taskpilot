/**
 * `/api/memory/...` routes.
 *
 * Capture surface, list/detail/update/delete, plus the `/stats` materialized
 * counts. Mirrors the tasks router contract — cursor pagination, summary
 * projection, hard 200-row cap.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemoryPage,
  listLinksFor,
  MemoryContentTooLargeError,
  MemoryDuplicateError,
  MEMORY_MAX_PAGE_LIMIT,
  updateMemory,
} from '@/main/memory/repository';
import { writeEnrichRequest } from '@/main/memory/protocol';
import { fetchUrlAsMarkdown } from '@/main/memory/url-fetcher';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const memoryStatusSchema = z.enum(['raw', 'enriched', 'failed']);
const memoryKindSchema = z.enum(['text', 'url', 'file']);

const booleanStringSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const listMemoryQuerySchema = z.object({
  status: memoryStatusSchema.optional(),
  kind: memoryKindSchema.optional(),
  tag: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(500).optional(),
  limit: z
    .union([z.number(), z.string().regex(/^\d{1,6}$/)])
    .transform((v) => (typeof v === 'string' ? parseInt(v, 10) : v))
    .optional(),
  cursor: z.string().min(1).max(200).optional(),
  fields: z.enum(['full', 'summary']).optional(),
});

const captureBodySchema = z
  .object({
    kind: memoryKindSchema,
    // For text: the body. For url: the URL itself. For file: a relative path
    // under MEMORY_FILES_DIR.
    content: z.string().min(1).max(1_000_000).optional(),
    url: z.string().url().max(2048).optional(),
    title: z.string().max(500).optional(),
    tags: z.array(z.string().min(1).max(64)).max(12).optional(),
    /**
     * When false, the server skips writing the enrichment request file
     * after persisting the row. Useful for tests + bulk imports.
     */
    enrich: booleanStringSchema.optional(),
  })
  .refine(
    (b) =>
      (b.kind === 'text' && typeof b.content === 'string') ||
      (b.kind === 'url' && typeof b.url === 'string') ||
      (b.kind === 'file' && typeof b.content === 'string'),
    {
      message:
        'kind=text or file requires `content`; kind=url requires `url`',
    },
  );

const updateBodySchema = z.object({
  title: z.string().max(500).nullable().optional(),
  summary: z.string().max(8_000).nullable().optional(),
  tags: z.array(z.string().min(1).max(64)).max(12).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function memoryRouter(): Router {
  const router = Router();

  // GET /api/memory ---------------------------------------------------------
  router.get(
    '/',
    validateQuery(listMemoryQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof listMemoryQuerySchema>;
      const filter: Parameters<typeof listMemoryPage>[0] = {};
      if (q.status !== undefined) filter.status = q.status;
      if (q.kind !== undefined) filter.kind = q.kind;
      if (q.tag !== undefined) filter.tag = q.tag;
      if (q.search !== undefined) filter.search = q.search;
      if (q.limit !== undefined) {
        filter.limit = Math.min(q.limit, MEMORY_MAX_PAGE_LIMIT);
      }
      if (q.cursor !== undefined) filter.cursor = q.cursor;
      if (q.fields !== undefined) filter.fields = q.fields;

      const page = listMemoryPage(filter);
      res.json({ items: page.items, next_cursor: page.next_cursor });
    }),
  );

  // GET /api/memory/stats ---------------------------------------------------
  router.get(
    '/stats',
    asyncHandler(async (_req, res) => {
      const { getMemoryStats, recomputeMemoryStats } = await import(
        '@/main/memory/stats'
      );
      const stats = getMemoryStats();
      const ageMs = Date.now() - new Date(stats.updated_at).getTime();
      const fresh = ageMs < 5_000 ? stats : recomputeMemoryStats();
      res.json({ stats: fresh });
    }),
  );

  // POST /api/memory --------------------------------------------------------
  router.post(
    '/',
    validateBody(captureBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof captureBodySchema>;

      // Resolve the raw_content + source fields per kind.
      let raw_content: string;
      let source_url: string | null = null;
      let source_path: string | null = null;
      let title: string | null = body.title ?? null;

      if (body.kind === 'text') {
        raw_content = body.content!;
      } else if (body.kind === 'file') {
        raw_content = body.content!;
        // The renderer is expected to upload the file via another endpoint
        // first; for v1 we store the path that callers supplied verbatim.
        // Strict relative-path validation lives in a follow-up.
        source_path = body.title ?? null;
      } else {
        // kind === 'url' — fetch the page as markdown.
        source_url = body.url!;
        try {
          const fetched = await fetchUrlAsMarkdown(source_url);
          raw_content = fetched.markdown;
          if (title === null && fetched.title) title = fetched.title;
        } catch (err: unknown) {
          throw new ApiHttpError(
            400,
            'url_fetch_failed',
            err instanceof Error ? err.message : 'failed to fetch URL',
          );
        }
      }

      let created;
      try {
        created = createMemory({
          kind: body.kind,
          raw_content,
          title,
          source_url,
          source_path,
          tags: body.tags ?? [],
        });
      } catch (err: unknown) {
        if (err instanceof MemoryDuplicateError) {
          // 409 with the existing id — renderer can navigate the user there.
          throw new ApiHttpError(409, 'duplicate', err.message, {
            existing_id: err.existingId,
          });
        }
        if (err instanceof MemoryContentTooLargeError) {
          throw new ApiHttpError(413, 'too_large', err.message);
        }
        throw err;
      }

      // Fire the enrichment request unless the caller opted out.
      if (body.enrich !== false) {
        try {
          await writeEnrichRequest(created.id);
        } catch {
          // Non-fatal — the row exists; the user can re-fire enrichment
          // from the detail view later.
        }
      }

      res.status(201).json({ item: created });
    }),
  );

  // GET /api/memory/:id -----------------------------------------------------
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const item = getMemory(id);
      if (!item) {
        throw new ApiHttpError(404, 'not_found', `Memory ${id} not found`);
      }
      const links = listLinksFor(id);
      res.json({ item, links });
    }),
  );

  // PATCH /api/memory/:id ---------------------------------------------------
  router.patch(
    '/:id',
    validateBody(updateBodySchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const body = req.body as z.infer<typeof updateBodySchema>;
      const updated = updateMemory(id, {
        title: body.title,
        summary: body.summary,
        tags: body.tags,
      });
      if (!updated) {
        throw new ApiHttpError(404, 'not_found', `Memory ${id} not found`);
      }
      res.json({ item: updated });
    }),
  );

  // DELETE /api/memory/:id --------------------------------------------------
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const removed = deleteMemory(id);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', `Memory ${id} not found`);
      }
      res.json({ ok: true, id });
    }),
  );

  // POST /api/memory/:id/enrich --------------------------------------------
  // Manually re-fire the enrichment request. Useful when the renderer wants
  // to recompute summary/tags after a content edit.
  router.post(
    '/:id/enrich',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const item = getMemory(id);
      if (!item) {
        throw new ApiHttpError(404, 'not_found', `Memory ${id} not found`);
      }
      try {
        const requestPath = await writeEnrichRequest(id);
        res.json({ ok: true, request_path: requestPath });
      } catch (err: unknown) {
        throw new ApiHttpError(
          500,
          'enrich_request_failed',
          err instanceof Error ? err.message : 'failed to write enrich request',
        );
      }
    }),
  );

  return router;
}
