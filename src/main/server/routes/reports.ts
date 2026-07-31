/**
 * `/api/reports/...` routes.
 *
 * Read-only analytics endpoints powering the Reports dashboard. Every route
 * here is GET-only, returns plain JSON, and delegates to pure aggregation
 * functions in `@/main/reports/aggregations`. No mutations. No side effects.
 *
 * Query-string contract:
 *   - `?days=N` (integer 1..365) for the time-series endpoints.
 *   - `?window=7d|30d|90d|all` for the rate / median / heat-map endpoints.
 *   - `/all` accepts both and forwards them.
 *
 * Invalid query strings 400 via Zod / the standard ValidationError envelope.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  agentSuccessRate,
  recentFailures,
  reportBundle,
  reviewQueueTrend,
  tagHeatMap,
  throughput,
  timeToDoneByPriority,
  timeToDoneByTag,
  type AgentSuccessRate,
  type RecentFailureRow,
  type ReportBundle,
  type ReportWindow,
  type ReviewQueueTrendPoint,
  type TagHeatMapRow,
  type ThroughputPoint,
  type TimeToDoneByPriority,
  type TimeToDoneByTagRow,
} from '@/main/reports/aggregations';

import { asyncHandler, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Response types (re-exported for the API contract)                         */
/* -------------------------------------------------------------------------- */

export interface ThroughputResponse {
  days: number;
  points: ThroughputPoint[];
}

export interface SuccessRateResponse {
  window: ReportWindow;
  rate: AgentSuccessRate;
}

export interface TimeToDoneResponse {
  window: ReportWindow;
  by_priority: TimeToDoneByPriority;
  by_tag: TimeToDoneByTagRow[];
}

export interface TagHeatMapResponse {
  window: ReportWindow;
  rows: TagHeatMapRow[];
}

export interface RecentFailuresResponse {
  failures: RecentFailureRow[];
}

export interface ReviewTrendResponse {
  days: number;
  points: ReviewQueueTrendPoint[];
}

export type ReportsAllResponse = ReportBundle;

/* -------------------------------------------------------------------------- */
/*  Query schemas                                                             */
/* -------------------------------------------------------------------------- */

const daysSchema = z
  .object({
    days: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine(
        (v) => v === undefined || (Number.isFinite(v) && v >= 1 && v <= 365),
        { message: 'days must be 1..365' },
      ),
  })
  .strict();

const windowSchema = z
  .object({
    window: z.enum(['7d', '30d', '90d', 'all']).optional(),
  })
  .strict();

const allQuerySchema = z
  .object({
    window: z.enum(['7d', '30d', '90d', 'all']).optional(),
    days: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine(
        (v) => v === undefined || (Number.isFinite(v) && v >= 1 && v <= 365),
        { message: 'days must be 1..365' },
      ),
  })
  .strict();

const failuresQuerySchema = z
  .object({
    limit: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine(
        (v) => v === undefined || (Number.isFinite(v) && v >= 1 && v <= 100),
        { message: 'limit must be 1..100' },
      ),
  })
  .strict();

const tagsQuerySchema = z
  .object({
    window: z.enum(['7d', '30d', '90d', 'all']).optional(),
    limit: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine(
        (v) => v === undefined || (Number.isFinite(v) && v >= 1 && v <= 100),
        { message: 'limit must be 1..100' },
      ),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function reportsRouter(): Router {
  const router = Router();

  // GET /api/reports/throughput?days=30 ------------------------------------
  router.get(
    '/throughput',
    validateQuery(daysSchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { days?: number };
      const days = q.days ?? 30;
      const body: ThroughputResponse = {
        days,
        points: throughput(days),
      };
      res.json(body);
    }),
  );

  // GET /api/reports/success-rate?window=30d -------------------------------
  router.get(
    '/success-rate',
    validateQuery(windowSchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { window?: ReportWindow };
      const window = q.window ?? '30d';
      const body: SuccessRateResponse = {
        window,
        rate: agentSuccessRate(window),
      };
      res.json(body);
    }),
  );

  // GET /api/reports/time-to-done?window=30d -------------------------------
  router.get(
    '/time-to-done',
    validateQuery(windowSchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { window?: ReportWindow };
      const window = q.window ?? '30d';
      const body: TimeToDoneResponse = {
        window,
        by_priority: timeToDoneByPriority(window),
        by_tag: timeToDoneByTag(window, 10),
      };
      res.json(body);
    }),
  );

  // GET /api/reports/tags?window=30d&limit=20 ------------------------------
  router.get(
    '/tags',
    validateQuery(tagsQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { window?: ReportWindow; limit?: number };
      const window = q.window ?? '30d';
      const limit = q.limit ?? 20;
      const body: TagHeatMapResponse = {
        window,
        rows: tagHeatMap(window, limit),
      };
      res.json(body);
    }),
  );

  // GET /api/reports/failures?limit=10 -------------------------------------
  router.get(
    '/failures',
    validateQuery(failuresQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { limit?: number };
      const limit = q.limit ?? 10;
      const body: RecentFailuresResponse = {
        failures: recentFailures(limit),
      };
      res.json(body);
    }),
  );

  // GET /api/reports/review-trend?days=30 ----------------------------------
  router.get(
    '/review-trend',
    validateQuery(daysSchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { days?: number };
      const days = q.days ?? 30;
      const body: ReviewTrendResponse = {
        days,
        points: reviewQueueTrend(days),
      };
      res.json(body);
    }),
  );

  // GET /api/reports/all?window=30d&days=30 --------------------------------
  router.get(
    '/all',
    validateQuery(allQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as { window?: ReportWindow; days?: number };
      const window = q.window ?? '30d';
      const body: ReportsAllResponse = reportBundle(window, q.days);
      res.json(body);
    }),
  );

  return router;
}
