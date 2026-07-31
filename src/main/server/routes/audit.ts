/**
 * `/api/audit/...` routes.
 *
 * Read-only view over the encrypted append-only ambient audit log. The write
 * side is internal — events are appended by repositories + the deliberation
 * orchestrator/ingester via `appendAuditEventSafe` — so no POST endpoint is
 * surfaced (operators who need to drop a manual entry can do so via the CLI
 * or a unit test; production paths must NOT inject arbitrary audit rows over
 * HTTP).
 *
 * Endpoints:
 *   - GET /api/audit/recent[?limit&kind&since]  → newest events first
 *   - GET /api/audit/status                     → file count + audit dir path
 *
 * Bearer-protected like every other route under `/api/*` — see
 * `server/middleware/auth.ts`. A future Audit view in the renderer will hit
 * `/recent` on mount.
 */

import { Router } from 'express';
import { z } from 'zod';

import { countAuditFiles, readRecentAuditEvents } from '@/main/audit';
import { AUDIT_DIR } from '@/shared/constants';

import { asyncHandler, validateQuery } from '../middleware';

const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
  kind: z.string().min(1).max(64).optional(),
  since: z.string().min(1).max(64).optional(),
});

export function auditRouter(): Router {
  const router = Router();

  router.get(
    '/recent',
    validateQuery(recentQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof recentQuerySchema>;
      const events = readRecentAuditEvents({
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(q.since !== undefined ? { since: q.since } : {}),
      });
      res.json({ events });
    }),
  );

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      res.json({
        audit_dir: AUDIT_DIR,
        file_count: countAuditFiles(),
      });
    }),
  );

  return router;
}
