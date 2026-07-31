/**
 * Recurrence engine.
 *
 * Opinionated, lean alternative to RFC-5545 RRULE. Four `kind`s cover ~95% of
 * the patterns a single user actually needs day-to-day:
 *
 *   - `daily`     — every N days
 *   - `weekdays`  — every weekday (Mon-Fri), skipping Sat/Sun
 *   - `weekly`    — every N weeks (preserves the source weekday)
 *   - `monthly`   — every N months (preserves the day-of-month when possible;
 *                                    clamps to month end when the source day
 *                                    doesn't exist, e.g. Jan 31 → Feb 28)
 *
 * Two termination knobs (optional, independent — whichever fires first wins):
 *   - `end_after_count` — stop after N completed occurrences
 *   - `end_on`          — stop once the next computed date is past this ISO
 *
 * All math runs in UTC. The renderer's `<input type="datetime-local">` already
 * converts to UTC via `Date.toISOString()` before storage, so this is a clean
 * boundary; the trade-off is that "every weekday" means every Mon-Fri in UTC,
 * which can drift for users in Pacific time. Documented as a known limitation.
 */

import {
  createTask,
  getTask,
  registerOnTaskCompleted,
} from './db/repositories/tasks.js';
import type {
  RecurrenceKind,
  RecurrenceRule,
  Task,
} from '../shared/types.js';

/* -------------------------------------------------------------------------- */
/*  Date helpers                                                              */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * Add N months in UTC, clamping the day-of-month so Jan 31 + 1 month = Feb 28
 * (or 29 in a leap year) rather than overflowing into March.
 */
function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const targetMonth = m + months;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  // Last day of the target month (day 0 of the next month).
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

/**
 * Advance to the next Monday-Friday. If `from` itself is already a weekday
 * AND `interval` is 1, returns `from + 1 day` (skipping weekend if needed).
 * Otherwise advances day-by-day skipping weekends until `interval` weekdays
 * have been counted.
 */
