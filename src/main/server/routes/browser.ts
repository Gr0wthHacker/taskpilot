/**
 * `/api/browser/*` routes — managed Chrome control via CDP.
 *
 * All actions are session-scoped. `POST /sessions` opens a new tab and
 * returns its session id; subsequent action routes accept an optional
 * `session_id` body field (defaults to the most recently opened session).
 *
 * Mounted by `server/index.ts`:
 *     app.use('/api/browser', browserRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  BrowserError,
  captureScreenshot,
  clickSelector,
  closeSession,
  evalExpression,
  getText,
  listSessions,
  openSession,
  typeIntoSelector,
} from '@/main/browser';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const sessionIdField = z.string().min(1).max(256);

// Zod's `.url()` accepts any valid URL — including `javascript:`, `data:`,
// and `file:`. CRI.New on a `javascript:` URL would execute it in chrome://newtab
// context; `file://` reads from disk. Restrict to http(s) only.
const httpUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((s) => /^https?:\/\//i.test(s), {
    message: 'url must start with http:// or https://',
  });

const openSchema = z.object({
  url: httpUrlSchema,
  headless: z.boolean().optional(),
  wait_ms: z.number().int().positive().max(60_000).optional(),
});

const screenshotSchema = z.object({
  session_id: sessionIdField.optional(),
  full_page: z.boolean().optional(),
  format: z.enum(['png', 'jpeg']).optional(),
});

const evalSchema = z.object({
  session_id: sessionIdField.optional(),
  expression: z.string().min(1).max(100_000),
  await_promise: z.boolean().optional(),
});

const clickSchema = z.object({
  session_id: sessionIdField.optional(),
  selector: z.string().min(1).max(1_000),
});

const typeSchema = z.object({
  session_id: sessionIdField.optional(),
  selector: z.string().min(1).max(1_000),
  text: z.string().max(100_000),
  replace: z.boolean().optional(),
});

const getTextSchema = z.object({
  session_id: sessionIdField.optional(),
  selector: z.string().min(1).max(1_000).optional(),
  max_length: z.number().int().positive().max(500_000).optional(),
});

const closeSchema = z.object({
  session_id: sessionIdField.optional(),
});

/* -------------------------------------------------------------------------- */
/*  Error translation                                                         */
/* -------------------------------------------------------------------------- */

function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof BrowserError) {
    const status =
      err.code === 'browser_no_session' || err.code === 'browser_session_not_found'
        ? 404
        : err.code === 'browser_selector_not_found' ||
            err.code === 'browser_selector_not_editable'
          ? 400
          : 502;
    return new ApiHttpError(status, err.code, err.message);
  }
  if (err instanceof Error) {
    return new ApiHttpError(502, 'browser_error', err.message);
  }
  return new ApiHttpError(502, 'browser_error', 'Unknown browser error');
}

function safe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw toApiError(err);
  });
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function browserRouter(): Router {
  const router = Router();

  router.get(
    '/sessions',
    asyncHandler(async (_req, res) => {
      res.json({ sessions: listSessions() });
    }),
  );

  router.post(
    '/sessions',
    validateBody(openSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof openSchema>;
      const session = await safe(() =>
        openSession(body.url, {
          ...(body.headless !== undefined ? { headless: body.headless } : {}),
          ...(body.wait_ms !== undefined ? { waitMs: body.wait_ms } : {}),
        }),
      );
      res.status(201).json({ session });
    }),
  );

  router.post(
    '/screenshot',
    validateBody(screenshotSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof screenshotSchema>;
      const result = await safe(() =>
        captureScreenshot({
          ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
          ...(body.full_page !== undefined ? { fullPage: body.full_page } : {}),
          ...(body.format !== undefined ? { format: body.format } : {}),
        }),
      );
      res.json(result);
    }),
  );

  router.post(
    '/eval',
    validateBody(evalSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof evalSchema>;
      const result = await safe(() =>
        evalExpression(body.expression, {
          ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
          ...(body.await_promise !== undefined
            ? { awaitPromise: body.await_promise }
            : {}),
        }),
      );
      res.json(result);
    }),
  );

  router.post(
    '/click',
    validateBody(clickSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof clickSchema>;
      const result = await safe(() =>
        clickSelector(body.selector, {
          ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
        }),
      );
      res.json(result);
    }),
  );

  router.post(
    '/type',
    validateBody(typeSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof typeSchema>;
      const result = await safe(() =>
        typeIntoSelector(body.selector, body.text, {
          ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
          ...(body.replace !== undefined ? { replace: body.replace } : {}),
        }),
      );
      res.json(result);
    }),
  );

  router.post(
    '/text',
    validateBody(getTextSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof getTextSchema>;
      const result = await safe(() =>
        getText({
          ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
          ...(body.selector !== undefined ? { selector: body.selector } : {}),
          ...(body.max_length !== undefined ? { maxLength: body.max_length } : {}),
        }),
      );
      res.json(result);
    }),
  );

  router.delete(
    '/sessions',
    validateBody(closeSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof closeSchema>;
      const result = await safe(() =>
        closeSession(body.session_id),
      );
      res.json(result);
    }),
  );

  return router;
}
