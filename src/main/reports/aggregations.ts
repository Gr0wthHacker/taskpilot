/**
 * Reports — pure SQL aggregations.
 *
 * Read-only analytics queries that power the `/reports` dashboard. Every
 * function in this module hits the DB once, returns a plain object, and
 * never mutates anything. Aggregations run against the same SQLite handle
 * the rest of the app uses (`getSqlite()` / `getDb()`), so they automatically
 * see whatever's in the live DB at call time.
 *
 * Conventions:
 *   - Windows are expressed as `'7d' | '30d' | '90d' | 'all'`. The helper
 *     `windowCutoffIso()` resolves the lower-bound ISO timestamp once per
 *     call so callers don't have to thread `Date.now()` through.
 *   - Daily buckets use `YYYY-MM-DD` keys in UTC. SQLite's `date()` function
 *     already truncates to a day boundary in UTC, which matches our ISO-8601
 *     timestamp storage.
 *   - "Time-to-done" is computed as `updated_at - created_at` in hours, only
 *     for tasks where `status='done'`. SQLite has no native hour subtraction,
 *     so we use `(julianday(updated_at) - julianday(created_at)) * 24` which
 *     produces a fractional-hour value.
 *   - Medians are computed in TS after pulling the sorted set, since SQLite
 *     doesn't have a `MEDIAN` aggregate. The set size is bounded by the
 *     window's task count, so this is fine for the kind of throughput we
 *     expect (low thousands per month).
 */

import { getSqlite } from '@/main/db';
import type { TaskPriority, TaskStatus } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export type ReportWindow = '7d' | '30d' | '90d' | 'all';

export interface ThroughputPoint {
  date: string; // YYYY-MM-DD
  closed: number;
}

export interface AgentSuccessRate {
  succeeded: number;
  failed: number;
  needs_review: number;
  total: number;
}

export interface TimeToDoneBucket {
  median_hours: number | null;
  count: number;
}

export interface TimeToDoneByPriority {
  p0: TimeToDoneBucket;
  p1: TimeToDoneBucket;
  p2: TimeToDoneBucket;
  p3: TimeToDoneBucket;
}

export interface TimeToDoneByTagRow {
  tag: string;
  count: number;
  median_hours: number | null;
}

export type TagHeatStatusCounts = Record<TaskStatus, number>;

export interface TagHeatMapRow {
  tag: string;
  total: number;
  by_status: TagHeatStatusCounts;
}

export interface RecentFailureRow {
  task_id: string;
  title: string;
  priority: TaskPriority;
  failed_at: string;
  /** Error message from the last execution log, when available. */
  error: string | null;
  tags: string[];
}

export interface ReviewQueueTrendPoint {
  date: string;
  count: number;
}

export interface ReportBundle {
  throughput: ThroughputPoint[];
  success_rate: AgentSuccessRate;
  time_to_done_priority: TimeToDoneByPriority;
  time_to_done_tags: TimeToDoneByTagRow[];
  tag_heat_map: TagHeatMapRow[];
  recent_failures: RecentFailureRow[];
  review_queue_trend: ReviewQueueTrendPoint[];
  window: ReportWindow;
  days: number;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const ALL_STATUSES: TaskStatus[] = [
  'inbox',
  'queued',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'archived',
];

function emptyStatusCounts(): TagHeatStatusCounts {
  const out = {} as TagHeatStatusCounts;
  for (const status of ALL_STATUSES) out[status] = 0;
  return out;
}

/**
 * Resolve the lower-bound ISO timestamp for a window. Returns `null` for
 * `'all'` so callers can skip the time filter entirely.
 */
function windowCutoffIso(window: ReportWindow): string | null {
  if (window === 'all') return null;
  const days = window === '7d' ? 7 : window === '30d' ? 30 : 90;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

/**
 * Return YYYY-MM-DD for a Date in UTC, matching how SQLite's `date()`
 * function truncates our ISO-8601 timestamps.
 */
function utcDateKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Median of a numeric array. Returns `null` for an empty input — callers
 * should treat that as "not enough data" rather than zero. Mutates the
 * input via sort; callers pass a fresh array.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[mid - 1]! + values[mid]!) / 2;
  }
  return values[mid]!;
}

