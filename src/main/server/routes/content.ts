/**
 * `/api/content/...` routes — the publishing pipeline.
 *
 * Surfaces the file-backed content engine over HTTP for the renderer (and any
 * future external automation). The endpoints are deliberately small — the
 * skill chain (DEAI check, atomize, draft Reddit copy, etc.) lives outside
 * the app; this surface just tracks state and stores the artifacts.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  advanceState,
  ContentStateError,
  createPiece,
  CONTENT_CHANNELS,
  deletePiece,
  listPieces,
  readPiece,
  setDerivative,
  updatePiece,
} from '@/main/content';
import { CONTENT_STATES } from '@/main/content/types';
import { businessTagSchema } from '@/main/businesses/loader';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const idSchema = z.string().regex(/^c_[A-Za-z0-9_-]{1,62}$/, 'Invalid content id');

const createBody = z.object({
  title: z.string().min(1).max(500),
  business: businessTagSchema.nullable().optional(),
  draft_markdown: z.string().max(200_000).optional(),
  hypothesis: z.string().max(2_000).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});

const updateBody = z.object({
  title: z.string().min(1).max(500).optional(),
  business: businessTagSchema.nullable().optional(),
  draft_markdown: z.string().max(200_000).optional(),
  hypothesis: z.string().max(2_000).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});

const advanceBody = z.object({
  to: z.enum(CONTENT_STATES),
});

const derivativeBody = z.object({
  channel: z.enum(CONTENT_CHANNELS),
  markdown: z.string().max(50_000),
  scheduled_at: z.string().datetime().nullable().optional(),
  published_at: z.string().datetime().nullable().optional(),
  published_url: z.string().url().max(2_048).nullable().optional(),
});

function parseId(raw: string): string {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_content_id', `Invalid content id: ${raw}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                     */
/* -------------------------------------------------------------------------- */

export function contentRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const all = await listPieces();
      const filtered = all.filter((p) => {
        if (
          typeof req.query.state === 'string' &&
          p.state !== req.query.state
        ) {
          return false;
        }
        if (
          typeof req.query.business === 'string' &&
          p.business !== req.query.business
        ) {
          return false;
        }
        return true;
      });
      res.json({ pieces: filtered });
    }),
  );

  router.post(
    '/',
    validateBody(createBody),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createBody>;
      const piece = await createPiece(body);
      res.status(201).json({ piece });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(String(req.params.id));
      const piece = await readPiece(id);
      if (!piece) {
        throw new ApiHttpError(404, 'not_found', `Content piece ${id} not found`);
      }
      res.json({ piece });
    }),
  );

  router.patch(
    '/:id',
    validateBody(updateBody),
    asyncHandler(async (req, res) => {
      const id = parseId(String(req.params.id));
      const body = req.body as z.infer<typeof updateBody>;
      const piece = await updatePiece(id, body);
      if (!piece) {
        throw new ApiHttpError(404, 'not_found', `Content piece ${id} not found`);
      }
      res.json({ piece });
    }),
  );

  router.post(
    '/:id/advance',
    validateBody(advanceBody),
    asyncHandler(async (req, res) => {
      const id = parseId(String(req.params.id));
      const body = req.body as z.infer<typeof advanceBody>;
      try {
        const piece = await advanceState(id, body.to);
        if (!piece) {
          throw new ApiHttpError(
            404,
            'not_found',
            `Content piece ${id} not found`,
          );
        }
        res.json({ piece });
      } catch (err) {
        if (err instanceof ContentStateError) {
          throw new ApiHttpError(409, err.code, err.message);
        }
        throw err;
      }
    }),
  );

  router.post(
    '/:id/derivatives',
    validateBody(derivativeBody),
    asyncHandler(async (req, res) => {
      const id = parseId(String(req.params.id));
      const body = req.body as z.infer<typeof derivativeBody>;
      const piece = await setDerivative(id, {
        channel: body.channel,
        markdown: body.markdown,
        scheduled_at: body.scheduled_at ?? null,
        published_at: body.published_at ?? null,
        published_url: body.published_url ?? null,
      });
      if (!piece) {
        throw new ApiHttpError(404, 'not_found', `Content piece ${id} not found`);
      }
      res.json({ piece });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(String(req.params.id));
      const removed = await deletePiece(id);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', `Content piece ${id} not found`);
      }
      res.json({ ok: true, id });
    }),
  );

  return router;
}
