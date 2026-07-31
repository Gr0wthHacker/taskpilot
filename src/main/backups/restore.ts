/**
 * Restore a backup over the live DB.
 *
 * Safety contract:
 *   1. PAUSE every registered subsystem (watcher, monitor, schedulers, etc.)
 *      so nothing writes to the DB or the on-disk WAL between snapshot swap
 *      and the eventual app restart. Resumed on success AND on failure.
 *   2. The snapshot is opened read-only and run through `PRAGMA
 *      integrity_check`. If integrity fails the restore is refused — a
 *      corrupted snapshot must never overwrite a working DB.
 *   3. If a `.sha256` sidecar exists the snapshot's hash must match before
 *      restore proceeds. Defense-in-depth against bit-flips.
 *   4. The current DB is renamed to `<DB_PATH>.pre-restore` (overwriting
 *      any prior pre-restore so we keep exactly one). On a failed restore
 *      the caller can rename it back manually.
 *   5. WAL/SHM sidecar files are also moved so SQLite can't re-attach the
 *      old journal to the new file after restore.
 *   6. The backup is copied (not moved) over the destination so the user
 *      can re-restore the same snapshot.
 *   7. A `restore_completed` audit event lands on success; `restore_failed`
 *      on every failure path.
 *
 * After a successful restore the caller MUST close the existing DB handle
 * and let `getDb()` reopen the new file on demand. The Electron main
 * process normally needs a full quit + reboot to pick up the swap cleanly;
 * the route returns 202 with `requires_restart: true`.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { appendAuditEventSafe } from '@/main/audit/log';
import { closeDb } from '@/main/db';
import { CURRENT_SCHEMA_VERSION } from '@/main/db/schema-version';
import { pauseAll, resumeAll } from '@/main/lifecycle/pause-registry';
import { DB_PATH, BACKUPS_DIR } from '@/shared/constants';

import { isValidBackupFilename } from './index';

export interface RestoreResult {
  source: string;
  pre_restore_path: string;
  requires_restart: boolean;
}

/**
 * Compute SHA256 of a file synchronously. Used both for verifying snapshots
 * against their sidecar at restore time and for stamping new snapshots.
 */
