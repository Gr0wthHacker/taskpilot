/**
 * Materialized counts of memory items. Same pattern as `task-stats.ts` —
 * singleton row, debounced eager refresh on writes, slow safety-net tick.
 */

import { getSqlite } from '@/main/db';
import type { MemoryStats } from '@/shared/types';

const ZERO_STATS: MemoryStats = {
  total: 0,
  raw: 0,
  enriched: 0,
  failed: 0,
  kind_text: 0,
  kind_url: 0,
  kind_file: 0,
  updated_at: new Date(0).toISOString(),
};

export function getMemoryStats(): MemoryStats {
  try {
    const db = getSqlite();
    const row = db
      .prepare(
        `SELECT total, raw, enriched, failed,
                kind_text, kind_url, kind_file, updated_at
         FROM memory_stats WHERE id = 1`,
      )
      .get() as MemoryStats | undefined;
    return row ?? { ...ZERO_STATS };
  } catch {
    return { ...ZERO_STATS };
  }
}

export function recomputeMemoryStats(): MemoryStats {
  const db = getSqlite();
  const stats = db
    .prepare(
      // COALESCE every SUM — over an empty memory_items table SUM() is NULL,
      // which violates the NOT NULL columns on memory_stats (empty state).
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status='raw' THEN 1 ELSE 0 END), 0) AS raw,
        COALESCE(SUM(CASE WHEN status='enriched' THEN 1 ELSE 0 END), 0) AS enriched,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN kind='text' THEN 1 ELSE 0 END), 0) AS kind_text,
        COALESCE(SUM(CASE WHEN kind='url' THEN 1 ELSE 0 END), 0) AS kind_url,
        COALESCE(SUM(CASE WHEN kind='file' THEN 1 ELSE 0 END), 0) AS kind_file
      FROM memory_items`,
    )
    .get() as Omit<MemoryStats, 'updated_at'>;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE memory_stats SET
       total = ?, raw = ?, enriched = ?, failed = ?,
       kind_text = ?, kind_url = ?, kind_file = ?, updated_at = ?
     WHERE id = 1`,
  ).run(
    stats.total,
    stats.raw,
    stats.enriched,
    stats.failed,
    stats.kind_text,
    stats.kind_url,
    stats.kind_file,
    now,
  );
  return { ...stats, updated_at: now };
}

const DEBOUNCE_MS = 200;
let debounceHandle: NodeJS.Timeout | null = null;

export function scheduleMemoryStatsRefresh(): void {
  if (debounceHandle !== null) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    try {
      recomputeMemoryStats();
    } catch {
      /* non-fatal */
    }
  }, DEBOUNCE_MS);
  if (debounceHandle && typeof debounceHandle.unref === 'function') {
    debounceHandle.unref();
  }
}

let tickHandle: NodeJS.Timeout | null = null;

export function startMemoryStatsTick(intervalMs = 10_000): void {
  stopMemoryStatsTick();
  try {
    recomputeMemoryStats();
  } catch {
    /* table may not exist on a fresh install before migrations run */
  }
  tickHandle = setInterval(() => {
    try {
      recomputeMemoryStats();
    } catch {
      /* non-fatal */
    }
  }, intervalMs);
  if (typeof tickHandle.unref === 'function') tickHandle.unref();
}

export function stopMemoryStatsTick(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle);
    debounceHandle = null;
  }
}

let hooksInstalled = false;
let writeUnsubscribe: (() => void) | null = null;

export async function installMemoryStatsHooks(): Promise<() => void> {
  if (hooksInstalled) {
    return () => {
      /* noop — already installed */
    };
  }
  hooksInstalled = true;

  const repo = await import('@/main/memory/repository');
  writeUnsubscribe = repo.addOnMemoryWritten(() => {
    scheduleMemoryStatsRefresh();
  });

  return () => {
    if (writeUnsubscribe) {
      writeUnsubscribe();
      writeUnsubscribe = null;
    }
    hooksInstalled = false;
  };
}
