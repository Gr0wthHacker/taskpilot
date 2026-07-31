/**
 * Backup creator + rotator + restore tests.
 *
 * Each test gets a fresh tmp `BACKUPS_DIR` via `mockTaskpilotPaths()` and an
 * in-memory DB via `useMockedDb()`. The backup module calls `getSqlite()` to
 * invoke better-sqlite3's `backup()` API; the in-memory DB supports that
 * out of the box.
 *
 * Coverage:
 *  - createBackup → file appears under BACKUPS_DIR with canonical name
 *  - listBackups → returns newest first, ignores non-matching files
 *  - rotateBackups → keeps newest N, deletes the rest
 *  - deleteBackup → rejects invalid filenames (path traversal guard)
 *  - restoreBackup → renames live DB to `.pre-restore`, copies backup over
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

/**
 * Helper: write a real (minimal but valid) SQLite database at the given
 * path so the restore-integrity-check accepts it. The restore module
 * opens snapshots read-only and runs `PRAGMA integrity_check`, which
 * rejects plain text files.
 */
function writeValidSqlite(filePath: string, marker: string): void {
  // Reset any stale file first so tests don't pick up rows from a prior
  // iteration (each test reuses PATHS.DB_PATH).
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* fine */
  }
  const tmp = new Database(filePath);
  try {
    tmp.exec(
      `CREATE TABLE IF NOT EXISTS test_marker (v TEXT); INSERT INTO test_marker (v) VALUES ('${marker}');`,
    );
  } finally {
    tmp.close();
  }
}

const PATHS = mockTaskpilotPaths();

import {
  createBackup,
  deleteBackup,
  isValidBackupFilename,
  listBackups,
  rotateBackups,
} from '@/main/backups';
import { restoreBackup } from '@/main/backups/restore';

