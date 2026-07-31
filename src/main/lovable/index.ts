/**
 * Lovable.dev bridge.
 *
 * Lovable is a hosted "describe an app, get a Next.js project" tool that
 * Jack uses for fast prototyping. TaskPilot doesn't drive Lovable itself —
 * that lives in the `anthropic-skills:lovable-builder` skill which uses
 * Chrome MCP automation to type into Lovable's chat surface and read its
 * generated code.
 *
 * This module is intentionally small. Its only job is to track which Lovable
 * project a task targets, so when Claude picks up an execute request it can
 * see "ah, this task is a Lovable thing — invoke the lovable-builder skill"
 * and pass along the project URL/id. No Chrome automation here; no API
 * calls to Lovable here.
 *
 * Context shape on a task:
 *
 *   task.context.lovable = {
 *     project_id: 'project-uuid-or-slug',
 *     url?: 'https://lovable.dev/projects/...'
 *   }
 */

import { getTask, updateTask } from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Error taxonomy                                                            */
/* -------------------------------------------------------------------------- */

export class LovableValidationError extends Error {
  readonly code = 'LOVABLE_INVALID_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'LovableValidationError';
  }
}

export class LovableTaskNotFoundError extends Error {
  readonly code = 'LOVABLE_TASK_NOT_FOUND';
  constructor(taskId: string) {
    super(`Task ${taskId} not found`);
    this.name = 'LovableTaskNotFoundError';
  }
}

/* -------------------------------------------------------------------------- */
/*  Project shape                                                              */
/* -------------------------------------------------------------------------- */

export interface LovableProjectRef {
  project_id: string;
  url: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lovable project ids are URL slugs — alnum, dash, underscore, dot. Allow
 * up to 128 chars to leave room for future schema changes; we don't want
 * to be the layer that rejects an otherwise-valid id.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Accept https:// URLs on the lovable.dev domain only. */
const URL_HOST_RE = /^https:\/\/(?:[a-z0-9-]+\.)?lovable\.dev\//i;

/**
 * Throws `LovableValidationError` when `project_id` doesn't match the
 * expected shape. Returned trimmed when valid.
 */
export function assertProjectId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new LovableValidationError('project_id must be a string');
  }
  const trimmed = input.trim();
  if (!PROJECT_ID_RE.test(trimmed)) {
    throw new LovableValidationError(
      `Invalid project_id (must match ${PROJECT_ID_RE.source})`,
    );
  }
  return trimmed;
}

/**
 * Optional URL. Returns null when absent; throws when present-but-invalid.
 */
export function assertProjectUrl(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') {
    throw new LovableValidationError('url must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2_048) {
    throw new LovableValidationError('url is too long');
  }
  if (!URL_HOST_RE.test(trimmed)) {
    throw new LovableValidationError(
      'url must be on the lovable.dev domain (https://lovable.dev/...)',
    );
  }
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function readContext(task: Task): Record<string, unknown> {
  if (!task.context || typeof task.context !== 'object') return {};
  return { ...(task.context as Record<string, unknown>) };
}

/**
 * Extract the Lovable project ref attached to a task, if any.
 */
export function getProjectFromContext(task: Task): LovableProjectRef | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const ctx = task.context as Record<string, unknown>;
  const lovable = ctx.lovable;
  if (!lovable || typeof lovable !== 'object') return null;
  const raw = lovable as Record<string, unknown>;
  if (typeof raw.project_id !== 'string' || raw.project_id.trim().length === 0) {
    return null;
  }
  return {
    project_id: raw.project_id.trim(),
    url: typeof raw.url === 'string' && raw.url.trim().length > 0
      ? raw.url.trim()
      : null,
  };
}

/**
 * Attach a Lovable project to a task — writes the ref into `context.lovable`
 * without disturbing other context keys. Returns the updated task.
 *
 * Throws `LovableValidationError` on bad input, `LovableTaskNotFoundError`
 * when the task doesn't exist.
 */
export function attachProjectToTask(
  task_id: string,
  project_id: string,
  url?: string | null,
): Task {
  const cleanProjectId = assertProjectId(project_id);
  const cleanUrl = assertProjectUrl(url);

  const task = getTask(task_id);
  if (!task) throw new LovableTaskNotFoundError(task_id);

  const ctx = readContext(task);
  ctx.lovable = {
    project_id: cleanProjectId,
    ...(cleanUrl ? { url: cleanUrl } : {}),
  };

  const updated = updateTask(task_id, { context: ctx });
  if (!updated) throw new LovableTaskNotFoundError(task_id);
  return updated;
}

/**
 * Remove the Lovable ref from a task. No-op if the task isn't tagged with
 * Lovable; returns the (possibly unchanged) task.
 */
export function detachProjectFromTask(task_id: string): Task {
  const task = getTask(task_id);
  if (!task) throw new LovableTaskNotFoundError(task_id);

  const ctx = readContext(task);
  if (!('lovable' in ctx)) return task;
  delete ctx.lovable;

  const next = Object.keys(ctx).length === 0 ? null : ctx;
  const updated = updateTask(task_id, { context: next });
  if (!updated) throw new LovableTaskNotFoundError(task_id);
  return updated;
}
