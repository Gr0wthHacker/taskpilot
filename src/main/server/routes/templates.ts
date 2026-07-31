/**
 * `/api/templates/...` routes.
 *
 * Thin wrappers over the task-templates repository. Templates are pure CRUD;
 * the only specialty endpoint is `POST /:id/materialize`, which spawns one or
 * more tasks from a template (with optional `{{variable}}` substitution).
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  agentMethodSchema,
  tagSchema,
  taskIdSchema,
  taskPrioritySchema,
} from '@/shared/io-schemas';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  materializeTemplate,
  updateTemplate,
} from '@/main/db/repositories/task-templates';
import type { MaterializeTemplateOverrides, Task } from '@/shared/types';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const createTemplateBodySchema = z.object({
  id: taskIdSchema.optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  task_title: z.string().min(1).max(500),
  task_description: z.string().max(50_000).nullable().optional(),
  priority: taskPrioritySchema.nullable().optional(),
  agent_method: agentMethodSchema.nullable().optional(),
  agent_instructions: z.string().max(50_000).nullable().optional(),
  tags: z.array(tagSchema).max(64).optional(),
  context: z.record(z.string().max(128), z.unknown()).nullable().optional(),
});

const updateTemplateBodySchema = createTemplateBodySchema
  .partial()
  .extend({
    name: z.string().min(1).max(200).optional(),
    task_title: z.string().min(1).max(500).optional(),
  });

const materializeBodySchema = z.object({
  overrides: z
    .object({
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(50_000).nullable().optional(),
      priority: taskPrioritySchema.optional(),
      due: z.string().max(64).nullable().optional(),
      tags: z.array(tagSchema).max(64).optional(),
      agent_method: agentMethodSchema.optional(),
      agent_instructions: z.string().max(50_000).nullable().optional(),
      context: z.record(z.string().max(128), z.unknown()).nullable().optional(),
      variables: z.record(z.string().max(64), z.string().max(5_000)).optional(),
    })
    .optional(),
  count: z.number().int().min(1).max(50).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function assertValidId(id: string): void {
  const parsed = taskIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new ApiHttpError(
      400,
      'invalid_template_id',
      `Invalid template id: ${id}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function templatesRouter(): Router {
  const router = Router();

  // GET /api/templates -----------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const templates = listTemplates();
      res.json({ templates });
    }),
  );

  // POST /api/templates ----------------------------------------------------
  router.post(
    '/',
    validateBody(createTemplateBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createTemplateBodySchema>;
      const template = createTemplate(body);
      res.status(201).json({ template });
    }),
  );

  // GET /api/templates/:id -------------------------------------------------
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const template = getTemplate(id);
      if (!template) {
        throw new ApiHttpError(404, 'not_found', `Template ${id} not found`);
      }
      res.json({ template });
    }),
  );

  // PATCH /api/templates/:id ----------------------------------------------
  router.patch(
    '/:id',
    validateBody(updateTemplateBodySchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const patch = req.body as z.infer<typeof updateTemplateBodySchema>;
      const template = updateTemplate(id, patch);
      if (!template) {
        throw new ApiHttpError(404, 'not_found', `Template ${id} not found`);
      }
      res.json({ template });
    }),
  );

  // DELETE /api/templates/:id ----------------------------------------------
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const removed = deleteTemplate(id);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', `Template ${id} not found`);
      }
      res.json({ ok: true, id });
    }),
  );

  // POST /api/templates/:id/materialize ------------------------------------
  router.post(
    '/:id/materialize',
    validateBody(materializeBodySchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const { overrides, count } = req.body as z.infer<
        typeof materializeBodySchema
      >;
      const total = count ?? 1;
      const created: Task[] = [];
      for (let i = 0; i < total; i++) {
        const task = materializeTemplate(
          id,
          (overrides ?? {}) as MaterializeTemplateOverrides,
        );
        if (!task) {
          throw new ApiHttpError(404, 'not_found', `Template ${id} not found`);
        }
        created.push(task);
      }
      res.status(201).json({ tasks: created });
    }),
  );

  return router;
}
