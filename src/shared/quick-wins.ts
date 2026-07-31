/**
 * "Found a moment" mode — pure helpers for picking small, low-energy tasks
 * the user can knock out when they have a sliver of free time (kid napping,
 * waiting for a build, between meetings).
 *
 * Two inputs drive the pick:
 *   • `context.estimated_minutes` — set by derivation when Claude proposes a
 *     child task, defaults to a generous fallback when missing.
 *   • `context.energy` — `'low' | 'medium' | 'high'`, optional. A user may
 *     tag a task explicitly; auto-tagging downgrades anything with
 *     `estimated_minutes <= 15` to `'low'` unless the producer set otherwise.
 *
 * Lives in `shared/` so the renderer + tests + any future MCP tool can use
 * the same filter without duplicating the heuristic.
 */

import type { Task } from './types';

export type EnergyLevel = 'low' | 'medium' | 'high';

export interface QuickWinFilter {
  /** Available time, in minutes. 5 / 10 / 15 / 30 are the typical UI presets. */
  minutes: number;
  /**
   * Maximum energy the user has. Defaults to `'medium'` (a typical mid-day
   * slot). A `'low'` cap excludes anything tagged `medium` or `high`.
   */
  energy?: EnergyLevel;
}

/**
 * Pull the user-set energy label off `task.context.energy`, or null when
 * unset / invalid.
 */
export function readTaskEnergy(task: Task): EnergyLevel | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)['energy'];
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return null;
}

/**
 * Pull `context.estimated_minutes` off a task. Returns `null` when missing
 * or malformed — callers treat that as "unknown, don't include in quick wins
 * unless the user has loose limits".
 */
export function readEstimatedMinutes(task: Task): number | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)['estimated_minutes'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  return null;
}

const ENERGY_ORDER: Record<EnergyLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const PRIORITY_ORDER: Record<string, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

/**
 * Filter a list to quick-win candidates and return them in display order.
 *
 * Rules (all must hold for a task to land in the list):
 *   1. Status is `inbox` or `queued` — actionable now.
 *   2. `estimated_minutes` is present AND ≤ `filter.minutes`. Tasks with no
 *      estimate are excluded by default — a task without a sized bucket
 *      isn't a "quick win" yet. Callers can post-filter to add them.
 *   3. Energy ≤ `filter.energy` (default `'medium'`). Tasks with no energy
 *      label are treated as `'medium'`.
 *
 * Sort order: priority (p0 → p3) → smallest estimate → most recently updated.
 */
export function pickQuickWins(tasks: Task[], filter: QuickWinFilter): Task[] {
  const energyCap = ENERGY_ORDER[filter.energy ?? 'medium'];
  const candidates = tasks.filter((t) => {
    if (t.status !== 'inbox' && t.status !== 'queued') return false;
    const minutes = readEstimatedMinutes(t);
    if (minutes === null) return false;
    if (minutes > filter.minutes) return false;
    const energy = readTaskEnergy(t) ?? 'medium';
    if (ENERGY_ORDER[energy] > energyCap) return false;
    return true;
  });
  return candidates.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 9;
    const pb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    const ma = readEstimatedMinutes(a) ?? 9999;
    const mb = readEstimatedMinutes(b) ?? 9999;
    if (ma !== mb) return ma - mb;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/**
 * Heuristic: a freshly derived task with no explicit energy gets `'low'`
 * when its estimate is ≤ 15 min. Used by io ingestion to auto-tag children
 * so the Got-N-min view has populated data immediately, even before the
 * user manually labels anything.
 */
export function deriveAutoEnergy(estimatedMinutes: number | null | undefined): EnergyLevel | null {
  if (typeof estimatedMinutes !== 'number') return null;
  if (estimatedMinutes <= 15) return 'low';
  if (estimatedMinutes <= 60) return 'medium';
  return 'high';
}
