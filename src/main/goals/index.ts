/**
 * Goals / Initiatives domain layer (Wave 17 — goals tier).
 *
 * A tier above tasks. Jack runs several businesses, so a goal looks like
 * "Hit $X MRR at Actually Health" or "Ship Leal v2 deck". Tasks roll up to a
 * goal two ways:
 *
 *   1. **Explicit**: `task.context.goal_id === goal.id`.
 *   2. **Soft membership**: the task carries any tag in `goal.tags`.
 *
 * A task is a member when EITHER holds (de-duplicated by task id).
 *
 * This module owns:
 *   - thin CRUD wrappers over the goals repo (re-exported for callers that
 *     want the domain entrypoint rather than the raw repo);
 *   - membership resolution (`listGoalTasks`);
 *   - progress aggregation (`computeProgress`);
 *   - attach / detach of a task to a goal (writes `context.goal_id`);
 *   - detach-on-delete (deleting a goal clears `context.goal_id` from its
 *     explicit members — it NEVER deletes a task);
 *   - optional first-run seeding of a couple example goals.
 *
 * Pure-synchronous (better-sqlite3) — no async anywhere.
 */

import type {
  CreateGoalInput,
  Goal,
  GoalFilter,
  GoalProgress,
  GoalWithProgress,
  Task,
  UpdateGoalInput,
} from '@/shared/types';

import {
  createGoal as repoCreateGoal,
  deleteGoal as repoDeleteGoal,
  getGoal,
  listGoals as repoListGoals,
  updateGoal as repoUpdateGoal,
} from '@/main/db/repositories/goals';
import {
  getTask,
  listTasks,
  updateTask,
} from '@/main/db/repositories/tasks';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Path key on a task's `context` where the attached goal id lives. */
export const GOAL_CONTEXT_KEY = 'goal_id';

/** Setting key flagging that the first-run example goals have been seeded. */
export const GOALS_SEEDED_SETTING_KEY = 'goals_seeded';

/* -------------------------------------------------------------------------- */
/*  CRUD wrappers                                                             */
/* -------------------------------------------------------------------------- */

export function listGoals(filter: GoalFilter = {}): Goal[] {
  return repoListGoals(filter);
}

export { getGoal };

export function createGoal(input: CreateGoalInput): Goal {
  return repoCreateGoal(input);
}

export function updateGoal(id: string, patch: UpdateGoalInput): Goal | null {
  return repoUpdateGoal(id, patch);
}

/* -------------------------------------------------------------------------- */
/*  Membership                                                                */
/* -------------------------------------------------------------------------- */

