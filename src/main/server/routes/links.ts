/**
 * `/api/tasks/:id/links` + `/api/skills/*` routes.
 *
 * Two routers exported from one file because they're tightly coupled in the
 * intelligence layer feature (Wave 12). Mounted separately in
 * `server/index.ts` so the URL space stays clean:
 *
 *   - `taskLinksRouter()` → mounted under `/api/tasks`
 *   - `skillsRouter()`    → mounted under `/api/skills`
 */

import { Router } from 'express';
import { z } from 'zod';

import { taskIdSchema, taskLinksPatchSchema } from '@/shared/io-schemas';
import type {
  AddTaskBlockResponse,
  GetTaskLinksResponse,
  ListSkillsResponse,
  RegisterSkillResponse,
  RemoveTaskBlockResponse,
  SuggestSkillsForTaskResponse,
  UpdateTaskLinksResponse,
} from '@/shared/api-contract';

import { getTask } from '@/main/db/repositories/tasks';
import {
  addBlock,
  findBlockedBy,
  getTaskLinks,
  patchTaskLinks,
  removeBlock,
} from '@/main/links';
import {
  listKnownSkills,
  registerCustomSkill,
  suggestSkillsForTask,
} from '@/main/skill-binding';

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
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const registerSkillBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_-]+(?::[a-z0-9_-]+)?$/, 'Invalid skill id'),
  label: z.string().min(1).max(128),
  description: z.string().min(1).max(2_000),
  keywords: z.array(z.string().max(64)).max(32).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Task links router                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted under `/api/tasks`. Routes:
 *
 *   GET    /:id/links
 *   PATCH  /:id/links
 *   POST   /:id/links/blocks/:other_id
 *   DELETE /:id/links/blocks/:other_id
 */
export function taskLinksRouter(): Router {
  const router = Router();

  router.get(
    '/:id/links',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const view = getTaskLinks(id);
      if (!view) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body: GetTaskLinksResponse = {
        links: view.links,
        blocked_by: view.blocked_by,
      };
      res.json(body);
    }),
  );

  router.patch(
    '/:id/links',
    validateBody(taskLinksPatchSchema),
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const patch = req.body as z.infer<typeof taskLinksPatchSchema>;
      const updated = patchTaskLinks(id, patch);
      if (!updated) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const task = getTask(id);
      if (!task) {
        // Couldn't happen — patchTaskLinks returned non-null — but the type
        // narrowing wants it spelled out.
        throw new ApiHttpError(500, 'update_failed', `Failed to reload ${id}`);
      }
      const body: UpdateTaskLinksResponse = {
        task,
        links: updated,
        blocked_by: findBlockedBy(id),
      };
      res.json(body);
    }),
  );

  router.post(
    '/:id/links/blocks/:other_id',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const otherId = parseTaskId(String(req.params.other_id));
      const links = addBlock(id, otherId);
      if (!links) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Either task ${id} or ${otherId} doesn't exist (or they're the same)`,
        );
      }
      const body: AddTaskBlockResponse = { ok: true, links };
      res.json(body);
    }),
  );

  router.delete(
    '/:id/links/blocks/:other_id',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const otherId = parseTaskId(String(req.params.other_id));
      const links = removeBlock(id, otherId);
      if (!links) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body: RemoveTaskBlockResponse = { ok: true, links };
      res.json(body);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Skills router                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted at `/api/skills`. Routes:
 *
 *   GET  /            → list every known skill (built-ins + customs)
 *   GET  /suggest/:id → suggest top-3 skills for a task by keyword match
 *   POST /register    → register / update a custom skill
 */
export function skillsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const body: ListSkillsResponse = { skills: listKnownSkills() };
      res.json(body);
    }),
  );

  router.get(
    '/suggest/:task_id',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.task_id));
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body: SuggestSkillsForTaskResponse = {
        task_id: id,
        skills: suggestSkillsForTask(task, 5),
      };
      res.json(body);
    }),
  );

  router.post(
    '/register',
    validateBody(registerSkillBodySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof registerSkillBodySchema>;
      const skill = registerCustomSkill({
        name: input.name,
        label: input.label,
        description: input.description,
        ...(input.keywords ? { keywords: input.keywords } : {}),
      });
      const body: RegisterSkillResponse = { ok: true, skill };
      res.json(body);
    }),
  );

  return router;
}
