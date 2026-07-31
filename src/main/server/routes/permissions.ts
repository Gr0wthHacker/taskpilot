/**
 * `/api/tasks/:id/permissions` and `/api/permissions/profiles/*` routes.
 *
 * These endpoints expose TaskPilot's permission system to the renderer
 * (Settings + TaskDetail) and to any external caller (CLI, MCP, scripts).
 * The actual resolution + validation logic lives in `@/main/permissions`.
 *
 * Two routers are exported and mounted separately in `server/index.ts`:
 *   - `taskPermissionsRouter()` lives under `/api/tasks` because its paths
 *     interleave with the existing tasks router (`:id/permissions`).
 *   - `permissionsProfilesRouter()` lives under `/api/permissions`.
 */

import { Router } from 'express';
import { z } from 'zod';

import { permissionSetSchema, taskIdSchema } from '@/shared/io-schemas';
import type {
  ApplyPermissionProfileResponse,
  ClearTaskPermissionsResponse,
  GetTaskPermissionsResponse,
  ListPermissionProfilesResponse,
  UpdateTaskPermissionsResponse,
} from '@/shared/api-contract';
import type { PermissionProfileName, PermissionSet } from '@/shared/types';

import {
  applyProfile,
  buildContextWithPermissions,
  listProfiles,
  readTaskPermissions,
  resolvePermissionsWithSource,
} from '@/main/permissions';
import { getTask, updateTask } from '@/main/db/repositories/tasks';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function assertValidTaskId(id: string): void {
  const parsed = taskIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${id}`);
  }
}

const profileNameSchema = z.enum([
  'trusted-local',
  'sandboxed',
  'read-only-research',
  'github-pr',
]);

const updatePermissionsBodySchema = z.object({
  permissions: permissionSetSchema,
});

const applyProfileBodySchema = z.object({
  task_id: taskIdSchema,
});

/* -------------------------------------------------------------------------- */
/*  Task-scoped router                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted under `/api/tasks`. Routes:
 *   GET    /:id/permissions
 *   PATCH  /:id/permissions
 *   DELETE /:id/permissions
 */
export function taskPermissionsRouter(): Router {
  const router = Router();

  router.get(
    '/:id/permissions',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidTaskId(id);
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const declared = readTaskPermissions(task);
      const { resolved, source } = resolvePermissionsWithSource(task);
      const body: GetTaskPermissionsResponse = {
        permissions: declared,
        resolved,
        source,
      };
      res.json(body);
    }),
  );

  router.patch(
    '/:id/permissions',
    validateBody(updatePermissionsBodySchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidTaskId(id);
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const { permissions } = req.body as z.infer<
        typeof updatePermissionsBodySchema
      >;
      const nextContext = buildContextWithPermissions(
        task.context,
        permissions,
      );
      const updated = updateTask(id, { context: nextContext });
      if (!updated) {
        throw new ApiHttpError(500, 'update_failed', `Couldn't update task ${id}`);
      }
      const { resolved } = resolvePermissionsWithSource(updated);
      const body: UpdateTaskPermissionsResponse = {
        task: updated,
        resolved,
      };
      res.json(body);
    }),
  );

  router.delete(
    '/:id/permissions',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidTaskId(id);
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const nextContext = buildContextWithPermissions(task.context, null);
      const updated = updateTask(id, { context: nextContext });
      if (!updated) {
        throw new ApiHttpError(500, 'update_failed', `Couldn't clear task ${id}`);
      }
      const { resolved } = resolvePermissionsWithSource(updated);
      const body: ClearTaskPermissionsResponse = {
        ok: true,
        task: updated,
        resolved,
      };
      res.json(body);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Profile router                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted at `/api/permissions`. Routes:
 *   GET  /profiles
 *   POST /profiles/:name/apply
 */
export function permissionsProfilesRouter(): Router {
  const router = Router();

  router.get(
    '/profiles',
    asyncHandler(async (_req, res) => {
      const body: ListPermissionProfilesResponse = {
        profiles: listProfiles(),
      };
      res.json(body);
    }),
  );

  router.post(
    '/profiles/:name/apply',
    validateBody(applyProfileBodySchema),
    asyncHandler(async (req, res) => {
      const rawName = String(req.params.name);
      const nameParsed = profileNameSchema.safeParse(rawName);
      if (!nameParsed.success) {
        throw new ApiHttpError(
          404,
          'unknown_profile',
          `Unknown permission profile: ${rawName}`,
        );
      }
      const profile: PermissionProfileName = nameParsed.data;
      const { task_id } = req.body as z.infer<typeof applyProfileBodySchema>;
      const task = getTask(task_id);
      if (!task) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Task ${task_id} not found`,
        );
      }
      const permissions: PermissionSet = applyProfile(profile, task_id);
      const nextContext = buildContextWithPermissions(
        task.context,
        permissions,
      );
      const updated = updateTask(task_id, { context: nextContext });
      if (!updated) {
        throw new ApiHttpError(
          500,
          'update_failed',
          `Couldn't update task ${task_id}`,
        );
      }
      const { resolved } = resolvePermissionsWithSource(updated);
      const body: ApplyPermissionProfileResponse = {
        task: updated,
        profile,
        resolved,
      };
      res.json(body);
    }),
  );

  return router;
}
