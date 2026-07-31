/**
 * Recurring schedules — domain layer.
 *
 * A schedule fires on a wall-clock cadence (NOT completion-driven; that's
 * the per-task `context.recurrence` in `@/main/recurrence`). Each fire:
 *
 *   1. Determines the fan-out set: either every repo in the linked goal
 *      (parsed from `goal.description` Markdown bullets), or a single
 *      "no-fanout" slot when `fan_out_goal_id` is null.
 *   2. For each fan-out slot × each `child_template` entry, materializes a
 *      task with `{repo}` / `{repo_short}` / `{site_name}` / `{date}` /
 *      `{schedule_name}` interpolated into title + instructions.
 *   3. Stamps `last_fired_at = now` and advances `next_fire_at` per the
 *      recurrence kind/interval.
 *
 * Re-exports the repository CRUD so callers can import everything from
 * `@/main/schedules`.
 */

import { createTask, updateTask } from '@/main/db/repositories/tasks';
import { getGoal } from '@/main/db/repositories/goals';
import {
  applyProfile,
  buildContextWithPermissions,
} from '@/main/permissions';
import type { CreateTaskInput, TaskPriority } from '@/shared/types';

import {
  createSchedule as repoCreateSchedule,
  deleteSchedule as repoDeleteSchedule,
  getSchedule,
  listSchedules,
  listDueSchedules,
  updateSchedule as repoUpdateSchedule,
  type ChildTemplate,
  type CreateScheduleInput,
  type RecurrenceKindString,
  type RecurringSchedule,
  type UpdateScheduleInput,
} from '@/main/db/repositories/schedules';

/* -------------------------------------------------------------------------- */
/*  Re-exports                                                                */
/* -------------------------------------------------------------------------- */

export {
  getSchedule,
  listSchedules,
  listDueSchedules,
  type ChildTemplate,
  type CreateScheduleInput,
  type RecurrenceKindString,
  type RecurringSchedule,
  type UpdateScheduleInput,
};

export function createSchedule(input: CreateScheduleInput): RecurringSchedule {
  return repoCreateSchedule(input);
}

export function updateSchedule(
  id: string,
  patch: UpdateScheduleInput,
): RecurringSchedule | null {
  return repoUpdateSchedule(id, patch);
}

export function deleteSchedule(id: string): boolean {
  return repoDeleteSchedule(id);
}

/* -------------------------------------------------------------------------- */
/*  Goal repo extraction                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parse `<owner>/<repo>` lines from a goal's description text. Goals seeded
 * by the workspace import write a Markdown bullet list:
 *
 *     Repos:
 *     - Gr0wthHacker/brooklyn-neuro-guides
 *     - Gr0wthHacker/brooklyn-brain-map
 *     ...
 *
 * We accept `- owner/repo` and `* owner/repo` forms, deduplicate, preserve
 * order. Returns an empty array when no lines match — the caller decides
 * whether that's an error.
 */
export function extractGoalRepos(description: string | null): string[] {
  if (!description) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of description.split(/\r?\n/)) {
    // owner/repo: alphanumeric + ._- in each segment.
    const m = /^\s*[-*]\s+([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)\s*$/.exec(
      line,
    );
    if (!m || !m[1]) continue;
    const repo = m[1];
    if (seen.has(repo)) continue;
    seen.add(repo);
    out.push(repo);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Template interpolation                                                     */
/* -------------------------------------------------------------------------- */

export interface InterpolationContext {
  /** Full `owner/repo`, e.g. `Gr0wthHacker/brooklyn-neuro-guides`. */
  repo: string;
  /** Just the repo segment, e.g. `brooklyn-neuro-guides`. */
  repo_short: string;
  /** Human-friendly site name, e.g. `Brooklyn Neuro Guides`. */
  site_name: string;
  /** ISO date (YYYY-MM-DD) of the fire. */
  date: string;
  /** Name of the schedule that fired. */
  schedule_name: string;
}

/**
 * Replace `{token}` markers with values from `ctx`. Tokens that aren't in
 * `ctx` are left literal (so a misspelled `{rrepo}` shows up in the output
 * rather than crashing).
 */
export function interpolate(template: string, ctx: InterpolationContext): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    const v = (ctx as unknown as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : match;
  });
}

