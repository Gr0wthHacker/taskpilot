/**
 * Decision-log routes (Wave 16).
 *
 * Two routers so the paths sit where the spec wants them:
 *   - `decisionsRouter()`  → mounted under `/api/tasks`, adds
 *       GET  /:id/decisions   — list a task's decision log (newest-first)
 *       POST /:id/decisions   — append a new entry
 *   - `decisionsRootRouter()` → mounted at `/api/decisions`, adds
 *       DELETE /:id           — delete a single entry
 *
 * The list/create pair lives under `/api/tasks` alongside `:id/journal`,
 * `:id/links`, etc. Delete keys off the decision's own id (not the task id),
 * so it gets its own top-level namespace.
 */

import { Router } from 'express';

import {
  deleteDecision,
  listDecisionsForTask,
  recordDecision,
} from '@/main/decisions';
import { getTask } from '@/main/db/repositories/tasks';
import { createDecisionSchema, taskIdSchema } from '@/shared/io-schemas';
import type {
  CreateDecisionResponse,
  DeleteDecisionResponse,
  ListDecisionsResponse,
} from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

function parseTaskId(raw: string): string {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${raw}`);
  }
  return parsed.data;
}

/**
 * Decision id shape — same constraints as a task id (nanoid alphabet,
 * bounded length) so it can never escape into a path / SQL injection.
 */
function parseDecisionId(raw: string): string {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(
      400,
      'invalid_decision_id',
      `Invalid decision id: ${raw}`,
    );
  }
  return parsed.data;
}

/**
 * Sub-router mounted at `/api/tasks`. Adds the per-task list + create.
 */
export function decisionsRouter(): Router {
  const router = Router();

  router.get(
    '/:id/decisions',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const decisions = listDecisionsForTask(id);
      const body: ListDecisionsResponse = { decisions };
      res.json(body);
    }),
  );

  router.post(
    '/:id/decisions',
    validateBody(createDecisionSchema),
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body = req.body as import('@/shared/io-schemas').CreateDecisionInput;
      const decision = recordDecision({
        task_id: id,
        text: body.text,
        category: body.category,
        ...(body.author !== undefined ? { author: body.author } : {}),
        ...(body.link !== undefined ? { link: body.link } : {}),
      });
      const response: CreateDecisionResponse = { decision };
      res.status(201).json(response);
    }),
  );

  return router;
}

/**
 * Router mounted at `/api/decisions`. Adds DELETE /:id.
 */
export function decisionsRootRouter(): Router {
  const router = Router();

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseDecisionId(String(req.params.id));
      const removed = deleteDecision(id);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', `Decision ${id} not found`);
      }
      const body: DeleteDecisionResponse = { ok: true, id };
      res.json(body);
    }),
  );

  return router;
}
