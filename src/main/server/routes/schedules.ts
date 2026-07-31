/**
 * `/api/schedules/*` routes — recurring schedule CRUD + manual fire.
 *
 * Schedules fire on a wall-clock cadence (separate from task-level
 * recurrence). The scheduler tick handles the time-driven path; this
 * router is for managing the rules and triggering a one-off fire.
 *
 * Mounted by `server/index.ts`:
 *     app.use('/api/schedules', schedulesRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  ScheduleFireError,
  createSchedule,
  deleteSchedule,
  fireSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
} from '@/main/schedules';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const recurrenceKindSchema = z.enum(['daily', 'weekdays', 'weekly', 'monthly']);

const childTemplateSchema = z.object({
  title_template: z.string().min(1).max(500),
  instructions_template: z.string().max(50_000).optional(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  agent_method: z.enum(['human_only', 'cli', 'cowork', 'either']).optional(),
  agent_executable: z.boolean().optional(),
  permission_profile: z
    .enum(['trusted-local', 'sandboxed', 'read-only-research', 'github-pr'])
    .optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  enabled: z.boolean().optional(),
  recurrence_kind: recurrenceKindSchema,
  recurrence_interval: z.number().int().positive().max(366).optional(),
  next_fire_at: z.string().min(1).max(64),
  fan_out_goal_id: z.string().min(1).max(64).optional(),
  child_templates: z.array(childTemplateSchema).min(1).max(32),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
  enabled: z.boolean().optional(),
  recurrence_kind: recurrenceKindSchema.optional(),
  recurrence_interval: z.number().int().positive().max(366).optional(),
  next_fire_at: z.string().min(1).max(64).optional(),
  fan_out_goal_id: z.string().min(1).max(64).nullable().optional(),
  child_templates: z.array(childTemplateSchema).min(1).max(32).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof ScheduleFireError) {
    const status = err.code === 'schedule_not_found' ? 404 : 400;
    return new ApiHttpError(status, err.code, err.message);
  }
  if (err instanceof Error) {
    // Repository validation errors (invalid kind, empty children, bad iso).
    return new ApiHttpError(400, 'schedule_invalid', err.message);
  }
  return new ApiHttpError(500, 'schedule_error', 'Unknown schedule error');
}

function safe<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      throw toApiError(err);
    });
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function schedulesRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const schedules = listSchedules();
      res.json({ schedules });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const schedule = getSchedule(id);
      if (!schedule) {
        throw new ApiHttpError(404, 'not_found', `Schedule ${id} not found`);
      }
      res.json({ schedule });
    }),
  );

  router.post(
    '/',
    validateBody(createSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createSchema>;
      const schedule = await safe(() =>
        createSchedule({
          name: body.name,
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          recurrence_kind: body.recurrence_kind,
          ...(body.recurrence_interval !== undefined
            ? { recurrence_interval: body.recurrence_interval }
            : {}),
          next_fire_at: body.next_fire_at,
          ...(body.fan_out_goal_id !== undefined
            ? { fan_out_goal_id: body.fan_out_goal_id }
            : {}),
          child_templates: body.child_templates,
        }),
      );
      res.status(201).json({ schedule });
    }),
  );

  router.patch(
    '/:id',
    validateBody(updateSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const body = req.body as z.infer<typeof updateSchema>;
      const updated = await safe(() => updateSchedule(id, body));
      if (!updated) {
        throw new ApiHttpError(404, 'not_found', `Schedule ${id} not found`);
      }
      res.json({ schedule: updated });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const ok = deleteSchedule(id);
      if (!ok) {
        throw new ApiHttpError(404, 'not_found', `Schedule ${id} not found`);
      }
      res.json({ ok: true });
    }),
  );

  router.post(
    '/:id/fire-now',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const result = await safe(() => fireSchedule(id));
      res.json(result);
    }),
  );

  return router;
}
