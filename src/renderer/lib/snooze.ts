/**
 * Snooze/defer helpers. A snooze hides a task from default lists until a
 * chosen time, stored at `task.context.snoozed_until` (ISO string) — no schema
 * change, mirroring how recurrence/goal_id/links already live under context.
 *
 * A task is "snoozed" only while `snoozed_until` is in the future; once it
 * passes the task reappears on its own with no write-back needed.
 */

import type { Task } from '@/shared/types';

export const SNOOZE_KEY = 'snoozed_until';

/** Read the raw ISO snooze timestamp, or null when none/invalid. */
export function getSnoozedUntil(task: Task): string | null {
  const raw = task.context?.[SNOOZE_KEY];
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : raw;
}

/** True while the snooze timestamp is still in the future. */
export function isSnoozed(task: Task, now: Date = new Date()): boolean {
  const iso = getSnoozedUntil(task);
  if (iso === null) return false;
  return new Date(iso).getTime() > now.getTime();
}

/** Split a list into still-snoozed vs. visible tasks. */
export function partitionSnoozed(
  tasks: Task[],
  now: Date = new Date(),
): { active: Task[]; snoozed: Task[] } {
  const active: Task[] = [];
  const snoozed: Task[] = [];
  for (const t of tasks) {
    if (isSnoozed(t, now)) snoozed.push(t);
    else active.push(t);
  }
  return { active, snoozed };
}

export interface SnoozePreset {
  key: string;
  label: string;
  /** Compute the target Date from `now`. */
  resolve: (now: Date) => Date;
}

function atHour(base: Date, hour: number): Date {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Built-in snooze choices, computed relative to the current moment. */
export const SNOOZE_PRESETS: SnoozePreset[] = [
  {
    key: 'later-today',
    label: 'Later today',
    resolve: (now) => new Date(now.getTime() + 3 * 60 * 60 * 1000),
  },
  {
    key: 'tomorrow',
    label: 'Tomorrow 9am',
    resolve: (now) => {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return atHour(d, 9);
    },
  },
  {
    key: 'next-week',
    label: 'Next Monday 9am',
    resolve: (now) => {
      const d = new Date(now);
      // 1 = Monday. Days until the *next* Monday (always ≥ 1).
      const delta = ((8 - d.getDay()) % 7) || 7;
      d.setDate(d.getDate() + delta);
      return atHour(d, 9);
    },
  },
];