describe('backups', () => {
  useMockedDb();

  beforeEach(() => {
    // Wipe any leftover backups from prior tests.
    if (fs.existsSync(PATHS.BACKUPS_DIR)) {
      for (const f of fs.readdirSync(PATHS.BACKUPS_DIR)) {
        try {
          fs.rmSync(path.join(PATHS.BACKUPS_DIR, f));
        } catch {
          // ignore
        }
      }
    } else {
      fs.mkdirSync(PATHS.BACKUPS_DIR, { recursive: true });
    }
  });

  it('rejects invalid filenames', () => {
    expect(isValidBackupFilename('taskpilot-2026-05-26-120000.db')).toBe(true);
    expect(isValidBackupFilename('../taskpilot-2026-05-26-120000.db')).toBe(
      false,
    );
    expect(isValidBackupFilename('foo.db')).toBe(false);
    expect(isValidBackupFilename('')).toBe(false);
    expect(isValidBackupFilename('taskpilot-2026-05-26-120000.db.bak')).toBe(
      false,
    );
  });

  it('createBackup writes a file with the canonical name', async () => {
    const summary = await createBackup();
    expect(summary.path).toContain(PATHS.BACKUPS_DIR);
    expect(isValidBackupFilename(summary.filename)).toBe(true);
    expect(fs.existsSync(summary.path)).toBe(true);
    expect(summary.size_bytes).toBeGreaterThan(0);
  });

  it('listBackups returns newest first', async () => {
    // Drop two synthetic files with deterministic timestamps so we don't
    // race against the per-second resolution of createBackup().
    const older = 'taskpilot-2026-05-26-100000.db';
    const newer = 'taskpilot-2026-05-26-110000.db';
    fs.writeFileSync(path.join(PATHS.BACKUPS_DIR, older), 'older');
    fs.writeFileSync(path.join(PATHS.BACKUPS_DIR, newer), 'newer');

    const list = await listBackups();
    expect(list.map((b) => b.filename)).toEqual([newer, older]);
  });

  it('listBackups ignores non-matching files', async () => {
    fs.writeFileSync(path.join(PATHS.BACKUPS_DIR, 'README.txt'), 'ignore');
    fs.writeFileSync(
      path.join(PATHS.BACKUPS_DIR, 'taskpilot-2026-05-26-120000.db'),
      'data',
    );

    const list = await listBackups();
    expect(list).toHaveLength(1);
    expect(list[0]?.filename).toBe('taskpilot-2026-05-26-120000.db');
  });

  it('rotateBackups keeps the newest N and deletes the rest', async () => {
    const names = [
      'taskpilot-2026-05-20-100000.db',
      'taskpilot-2026-05-21-100000.db',
      'taskpilot-2026-05-22-100000.db',
      'taskpilot-2026-05-23-100000.db',
      'taskpilot-2026-05-24-100000.db',
    ];
    for (const n of names) {
      fs.writeFileSync(path.join(PATHS.BACKUPS_DIR, n), 'x');
    }

    const result = await rotateBackups(2);
    expect(result.deleted).toHaveLength(3);
    // The two NEWEST should remain.
    const remaining = (await listBackups()).map((b) => b.filename);
    expect(remaining).toEqual([
      'taskpilot-2026-05-24-100000.db',
      'taskpilot-2026-05-23-100000.db',
    ]);
  });

  it('rotateBackups is a no-op when count <= retain', async () => {
    fs.writeFileSync(
      path.join(PATHS.BACKUPS_DIR, 'taskpilot-2026-05-26-120000.db'),
      'x',
    );
    const result = await rotateBackups(14);
    expect(result.deleted).toEqual([]);
  });

  it('deleteBackup rejects path traversal attempts', async () => {
    await expect(deleteBackup('../etc/passwd')).rejects.toThrow();
    await expect(deleteBackup('/absolute/path')).rejects.toThrow();
    await expect(deleteBackup('not-a-backup.db')).rejects.toThrow();
  });

  it('deleteBackup removes a valid file', async () => {
    const name = 'taskpilot-2026-05-26-120000.db';
    fs.writeFileSync(path.join(PATHS.BACKUPS_DIR, name), 'data');
    await deleteBackup(name);
    expect(fs.existsSync(path.join(PATHS.BACKUPS_DIR, name))).toBe(false);
  });

  it('restoreBackup renames live DB to .pre-restore and copies backup over', async () => {
    // Restore now runs PRAGMA integrity_check on the snapshot before
    // swapping, so the fixture must be a real SQLite file.
    const liveDb = PATHS.DB_PATH;
    fs.mkdirSync(path.dirname(liveDb), { recursive: true });
    writeValidSqlite(liveDb, 'live-db-contents');

    const backupName = 'taskpilot-2026-05-26-120000.db';
    const backupPath = path.join(PATHS.BACKUPS_DIR, backupName);
    writeValidSqlite(backupPath, 'backup-contents');

    const result = await restoreBackup(backupName);
    expect(result.requires_restart).toBe(true);
    expect(result.pre_restore_path).toBe(`${liveDb}.pre-restore`);
    expect(fs.existsSync(`${liveDb}.pre-restore`)).toBe(true);
    // Live DB is now a copy of the backup — verify by reading the marker
    // row we wrote into the backup fixture.
    const restored = new Database(liveDb, { readonly: true });
    try {
      const row = restored
        .prepare('SELECT v FROM test_marker LIMIT 1')
        .get() as { v: string } | undefined;
      expect(row?.v).toBe('backup-contents');
    } finally {
      restored.close();
    }
    // Backup itself is untouched.
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it('restoreBackup overwrites a prior .pre-restore so we keep only one', async () => {
    const liveDb = PATHS.DB_PATH;
    fs.mkdirSync(path.dirname(liveDb), { recursive: true });
    writeValidSqlite(liveDb, 'live-v1');
    fs.writeFileSync(`${liveDb}.pre-restore`, 'stale-pre-restore');

    const backupName = 'taskpilot-2026-05-26-130000.db';
    writeValidSqlite(path.join(PATHS.BACKUPS_DIR, backupName), 'backup-v1');

    await restoreBackup(backupName);

    // The OLD pre-restore was replaced with the current live DB content.
    // Verify by opening the .pre-restore as a sqlite file and reading
    // the marker row from the original live DB.
    const prev = new Database(`${liveDb}.pre-restore`, { readonly: true });
    try {
      const row = prev
        .prepare('SELECT v FROM test_marker LIMIT 1')
        .get() as { v: string } | undefined;
      expect(row?.v).toBe('live-v1');
    } finally {
      prev.close();
    }
  });

  it('restoreBackup refuses a snapshot that fails integrity_check', async () => {
    // A plain text file is not a valid SQLite database — the integrity
    // probe must reject it before the swap.
    const backupName = 'taskpilot-2026-05-26-140000.db';
    fs.writeFileSync(
      path.join(PATHS.BACKUPS_DIR, backupName),
      'not-a-sqlite-file',
    );
    await expect(restoreBackup(backupName)).rejects.toThrow(
      /integrity|probe|sqlite/i,
    );
  });

  it('restoreBackup rejects an invalid filename', async () => {
    await expect(restoreBackup('../etc/passwd')).rejects.toThrow();
    await expect(restoreBackup('not-canonical.db')).rejects.toThrow();
  });

  it('restoreBackup throws when the backup does not exist', async () => {
    await expect(
      restoreBackup('taskpilot-2099-01-01-000000.db'),
    ).rejects.toThrow(/not found/i);
  });
});