/**
 * Derive a human-readable site name from a repo slug. `brooklyn-neuro-guides`
 * → `Brooklyn Neuro Guides`. Best-effort — fed into the {site_name} token
 * for child task titles.
 */
export function siteNameFromRepo(repo: string): string {
  const segment = repo.includes('/') ? (repo.split('/').pop() ?? repo) : repo;
  return segment
    .split(/[-_]+/)
    .filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/*  Fan-out                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compute the list of repos to fan out over. When `fan_out_goal_id` is null,
 * returns a single "no fan-out" sentinel so we still materialize one task
 * per child_template entry. Throws when the goal is set but not found, OR
 * when it's found but parses to zero repos (better to surface the
 * misconfiguration than silently fire nothing).
 */
export function resolveFanOutRepos(
  schedule: Pick<RecurringSchedule, 'fan_out_goal_id'>,
): string[] {
  if (!schedule.fan_out_goal_id) {
    // Sentinel: one slot, no repo context. Interpolation leaves {repo} etc.
    // unmolested — child templates that don't reference them work fine; ones
    // that do will surface the issue in the rendered title.
    return [''];
  }
  const goal = getGoal(schedule.fan_out_goal_id);
  if (!goal) {
    throw new ScheduleFireError(
      'goal_not_found',
      `Schedule references goal ${schedule.fan_out_goal_id} but no such goal exists.`,
    );
  }
  const repos = extractGoalRepos(goal.description);
  if (repos.length === 0) {
    throw new ScheduleFireError(
      'no_repos_in_goal',
      `Goal "${goal.name}" has no parseable "- owner/repo" lines in its description.`,
    );
  }
  return repos;
}

/* -------------------------------------------------------------------------- */
/*  Next-fire computation                                                      */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const targetMonth = m + months;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate();
  const clampedDay = Math.min(d, lastDay);
  return new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      clampedDay,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

function nextWeekdayUtc(from: Date, interval: number): Date {
  let counted = 0;
  let cursor = from;
  while (counted < interval) {
    cursor = addDaysUtc(cursor, 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) counted += 1;
  }
  return cursor;
}

/**
 * Compute the next fire time AFTER `from` for a given kind/interval. Mirrors
 * the math in `@/main/recurrence` but works off raw kind+interval rather
 * than a wrapped RecurrenceRule object.
 */
export function computeNextFireAt(
  kind: RecurrenceKindString,
  interval: number,
  from: Date,
): Date {
  const n = Math.max(1, Math.floor(interval));
  switch (kind) {
    case 'daily':
      return addDaysUtc(from, n);
    case 'weekly':
      return addDaysUtc(from, n * 7);
    case 'monthly':
      return addMonthsUtc(from, n);
    case 'weekdays':
      return nextWeekdayUtc(from, n);
  }
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class ScheduleFireError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScheduleFireError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*  Fire                                                                       */
/* -------------------------------------------------------------------------- */

export interface FireResult {
  schedule_id: string;
  fired_at: string;
  next_fire_at: string;
  /** Tasks created by this fire (ids only). */
  created_task_ids: string[];
  /** Number of fan-out slots × child templates. */
  expected_count: number;
}

/**
 * Materialize every child task for this fire, advance `next_fire_at` past
 * `now`, and stamp `last_fired_at`. Idempotent in spirit but NOT atomic —
 * callers (the scheduler tick) should hold off on re-firing the same
 * schedule within the same minute via their own dedup.
 *
 * Idempotency note: if a fire fails midway through `createTask`, partial
 * children may have been created. The repository update still advances
 * `next_fire_at` so the schedule doesn't refire-storm on the next tick.
 * Children carry `context.schedule_fire_at = fired_at` so a post-hoc audit
 * can spot partials.
 */
export function fireSchedule(
  scheduleId: string,
  now: Date = new Date(),
): FireResult {
  const schedule = getSchedule(scheduleId);
  if (!schedule) {
    throw new ScheduleFireError(
      'schedule_not_found',
      `No schedule with id ${scheduleId}.`,
    );
  }

  const repos = resolveFanOutRepos(schedule);
  const firedAt = now.toISOString();
  const date = firedAt.slice(0, 10);

  const createdIds: string[] = [];

  for (const repo of repos) {
    const ctx: InterpolationContext = {
      repo,
      repo_short: repo.includes('/') ? (repo.split('/').pop() ?? repo) : repo,
      site_name: repo ? siteNameFromRepo(repo) : '',
      date,
      schedule_name: schedule.name,
    };
    for (const child of schedule.child_templates) {
      const task = createChildTask(schedule, repo, ctx, child, firedAt);
      createdIds.push(task);
    }
  }

  // Advance next_fire_at to the next slot strictly AFTER `now`, ANCHORED on
  // the originally-scheduled next_fire_at — not on `now`. This preserves the
  // intended cadence: a "Mondays 09:00" schedule fired manually on Saturday
  // 20:59 should next fire next Monday 09:00, not next Saturday 20:59.
  //
  // For a wildly-stale schedule (next_fire_at = months ago), the while-loop
  // converges to the next future occurrence — still on the original weekday
  // / hour. Worst case ~O(missed-intervals) iterations, which is fine even
  // for years of drift.
  //
  // Falls back to `now` as anchor if the stored next_fire_at is unparseable.
  const anchorRaw = new Date(schedule.next_fire_at);
  const anchor = Number.isNaN(anchorRaw.getTime()) ? now : anchorRaw;
  let nextFire = computeNextFireAt(
    schedule.recurrence_kind,
    schedule.recurrence_interval,
    anchor,
  );
  while (nextFire.getTime() <= now.getTime()) {
    nextFire = computeNextFireAt(
      schedule.recurrence_kind,
      schedule.recurrence_interval,
      nextFire,
    );
  }

  repoUpdateSchedule(scheduleId, {
    next_fire_at: nextFire.toISOString(),
    last_fired_at: firedAt,
  });

  return {
    schedule_id: scheduleId,
    fired_at: firedAt,
    next_fire_at: nextFire.toISOString(),
    created_task_ids: createdIds,
    expected_count: repos.length * schedule.child_templates.length,
  };
}

function createChildTask(
  schedule: RecurringSchedule,
  repo: string,
  ctx: InterpolationContext,
  child: ChildTemplate,
  firedAt: string,
): string {
  const title = interpolate(child.title_template, ctx);
  const instructions = child.instructions_template
    ? interpolate(child.instructions_template, ctx)
    : null;

  // Encode schedule lineage on the child so:
  //   - the task detail view can show "spawned by Sparman weekly @ 2026-05-30"
  //   - a future cleanup tool can find all tasks from a given fire
  //   - the github_repo link is set when fan-out is in play
  const context: Record<string, unknown> = {
    schedule_id: schedule.id,
    schedule_name: schedule.name,
    schedule_fire_at: firedAt,
  };
  if (repo) {
    context.github_repo = repo;
  }
  if (schedule.fan_out_goal_id) {
    context.goal_id = schedule.fan_out_goal_id;
  }

  // Trust-forward defaults from the child template. When unset, fall back to
  // the legacy human_only behavior so existing schedules keep their semantics.
  const agentMethod = child.agent_method ?? 'human_only';
  const agentExecutable =
    child.agent_executable ?? (agentMethod !== 'human_only');

  const createInput: CreateTaskInput = {
    title,
    description: null,
    status: 'inbox',
    priority: (child.priority ?? 'p2') as TaskPriority,
    due: null,
    parent_id: null,
    agent_executable: agentExecutable,
    agent_method: agentMethod,
    agent_instructions: instructions,
    agent_status: 'pending',
    context,
    tags: child.tags ?? [],
  };
  const task = createTask(createInput);

  // If the template names a permission profile, materialize it into the task's
  // context now so it's ready for auto-execute without a manual /apply step.
  if (child.permission_profile) {
    const permissions = applyProfile(child.permission_profile, task.id);
    const nextContext = buildContextWithPermissions(task.context, permissions);
    updateTask(task.id, { context: nextContext });
  }

  return task.id;
}
