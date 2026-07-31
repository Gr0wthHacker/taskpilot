/**
 * `/api/businesses/...` routes.
 *
 * Per-business status surface. Reads `~/.taskpilot/projects.json` for the
 * business → repo map, computes an on-demand snapshot (tasks + decisions +
 * Claude-Code conversations mapped by repo CWD + explicit cross-session
 * deltas), and exposes:
 *
 *   GET    /api/businesses                       — overview list
 *   GET    /api/businesses/:tag                  — full snapshot
 *   GET    /api/businesses/:tag/status.md        — markdown rendering
 *   POST   /api/businesses/:tag/update           — record a status delta
 *
 * No background scheduler — every read recomputes. The two on-disk caches
 * (`status.json`, `STATUS.md` under `~/.taskpilot/businesses/<tag>/`) are
 * rewritten as a side effect of any read or update.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  computeOverview,
  getBusiness,
  recordUpdate,
  refreshAndPersistSnapshot,
  renderStatusMarkdown,
} from '@/main/businesses';
import { businessTagSchema } from '@/main/businesses/loader';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const updateBodySchema = z.object({
  at: z.string().datetime().optional(),
  headline: z.string().min(1).max(500),
  what_changed: z.string().max(10_000).optional(),
  source: z.string().max(500).optional(),
  links: z
    .array(
      z.object({
        label: z.string().max(200),
        url: z.string().max(2048),
      }),
    )
    .max(16)
    .optional(),
});

function parseTag(raw: string): string {
  const parsed = businessTagSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(
      400,
      'invalid_business_tag',
      `Invalid business tag: ${raw}`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                     */
/* -------------------------------------------------------------------------- */

export function businessesRouter(): Router {
  const router = Router();

  // GET /api/businesses -----------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const businesses = await computeOverview();
      res.json({ businesses });
    }),
  );

  // GET /api/businesses/:tag ------------------------------------------------
  router.get(
    '/:tag',
    asyncHandler(async (req, res) => {
      const tag = parseTag(String(req.params.tag));
      const snapshot = await refreshAndPersistSnapshot(tag);
      if (!snapshot) {
        throw new ApiHttpError(
          404,
          'not_found',
          `No business configured for tag ${tag}. Add an entry to ~/.taskpilot/projects.json.`,
        );
      }
      res.json({ snapshot });
    }),
  );

  // GET /api/businesses/:tag/status.md --------------------------------------
  router.get(
    '/:tag/status.md',
    asyncHandler(async (req, res) => {
      const tag = parseTag(String(req.params.tag));
      const snapshot = await refreshAndPersistSnapshot(tag);
      if (!snapshot) {
        throw new ApiHttpError(404, 'not_found', `No business for tag ${tag}`);
      }
      res.type('text/markdown').send(renderStatusMarkdown(snapshot));
    }),
  );

  // POST /api/businesses/:tag/update ----------------------------------------
  router.post(
    '/:tag/update',
    validateBody(updateBodySchema),
    asyncHandler(async (req, res) => {
      const tag = parseTag(String(req.params.tag));
      if (!getBusiness(tag)) {
        throw new ApiHttpError(404, 'not_found', `No business for tag ${tag}`);
      }
      const body = req.body as z.infer<typeof updateBodySchema>;
      const at = body.at ?? new Date().toISOString();
      const snapshot = await recordUpdate(tag, {
        at,
        headline: body.headline,
        ...(body.what_changed !== undefined
          ? { what_changed: body.what_changed }
          : {}),
        ...(body.source !== undefined ? { source: body.source } : {}),
        ...(body.links !== undefined ? { links: body.links } : {}),
      });
      res.status(201).json({ ok: true, snapshot });
    }),
  );

  return router;
}
