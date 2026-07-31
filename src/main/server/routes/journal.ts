/**
 * `/api/tasks/:id/journal` route (Wave 15A).
 *
 * Mounted under `/api/tasks` so the path sits alongside `:id/links`,
 * `:id/attachments`, `:id/permissions`. Returns the full ordered narrative
 * of events that touched a task — built by the aggregator from execution
 * logs, feedback rows, cost events, the on-disk result/derived JSON, and
 * the task's `context` blob.
 */

import { Router } from 'express';
import { z } from 'zod';

import { getTaskJournal } from '@/main/journal/aggregator';
import { getTask } from '@/main/db/repositories/tasks';
import { taskIdSchema } from '@/shared/io-schemas';
import type { JournalResponse } from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Query string validation. `since` must be an ISO-parseable timestamp;
 * `limit` clamps to 1..500 to match the aggregator. Express delivers
 * everything as strings so we coerce limit explicitly.
 */
const journalQuerySchema = z
  .object({
    since: z
      .string()
      .min(1)
      .max(64)
      .refine((v) => Number.isFinite(Date.parse(v)), 'invalid ISO timestamp')
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

function parseTaskId(raw: string): string {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${raw}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted at `/api/tasks`. Adds:
 *
 *   GET /:id/journal
 */
export function journalRouter(): Router {
  const router = Router();

  router.get(
    '/:id/journal',
    validateQuery(journalQuerySchema),
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      // Surface 404 explicitly so the renderer can show a "not found" panel
      // rather than an empty timeline that's indistinguishable from "no
      // events yet".
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const q = req.query as z.infer<typeof journalQuerySchema>;
      const events = await getTaskJournal(id, {
        ...(q.since !== undefined ? { since: q.since } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      const body: JournalResponse = { events };
      res.json(body);
    }),
  );

  return router;
}
