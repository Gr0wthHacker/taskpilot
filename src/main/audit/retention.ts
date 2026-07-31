/**
 * Retention sweep for the encrypted audit log.
 *
 * Per-month files older than `ambient_audit_retention_days` (default 90) are
 * unlinked. The cutoff is computed against the file's nominal month — a file
 * dated `ambient-2025-12.jsonl.enc` is treated as if its newest event was
 * captured at the last instant of December UTC.
 *
 * Wired by {@link startAuditRetention} as a daily setInterval. The first
 * sweep runs `initialDelayMs` after boot so we don't fight migrations on
 * cold start. Idempotent — calling stop without a prior start is a no-op.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AUDIT_DIR } from '@/shared/constants';

import { appendAuditEventSafe } from './log';

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

const FILE_REGEX = /^ambient-(\d{4})-(\d{2})\.jsonl\.enc$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the cutoff: any file whose nominal month ends before `cutoff` ms
 * should be deleted. Returns the cutoff Date.
 */
export function computeCutoffDate(now: Date, retentionDays: number): Date {
  const days =
    Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90;
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * The last instant of the month identified by `(year, month)`. Used to decide
 * whether a whole file's events can be safely older than the cutoff. Month is
 * 1-indexed to match the on-disk filename convention.
 */
function lastInstantOfMonth(year: number, month: number): Date {
  // Day 0 of next month = last day of current month at 23:59:59.999 UTC.
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}

/* -------------------------------------------------------------------------- */
/*  Sweep                                                                      */
/* -------------------------------------------------------------------------- */

export interface RetentionSweepResult {
  filesScanned: number;
  filesDeleted: number;
  cutoff: string;
}

/**
 * Run one retention sweep. Returns a summary so tests / status routes can
 * assert observable behaviour. Never throws.
 */
export function runAuditRetention(
  retentionDays: number,
  now: Date = new Date(),
): RetentionSweepResult {
  const cutoff = computeCutoffDate(now, retentionDays);
  let scanned = 0;
  let deleted = 0;

  let names: string[];
  try {
    names = fs.readdirSync(AUDIT_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn(
        '[audit:retention] readdir failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    return { filesScanned: 0, filesDeleted: 0, cutoff: cutoff.toISOString() };
  }

  for (const name of names) {
    const m = FILE_REGEX.exec(name);
    if (!m) continue;
    scanned += 1;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
    const fileEnd = lastInstantOfMonth(year, month);
    if (fileEnd.getTime() >= cutoff.getTime()) continue;
    const full = path.join(AUDIT_DIR, name);
    try {
      fs.unlinkSync(full);
      deleted += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[audit:retention] unlink failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    filesScanned: scanned,
    filesDeleted: deleted,
    cutoff: cutoff.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Daily loop                                                                 */
/* -------------------------------------------------------------------------- */

export interface AuditRetentionOptions {
  /** Retention window in days. Default 90. */
  retentionDays?: number;
  /** Tick interval. Default 24 h. Clamped to a minimum of 60s. */
  intervalMs?: number;
  /** Delay before the first sweep. Default 30s — small but non-zero so the
   *  boot path lands first. */
  initialDelayMs?: number;
}

export interface AuditRetentionHandle {
  stop: () => void;
  /** Force a sweep immediately. Returns the sweep summary. */
  runNow: () => RetentionSweepResult;
}

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;

/**
 * Start the daily retention loop. Returns a handle whose `stop()` clears
 * every timer (boot + interval). The first sweep runs `initialDelayMs` after
 * the call; subsequent sweeps follow `intervalMs`.
 */
export function startAuditRetention(
  options: AuditRetentionOptions = {},
): AuditRetentionHandle {
  const retentionDays = Math.max(
    1,
    Math.floor(options.retentionDays ?? DEFAULT_RETENTION_DAYS),
  );
  const intervalMs = Math.max(60_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const initialDelayMs = Math.max(
    0,
    options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
  );

  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tick = (): RetentionSweepResult => {
    const summary = runAuditRetention(retentionDays);
    if (summary.filesDeleted > 0) {
      appendAuditEventSafe({
        kind: 'audit_retention_swept',
        payload: {
          files_scanned: summary.filesScanned,
          files_deleted: summary.filesDeleted,
          cutoff: summary.cutoff,
          retention_days: retentionDays,
        },
      });
    }
    return summary;
  };

  bootTimer = setTimeout(() => {
    if (stopped) return;
    tick();
  }, initialDelayMs);

  intervalTimer = setInterval(() => {
    if (stopped) return;
    tick();
  }, intervalMs);

  return {
    stop(): void {
      stopped = true;
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },
    runNow: tick,
  };
}
