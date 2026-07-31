/**
 * `/api/settings/...` routes.
 *
 * Thin pass-through over the settings repository. Used by the Settings view
 * to read/write arbitrary JSON-compatible key/value preferences.
 */

import { Router } from 'express';
import { z } from 'zod';

import { settingsRepository } from '@/main/db/repositories/settings';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

const patchSchema = z.object({
  value: z.unknown(),
});

export function settingsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const all = settingsRepository.getAll();
      res.json({ settings: all });
    }),
  );

  router.get(
    '/:key',
    asyncHandler(async (req, res) => {
      const key = req.params.key;
      if (!key) throw new ApiHttpError(400, 'bad_request', 'Missing key');
      const value = settingsRepository.get(key);
      res.json({ key, value });
    }),
  );

  router.patch(
    '/:key',
    validateBody(patchSchema),
    asyncHandler(async (req, res) => {
      const key = String(req.params.key ?? '');
      if (!key) throw new ApiHttpError(400, 'bad_request', 'Missing key');
      const { value } = req.body as z.infer<typeof patchSchema>;
      settingsRepository.set(key, value);
      res.json({ ok: true, key, value });
    }),
  );

  router.delete(
    '/:key',
    asyncHandler(async (req, res) => {
      const key = req.params.key;
      if (!key) throw new ApiHttpError(400, 'bad_request', 'Missing key');
      const deleted = settingsRepository.delete(key);
      res.json({ ok: true, key, deleted });
    }),
  );

  return router;
}
