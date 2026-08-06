/**
 * Mindstream synthesis scheduler.
 *
 * Runs synthesis generation every 30 minutes. Stores pending syntheses in
 * TaskPilot's database for user approval before publishing to GitHub.
 */

import * as settingsRepo from '@/main/db/repositories/settings';
import { generateSynthesis, type SynthesisResult } from './index';
import { getSqlite } from '@/main/db';

const SYNTHESIS_TABLE = 'mindstream_syntheses';
const SCHEDULER_INTERVAL_MS = 30 * 60 * 1_000;

function storeSynthesisForReview(synthesis: SynthesisResult): string {
  const db = getSqlite();

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SYNTHESIS_TABLE} (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      markdown TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT,
      published_at TEXT
    )
  `);

  const id = `syn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `
    INSERT INTO ${SYNTHESIS_TABLE} (id, timestamp, markdown, status)
    VALUES (?, ?, ?, 'pending')
  `,
  ).run(id, synthesis.timestamp, synthesis.raw_summary);

  return id;
}

export function getPendingSyntheses(): Array<{
  id: string;
  timestamp: string;
  markdown: string;
  created_at: string;
}> {
  const db = getSqlite();

  try {
    return db
      .prepare(
        `
      SELECT id, timestamp, markdown, created_at
      FROM ${SYNTHESIS_TABLE}
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 50
    `,
      )
      .all() as Array<{
      id: string;
      timestamp: string;
      markdown: string;
      created_at: string;
    }>;
  } catch {
    return [];
  }
}

export function approveSynthesis(id: string): boolean {
  const db = getSqlite();
  try {
    const result = db
      .prepare(
        `
      UPDATE ${SYNTHESIS_TABLE}
      SET status = 'approved', approved_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `,
      )
      .run(id);
    return (result as any).changes > 0;
  } catch {
    return false;
  }
}

export function rejectSynthesis(id: string): boolean {
  const db = getSqlite();
  try {
    const result = db
      .prepare(
        `
      DELETE FROM ${SYNTHESIS_TABLE}
      WHERE id = ? AND status = 'pending'
    `,
      )
      .run(id);
    return (result as any).changes > 0;
  } catch {
    return false;
  }
}

export function getApprovedSyntheses(): Array<{
  id: string;
  timestamp: string;
  markdown: string;
}> {
  const db = getSqlite();

  try {
    return db
      .prepare(
        `
      SELECT id, timestamp, markdown
      FROM ${SYNTHESIS_TABLE}
      WHERE status = 'approved' AND published_at IS NULL
      ORDER BY approved_at ASC
    `,
      )
      .all() as Array<{
      id: string;
      timestamp: string;
      markdown: string;
    }>;
  } catch {
    return [];
  }
}

export function markPublished(id: string): boolean {
  const db = getSqlite();
  try {
    const result = db
      .prepare(
        `
      UPDATE ${SYNTHESIS_TABLE}
      SET status = 'published', published_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      )
      .run(id);
    return (result as any).changes > 0;
  } catch {
    return false;
  }
}

export interface SynthesisSchedulerHandle {
  start: () => void;
  stop: () => void;
  runNow: () => Promise<void>;
  status: () => {
    running: boolean;
    last_run: string | null;
    next_run: string | null;
  };
}

let schedulerHandle: SynthesisSchedulerHandle | null = null;

export function startSynthesisScheduler(): SynthesisSchedulerHandle {
  if (schedulerHandle) return schedulerHandle;

  let timer: NodeJS.Timeout | null = null;
  let lastRun: string | null = null;
  let nextRun: string | null = null;
  let running = true;

  async function tick(): Promise<void> {
    try {
      const synthesis = await generateSynthesis();
      if (synthesis) {
        storeSynthesisForReview(synthesis);
        lastRun = new Date().toISOString();
      }
    } catch (err) {
      console.error('[mindstream] synthesis failed:', err);
    }

    if (running) {
      nextRun = new Date(Date.now() + SCHEDULER_INTERVAL_MS).toISOString();
      timer = setTimeout(tick, SCHEDULER_INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  const initialDelay = 60_000;
  timer = setTimeout(tick, initialDelay);
  if (typeof timer.unref === 'function') timer.unref();

  nextRun = new Date(Date.now() + initialDelay).toISOString();

  schedulerHandle = {
    start: () => {
      if (!running) {
        running = true;
        nextRun = new Date(Date.now() + SCHEDULER_INTERVAL_MS).toISOString();
        timer = setTimeout(tick, SCHEDULER_INTERVAL_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }
    },
    stop: () => {
      running = false;
      if (timer) clearTimeout(timer);
    },
    runNow: async () => {
      await tick();
    },
    status: () => ({
      running,
      last_run: lastRun,
      next_run: nextRun,
    }),
  };

  return schedulerHandle;
}

export function getSchedulerHandle(): SynthesisSchedulerHandle | null {
  return schedulerHandle;
}
