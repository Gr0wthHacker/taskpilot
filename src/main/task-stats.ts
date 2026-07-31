/**
 * Materialized counts of tasks by status.
 *
 * The single-row `task_stats` table (see migrations v8) holds the counts
 * that the sidebar badges, command-palette hints, and daily-plan view read
 * on every refetch. A naïve `SELECT COUNT(*) FROM tasks WHERE status=?` is
 * fine at 100 rows but burns measurable wall-clock at 30k+ and is called
 * many times per UI tick.
 *
 * The contract is intentionally loose:
 *  - Reads are O(1) — a single-row select.
 *  - Writes happen via `recomputeTaskStats()` on a slow tick (every ~10 s)
 *    plus on demand after large mutations.
 *  - Slight staleness is fine — these counts feed badges, not invariants.
 */

import { getSqlite } from '@/main/db';

export interface TaskStats {
  total: number;
  inbox: number;
  queued: number;
  in_progress: number;
  blocked: number;
  review_pending: number;
  done: number;
  cancelled: number;
  archived: number;
  agent_executable_open: number;
  updated_at: string;
}

const ZERO_STATS: TaskStats = {
  total: 0,
  inbox: 0,
  queued: 0,
  in_progress: 0,
  blocked: 0,
  review_pending: 0,
  done: 0,
  cancelled: 0,
  archived: 0,
  agent_executable_open: 0,
  updated_at: new Date(0).toISOString(),
};

/**
 * Read the singleton counts row. Returns zeros if the row hasn't been seeded
 * yet (first boot before recompute runs); never throws.
 */
export function getTaskStats(): TaskStats {
  try {
    const db = getSqlite();
    const row = db
      .prepare(
        `SELECT total, inbox, queued, in_progress, blocked,
                review_pending, done, cancelled, archived,
                agent_executable_open, updated_at
         FROM task_stats WHERE id = 1`,
      )
      .get() as TaskStats | undefined;
    return row ?? { ...ZERO_STATS };
  } catch {
    return { ...ZERO_STATS };
  }
}

/**
 * Recompute the singleton row from the live `tasks` table. Cheap at ≤200k
 * rows (~5 ms on a warm cache). Runs in a single transaction so concurrent
 * readers always see a consistent snapshot.
 */
export function recomputeTaskStats(): TaskStats {
  const db = getSqlite();
  const stats = db
    .prepare(
      // COALESCE every SUM: over an empty tasks table SUM() returns NULL, not
      // 0, which then violates the NOT NULL columns on task_stats (the
      // fresh-install / just-reset empty state).
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END), 0) AS inbox,
        COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
        COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress,
        COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
        COALESCE(SUM(CASE WHEN status = 'review_pending' THEN 1 ELSE 0 END), 0) AS review_pending,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived,
        COALESCE(SUM(CASE WHEN agent_executable = 1
                  AND status IN ('inbox','queued','in_progress','blocked','review_pending')
                 THEN 1 ELSE 0 END), 0) AS agent_executable_open
      FROM tasks`,
    )
    .get() as Omit<TaskStats, 'updated_at'>;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_stats SET
       total = ?, inbox = ?, queued = ?, in_progress = ?, blocked = ?,
       review_pending = ?, done = ?, cancelled = ?, archived = ?,
       agent_executable_open = ?, updated_at = ?
     WHERE id = 1`,
  ).run(
    stats.total,
    stats.inbox,
    stats.queued,
    stats.in_progress,
    stats.blocked,
    stats.review_pending,
    stats.done,
    stats.cancelled,
    stats.archived,
    stats.agent_executable_open,
    now,
  );

  return { ...stats, updated_at: now };
}

/* -------------------------------------------------------------------------- */
/*  Debounced eager refresh                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Coalesce write-burst recomputes so a backfill of 10k creates doesn't fire
 * 10k recomputes. Trailing-edge debounce — the last write within the window
 * triggers a single recompute ~200 ms later.
 */
const DEBOUNCE_MS = 200;
let debounceHandle: NodeJS.Timeout | null = null;

export function scheduleTaskStatsRefresh(): void {
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle);
  }
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    try {
      recomputeTaskStats();
    } catch {
      // Non-fatal — next tick will catch up.
    }
  }, DEBOUNCE_MS);
  if (debounceHandle && typeof debounceHandle.unref === 'function') {
    debounceHandle.unref();
  }
}

let tickHandle: NodeJS.Timeout | null = null;

/**
 * Start the background recompute loop. Idempotent — calling twice replaces
 * the prior timer. The tick is intentionally slow (10s) because:
 *   - Reads are O(1) and don't need fresh-to-the-second data.
 *   - Counts also get refreshed eagerly after derive/execute/ingest, so the
 *     tick is just a safety net.
 *
 * Pass `intervalMs` for tests.
 */
export function startTaskStatsTick(intervalMs = 10_000): void {
  stopTaskStatsTick();
  // Run once immediately so the first read returns live data.
  try {
    recomputeTaskStats();
  } catch {
    // Boot ordering: the table may not exist yet on a brand-new install
    // until the inline migration runs. Swallow — the next tick will catch up.
  }
  tickHandle = setInterval(() => {
    try {
      recomputeTaskStats();
    } catch {
      // Recompute failure is non-fatal — we just serve a stale row next read.
    }
  }, intervalMs);
  // Don't keep the event loop alive just for this.
  if (typeof tickHandle.unref === 'function') tickHandle.unref();
}

export function stopTaskStatsTick(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle);
    debounceHandle = null;
  }
}

/**
 * Subscribe to the task repository's write + pre-delete hooks so the
 * materialized counts refresh eagerly after any mutation, not just on the
 * slow tick. Idempotent — only installs once per process; subsequent calls
 * are no-ops. Coalesced via the 200 ms debounce so a backfill burst fires
 * recompute exactly once.
 *
 * The hooks themselves are intentionally process-lifetime: the write hook
 * is unsubscribed on shutdown, but the pre-delete slot is append-only and
 * shared with the audit module — we leave our entry in place and rely on
 * process exit to release the closure. (Calling registerOnTaskPreDelete(null)
 * would wipe audit's hook too.)
 */
let hooksInstalled = false;
let writeUnsubscribe: (() => void) | null = null;

export async function installTaskStatsHooks(): Promise<() => void> {
  if (hooksInstalled) {
    return () => {
      /* noop — already installed */
    };
  }
  hooksInstalled = true;

  const tasks = await import('@/main/db/repositories/tasks');
  writeUnsubscribe = tasks.addOnTaskWritten(() => {
    scheduleTaskStatsRefresh();
  });
  // Pre-delete fires INSIDE the delete transaction. By the time the
  // debounced recompute runs 200 ms later the transaction has committed,
  // so the count reflects the removed row.
  tasks.registerOnTaskPreDelete(() => {
    scheduleTaskStatsRefresh();
  });

  return () => {
    if (writeUnsubscribe) {
      writeUnsubscribe();
      writeUnsubscribe = null;
    }
    hooksInstalled = false;
  };
}
