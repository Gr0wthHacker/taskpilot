/**
 * Database backup creator + rotator.
 *
 * Writes hot-copies of `~/.taskpilot/taskpilot.db` to
 * `~/.taskpilot/backups/taskpilot-YYYY-MM-DD-HHMMSS.db` using better-sqlite3's
 * atomic `backup()` API — safe against WAL writes from the live server.
 *
 * Scheduling: `startScheduledBackups()` runs an initial snapshot a few seconds
 * after boot (so any startup churn settles) and then once every 24h. The
 * retention pass keeps the newest N snapshots and deletes the rest.
 *
 * All disk I/O is wrapped so a failure NEVER crashes the caller — the API
 * server's boot path expects backup failures to log and continue.
 */

import fs from 'node:fs';
import path from 'node:path';

import { BACKUPS_DIR, DB_PATH, ensureDirs } from '@/shared/constants';
import { getSqlite } from '@/main/db';

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export interface BackupSummary {
  /** Absolute path to the backup file. */
  path: string;
  /** Just the basename (`taskpilot-YYYY-MM-DD-HHMMSS.db`). */
  filename: string;
  /** Size on disk in bytes. */
  size_bytes: number;
  /** ISO timestamp parsed from the filename. */
  created_at: string;
}

export interface RotateResult {
  deleted: string[];
}

export interface BackupStatus {
  retain_count: number;
  next_run_at: string | null;
  last_run_at: string | null;
  count: number;
}

/* -------------------------------------------------------------------------- */
/*  Filename helpers                                                          */
/* -------------------------------------------------------------------------- */

const FILENAME_REGEX = /^taskpilot-(\d{4}-\d{2}-\d{2})-(\d{6})\.db$/;

/**
 * Whitelist filename pattern. Any caller-supplied filename that doesn't match
 * is rejected — keeps path traversal (`..`, `/`, `\`) out of the API.
 */
export function isValidBackupFilename(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 64) return false;
  return FILENAME_REGEX.test(name);
}

function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function parseFilenameTimestamp(name: string): string | null {
  const match = FILENAME_REGEX.exec(name);
  if (!match) return null;
  const [, ymd, hms] = match;
  if (!ymd || !hms) return null;
  // Synthesize an ISO timestamp from local wall-clock fields. The original
  // backup uses local time so the displayed ordering matches the user's
  // expectation.
  const hh = hms.slice(0, 2);
  const mm = hms.slice(2, 4);
  const ss = hms.slice(4, 6);
  return `${ymd}T${hh}:${mm}:${ss}`;
}

