/**
 * `/api/notion/...` routes.
 *
 * Lifecycle endpoints (status / connect / disconnect), database
 * picker (list / select), and on-demand sync trigger. The integration
 * token is never returned in any response or logged.
 *
 * Mounted by `server/index.ts`:
 *
 *     import { notionRouter } from './routes/notion';
 *     app.use('/api/notion', notionRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import { settingsRepository } from '@/main/db/repositories/settings';
import {
  NotionApiError,
  NotionAuthError,
  NotionNotConfiguredError,
  NotionRateLimitError,
  connect as notionConnect,
  disconnect as notionDisconnect,
  getStatus as notionGetStatus,
  listDatabases,
} from '@/main/notion';
import { syncOnce, startSyncJob } from '@/main/notion/sync';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

// Notion internal-integration tokens are `secret_...` or `ntn_...`,
// typically <100 chars. Bound the upload generously.
const connectSchema = z.object({
  token: z.string().min(8).max(2_048),
});

// Notion ids are 32-char hex with optional hyphens — accept the user's
// raw form (with or without hyphens). The SDK normalises on the way out.
const databaseIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/, { message: 'Invalid database id' });

const selectDbSchema = z.object({
  database_id: databaseIdSchema,
});

/* -------------------------------------------------------------------------- */
/*  Error translation                                                         */
/* -------------------------------------------------------------------------- */

function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof NotionNotConfiguredError) {
    return new ApiHttpError(
      401,
      'notion_not_configured',
      'Notion is not connected. Open Settings → Integrations to connect.',
    );
  }
  if (err instanceof NotionAuthError) {
    return new ApiHttpError(
      401,
      'notion_auth',
      err.message || 'Notion rejected the token.',
    );
  }
  if (err instanceof NotionRateLimitError) {
    return new ApiHttpError(
      429,
      'notion_rate_limit',
      err.message || 'Notion rate limit exceeded.',
      err.retryAfter !== null ? { retry_after: err.retryAfter } : undefined,
    );
  }
  if (err instanceof NotionApiError) {
    const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
    return new ApiHttpError(
      status,
      'notion_api_error',
      err.message || 'Notion request failed.',
    );
  }
  return new ApiHttpError(
    500,
    'notion_unknown',
    err instanceof Error ? err.message : 'Unknown Notion error',
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

export function notionRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const base = await safe(() => notionGetStatus());
      // Surface the selected database id so the renderer can decide
      // whether to nudge the user into picking one.
      const databaseId = settingsRepository.get<unknown>('notion_database_id');
      const body: {
        connected: boolean;
        workspace_name?: string;
        workspace_icon?: string | null;
        database_id?: string;
      } = { connected: base.connected };
      if (base.workspace_name) body.workspace_name = base.workspace_name;
      if (base.workspace_icon !== undefined) body.workspace_icon = base.workspace_icon;
      if (typeof databaseId === 'string' && databaseId.length > 0) {
        body.database_id = databaseId;
      }
      res.json(body);
    }),
  );

  router.post(
    '/connect',
    validateBody(connectSchema),
    asyncHandler(async (req, res) => {
      const { token } = req.body as z.infer<typeof connectSchema>;
      const result = await safe(() => notionConnect(token));
      // Boot the background sync job (idempotent) so the next tick
      // picks up any tasks marked for mirror.
      try {
        startSyncJob({ skipInitialTick: true });
      } catch {
        /* best-effort */
      }
      res.json({
        connected: true,
        workspace_name: result.workspace.workspace_name,
        workspace_icon: result.workspace.workspace_icon,
      });
    }),
  );

  router.post(
    '/disconnect',
    asyncHandler(async (_req, res) => {
      await safe(() => notionDisconnect());
      res.json({ ok: true });
    }),
  );

  router.get(
    '/databases',
    asyncHandler(async (_req, res) => {
      const databases = await safe(() => listDatabases(100));
      res.json({ databases });
    }),
  );

  router.post(
    '/databases/select',
    validateBody(selectDbSchema),
    asyncHandler(async (req, res) => {
      const { database_id } = req.body as z.infer<typeof selectDbSchema>;
      settingsRepository.set('notion_database_id', database_id);
      res.json({ ok: true, database_id });
    }),
  );

  router.post(
    '/sync-now',
    asyncHandler(async (_req, res) => {
      const result = await safe(() => syncOnce());
      res.json({
        ok: result.ok,
        pushed: result.pushed,
        skipped: result.skipped,
        failed: result.failed,
        ...(result.notConfigured ? { notConfigured: true } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.errors ? { errors: result.errors } : {}),
      });
    }),
  );

  return router;
}
