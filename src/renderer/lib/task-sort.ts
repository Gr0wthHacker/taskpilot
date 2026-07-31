/**
 * Shared task-ordering helpers. Previously copy-pasted across Inbox, Board,
 * CoworkQueue, and Triage — consolidated here so every list sorts identically.
 *
 * Ordering: priority (p0 first) → earliest due → created_at tiebreak. The only
 * variation between callers was the final tiebreak direction, exposed via the
 * `recent` option (newest-first by default; Board uses oldest-first).
 */

import type { Task, TaskPriority } from '@/shared/types';

/** Lower number = higher priority, for numeric comparison. */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

/** Highest → lowest priority. Used for adjacency (bump up/down). */
export const PRIORITY_ORDER: TaskPriority[] = ['p0', 'p1', 'p2', 'p3'];

export interface SortByPriorityOptions {
  /**
   * Tiebreak when priority and due date are equal. `true` (default) puts the
   * most recently created task first; `false` puts the oldest first.
   */
  recent?: boolean;
}

/** Return a new array sorted by priority → due → created_at. */
export function sortByPriority(
  tasks: Task[],
  opts: SortByPriorityOptions = {},
): Task[] {
  const recent = opts.recent ?? true;
  return [...tasks].sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    const aDue = a.due ? new Date(a.due).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.due ? new Date(b.due).getTime() : Number.POSITIVE_INFINITY;
    // Guard equality first: Infinity - Infinity is NaN, which would otherwise
    // swallow the created_at tiebreak for the (common) due-less case.
    if (aDue !== bDue) return aDue - bDue;
    return recent
      ? b.created_at.localeCompare(a.created_at)
      : a.created_at.localeCompare(b.created_at);
  });
}