/** Pull the attached goal id off a task's context (or null if absent). */
export function readTaskGoalId(task: Task | null): string | null {
  if (!task || !task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)[GOAL_CONTEXT_KEY];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * True when `task` belongs to `goal` — either explicitly
 * (`context.goal_id === goal.id`) or by carrying any of the goal's tags.
 */
export function taskBelongsToGoal(task: Task, goal: Goal): boolean {
  if (readTaskGoalId(task) === goal.id) return true;
  if (goal.tags.length === 0) return false;
  const taskTags = task.tags ?? [];
  if (taskTags.length === 0) return false;
  const wanted = new Set(goal.tags);
  return taskTags.some((t) => wanted.has(t));
}

/**
 * All tasks that roll up to a goal. Combines the explicit attachments (a fast
 * indexed-ish LIKE on `context.goal_id`) with the tag-membership set, then
 * de-duplicates by id. Archived tasks are excluded (they shouldn't count
 * toward an active initiative's progress).
 *
 * Returns an empty array when the goal id doesn't exist.
 */
export function listGoalTasks(goalId: string): Task[] {
  const goal = getGoal(goalId);
  if (!goal) return [];

  const byId = new Map<string, Task>();

  // 1. Explicit attachments via context.goal_id.
  for (const t of listTasks({ goal_id: goalId })) {
    byId.set(t.id, t);
  }

  // 2. Soft membership via shared tags. `listTasks({ tag })` is a quoted LIKE
  //    per tag; we union the results. A task already captured above is simply
  //    overwritten with the same value (no double count).
  for (const tag of goal.tags) {
    for (const t of listTasks({ tag })) {
      byId.set(t.id, t);
    }
  }

  return [...byId.values()];
}

/* -------------------------------------------------------------------------- */
/*  Progress                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Roll a goal's member tasks into a {@link GoalProgress}. Done over the
 * provided task list so callers can reuse a fetch. `done` counts terminal
 * success; `in_progress` and `blocked` map to their statuses. `percent` is
 * `done / total * 100` rounded (0 when there are no members). Overdue =
 * non-done tasks whose `due` is strictly in the past; `next_due` is the
 * earliest non-done due date (overdue or upcoming), or null.
 */
export function computeProgress(goalId: string, tasks: Task[]): GoalProgress {
  const now = Date.now();
  let done = 0;
  let inProgress = 0;
  let blocked = 0;
  let overdue = 0;
  let nextDue: string | null = null;
  let nextDueMs = Number.POSITIVE_INFINITY;

  for (const t of tasks) {
    if (t.status === 'done') done += 1;
    else if (t.status === 'in_progress') inProgress += 1;
    else if (t.status === 'blocked') blocked += 1;

    if (t.status !== 'done' && t.due) {
      const dueMs = Date.parse(t.due);
      if (!Number.isNaN(dueMs)) {
        if (dueMs < now) overdue += 1;
        if (dueMs < nextDueMs) {
          nextDueMs = dueMs;
          nextDue = t.due;
        }
      }
    }
  }

  const total = tasks.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return {
    goal_id: goalId,
    total,
    done,
    in_progress: inProgress,
    blocked,
    percent,
    overdue_tasks: overdue,
    next_due: nextDue,
  };
}

/**
 * Progress for a goal by id, fetching its members. Returns a zeroed progress
 * when the goal doesn't exist (callers that need existence should check
 * `getGoal` first).
 */
export function getGoalProgress(goalId: string): GoalProgress {
  const tasks = listGoalTasks(goalId);
  return computeProgress(goalId, tasks);
}

/**
 * List goals, each bundled with its computed progress. Used by the list
 * endpoint and the renderer card grid.
 */
export function listGoalsWithProgress(
  filter: GoalFilter = {},
): GoalWithProgress[] {
  return listGoals(filter).map((goal) => ({
    ...goal,
    progress: computeProgress(goal.id, listGoalTasks(goal.id)),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Attach / detach                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Attach a task to a goal (or detach when `goalId` is null) by writing
 * `context.goal_id`. Returns the updated task, or null when the task doesn't
 * exist. Does NOT validate that the goal exists — the route layer does that
 * so it can return a clean 404; passing a non-existent id here just stores it.
 */
export function setTaskGoal(taskId: string, goalId: string | null): Task | null {
  const task = getTask(taskId);
  if (!task) return null;

  const baseCtx =
    task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : {};
  const nextCtx: Record<string, unknown> = { ...baseCtx };

  if (goalId === null) {
    delete nextCtx[GOAL_CONTEXT_KEY];
  } else {
    nextCtx[GOAL_CONTEXT_KEY] = goalId;
  }

  const persistCtx = Object.keys(nextCtx).length === 0 ? null : nextCtx;
  return updateTask(taskId, { context: persistCtx });
}

/* -------------------------------------------------------------------------- */
/*  Delete (with detach)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Delete a goal and detach its EXPLICIT members — i.e. clear
 * `context.goal_id` from every task that pointed at it. Tasks that were only
 * soft tag-members are untouched (nothing on them referenced the goal). NO
 * task is ever deleted.
 *
 * Returns `{ removed, detached }`: whether the goal row went away and how many
 * tasks had their attachment cleared.
 */
export function deleteGoalAndDetach(goalId: string): {
  removed: boolean;
  detached: number;
} {
  // Detach explicit members first so a later re-create with the same id
  // doesn't silently re-adopt orphans.
  const explicit = listTasks({ goal_id: goalId });
  let detached = 0;
  for (const t of explicit) {
    const updated = setTaskGoal(t.id, null);
    if (updated) detached += 1;
  }

  const removed = repoDeleteGoal(goalId);
  return { removed, detached };
}

/* -------------------------------------------------------------------------- */
/*  First-run seeding                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Example goals seeded the first time the goals list is opened on a brand-new
 * install with zero goals. Mirrors Jack's businesses so the empty state shows
 * something useful. Seeding is opt-in via {@link seedExampleGoalsIfEmpty} —
 * the list endpoint does NOT auto-seed (a clean empty state is preferred);
 * this is here for callers that want it.
 */
export const EXAMPLE_GOALS: readonly CreateGoalInput[] = Object.freeze([
  {
    name: 'Hit $50k MRR at Actually Health',
    description:
      'Success criteria: 50 paying members at the standard plan, < 5% monthly churn, payback under 3 months.',
    status: 'active',
    tags: ['actually-health', 'growth', 'revenue'],
    workspace: 'actually-health',
  },
  {
    name: 'Ship Leal v2 deck',
    description:
      'Success criteria: refreshed oncology positioning deck, reviewed by clinical, used in 3 live pitches.',
    status: 'active',
    tags: ['leal', 'content', 'deck'],
    workspace: 'leal-health',
  },
  {
    name: 'IndexThread: 10 retained Reddit clients',
    description:
      'Success criteria: 10 clients on monthly retainers, each with a live campaign and a published research paper.',
    status: 'active',
    tags: ['indexthread', 'sales', 'reddit'],
    workspace: 'indexthread',
  },
]);

/**
 * Seed the example goals only when NO goals exist yet. Returns the goals that
 * were created (empty array when the table already had rows). Idempotent in
 * the practical sense — a single non-empty goal short-circuits it.
 */
export function seedExampleGoalsIfEmpty(): Goal[] {
  if (listGoals().length > 0) return [];
  return EXAMPLE_GOALS.map((g) => createGoal(g));
}

/* -------------------------------------------------------------------------- */
/*  Namespace export                                                          */
/* -------------------------------------------------------------------------- */

export const goals = {
  list: listGoals,
  listWithProgress: listGoalsWithProgress,
  get: getGoal,
  create: createGoal,
  update: updateGoal,
  delete: deleteGoalAndDetach,
  tasks: listGoalTasks,
  progress: getGoalProgress,
  attach: setTaskGoal,
  seed: seedExampleGoalsIfEmpty,
};