/**
 * Parse a JSON-stringified tag column safely. Mirrors the inverse of the
 * tasks repository's serialization. Returns `[]` for any malformed input
 * so reports always render.
 */
function parseTags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Throughput                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Daily count of tasks closed (status flipped to `done` or `failed`) over
 * the last N days. The returned array is oldest-first and always contains
 * exactly `days` entries — days with zero closures still appear with
 * `closed: 0` so the chart renders a contiguous timeline.
 *
 * "Closed on day X" means `status IN ('done','failed') AND date(updated_at)
 * = X`. We accept that a task closed, reopened, and re-closed within the
 * window only counts on its latest closure day — which matches the user's
 * intuition for throughput.
 */
export function throughput(days = 30): ThroughputPoint[] {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  const sqlite = getSqlite();
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  const rows = sqlite
    .prepare(
      `SELECT date(updated_at) AS day, COUNT(*) AS closed
         FROM tasks
        WHERE status IN ('done','failed')
          AND updated_at >= ?
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(cutoff.toISOString()) as Array<{ day: string; closed: number }>;

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.day, Number(r.closed) || 0);

  // Build a contiguous timeline so the renderer doesn't have to gap-fill.
  const out: ThroughputPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = utcDateKey(d);
    out.push({ date: key, closed: counts.get(key) ?? 0 });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Agent success rate                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Counts of execution outcomes for agent-executable tasks within the window.
 * "Outcome" reads from `execution_logs.status` — a task can appear multiple
 * times if it ran more than once, which is the right denominator for a rate.
 */
export function agentSuccessRate(window: ReportWindow = '30d'): AgentSuccessRate {
  const sqlite = getSqlite();
  const cutoff = windowCutoffIso(window);

  const params: unknown[] = [];
  let where = `WHERE t.agent_executable = 1 AND el.status IS NOT NULL`;
  if (cutoff) {
    where += ` AND COALESCE(el.completed_at, el.started_at) >= ?`;
    params.push(cutoff);
  }

  const rows = sqlite
    .prepare(
      `SELECT el.status AS status, COUNT(*) AS n
         FROM execution_logs el
         JOIN tasks t ON t.id = el.task_id
         ${where}
        GROUP BY el.status`,
    )
    .all(...params) as Array<{ status: string | null; n: number }>;

  const out: AgentSuccessRate = {
    succeeded: 0,
    failed: 0,
    needs_review: 0,
    total: 0,
  };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.status === 'succeeded') out.succeeded += n;
    else if (r.status === 'failed') out.failed += n;
    else if (r.status === 'needs_review') out.needs_review += n;
  }
  out.total = out.succeeded + out.failed + out.needs_review;
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Time-to-done                                                              */
/* -------------------------------------------------------------------------- */

interface DoneRow {
  priority: TaskPriority;
  hours: number;
  tags: string | null;
}

function fetchDoneRows(window: ReportWindow): DoneRow[] {
  const sqlite = getSqlite();
  const cutoff = windowCutoffIso(window);
  const params: unknown[] = [];
  let where = `WHERE status = 'done'`;
  if (cutoff) {
    where += ` AND updated_at >= ?`;
    params.push(cutoff);
  }
  const rows = sqlite
    .prepare(
      `SELECT priority,
              (julianday(updated_at) - julianday(created_at)) * 24 AS hours,
              tags
         FROM tasks
         ${where}`,
    )
    .all(...params) as Array<{
    priority: TaskPriority;
    hours: number | null;
    tags: string | null;
  }>;

  return rows
    .filter((r) => r.hours !== null && Number.isFinite(r.hours) && r.hours >= 0)
    .map((r) => ({
      priority: r.priority,
      hours: r.hours as number,
      tags: r.tags,
    }));
}

/**
 * Median hours-to-done bucketed by priority. Each bucket also includes the
 * raw count so the UI can call out small samples ("only 2 p0 tasks closed").
 */
export function timeToDoneByPriority(
  window: ReportWindow = '30d',
): TimeToDoneByPriority {
  const rows = fetchDoneRows(window);
  const byPri: Record<TaskPriority, number[]> = {
    p0: [],
    p1: [],
    p2: [],
    p3: [],
  };
  for (const r of rows) {
    if (r.priority in byPri) byPri[r.priority].push(r.hours);
  }
  return {
    p0: { median_hours: median([...byPri.p0]), count: byPri.p0.length },
    p1: { median_hours: median([...byPri.p1]), count: byPri.p1.length },
    p2: { median_hours: median([...byPri.p2]), count: byPri.p2.length },
    p3: { median_hours: median([...byPri.p3]), count: byPri.p3.length },
  };
}

/**
 * Top tags by closed-task count, with median hours-to-done per tag. A task
 * with multiple tags contributes to each tag's bucket — that's intentional
 * since "what's slow under tag X" doesn't require that X be the only tag.
 */
export function timeToDoneByTag(
  window: ReportWindow = '30d',
  limit = 10,
): TimeToDoneByTagRow[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = fetchDoneRows(window);
  const byTag = new Map<string, number[]>();
  for (const r of rows) {
    const tags = parseTags(r.tags);
    for (const tag of tags) {
      let bucket = byTag.get(tag);
      if (!bucket) {
        bucket = [];
        byTag.set(tag, bucket);
      }
      bucket.push(r.hours);
    }
  }
  const out: TimeToDoneByTagRow[] = [];
  for (const [tag, hours] of byTag) {
    out.push({
      tag,
      count: hours.length,
      median_hours: median([...hours]),
    });
  }
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.tag.localeCompare(b.tag);
  });
  return out.slice(0, safeLimit);
}

/* -------------------------------------------------------------------------- */
/*  Tag heat map                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Per-tag task totals broken down by status. Used for the heat map cells —
 * intensity = `total`, the breakdown surfaces in the tooltip.
 *
 * Window filter is on `updated_at` so the heat map reflects recent activity
 * rather than every task ever created. `archived` tasks ARE included since
 * the heat map is meant to show volume, not just "live work".
 */
export function tagHeatMap(
  window: ReportWindow = '30d',
  limit = 20,
): TagHeatMapRow[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sqlite = getSqlite();
  const cutoff = windowCutoffIso(window);

  const params: unknown[] = [];
  let where = `WHERE tags IS NOT NULL AND tags != ''`;
  if (cutoff) {
    where += ` AND updated_at >= ?`;
    params.push(cutoff);
  }

  const rows = sqlite
    .prepare(
      `SELECT status, tags
         FROM tasks
         ${where}`,
    )
    .all(...params) as Array<{ status: TaskStatus; tags: string | null }>;

  const byTag = new Map<string, TagHeatMapRow>();
  for (const r of rows) {
    const tags = parseTags(r.tags);
    for (const tag of tags) {
      let entry = byTag.get(tag);
      if (!entry) {
        entry = { tag, total: 0, by_status: emptyStatusCounts() };
        byTag.set(tag, entry);
      }
      entry.total += 1;
      if (r.status in entry.by_status) {
        entry.by_status[r.status] += 1;
      }
    }
  }

  const out = [...byTag.values()];
  out.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.tag.localeCompare(b.tag);
  });
  return out.slice(0, safeLimit);
}

/* -------------------------------------------------------------------------- */
/*  Recent failures                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Last N failed tasks. Joins to the latest execution log per task to surface
 * the actual error message. Tasks without any execution log still appear —
 * they just have `error: null`.
 */
export function recentFailures(limit = 10): RecentFailureRow[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sqlite = getSqlite();

  // Pull failed tasks newest-first, then resolve the latest log per task in
  // a second query. Doing it as one query with a correlated subquery works
  // but reads worse — better-sqlite3 is fast enough for the two-step.
  const taskRows = sqlite
    .prepare(
      `SELECT id, title, priority, updated_at, tags
         FROM tasks
        WHERE status = 'failed'
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(safeLimit) as Array<{
    id: string;
    title: string;
    priority: TaskPriority;
    updated_at: string;
    tags: string | null;
  }>;

  if (taskRows.length === 0) return [];

  const logStmt = sqlite.prepare(
    `SELECT error, output
       FROM execution_logs
      WHERE task_id = ?
      ORDER BY COALESCE(completed_at, started_at) DESC
      LIMIT 1`,
  );

  const out: RecentFailureRow[] = [];
  for (const t of taskRows) {
    const log = logStmt.get(t.id) as
      | { error: string | null; output: string | null }
      | undefined;
    const errorMsg =
      log?.error && log.error.length > 0
        ? log.error
        : log?.output && log.output.length > 0
          ? log.output
          : null;
    out.push({
      task_id: t.id,
      title: t.title,
      priority: t.priority,
      failed_at: t.updated_at,
      error: errorMsg,
      tags: parseTags(t.tags),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Review queue trend                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Daily snapshot of "review queue size". The DB only records the current
 * state of each task, not its history — so the trend is an approximation
 * built from each task's current `agent_status` + `updated_at`:
 *
 *   A task contributed to the queue on day D when:
 *     - it's currently in a needs-review or failed state, AND
 *     - it transitioned into that state on or before D.
 *
 * That misses tasks that entered review and were resolved before today.
 * Acceptable approximation for the dashboard — the alternative (event log)
 * is a future migration. Returned oldest-first.
 */
export function reviewQueueTrend(days = 30): ReviewQueueTrendPoint[] {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  const sqlite = getSqlite();

  // Pull every task that ever entered review/failed and the date it
  // landed there (best signal: `updated_at` while in that state).
  const rows = sqlite
    .prepare(
      `SELECT date(updated_at) AS day
         FROM tasks
        WHERE agent_status = 'needs_review' OR status = 'failed'`,
    )
    .all() as Array<{ day: string | null }>;

  // For each day in the window, count tasks whose entry-day <= that day.
  // Because the snapshot only sees the CURRENT entry day, this resolves
  // to "tasks currently in review whose updated_at <= this day".
  const entryDays = rows
    .map((r) => r.day)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .sort();

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const out: ReviewQueueTrendPoint[] = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = utcDateKey(d);
    // Count how many tasks had entered review on/before this day. With
    // sorted entry days this is binary-searchable, but the list is small
    // enough that a linear scan is fine.
    let count = 0;
    for (const ed of entryDays) {
      if (ed <= key) count += 1;
      else break;
    }
    out.push({ date: key, count });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Bundle                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One-shot helper that returns every report at once. The `/api/reports/all`
 * endpoint hands this straight back so the dashboard only does a single
 * round-trip per filter change. `days` controls the throughput + review
 * trend window length; `window` controls everything else.
 */
export function reportBundle(
  window: ReportWindow = '30d',
  days?: number,
): ReportBundle {
  const resolvedDays =
    days ??
    (window === '7d' ? 7 : window === '30d' ? 30 : window === '90d' ? 90 : 30);
  return {
    throughput: throughput(resolvedDays),
    success_rate: agentSuccessRate(window),
    time_to_done_priority: timeToDoneByPriority(window),
    time_to_done_tags: timeToDoneByTag(window, 10),
    tag_heat_map: tagHeatMap(window, 20),
    recent_failures: recentFailures(10),
    review_queue_trend: reviewQueueTrend(resolvedDays),
    window,
    days: resolvedDays,
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal exports (tests)                                                  */
/* -------------------------------------------------------------------------- */

export const __internals = {
  median,
  parseTags,
  utcDateKey,
  windowCutoffIso,
};
