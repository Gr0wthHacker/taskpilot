/**
 * `/api/reports/status/...` routes (Wave 16E).
 *
 * The weekly status report surface. Mounted at `/api/reports` BEFORE the
 * analytics `reportsRouter` so the `/status*` paths resolve here (the
 * analytics router defines none of them, so this is belt-and-suspenders).
 *
 * Endpoints:
 *   - POST  /status            generate + publish to `destinations`
 *   - GET   /status/preview    generate WITHOUT publishing
 *   - GET   /status/history    past reports from disk
 *   - GET   /status/schedule   read the cron schedule
 *   - PATCH /status/schedule   update enabled / cron / destinations
 *
 * Generation always also persists a disk copy (whether or not `disk` is in the
 * destination list) so the history endpoint has something to list and the user
 * never loses a generated report.
 */

import { Router } from 'express';
import { z } from 'zod';

import { generateStatusReport } from '@/main/reports/status-report';
import {
  listReportHistory,
  publishReport,
} from '@/main/reports/report-publish';
import {
  readSchedule,
  writeSchedule,
} from '@/main/reports/report-scheduler';
import type {
  GenerateStatusReportResponse,
  StatusReport,
  StatusReportDestination,
  StatusReportHistoryResponse,
  StatusReportPreviewResponse,
  StatusReportScheduleResponse,
} from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const windowEnum = z.enum(['24h', '7d', '30d', '90d']);
const destinationEnum = z.enum(['slack', 'notion', 'gmail', 'disk']);

const generateBodySchema = z
  .object({
    window: windowEnum.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    destinations: z.array(destinationEnum).optional(),
  })
  .strict()
  .refine(
    (v) => (v.from === undefined) === (v.to === undefined),
    { message: 'from and to must be supplied together' },
  );

const previewQuerySchema = z
  .object({
    window: windowEnum.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

const historyQuerySchema = z
  .object({
    limit: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine(
        (v) => v === undefined || (Number.isFinite(v) && v >= 1 && v <= 200),
        { message: 'limit must be 1..200' },
      ),
  })
  .strict();

const scheduleBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    cron: z.string().min(1).optional(),
    destinations: z.array(destinationEnum).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function scheduleResponse(): StatusReportScheduleResponse {
  const s = readSchedule();
  return {
    enabled: s.enabled,
    cron: s.cron,
    destinations: s.destinations,
    last_run_at: s.last_run_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                     */
/* -------------------------------------------------------------------------- */

export function statusReportRouter(): Router {
  const router = Router();

  // POST /api/reports/status — generate + publish ---------------------------
  router.post(
    '/status',
    validateBody(generateBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof generateBodySchema>;
      const report = await generateStatusReport({
        ...(body.window !== undefined ? { window: body.window } : {}),
        ...(body.from !== undefined ? { from: body.from } : {}),
        ...(body.to !== undefined ? { to: body.to } : {}),
      });

      // Always persist a disk copy so history has the report. If `disk` was
      // explicitly requested we don't want to publish twice, so fold it into
      // the requested set.
      const requested = new Set<StatusReportDestination>(body.destinations ?? []);
      requested.add('disk');
      const published = await publishReport(report, [...requested]);

      const payload: GenerateStatusReportResponse = { report, published };
      res.json(payload);
    }),
  );

  // GET /api/reports/status/preview — generate without publishing -----------
  router.get(
    '/status/preview',
    validateQuery(previewQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof previewQuerySchema>;
      const report: StatusReport = await generateStatusReport({
        ...(q.window !== undefined ? { window: q.window } : {}),
        ...(q.from !== undefined ? { from: q.from } : {}),
        ...(q.to !== undefined ? { to: q.to } : {}),
      });
      const payload: StatusReportPreviewResponse = report;
      res.json(payload);
    }),
  );

  // GET /api/reports/status/history -----------------------------------------
  router.get(
    '/status/history',
    validateQuery(historyQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { limit?: number };
      const entries = await listReportHistory(q.limit ?? 20);
      const payload: StatusReportHistoryResponse = {
        reports: entries.map((e) => ({
          filename: e.filename,
          generated_at: e.generated_at,
          window: e.window,
          metrics: e.metrics,
        })),
      };
      res.json(payload);
    }),
  );

  // GET /api/reports/status/schedule ----------------------------------------
  router.get(
    '/status/schedule',
    asyncHandler(async (_req, res) => {
      res.json(scheduleResponse());
    }),
  );

  // PATCH /api/reports/status/schedule --------------------------------------
  router.patch(
    '/status/schedule',
    validateBody(scheduleBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof scheduleBodySchema>;
      try {
        writeSchedule({
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.cron !== undefined ? { cron: body.cron } : {}),
          ...(body.destinations !== undefined
            ? { destinations: body.destinations }
            : {}),
        });
      } catch (err) {
        throw new ApiHttpError(
          400,
          'invalid_cron',
          err instanceof Error ? err.message : 'invalid schedule',
        );
      }
      res.json(scheduleResponse());
    }),
  );

  return router;
}
