/**
 * `/api/backups/...` routes.
 *
 * Thin HTTP layer over `src/main/backups`. Mounted by `server/index.ts`.
 *
 * Endpoints:
 *   - GET    /api/backups              → list
 *   - POST   /api/backups              → trigger immediate snapshot
 *   - DELETE /api/backups/:filename    → delete one
 *   - POST   /api/backups/:filename/restore → restore (kicks off in background, 202)
 *   - GET    /api/backups/status       → retention + last/next run + count
 *
 * `:filename` is validated against the canonical regex inside the backups
 * module so path traversal can't escape `BACKUPS_DIR`.
 */

import { Router } from 'express';

import {
  createBackup,
  deleteBackup,
  isValidBackupFilename,
  listBackups,
} from '@/main/backups';
import { restoreBackup } from '@/main/backups/restore';
import { getScheduledBackupsHandle } from '@/main/backups/scheduler';

import { ApiHttpError } from '../errors';
import { asyncHandler } from '../middleware';

export function backupsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const backups = await listBackups();
      res.json({ backups });
    }),
  );

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const handle = getScheduledBackupsHandle();
      const status = handle
        ? handle.status()
        : { retain_count: 14, next_run_at: null, last_run_at: null, count: 0 };
      res.json(status);
    }),
  );

  router.post(
    '/',
    asyncHandler(async (_req, res) => {
      const summary = await createBackup();
      res.json({ backup: summary });
    }),
  );

  router.delete(
    '/:filename',
    asyncHandler(async (req, res) => {
      const filename = String(req.params.filename ?? '');
      if (!isValidBackupFilename(filename)) {
        throw new ApiHttpError(
          400,
          'invalid_filename',
          'Backup filename does not match canonical pattern',
        );
      }
      try {
        await deleteBackup(filename);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message.includes('not found')) {
          throw new ApiHttpError(404, 'backup_not_found', message);
        }
        throw new ApiHttpError(500, 'delete_failed', message);
      }
      res.json({ ok: true, filename });
    }),
  );

  router.post(
    '/:filename/restore',
    asyncHandler(async (req, res) => {
      const filename = String(req.params.filename ?? '');
      if (!isValidBackupFilename(filename)) {
        throw new ApiHttpError(
          400,
          'invalid_filename',
          'Backup filename does not match canonical pattern',
        );
      }
      // Run synchronously — restore is fast (file copy) and the renderer
      // needs the `requires_restart` flag to prompt the user. We still
      // return 202 to signal "you must restart for this to take effect".
      let result;
      try {
        result = await restoreBackup(filename);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message.includes('not found')) {
          throw new ApiHttpError(404, 'backup_not_found', message);
        }
        throw new ApiHttpError(500, 'restore_failed', message);
      }
      res.status(202).json({
        ok: true,
        ...result,
      });
    }),
  );

  return router;
}