export function fileSha256(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.slice(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function readSidecarHash(snapshotPath: string): string | null {
  const sidecar = `${snapshotPath}.sha256`;
  try {
    const raw = fs.readFileSync(sidecar, 'utf8').trim();
    // Sidecars are either `<hex>` alone or `<hex>  <filename>` per `sha256sum`.
    const first = raw.split(/\s+/)[0];
    return /^[a-f0-9]{64}$/i.test(first) ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Open the snapshot read-only and run integrity_check. Reads the embedded
 * schema version from `_schema_version` so the caller can refuse downgrade
 * restores (a snapshot from a newer schema can't safely overwrite a
 * running app at an older version).
 *
 * Throws with an actionable message on failure.
 */
function validateSnapshot(snapshotPath: string): {
  integrity: 'ok' | string;
  schemaVersion: number;
} {
  let probe: Database.Database | null = null;
  try {
    probe = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    const integrityRow = probe.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    const integrity = integrityRow?.integrity_check ?? 'unknown';
    let schemaVersion = 0;
    try {
      const row = probe
        .prepare('SELECT MAX(version) AS v FROM _schema_version')
        .get() as { v: number | null } | undefined;
      if (row && typeof row.v === 'number') schemaVersion = row.v;
    } catch {
      // Snapshot pre-dates the version ledger; treat as v0 — caller's
      // version gate handles the rest.
    }
    return { integrity, schemaVersion };
  } finally {
    try {
      probe?.close();
    } catch {
      /* probe close failure is non-fatal */
    }
  }
}

/**
 * Restore the named backup. The filename is validated against the canonical
 * regex so the caller can't escape `BACKUPS_DIR`.
 */
export async function restoreBackup(filename: string): Promise<RestoreResult> {
  if (!isValidBackupFilename(filename)) {
    appendAuditEventSafe({
      kind: 'restore_failed',
      payload: { filename, reason: 'invalid_filename' },
    });
    throw new Error(`invalid backup filename: ${filename}`);
  }
  const source = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(source)) {
    appendAuditEventSafe({
      kind: 'restore_failed',
      payload: { filename, reason: 'not_found' },
    });
    throw new Error(`backup not found: ${filename}`);
  }
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size === 0) {
    appendAuditEventSafe({
      kind: 'restore_failed',
      payload: { filename, reason: 'empty_or_not_file' },
    });
    throw new Error(`backup is empty or not a regular file: ${filename}`);
  }

  // Sidecar SHA256 check. Best-effort — sidecars are written by the backup
  // creator going forward; older snapshots won't have one and skip the
  // check (we still run integrity_check below regardless).
  const expectedHash = readSidecarHash(source);
  if (expectedHash) {
    const actualHash = fileSha256(source);
    if (actualHash !== expectedHash) {
      appendAuditEventSafe({
        kind: 'restore_failed',
        payload: {
          filename,
          reason: 'sha256_mismatch',
          expected: expectedHash,
          actual: actualHash,
        },
      });
      throw new Error(
        `restore refused: snapshot SHA256 mismatch (expected ${expectedHash}, got ${actualHash}). The snapshot may be corrupted.`,
      );
    }
  }

  // Integrity check + schema version capture.
  let validation: ReturnType<typeof validateSnapshot>;
  try {
    validation = validateSnapshot(source);
  } catch (err) {
    appendAuditEventSafe({
      kind: 'restore_failed',
      payload: {
        filename,
        reason: 'integrity_probe_failed',
        message: (err as Error).message,
      },
    });
    throw new Error(
      `restore refused: could not probe snapshot at ${source}: ${(err as Error).message}`,
    );
  }
  if (validation.integrity !== 'ok') {
    appendAuditEventSafe({
      kind: 'restore_failed',
      payload: {
        filename,
        reason: 'integrity_failed',
        detail: validation.integrity,
      },
    });
    throw new Error(
      `restore refused: snapshot failed integrity_check: ${validation.integrity}`,
    );
  }
  // Schema version gate. A snapshot from a NEWER schema can't be restored —
  // its tables/columns may not exist in the current code. An OLDER snapshot
  // is fine; inline migrations re-apply on the restored DB at boot.
  if (validation.schemaVersion > CURRENT_SCHEMA_VERSION) {
    appendAuditEventSafe({
      kind: 'restore_failed',
      payload: {
        filename,
        reason: 'schema_too_new',
        snapshot_version: validation.schemaVersion,
        runtime_version: CURRENT_SCHEMA_VERSION,
      },
    });
    throw new Error(
      `restore refused: snapshot is from schema v${validation.schemaVersion} but this build only knows v${CURRENT_SCHEMA_VERSION}. Upgrade the app before restoring.`,
    );
  }

  // Pause every registered subsystem so nothing writes during the swap. We
  // resume in `finally` whether or not the restore succeeds — pause is a
  // soft state, not a destructive operation.
  let paused: string[] = [];
  try {
    paused = await pauseAll();
  } catch (err) {
    // pauseAll itself swallows internal failures; an exception here is
    // unexpected but we keep going — paused will be partially-populated.
    // eslint-disable-next-line no-console
    console.warn('[restore] pauseAll threw unexpectedly:', err);
  }

  // Close the live DB handle so SQLite releases its locks on Windows. If
  // the app isn't holding a handle this is a no-op.
  try {
    closeDb();
  } catch {
    // already closed — fine
  }

  const preRestore = `${DB_PATH}.pre-restore`;
  const walPath = `${DB_PATH}-wal`;
  const shmPath = `${DB_PATH}-shm`;
  const preRestoreWal = `${preRestore}-wal`;
  const preRestoreShm = `${preRestore}-shm`;

  try {
    if (fs.existsSync(DB_PATH)) {
      if (fs.existsSync(preRestore)) fs.rmSync(preRestore);
      fs.renameSync(DB_PATH, preRestore);
    }
    if (fs.existsSync(walPath)) {
      if (fs.existsSync(preRestoreWal)) fs.rmSync(preRestoreWal);
      fs.renameSync(walPath, preRestoreWal);
    }
    if (fs.existsSync(shmPath)) {
      if (fs.existsSync(preRestoreShm)) fs.rmSync(preRestoreShm);
      fs.renameSync(shmPath, preRestoreShm);
    }

    try {
      fs.copyFileSync(source, DB_PATH);
    } catch (cause) {
      if (fs.existsSync(preRestore)) {
        try {
          fs.renameSync(preRestore, DB_PATH);
        } catch {
          /* surface original */
        }
      }
      throw new Error(
        `restore failed copying ${source} → ${DB_PATH}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    appendAuditEventSafe({
      kind: 'restore_completed',
      payload: {
        filename,
        snapshot_schema_version: validation.schemaVersion,
        runtime_schema_version: CURRENT_SCHEMA_VERSION,
        paused_subsystems: paused,
        pre_restore_path: preRestore,
      },
    });

    return {
      source,
      pre_restore_path: preRestore,
      requires_restart: true,
    };
  } catch (err) {
    appendAuditEventSafe({
      kind: 'restore_failed',
      payload: {
        filename,
        reason: 'swap_failed',
        message: (err as Error).message,
      },
    });
    throw err;
  } finally {
    // Resume subsystems even on failure so the app keeps working.
    try {
      await resumeAll();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[restore] resumeAll threw:', err);
    }
  }
}
