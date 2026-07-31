/**
 * `/api/plan/...` routes.
 *
 * `POST /api/plan/today` synthesizes the daily plan from calendar events +
 * tasks. `GET /api/plan/today` is exposed as a convenience alias so the CLI
 * and any one-off curl can hit it without crafting a body. Both accept an
 * optional `date` (`YYYY-MM-DD`) to plan a different day.
 */

import { Router } from 'express';
import { z } from 'zod';

import { generateTodaysPlan, type DailyPlan } from '@/main/plan/generator';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be YYYY-MM-DD',
  })
  .optional();

const planBodySchema = z
  .object({
    date: dateString,
  })
  .partial();

const planQuerySchema = z
  .object({
    date: dateString,
  })
  .partial();

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function parseDate(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  // Pin to local midnight so the generator's start-of-day math stays in the
  // user's wall clock. `new Date('YYYY-MM-DD')` would land at UTC midnight,
  // which on the West Coast renders as the *previous* calendar day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) {
    throw new ApiHttpError(400, 'invalid_date', `Invalid date "${raw}"`);
  }
  const [, yStr, monthStr, dayStr] = m;
  const y = Number.parseInt(yStr ?? '0', 10);
  const mo = Number.parseInt(monthStr ?? '0', 10) - 1;
  const d = Number.parseInt(dayStr ?? '0', 10);
  const dt = new Date(y, mo, d, 0, 0, 0, 0);
  if (Number.isNaN(dt.getTime())) {
    throw new ApiHttpError(400, 'invalid_date', `Invalid date "${raw}"`);
  }
  return dt;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function planRouter(): Router {
  const router = Router();

  router.post(
    '/today',
    validateBody(planBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof planBodySchema>;
      const when = parseDate(body.date);
      const plan: DailyPlan = await generateTodaysPlan(when);
      res.json(plan);
    }),
  );

  router.get(
    '/today',
    validateQuery(planQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof planQuerySchema>;
      const when = parseDate(q.date);
      const plan: DailyPlan = await generateTodaysPlan(when);
      res.json(plan);
    }),
  );

  return router;
}
