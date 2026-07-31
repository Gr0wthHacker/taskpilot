/**
 * `/api/telemetry/...` routes.
 *
 * Surfaces the telemetry collector's status + a manual "flush now" trigger.
 * The actual opt-in flag and endpoint URL are stored under the standard
 * settings repository (`telemetry_enabled`, `telemetry_endpoint`) and toggled
 * via `/api/settings/*` — these routes are read-only sidecar info.
 *
 * Endpoints:
 *   - GET  /api/telemetry/status  → { enabled, endpoint, log_path, pending }
 *   - POST /api/telemetry/flush   → trigger an upload pass on demand
 *   - POST /api/telemetry/event   → record a renderer-side event (renderer
 *                                   doesn't have fs access, so it relays
 *                                   through the API)
 */

import fs from 'node:fs';

import { Router } from 'express';
import { z } from 'zod';

import { settingsRepository } from '@/main/db/repositories/settings';
import { flush, record, TELEMETRY_LOG } from '@/main/telemetry';

import { asyncHandler, validateBody } from '../middleware';

function countLines(path: string): number {
  try {
    if (!fs.existsSync(path)) return 0;
    const raw = fs.readFileSync(path, 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) {
      if (line.length > 0) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

const eventBodySchema = z.object({
  kind: z.enum([
    'launch',
    'task_created',
    'task_done',
    'task_failed',
    'error',
    'derive',
    'execute',
  ]),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export function telemetryRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const enabled = settingsRepository.get<boolean>('telemetry_enabled') === true;
      const endpoint =
        settingsRepository.get<string>('telemetry_endpoint') ?? '';
      const cursor = settingsRepository.get<number>('telemetry_upload_cursor');
      const total = countLines(TELEMETRY_LOG);
      const cursorVal =
        typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0
          ? cursor
          : 0;
      res.json({
        enabled,
        endpoint,
        log_path: TELEMETRY_LOG,
        total_events: total,
        pending: Math.max(0, total - cursorVal),
      });
    }),
  );

  router.post(
    '/flush',
    asyncHandler(async (_req, res) => {
      const result = await flush();
      res.json({ ok: true, ...result });
    }),
  );

  router.post(
    '/event',
    validateBody(eventBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof eventBodySchema>;
      record({ kind: body.kind, payload: body.payload });
      res.json({ ok: true });
    }),
  );

  return router;
}
