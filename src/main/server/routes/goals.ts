/**
 * `/api/goals/...` + `POST /api/tasks/:id/goal` routes (Wave 17 — goals tier).
 *
 * Two surfaces:
 *
 *   - `goalsRouter()` mounted at `/api/goals` — CRUD over goals plus
 *     `GET /:id/tasks` (member tasks). The list and detail responses bundle
 *     rolled-up progress.
 *   - `taskGoalRouter()` mounted at `/api/tasks` — `POST /:id/goal` to
 *     attach / detach a task. Mounted separately so the `:id/goal` path sits
 *     alongside `:id/links`, `:id/phase`, etc., without colliding with the
 *     main tasks router.
 *
 * The domain logic lives in `@/main/goals`. These handlers are thin shape
 * mappers onto the HTTP contract in `api-contract.ts`.
 */

import { Router } from 'express';
import type { z } from 'zod';

import {
  attachGoalSchema,
  createGoalSchema,
  goalIdSchema,
  goalStatusSchema,
  taskIdSchema,
  updateGoalSchema,
} from '@/shared/io-schemas';
import type {
  AttachTaskGoalResponse,
  CreateGoalResponse,
  DeleteGoalResponse,
  GetGoalResponse,
  ListGoalsResponse,
  ListGoalTasksResponse,
  UpdateGoalResponse,
} from '@/shared/api-contract';
import type { GoalFilter } from '@/shared/types';

import {
  createGoal,
  deleteGoalAndDetach,
  getGoal,
  getGoalProgress,
  listGoalsWithProgress,
  listGoalTasks,
  setTaskGoal,
  updateGoal,
} from '@/main/goals';
import { getTask } from '@/main/db/repositories/tasks';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function parseGoalId(raw: string): string {
  const parsed = goalIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_goal_id', `Invalid goal id: ${raw}`);
  }
  return parsed.data;
}

function parseTaskId(raw: string): string {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${raw}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Goals router                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted at `/api/goals`. Routes:
 *
 *   GET    /              — list goals with progress (filter: status, workspace)
 *   POST   /              — create
 *   GET    /:id           — goal + progress + member tasks
 *   PATCH  /:id           — update
 *   DELETE /:id           — delete (detaches explicit members)
 *   GET    /:id/tasks     — member tasks
 */
export function goalsRouter(): Router {
  const router = Router();

  // GET /api/goals ---------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const filter: GoalFilter = {};
      const statusRaw = req.query.status;
      if (typeof statusRaw === 'string' && statusRaw.length > 0) {
        const parsed = goalStatusSchema.safeParse(statusRaw);
        if (!parsed.success) {
          throw new ApiHttpError(
            400,
            'invalid_status',
            `Invalid goal status: ${statusRaw}`,
          );
        }
        filter.status = parsed.data;
      }
      const workspaceRaw = req.query.workspace;
      if (typeof workspaceRaw === 'string' && workspaceRaw.length > 0) {
        filter.workspace = workspaceRaw;
      }
      const body: ListGoalsResponse = { goals: listGoalsWithProgress(filter) };
      res.json(body);
    }),
  );

  // POST /api/goals --------------------------------------------------------
  router.post(
    '/',
    validateBody(createGoalSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof createGoalSchema>;
      const goal = createGoal(input);
      const body: CreateGoalResponse = { goal };
      res.status(201).json(body);
    }),
  );

  // GET /api/goals/:id -----------------------------------------------------
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseGoalId(String(req.params.id));
      const goal = getGoal(id);
      if (!goal) {
        throw new ApiHttpError(404, 'not_found', `Goal ${id} not found`);
      }
      const tasks = listGoalTasks(id);
      const body: GetGoalResponse = {
        goal,
        progress: getGoalProgress(id),
        tasks,
      };
      res.json(body);
    }),
  );

  // PATCH /api/goals/:id ---------------------------------------------------
  router.patch(
    '/:id',
    validateBody(updateGoalSchema),
    asyncHandler(async (req, res) => {
      const id = parseGoalId(String(req.params.id));
      const patch = req.body as z.infer<typeof updateGoalSchema>;
      const goal = updateGoal(id, patch);
      if (!goal) {
        throw new ApiHttpError(404, 'not_found', `Goal ${id} not found`);
      }
      const body: UpdateGoalResponse = { goal };
      res.json(body);
    }),
  );

  // DELETE /api/goals/:id --------------------------------------------------
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseGoalId(String(req.params.id));
      const { removed, detached } = deleteGoalAndDetach(id);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', `Goal ${id} not found`);
      }
      const body: DeleteGoalResponse = { ok: true, id, detached };
      res.json(body);
    }),
  );

  // GET /api/goals/:id/tasks -----------------------------------------------
  router.get(
    '/:id/tasks',
    asyncHandler(async (req, res) => {
      const id = parseGoalId(String(req.params.id));
      const goal = getGoal(id);
      if (!goal) {
        throw new ApiHttpError(404, 'not_found', `Goal ${id} not found`);
      }
      const body: ListGoalTasksResponse = { tasks: listGoalTasks(id) };
      res.json(body);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Task → goal router                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted at `/api/tasks` for the attach/detach endpoint.
 *
 *   POST /:id/goal   body { goal_id: string | null }
 */
export function taskGoalRouter(): Router {
  const router = Router();

  router.post(
    '/:id/goal',
    validateBody(attachGoalSchema),
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const { goal_id } = req.body as z.infer<typeof attachGoalSchema>;
      // When attaching, the goal must exist — refuse a dangling pointer.
      if (goal_id !== null) {
        const goal = getGoal(goal_id);
        if (!goal) {
          throw new ApiHttpError(404, 'goal_not_found', `Goal ${goal_id} not found`);
        }
      }
      const updated = setTaskGoal(id, goal_id);
      if (!updated) {
        throw new ApiHttpError(500, 'update_failed', `Failed to update ${id}`);
      }
      const body: AttachTaskGoalResponse = { ok: true, task: updated };
      res.json(body);
    }),
  );

  return router;
}
