/**
 * Single source of truth for the app's schema version.
 *
 * The `_schema_version` table records every applied migration with a wall-clock
 * timestamp and an optional note. Inline migrations stamp version 1 once the
 * baseline tables exist; future drizzle migrations should bump it via
 * `setVersion()` so `db:status` reflects reality.
 *
 * Drizzle keeps its own `__drizzle_migrations` ledger — that's intentional.
 * `_schema_version` is the app-level intent (what the *code* expects); drizzle's
 * table is bookkeeping for the migrator itself.
 */

import type Database from 'better-sqlite3';

/**
 * Current schema version baked into this build. Bump this every time you add a
 * drizzle migration or a baseline-altering inline migration so `db:status` can
 * compare runtime vs. expected.
 */
export const CURRENT_SCHEMA_VERSION = 12;

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_schema_version_version ON _schema_version(version);
`;

export interface SchemaVersionRow {
  version: number;
  applied_at: string;
  note: string | null;
}

/**
 * Ensure the `_schema_version` table exists. Idempotent — runs on every boot
 * so older DBs auto-upgrade.
 */
export function ensureSchemaVersionTable(db: Database.Database): void {
  db.exec(ENSURE_TABLE_SQL);
}

/**
 * Returns the highest applied version, or 0 if no migrations are recorded yet.
 */
export function getCurrentVersion(db: Database.Database): number {
  ensureSchemaVersionTable(db);
  const row = db
    .prepare(
      'SELECT MAX(version) AS version FROM _schema_version',
    )
    .get() as { version: number | null } | undefined;
  if (!row || row.version === null || row.version === undefined) return 0;
  return Number(row.version);
}

/**
 * Append a new version row. We never overwrite — the table is an append-only
 * journal so `db:status` can show the migration timeline.
 */
export function setVersion(
  db: Database.Database,
  version: number,
  note?: string,
): void {
  ensureSchemaVersionTable(db);
  const appliedAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO _schema_version (version, applied_at, note) VALUES (?, ?, ?)',
  ).run(version, appliedAt, note ?? null);
}

/**
 * Full migration history, newest first.
 */
export function listAppliedMigrations(
  db: Database.Database,
): SchemaVersionRow[] {
  ensureSchemaVersionTable(db);
  const rows = db
    .prepare(
      'SELECT version, applied_at, note FROM _schema_version ORDER BY applied_at DESC, version DESC',
    )
    .all() as Array<{ version: number; applied_at: string; note: string | null }>;
  return rows.map((r) => ({
    version: Number(r.version),
    applied_at: r.applied_at,
    note: r.note,
  }));
}

/**
 * Best-effort rollback. We don't have down-migrations (drizzle-kit doesn't
 * generate them), so this just deletes the most recent version row from the
 * ledger. The schema itself stays unchanged — useful for re-running a
 * migration in dev, not a true revert.
 *
 * Returns the version that was removed, or null if nothing to roll back.
 */
export function rollbackLastVersion(db: Database.Database): number | null {
  ensureSchemaVersionTable(db);
  const row = db
    .prepare(
      'SELECT rowid AS rowid, version FROM _schema_version ORDER BY applied_at DESC, version DESC LIMIT 1',
    )
    .get() as { rowid: number; version: number } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM _schema_version WHERE rowid = ?').run(row.rowid);
  return Number(row.version);
}
