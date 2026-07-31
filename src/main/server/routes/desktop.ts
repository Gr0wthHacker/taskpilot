/**
 * `/api/desktop/*` routes — gated desktop input.
 *
 * Every action requires the `desktop_input_enabled` setting to be true.
 * Disabled requests return 403 `desktop_input_disabled` so the client can
 * present a clear "enable in settings" UX rather than a generic failure.
 *
 * Mounted by `server/index.ts`:
 *     app.use('/api/desktop', desktopRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  DesktopInputDisabledError,
  DesktopInputUnsupportedError,
  captureScreen,
  clickAt,
  getPrimaryScreenSize,
  moveMouse,
  sendKeys,
} from '@/main/desktop';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const moveSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const clickSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  button: z.enum(['left', 'right', 'middle']).optional(),
});

const keysSchema = z.object({
  keys: z.string().min(1).max(10_000),
  raw: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/*  Error translation                                                         */
/* -------------------------------------------------------------------------- */

function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof DesktopInputDisabledError) {
    return new ApiHttpError(403, err.code, err.message);
  }
  if (err instanceof DesktopInputUnsupportedError) {
    return new ApiHttpError(501, err.code, err.message);
  }
  // Errors from assertWindows on non-Windows hosts surface as plain Error.
  if (err instanceof Error && /only supported on Windows/i.test(err.message)) {
    return new ApiHttpError(501, 'desktop_input_unsupported', err.message);
  }
  return new ApiHttpError(
    500,
    'desktop_error',
    err instanceof Error ? err.message : 'Unknown desktop error',
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

export function desktopRouter(): Router {
  const router = Router();

  router.get(
    '/screen',
    asyncHandler(async (_req, res) => {
      const size = await safe(() => getPrimaryScreenSize());
      res.json(size);
    }),
  );

  router.post(
    '/screenshot',
    asyncHandler(async (_req, res) => {
      const result = await safe(() => captureScreen());
      res.json(result);
    }),
  );

  router.post(
    '/mouse/move',
    validateBody(moveSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof moveSchema>;
      const result = await safe(() => moveMouse(body.x, body.y));
      res.json(result);
    }),
  );

  router.post(
    '/mouse/click',
    validateBody(clickSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof clickSchema>;
      const result = await safe(() =>
        clickAt(body.x, body.y, body.button ?? 'left'),
      );
      res.json(result);
    }),
  );

  router.post(
    '/keys',
    validateBody(keysSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof keysSchema>;
      const result = await safe(() =>
        sendKeys(body.keys, body.raw !== undefined ? { raw: body.raw } : {}),
      );
      res.json(result);
    }),
  );

  return router;
}
