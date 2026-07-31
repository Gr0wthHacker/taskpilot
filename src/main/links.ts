/**
 * Task links (Wave 12 intelligence layer).
 *
 * Cross-task relationships beyond `parent_id`. Stored at
 * `task.context.links` so no schema change is required. Three relations:
 *
 *   - `blocks` — this task blocks the listed task ids.
 *   - `related` — bidirectional general relation.
 *   - `duplicate_of` — marks this task as a duplicate of another.
 *
 * The repository owns CRUD; integrity (cleanup on delete) is delegated to
 * `cleanupLinksForDeletedTask` which the tasks repo calls before deletion.
 *
 * Module is pure-synchronous — better-sqlite3 is sync and so are the
 * repository helpers we use.
 */

import { taskLinksSchema, type TaskLinksPatch } from '@/shared/io-schemas';
import type { Task, TaskLinks } from '@/shared/types';

import {
  getTask,
  listTasks,
  registerOnTaskPreDelete,
  updateTask,
} from '@/main/db/repositories/tasks';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Path key on a task's `context` where the {@link TaskLinks} block lives. */
export const LINKS_CONTEXT_KEY = 'links';

/**
 * Canonical "empty" links object. Used when a task hasn't declared anything
 * yet — the read path always returns a fully materialized shape so the UI
 * doesn't have to guard for `undefined` arrays.
 */
function emptyLinks(): TaskLinks {
  return { blocks: [], related: [], duplicate_of: null };
}

/* -------------------------------------------------------------------------- */
/*  Read helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read the raw {@link TaskLinks} block off a task. Returns an empty object
 * when the task has no links, when the context isn't a plain object, or when
 * the stored value fails schema validation. Validation errors are swallowed
 * silently — a corrupted links blob shouldn't break the rest of the row.
 */
export function readTaskLinks(task: Task | null): TaskLinks {
  if (!task || !task.context || typeof task.context !== 'object') {
    return emptyLinks();
  }
  const raw = (task.context as Record<string, unknown>)[LINKS_CONTEXT_KEY];
  if (!raw || typeof raw !== 'object') return emptyLinks();
  const parsed = taskLinksSchema.safeParse(raw);
  if (!parsed.success) return emptyLinks();
  return parsed.data;
}

/**
 * Compute the reverse "blocked_by" set for a task by scanning every other
 * task's `blocks` array. Linear in the number of tasks — fine for the local
 * SQLite scale (thousands at most).
 *
 * `include_archived: true` so we don't drop blockers that have been put on
 * ice but technically still block work.
 */
export function findBlockedBy(taskId: string): string[] {
  const all = listTasks({ include_archived: true });
  const out: string[] = [];
  for (const candidate of all) {
    if (candidate.id === taskId) continue;
    const links = readTaskLinks(candidate);
    if (links.blocks.includes(taskId)) out.push(candidate.id);
  }
  return out;
}

/**
 * Bundle of a task's outgoing links + its computed inbound `blocked_by`.
 * What the GET endpoint returns.
 */
export interface TaskLinksView {
  links: TaskLinks;
  blocked_by: string[];
}

export function getTaskLinks(taskId: string): TaskLinksView | null {
  const task = getTask(taskId);
  if (!task) return null;
  return {
    links: readTaskLinks(task),
    blocked_by: findBlockedBy(taskId),
  };
}

/* -------------------------------------------------------------------------- */
/*  Write helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Merge a freshly built {@link TaskLinks} block into the task's context and
 * persist it. The merge is "replace" — fields supplied on the patch overwrite
 * whatever was stored; fields omitted are left untouched. Returns the
 * updated `TaskLinks` (after the patch), or `null` when the task is missing.
 */
export function patchTaskLinks(
  taskId: string,
  patch: TaskLinksPatch,
): TaskLinks | null {
  const task = getTask(taskId);
  if (!task) return null;

  const current = readTaskLinks(task);
  const next: TaskLinks = {
    blocks: dedupeAndStrip(
      patch.blocks !== undefined ? patch.blocks : current.blocks,
      taskId,
    ),
    related: dedupeAndStrip(
      patch.related !== undefined ? patch.related : current.related,
      taskId,
    ),
    duplicate_of:
      patch.duplicate_of !== undefined ? patch.duplicate_of : current.duplicate_of,
  };

  // A task can never be a duplicate of itself.
  if (next.duplicate_of === taskId) next.duplicate_of = null;

  return writeLinks(task, next);
}

