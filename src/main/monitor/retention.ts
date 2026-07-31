/**
 * Retention sweep for ambient observations.
 *
 * Runs once per hour (driven by index.ts). Walks the DB + the captures
 * directory and prunes anything older than `ambient_observation_retention_days`
 * (default 14). Never deletes a PNG that's still referenced by a row in the
 * `context_observations` table — the order is:
 *
 *   1. Compute the cutoff timestamp.
 *   2. Fetch + delete observation rows captured before the cutoff (capped
 *      at `MAX_PER_SWEEP` so a never-pruned table doesn't pin the event
 *      loop for seconds at a time).
 *   3. Unlink the on-disk screenshot file for each deleted row.
 *   4. Scan `~/.taskpilot/captures/` and unlink any orphan file whose mtime
 *      is older than the cutoff AND that doesn't match any live row.
 *
 * Failures are logged but never thrown — the monitor stays alive.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { contextObservationsRepository } from '@/main/db/repositories/context-observations';

import { CAPTURES_DIR_PATH } from './screenshot';

/** Cap deleted-per-sweep so a giant table doesn't stall the tick. */
const MAX_PER_SWEEP = 5_000;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface RetentionSweepResult {
  cutoff_iso: string;
  rows_deleted: number;
  files_deleted: number;
  orphans_deleted: number;
}

/**
 * Compute the cutoff ISO timestamp for a given retention window.
 * Exposed for tests so callers can pin the clock.
 */
export function computeCutoff(now: Date, retentionDays: number): string {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 14;
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

/**
 * Best-effort unlink. Returns `true` when the file was removed (or was
 * already gone). Logs nothing to keep the sweep quiet under normal load.
 */
async function safeUnlink(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Scan `CAPTURES_DIR` for files older than `cutoff_iso` that no live row
 * still references. Used as a second pass after the row-driven unlinks.
 *
 * @param liveScreenshotPaths Set of paths still referenced by live rows.
 *   We pull this from the DB before scanning so we never delete an orphan
 *   that turns out to be referenced.
 */
async function sweepOrphanFiles(
  cutoffIso: string,
  liveScreenshotPaths: Set<string>,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(CAPTURES_DIR_PATH);
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return 0;
    }
    return 0;
  }
  const cutoffMs = new Date(cutoffIso).getTime();
  let deleted = 0;
  for (const name of entries) {
    if (deleted >= MAX_PER_SWEEP) break;
    const full = path.join(CAPTURES_DIR_PATH, name);
    if (liveScreenshotPaths.has(full)) continue;
    let mtimeMs = Number.POSITIVE_INFINITY;
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > cutoffMs) continue;
    if (await safeUnlink(full)) deleted++;
  }
  return deleted;
}

/**
 * Gather every screenshot path still referenced by a live row. Used to
 * protect orphan-scan from deleting a file we just decided to keep.
 */
function liveScreenshotPaths(): Set<string> {
  // Pulling the full list is fine — `context_observations` is small (caps at
  // ~10k rows for a 14-day window @ a 3 min cadence). For pathological
  // configs the list is still bounded by `ambient_observation_retention_days`.
  const live = contextObservationsRepository.list({});
  const out = new Set<string>();
  for (const row of live) {
    if (row.screenshot_path) out.add(row.screenshot_path);
  }
  return out;
}

/**
 * Run one full retention pass. Idempotent and safe to invoke from a timer
 * even when the monitor is paused — if the cutoff is in the future (e.g.
 * the user set retention to 9999), no rows match and nothing is deleted.
 */
export async function runRetentionSweep(
  retentionDays: number,
  now: Date = new Date(),
): Promise<RetentionSweepResult> {
  const cutoff = computeCutoff(now, retentionDays);

  // Step 1: nuke rows older than cutoff, capturing their on-disk paths so
  // we can unlink the PNGs next.
  const deletedRows = contextObservationsRepository.deleteOlderThan(
    cutoff,
    MAX_PER_SWEEP,
  );

  let filesDeleted = 0;
  for (const row of deletedRows) {
    if (!row.screenshot_path) continue;
    if (await safeUnlink(row.screenshot_path)) filesDeleted++;
  }

  // Step 2: orphan-scan, careful to skip paths that live rows still own.
  const orphansDeleted = await sweepOrphanFiles(cutoff, liveScreenshotPaths());

  return {
    cutoff_iso: cutoff,
    rows_deleted: deletedRows.length,
    files_deleted: filesDeleted,
    orphans_deleted: orphansDeleted,
  };
}
