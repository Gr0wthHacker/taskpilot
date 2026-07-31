/**
 * `/api/phases/...` + `/api/tasks/:id/phase/...` routes (Wave 15).
 *
 * Two surfaces:
 *
 *   - `phasesRouter()` mounted at `/api/phases` — CRUD over the pipeline
 *     catalog plus a "reset to defaults" helper.
 *   - `taskPhasesRouter()` mounted at `/api/tasks` — read + patch a single
 *     task's phase assignment, advance, regress.
 *
 * The actual phase model lives in `@/main/phases`. These handlers are thin
 * pass-throughs that map shapes onto the HTTP contract in `api-contract.ts`.
 */

import { Router } from 'express';
import type { z } from 'zod';

import {
  pipelinePatchSchema,
  pipelineSchema,
  taskIdSchema,
  taskPhasePatchSchema,
} from '@/shared/io-schemas';
import type {
  CreatePipelineResponse,
  DeletePipelineResponse,
  GetTaskPhaseResponse,
  ListPipelinesResponse,
  UpdatePipelineResponse,
  UpdateTaskPhaseResponse,
} from '@/shared/api-contract';

import {
  advancePhase,
  deletePipeline,
  getPhaseAssignment,
  listPipelines,
  regressPhase,
  resetPipelines,
  setTaskPhase,
  upsertPipeline,
} from '@/main/phases';
import { getTask } from '@/main/db/repositories/tasks';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function parseTaskId(raw: string): string {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${raw}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Pipelines router                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted under `/api/phases`. Routes:
 *
 *   GET    /pipelines
 *   POST   /pipelines
 *   PATCH  /pipelines/:id
 *   DELETE /pipelines/:id
 *   POST   /pipelines/reset
 */
export function phasesRouter(): Router {
  const router = Router();

  router.get(
    '/pipelines',
    asyncHandler(async (_req, res) => {
      const body: ListPipelinesResponse = { pipelines: listPipelines() };
      res.json(body);
    }),
  );

  router.post(
    '/pipelines',
    validateBody(pipelineSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof pipelineSchema>;
      // Refuse if the id already exists — POST is "create", not "upsert".
      // PATCH is the upsert path.
      const existing = listPipelines().find((p) => p.id === input.id);
      if (existing) {
        throw new ApiHttpError(
          409,
          'pipeline_exists',
          `Pipeline "${input.id}" already exists. PATCH it to update.`,
        );
      }
      try {
        const pipeline = upsertPipeline(input);
        const body: CreatePipelineResponse = { pipeline };
        res.status(201).json(body);
      } catch (cause) {
        throw new ApiHttpError(
          400,
          'invalid_pipeline',
          cause instanceof Error ? cause.message : 'Invalid pipeline shape',
        );
      }
    }),
  );

  router.patch(
    '/pipelines/:id',
    validateBody(pipelinePatchSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id ?? '');
      if (id.length === 0) {
        throw new ApiHttpError(400, 'bad_request', 'Missing pipeline id');
      }
      const existing = listPipelines().find((p) => p.id === id);
      if (!existing) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Pipeline "${id}" not found`,
        );
      }
      const patch = req.body as z.infer<typeof pipelinePatchSchema>;
      const merged = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.phases !== undefined ? { phases: patch.phases } : {}),
        ...(patch.applies_to !== undefined
          ? { applies_to: patch.applies_to }
          : {}),
        ...(patch.default !== undefined ? { default: patch.default } : {}),
      };
      try {
        const pipeline = upsertPipeline(merged);
        const body: UpdatePipelineResponse = { pipeline };
        res.json(body);
      } catch (cause) {
        throw new ApiHttpError(
          400,
          'invalid_pipeline',
          cause instanceof Error ? cause.message : 'Invalid pipeline shape',
        );
      }
    }),
  );

  router.delete(
    '/pipelines/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id ?? '');
      if (id.length === 0) {
        throw new ApiHttpError(400, 'bad_request', 'Missing pipeline id');
      }
      const removed = deletePipeline(id);
      if (!removed) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Pipeline "${id}" not found`,
        );
      }
      const body: DeletePipelineResponse = { ok: true, id };
      res.json(body);
    }),
  );

  router.post(
    '/pipelines/reset',
    asyncHandler(async (_req, res) => {
      const pipelines = resetPipelines();
      const body: ListPipelinesResponse = { pipelines };
      res.json(body);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Task-phase router                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted at `/api/tasks` for the per-task phase endpoints.
 * Mounted separately so the URL space stays tidy alongside `:id/links`,
 * `:id/permissions`, etc.
 *
 *   GET   /:id/phase
 *   PATCH /:id/phase
 *   POST  /:id/phase/advance
 *   POST  /:id/phase/regress
 */
export function taskPhasesRouter(): Router {
  const router = Router();

  router.get(
    '/:id/phase',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const view = getPhaseAssignment(id);
      if (!view) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body: GetTaskPhaseResponse = view;
      res.json(body);
    }),
  );

  router.patch(
    '/:id/phase',
    validateBody(taskPhasePatchSchema),
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const patch = req.body as z.infer<typeof taskPhasePatchSchema>;
      const updated = setTaskPhase(
        id,
        patch.phase,
        patch.pipeline_id === undefined ? undefined : patch.pipeline_id,
      );
      if (!updated) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(500, 'update_failed', `Failed to reload ${id}`);
      }
      const body: UpdateTaskPhaseResponse = {
        task,
        pipeline: updated.pipeline,
        phase: updated.phase,
        phase_definition: updated.phase_definition,
      };
      res.json(body);
    }),
  );

  router.post(
    '/:id/phase/advance',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const updated = advancePhase(id);
      if (!updated) {
        throw new ApiHttpError(
          409,
          'phase_at_terminal',
          'No next phase — already at the end of the pipeline (or no pipeline applies).',
        );
      }
      const refreshed = getTask(id);
      if (!refreshed) {
        throw new ApiHttpError(500, 'update_failed', `Failed to reload ${id}`);
      }
      const body: UpdateTaskPhaseResponse = {
        task: refreshed,
        pipeline: updated.pipeline,
        phase: updated.phase,
        phase_definition: updated.phase_definition,
      };
      res.json(body);
    }),
  );

  router.post(
    '/:id/phase/regress',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const updated = regressPhase(id);
      if (!updated) {
        throw new ApiHttpError(
          409,
          'phase_at_start',
          'No previous phase — already at the start (or no pipeline applies).',
        );
      }
      const refreshed = getTask(id);
      if (!refreshed) {
        throw new ApiHttpError(500, 'update_failed', `Failed to reload ${id}`);
      }
      const body: UpdateTaskPhaseResponse = {
        task: refreshed,
        pipeline: updated.pipeline,
        phase: updated.phase,
        phase_definition: updated.phase_definition,
      };
      res.json(body);
    }),
  );

  return router;
}