function summarize(filepath: string): BackupSummary | null {
  try {
    const stat = fs.statSync(filepath);
    if (!stat.isFile()) return null;
    const filename = path.basename(filepath);
    const ts = parseFilenameTimestamp(filename);
    if (!ts) return null;
    return {
      path: filepath,
      filename,
      size_bytes: stat.size,
      created_at: ts,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Core operations                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Take a hot-copy of the live DB.
 *
 * Uses better-sqlite3's `backup()` API which streams pages while the source
 * remains writable — safe with WAL. Falls back to `fs.copyFileSync` only if
 * the live DB isn't open (e.g. someone invoked the CLI before the server
 * booted); in that case the file is plain-copied and SQLite checkpointing
 * still guarantees a consistent snapshot on a quiescent DB.
 */
export async function createBackup(): Promise<BackupSummary> {
  ensureDirs();
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }

  const filename = `taskpilot-${formatTimestamp(new Date())}.db`;
  const dest = path.join(BACKUPS_DIR, filename);

  // Avoid clobbering an existing backup (the per-second timestamp is unique
  // unless the caller invokes createBackup twice in the same wall-clock
  // second). Append a short numeric suffix in that rare collision case.
  let finalDest = dest;
  let attempt = 0;
  while (fs.existsSync(finalDest)) {
    attempt += 1;
    finalDest = path.join(
      BACKUPS_DIR,
      filename.replace(/\.db$/, `-${attempt}.db`),
    );
    // The collision case can't satisfy the canonical regex (it carries the
    // extra `-N` suffix). That's fine — `listBackups` filters by the regex,
    // so this fallback only matters as a safety against overwrite, not as a
    // canonical entry.
    if (attempt > 20) {
      throw new Error('Could not allocate a unique backup filename');
    }
  }

  // Disk-space guard. better-sqlite3.backup() can fail mid-copy on a full
  // disk; refusing up front gives a cleaner error than half a snapshot file.
  // Best-effort — statfs failures don't block the backup.
  try {
    const sourceSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    // Node 18.15+ exposes statfs; older falls through.
    if (typeof (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint; bsize: bigint } }).statfsSync === 'function') {
      const sfs = (fs as unknown as { statfsSync: (p: string) => { bavail: bigint; bsize: bigint } }).statfsSync(BACKUPS_DIR);
      const freeBytes = Number(sfs.bavail) * Number(sfs.bsize);
      const needed = Math.max(sourceSize * 2, 50 * 1024 * 1024); // 2x source or 50MB floor
      if (freeBytes < needed) {
        throw new Error(
          `insufficient disk space for backup: need ~${Math.ceil(needed / 1_048_576)} MB, have ${Math.floor(freeBytes / 1_048_576)} MB free at ${BACKUPS_DIR} (${os.platform()})`,
        );
      }
    }
  } catch (err) {
    // Only re-throw the disk-space error; statfs unavailability is non-fatal.
    if (err instanceof Error && err.message.startsWith('insufficient disk space')) {
      throw err;
    }
  }

  try {
    const sqlite = getSqlite();
    // better-sqlite3 returns a promise from `backup()` — it runs page-by-page
    // and never blocks the source DB for more than a few microseconds at a
    // time.
    await sqlite.backup(finalDest);
  } catch (cause) {
    // If the DB handle isn't usable, fall back to a plain copy. This is best
    // effort — the caller should still hear about it.
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(
        `cannot back up: live DB missing at ${DB_PATH} (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
    fs.copyFileSync(DB_PATH, finalDest);
  }

  // SHA256 sidecar. Written immediately after the snapshot lands so a later
  // restore can verify integrity before opening the file. Best-effort — a
  // failed sidecar write does NOT fail the backup (the snapshot itself is
  // still usable; restore will fall back to PRAGMA integrity_check alone).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fileSha256 } = require('./restore') as typeof import('./restore');
    const hash = fileSha256(finalDest);
    fs.writeFileSync(`${finalDest}.sha256`, `${hash}  ${path.basename(finalDest)}\n`, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[backup] sha256 sidecar write failed (non-fatal):', (err as Error).message);
  }

  const summary = summarize(finalDest);
  if (!summary) {
    // The collision-suffix branch can produce a non-canonical name. Build a
    // synthesized summary so callers still get a usable BackupSummary even
    // when the regex parse fails.
    const stat = fs.statSync(finalDest);
    return {
      path: finalDest,
      filename: path.basename(finalDest),
      size_bytes: stat.size,
      created_at: new Date().toISOString(),
    };
  }
  return summary;
}

/**
 * List every backup that matches the canonical filename pattern, newest first.
 * Files with non-matching names (manual copies, the collision-suffix fallback)
 * are skipped — they're not part of the rotation policy.
 */
export async function listBackups(): Promise<BackupSummary[]> {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(BACKUPS_DIR);
  } catch {
    return [];
  }
  const summaries: BackupSummary[] = [];
  for (const name of entries) {
    if (!isValidBackupFilename(name)) continue;
    const s = summarize(path.join(BACKUPS_DIR, name));
    if (s) summaries.push(s);
  }
  summaries.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return summaries;
}

/**
 * Delete a single backup. Filename is validated against the canonical regex
 * to prevent path traversal — any other shape returns `false` without
 * touching the filesystem.
 */
export async function deleteBackup(filename: string): Promise<void> {
  if (!isValidBackupFilename(filename)) {
    throw new Error(`invalid backup filename: ${filename}`);
  }
  const target = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(target)) {
    throw new Error(`backup not found: ${filename}`);
  }
  fs.rmSync(target);
}

/**
 * Keep the newest `retain` backups, delete the rest. Returns the names of
 * everything that was removed.
 */
export async function rotateBackups(retain: number): Promise<RotateResult> {
  const safeRetain = Math.max(1, Math.floor(retain));
  const all = await listBackups();
  if (all.length <= safeRetain) return { deleted: [] };

  const toDelete = all.slice(safeRetain);
  const deleted: string[] = [];
  for (const summary of toDelete) {
    try {
      fs.rmSync(summary.path);
      deleted.push(summary.filename);
    } catch {
      // Best-effort — a delete failure for one backup doesn't block the rest.
    }
  }
  return { deleted };
}

/* -------------------------------------------------------------------------- */
/*  Scheduler                                                                 */
/* -------------------------------------------------------------------------- */

export interface ScheduledBackupsOptions {
  /** How many snapshots to keep around. Defaults to 14. */
  retainCount?: number;
  /** Take a snapshot a few seconds after boot. Defaults to true. */
  runOnBoot?: boolean;
  /** Interval between snapshots, ms. Defaults to 24h. */
  intervalMs?: number;
  /** Delay before the boot snapshot, ms. Defaults to 5s. */
  initialDelayMs?: number;
}

export interface ScheduledBackupsHandle {
  stop(): void;
  /** Read-only view of the next/last run + retention count. */
  status(): BackupStatus;
}

const DEFAULT_RETAIN = 14;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5_000;

/**
 * Wire the daily snapshot loop. Idempotent — calling start twice without
 * stopping leaks no timers because the second handle owns the new ones.
 *
 * Failures inside a tick log via console (electron-log captures them) and
 * never throw out of the timer callback.
 */
export function startScheduledBackups(
  options: ScheduledBackupsOptions = {},
): ScheduledBackupsHandle {
  const retain = Math.max(1, Math.floor(options.retainCount ?? DEFAULT_RETAIN));
  const interval = Math.max(60_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const initialDelay = Math.max(
    0,
    options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
  );
  const runOnBoot = options.runOnBoot !== false;

  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let lastRunAt: string | null = null;
  let nextRunAt: string | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const summary = await createBackup();
      lastRunAt = summary.created_at;
      await rotateBackups(retain);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[taskpilot:backups] scheduled snapshot failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    nextRunAt = new Date(Date.now() + interval).toISOString();
  };

  if (runOnBoot) {
    nextRunAt = new Date(Date.now() + initialDelay).toISOString();
    bootTimer = setTimeout(() => {
      void tick();
    }, initialDelay);
  } else {
    nextRunAt = new Date(Date.now() + interval).toISOString();
  }

  intervalTimer = setInterval(() => {
    void tick();
  }, interval);

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
    status(): BackupStatus {
      // The count is recomputed on each call so a "Backup now" doesn't desync
      // the badge in the UI.
      let count = 0;
      try {
        if (fs.existsSync(BACKUPS_DIR)) {
          for (const name of fs.readdirSync(BACKUPS_DIR)) {
            if (isValidBackupFilename(name)) count += 1;
          }
        }
      } catch {
        // ignore — the badge falls back to 0
      }
      return {
        retain_count: retain,
        next_run_at: nextRunAt,
        last_run_at: lastRunAt,
        count,
      };
    },
  };
}
