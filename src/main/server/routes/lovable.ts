/**
 * `/api/tasks/:id/lovable` routes (mounted under `/api`).
 *
 * Attach / detach a Lovable.dev project ref on a task. Nothing fancy — this
 * is just typed CRUD over `task.context.lovable`. The actual Lovable
 * browser automation lives in the `anthropic-skills:lovable-builder` skill,
 * not here.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  LovableTaskNotFoundError,
  LovableValidationError,
  attachProjectToTask,
  detachProjectFromTask,
  getProjectFromContext,
} from '@/main/lovable';
import { getTask } from '@/main/db/repositories/tasks';
import { taskIdSchema } from '@/shared/io-schemas';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const attachSchema = z.object({
  project_id: z.string().min(1).max(128),
  url: z.string().url().max(2_048).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Error translation                                                          */
/* -------------------------------------------------------------------------- */

function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof LovableValidationError) {
    return new ApiHttpError(400, 'lovable_invalid_input', err.message);
  }
  if (err instanceof LovableTaskNotFoundError) {
    return new ApiHttpError(404, 'not_found', err.message);
  }
  return new ApiHttpError(
    500,
    'lovable_unknown',
    err instanceof Error ? err.message : 'Unknown Lovable error',
  );
}

function safe<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      throw toApiError(err);
    });
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                     */
/* -------------------------------------------------------------------------- */

export function lovableRouter(): Router {
  const router = Router();

  // GET /api/tasks/:id/lovable — return the attached ref (or null).
  router.get(
    '/tasks/:id/lovable',
    asyncHandler(async (req, res) => {
      const parsed = taskIdSchema.safeParse(req.params.id);
      if (!parsed.success) {
        throw new ApiHttpError(400, 'invalid_task_id', 'Invalid task id');
      }
      const task = getTask(parsed.data);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${parsed.data} not found`);
      }
      const ref = getProjectFromContext(task);
      res.json({ lovable: ref });
    }),
  );

  // POST /api/tasks/:id/lovable — attach.
  router.post(
    '/tasks/:id/lovable',
    validateBody(attachSchema),
    asyncHandler(async (req, res) => {
      const parsed = taskIdSchema.safeParse(req.params.id);
      if (!parsed.success) {
        throw new ApiHttpError(400, 'invalid_task_id', 'Invalid task id');
      }
      const body = req.body as z.infer<typeof attachSchema>;
      const updated = await safe(() =>
        attachProjectToTask(parsed.data, body.project_id, body.url ?? null),
      );
      res.json({ ok: true, task: updated, lovable: getProjectFromContext(updated) });
    }),
  );

  // DELETE /api/tasks/:id/lovable — detach.
  router.delete(
    '/tasks/:id/lovable',
    asyncHandler(async (req, res) => {
      const parsed = taskIdSchema.safeParse(req.params.id);
      if (!parsed.success) {
        throw new ApiHttpError(400, 'invalid_task_id', 'Invalid task id');
      }
      const updated = await safe(() => detachProjectFromTask(parsed.data));
      res.json({ ok: true, task: updated });
    }),
  );

  return router;
}