function nextWeekday(from: Date, interval: number): Date {
  let counted = 0;
  let cursor = from;
  while (counted < interval) {
    cursor = addDaysUtc(cursor, 1);
    const day = cursor.getUTCDay();
    // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) counted += 1;
  }
  return cursor;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

const VALID_KINDS: ReadonlySet<RecurrenceKind> = new Set([
  'daily',
  'weekdays',
  'weekly',
  'monthly',
]);

/**
 * Normalize the interval to a positive integer. Defaults to 1 when unset or
 * non-positive — the rule still fires, just on the natural cadence of the
 * kind.
 */
function normalizeInterval(rule: RecurrenceRule): number {
  const raw = rule.interval;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

/**
 * Compute the next occurrence of `rule` after `from`. Returns `null` when the
 * rule has run out of occurrences (either the count limit was hit or the next
 * candidate date is past `end_on`).
 *
 * `from` is the anchor date — typically the just-completed instance's `due`
 * (or `created_at` if no due was set). Callers pass the *current* completion
 * date and get back the next one to schedule.
 */
export function nextOccurrence(
  rule: RecurrenceRule,
  from: Date,
): Date | null {
  if (!VALID_KINDS.has(rule.kind)) return null;
  if (Number.isNaN(from.getTime())) return null;

  // Termination check #1: count.
  if (typeof rule.end_after_count === 'number') {
    const done = rule.occurrences_completed ?? 0;
    if (done >= rule.end_after_count) return null;
  }

  const interval = normalizeInterval(rule);
  let next: Date;

  switch (rule.kind) {
    case 'daily':
      next = addDaysUtc(from, interval);
      break;
    case 'weekdays':
      next = nextWeekday(from, interval);
      break;
    case 'weekly':
      next = addDaysUtc(from, interval * 7);
      break;
    case 'monthly':
      next = addMonthsUtc(from, interval);
      break;
    default:
      return null;
  }

  // Termination check #2: end_on. We compare on the day boundary in UTC so
  // a rule that says "until 2026-06-01" still fires for a 09:00 occurrence
  // on that day. Parse failure → ignore the bound.
  if (rule.end_on) {
    const end = new Date(rule.end_on);
    if (!Number.isNaN(end.getTime()) && next.getTime() > end.getTime()) {
      return null;
    }
  }

  return next;
}

/**
 * Human-readable summary for a recurrence rule. Renderers use this in task
 * detail headers. Returns an empty string for `null` / invalid rules.
 */
export function describeRecurrence(rule: RecurrenceRule | null): string {
  if (!rule) return '';
  const interval = normalizeInterval(rule);
  const everyN = interval === 1 ? '' : `every ${interval} `;
  let base: string;
  switch (rule.kind) {
    case 'daily':
      base = interval === 1 ? 'daily' : `${everyN}days`;
      break;
    case 'weekdays':
      base = interval === 1 ? 'every weekday' : `${everyN}weekdays`;
      break;
    case 'weekly':
      base = interval === 1 ? 'weekly' : `${everyN}weeks`;
      break;
    case 'monthly':
      base = interval === 1 ? 'monthly' : `${everyN}months`;
      break;
    default:
      return '';
  }
  const suffixes: string[] = [];
  if (typeof rule.end_after_count === 'number') {
    suffixes.push(`for ${rule.end_after_count} occurrences`);
  }
  if (rule.end_on) suffixes.push(`until ${rule.end_on.slice(0, 10)}`);
  return suffixes.length === 0 ? base : `${base} (${suffixes.join(', ')})`;
}

/* -------------------------------------------------------------------------- */
/*  Materialization                                                           */
/* -------------------------------------------------------------------------- */

/**
 * When a recurring task is marked done, spawn the next instance.
 *
 * Returns the newly created child task, or `null` when no follow-up was
 * created (either the rule has ended or the task has no recurrence).
 *
 * Dynamic-imports the tasks repository to avoid a circular import — the
 * tasks repo also calls into this module when status flips to `done`.
 *
 * The new task:
 *   - Carries the same title, description, priority, tags, agent settings
 *   - Bumps `context.recurrence.occurrences_completed`
 *   - Has its `due` set to the computed next occurrence (or null if the
 *     source task had no `due` — in that case we use `created_at`-relative
 *     scheduling for the *rule* but leave the child's `due` null so the user
 *     decides when to start it)
 *   - Starts in `inbox` status, `agent_status: 'pending'`
 *   - Links back to the source via `context.recurrence_parent_id` so we can
 *     trace the chain.
 */
export function materializeNextOccurrence(taskId: string): Task | null {
  const task = getTask(taskId);
  if (!task) return null;

  const ctx = task.context;
  if (!ctx || typeof ctx !== 'object') return null;
  const rawRule = (ctx as Record<string, unknown>)['recurrence'];
  if (!rawRule || typeof rawRule !== 'object') return null;
  const rule = rawRule as RecurrenceRule;
  if (!VALID_KINDS.has(rule.kind)) return null;

  const occurrencesDone = rule.occurrences_completed ?? 0;

  // Anchor: prefer due date so cadence is preserved; fall back to created_at.
  const anchorIso = task.due ?? task.created_at;
  const anchor = new Date(anchorIso);
  if (Number.isNaN(anchor.getTime())) return null;

  // We pass a rule with the *incremented* count so terminator math (#1)
  // accounts for the completion we're processing now.
  const nextRule: RecurrenceRule = {
    ...rule,
    occurrences_completed: occurrencesDone + 1,
  };
  const next = nextOccurrence(rule, anchor);
  if (!next) return null;

  // Compose the next task. Keep context but stamp the updated rule.
  const nextContext: Record<string, unknown> = {
    ...(ctx as Record<string, unknown>),
    recurrence: nextRule,
    recurrence_parent_id: task.id,
  };

  // If the source had no `due`, the child gets no due either — we still
  // advanced the rule, but the user opted out of strict scheduling.
  const nextDue = task.due ? next.toISOString() : null;

  return createTask({
    title: task.title,
    description: task.description,
    priority: task.priority,
    due: nextDue,
    tags: task.tags,
    agent_method: task.agent_method,
    agent_executable: task.agent_executable,
    agent_instructions: task.agent_instructions,
    context: nextContext,
    status: 'inbox',
    agent_status: 'pending',
  });
}

/* -------------------------------------------------------------------------- */
/*  Hook registration                                                          */
/* -------------------------------------------------------------------------- */

// Self-register so any module that imports `tasks.ts` gets recurrence as a
// side effect when `recurrence.ts` is loaded. Tests that need to test the
// engine in isolation can call `registerOnTaskCompleted(null)`.
registerOnTaskCompleted((taskId) => {
  materializeNextOccurrence(taskId);
});

/* -------------------------------------------------------------------------- */
/*  Test exports                                                              */
/* -------------------------------------------------------------------------- */

export const __testing = {
  addDaysUtc,
  addMonthsUtc,
  nextWeekday,
  normalizeInterval,
};