/**
 * Add a single `blocks` edge from `taskId` to `otherId`. Idempotent.
 */
export function addBlock(taskId: string, otherId: string): TaskLinks | null {
  if (taskId === otherId) return null;
  const task = getTask(taskId);
  if (!task) return null;
  // Make sure the referent exists — refusing dangling edges keeps the data
  // tidy without forcing the UI to validate.
  const other = getTask(otherId);
  if (!other) return null;

  const current = readTaskLinks(task);
  if (current.blocks.includes(otherId)) {
    return current; // no-op
  }
  const next: TaskLinks = {
    ...current,
    blocks: [...current.blocks, otherId],
  };
  return writeLinks(task, next);
}

/**
 * Remove a single `blocks` edge. Idempotent — returns the current links
 * unchanged if the edge wasn't present.
 */
export function removeBlock(
  taskId: string,
  otherId: string,
): TaskLinks | null {
  const task = getTask(taskId);
  if (!task) return null;
  const current = readTaskLinks(task);
  if (!current.blocks.includes(otherId)) return current;
  const next: TaskLinks = {
    ...current,
    blocks: current.blocks.filter((id) => id !== otherId),
  };
  return writeLinks(task, next);
}

/* -------------------------------------------------------------------------- */
/*  Integrity                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Called by the tasks repo right before a task is deleted. Walks every other
 * task and strips references to the deleted id from its links block. Returns
 * the count of tasks that were touched (for diagnostics / tests).
 *
 * Best-effort: any per-task write failure is logged and we move on. The
 * outer delete still proceeds — dangling references just become invisible
 * when the deleted task can't be found.
 */
export function cleanupLinksForDeletedTask(deletedId: string): number {
  if (!deletedId) return 0;
  const all = listTasks({ include_archived: true });
  let touched = 0;
  for (const candidate of all) {
    if (candidate.id === deletedId) continue;
    const links = readTaskLinks(candidate);
    const filteredBlocks = links.blocks.filter((id) => id !== deletedId);
    const filteredRelated = links.related.filter((id) => id !== deletedId);
    const filteredDup =
      links.duplicate_of === deletedId ? null : links.duplicate_of;
    if (
      filteredBlocks.length === links.blocks.length &&
      filteredRelated.length === links.related.length &&
      filteredDup === links.duplicate_of
    ) {
      continue;
    }
    try {
      writeLinks(candidate, {
        blocks: filteredBlocks,
        related: filteredRelated,
        duplicate_of: filteredDup,
      });
      touched += 1;
    } catch {
      /* non-fatal — keep walking */
    }
  }
  return touched;
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function dedupeAndStrip(ids: string[], selfId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id === selfId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Hook registration (side-effect)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Side-effect: register the pre-delete hook so the tasks repo calls us to
 * scrub references before a row is deleted. Idempotent — register once at
 * module load. The hook is null-safe; importing this module is enough to
 * wire it up.
 */
registerOnTaskPreDelete((deletedId) => {
  cleanupLinksForDeletedTask(deletedId);
});

function writeLinks(task: Task, links: TaskLinks): TaskLinks {
  const ctx =
    task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : {};
  // Strip when fully empty so the JSON stays tidy.
  const empty =
    links.blocks.length === 0 &&
    links.related.length === 0 &&
    links.duplicate_of === null;
  let nextCtx: Record<string, unknown> | null;
  if (empty) {
    const { [LINKS_CONTEXT_KEY]: _omit, ...rest } = ctx;
    void _omit;
    nextCtx = Object.keys(rest).length === 0 ? null : rest;
  } else {
    nextCtx = { ...ctx, [LINKS_CONTEXT_KEY]: links };
  }
  updateTask(task.id, { context: nextCtx });
  return links;
}
