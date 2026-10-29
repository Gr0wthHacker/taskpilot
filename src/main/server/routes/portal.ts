/**
 * Client portal routes (T707).
 *
 * Admin, bearer-protected, mounted at `/api/portal`:
 *   GET    /clients                    clients seen in the queue, renewals, entries or links
 *   GET    /preview?client=&month=     the exact view a client would see
 *   GET    /links?client=              share links with status and URL
 *   POST   /links                      { client, expires_in_days?, label? }
 *   POST   /links/:id/revoke
 *   GET    /entries?client=&month=     findings, deliverables, next steps, monthly notes
 *   POST   /entries
 *   PATCH  /entries/:id
 *   DELETE /entries/:id
 *
 * Public, token-gated, mounted at `/portal` (allowlisted in the auth
 * middleware):
 *   GET    /:token                     HTML page
 *   GET    /:token/view.json           same data as JSON
 *
 * Any invalid, expired or revoked token gets the same 404 page, so the
 * response never tells a guesser which part failed.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';

import { getSqlite } from '@/main/db';
import {
  PortalError,
  createPortalEntry,
  deletePortalEntry,
  listPortalEntries,
  updatePortalEntry,
} from '@/main/portal/entries';
import { renderPortalHtml, renderPortalUnavailableHtml } from '@/main/portal/html';
import {
  MAX_LINK_DAYS,
  createPortalLink,
  listPortalLinks,
  recordPortalView,
  revokePortalLink,
  verifyPortalToken,
} from '@/main/portal/links';
import { buildPortalView } from '@/main/portal/view';
import { PORTAL_ENTRY_KINDS, isMonth, isSafeHttpUrl } from '@/shared/portal';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

const monthSchema = z.string().refine(isMonth, 'must be YYYY-MM');
const urlSchema = z
  .string()
  .max(2_000)
  .refine((v) => isSafeHttpUrl(v), 'must be an http(s) URL');

const linkSchema = z.object({
  client: z.string().min(1).max(200),
  expires_in_days: z.number().int().min(1).max(MAX_LINK_DAYS).optional(),
  label: z.string().max(200).nullable().optional(),
});

const entrySchema = z.object({
  client: z.string().min(1).max(200),
  kind: z.enum(PORTAL_ENTRY_KINDS),
  title: z.string().min(1).max(300),
  body: z.string().max(10_000).nullable().optional(),
  url: urlSchema.nullable().optional(),
  month: monthSchema.nullable().optional(),
  client_visible: z.boolean().optional(),
  done: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

const entryPatchSchema = entrySchema.partial();

function run<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PortalError) {
      throw new ApiHttpError(err.code === 'not_found' ? 404 : 400, `portal_${err.code}`, err.message);
    }
    throw err;
  }
}

function queryString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function queryMonth(raw: unknown): string | undefined {
  const m = queryString(raw);
  if (m === undefined) return undefined;
  if (!isMonth(m)) throw new ApiHttpError(400, 'invalid_query', 'month must be YYYY-MM');
  return m;
}

export function portalAdminRouter(): Router {
  const router = Router();

  router.get(
    '/clients',
    asyncHandler(async (_req, res) => {
      const rows = getSqlite()
        .prepare(
          `SELECT client FROM delivery_items UNION SELECT client FROM renewals
           UNION SELECT client FROM portal_entries UNION SELECT client FROM portal_links
           ORDER BY client`,
        )
        .all() as Array<{ client: string }>;
      res.json({ clients: rows.map((r) => r.client) });
    }),
  );

  router.get(
    '/preview',
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const client = queryString(q.client);
      if (!client) throw new ApiHttpError(400, 'invalid_query', 'client is required');
      res.json({ view: buildPortalView(client, { month: queryMonth(q.month) }) });
    }),
  );

  router.get(
    '/links',
    asyncHandler(async (req, res) => {
      res.json({ links: listPortalLinks(queryString((req.query as Record<string, unknown>).client)) });
    }),
  );

  router.post(
    '/links',
    validateBody(linkSchema),
    asyncHandler(async (req, res) => {
      const link = createPortalLink(req.body as z.infer<typeof linkSchema>);
      res.status(201).json({ link });
    }),
  );

  router.post(
    '/links/:id/revoke',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const link = revokePortalLink(id);
      if (!link) throw new ApiHttpError(404, 'not_found', `Link ${id} not found`);
      res.json({ link });
    }),
  );

  router.get(
    '/entries',
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      res.json({ entries: listPortalEntries({ client: queryString(q.client), month: queryMonth(q.month) }) });
    }),
  );

  router.post(
    '/entries',
    validateBody(entrySchema),
    asyncHandler(async (req, res) => {
      const entry = run(() => createPortalEntry(req.body as z.infer<typeof entrySchema>));
      res.status(201).json({ entry });
    }),
  );

  router.patch(
    '/entries/:id',
    validateBody(entryPatchSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const entry = run(() => updatePortalEntry(id, req.body as z.infer<typeof entryPatchSchema>));
      if (!entry) throw new ApiHttpError(404, 'not_found', `Entry ${id} not found`);
      res.json({ entry });
    }),
  );

  router.delete(
    '/entries/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!deletePortalEntry(id)) throw new ApiHttpError(404, 'not_found', `Entry ${id} not found`);
      res.json({ ok: true });
    }),
  );

  return router;
}

function setPortalHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

export function portalPublicRouter(): Router {
  const router = Router();

  const resolve = (token: string, res: Response): ReturnType<typeof verifyPortalToken> => {
    setPortalHeaders(res);
    return verifyPortalToken(token);
  };

  router.get(
    '/:token/view.json',
    asyncHandler(async (req, res) => {
      const result = resolve(String(req.params.token), res);
      if (!result.ok) {
        res.status(404).json({ error: { code: 'portal_unavailable', message: 'This link is not available' } });
        return;
      }
      recordPortalView(result.link.id);
      res.json({ view: buildPortalView(result.link.client) });
    }),
  );

  router.get(
    '/:token',
    asyncHandler(async (req, res) => {
      const result = resolve(String(req.params.token), res);
      res.type('html');
      if (!result.ok) {
        res.status(404).send(renderPortalUnavailableHtml());
        return;
      }
      recordPortalView(result.link.id);
      res.send(renderPortalHtml(buildPortalView(result.link.client)));
    }),
  );

  return router;
}
