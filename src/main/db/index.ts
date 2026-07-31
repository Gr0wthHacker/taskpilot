/**
 * Database singleton.
 *
 * - Opens better-sqlite3 at `DB_PATH` (lazy — first call to `getDb()`).
 * - Ensures parent directories exist via `ensureDirs()` from constants.
 * - Always ensures the `_schema_version` ledger exists, then:
 *     • On first boot (no version stamped) runs the inline baseline so the
 *       app can stand up without any drizzle-kit output.
 *     • If `./drizzle/` is present, layers drizzle-generated migrations on top
 *       — drizzle keeps its own `__drizzle_migrations` table, that's fine.
 * - Enables WAL + foreign keys.
 *
 * The schema-version flow eliminates the "table already exists" warnings that
 * fired on every boot under the old "always run both" approach.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { DB_PATH, ensureDirs } from '../../shared/constants.js';
import { schema, type DB } from '../../shared/schema.js';

import { runInlineMigrations } from './migrations.js';
import {
  CURRENT_SCHEMA_VERSION,
  ensureSchemaVersionTable,
  getCurrentVersion,
  setVersion,
} from './schema-version.js';

// Resolve __dirname for both CJS (Electron main) and ESM (tsx, packaged ESM).
const _dirname =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

let _sqlite: Database.Database | null = null;
let _db: DB | null = null;

/**
 * Resolve the drizzle migrations folder if it exists. Multiple candidate
 * locations are checked because the runtime layout differs between `tsx`
 * (source), `tsup` build, and Electron-packaged app.
 */
function resolveMigrationsFolder(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(_dirname, '..', '..', '..', 'drizzle'),
    path.resolve(_dirname, '..', '..', 'drizzle'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        // Drizzle migrations folder must contain a `meta/_journal.json`.
        const journal = path.join(candidate, 'meta', '_journal.json');
        if (fs.existsSync(journal)) return candidate;
      }
    } catch {
      // ignore and continue
    }
  }
  return null;
}

interface DrizzleJournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: DrizzleJournalEntry[];
}

/**
 * Seed `__drizzle_migrations` with one row per journal entry so drizzle's
 * migrator considers every baseline migration applied. Hash format matches
 * `readMigrationFiles()` from drizzle-orm/migrator.cjs:
 *   sha256(raw migration file contents).
 *
 * Safe to call repeatedly — bails out if the ledger is already populated.
 */
function seedDrizzleLedger(
  db: Database.Database,
  migrationsFolder: string,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  // Backfill any missing entries. On a first-time seed the ledger is empty
  // and we insert everything; on an upgrade (e.g., v5 → v6) prior entries
  // are already there and we only need to stamp the new tags. Drizzle reads
  // entries in journal order, so inserting just the tail keeps ordering.
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations')
    .get() as { n: number } | undefined;
  const existingCount = existing ? Number(existing.n) : 0;

  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const raw = fs.readFileSync(journalPath, 'utf-8');
  const journal = JSON.parse(raw) as DrizzleJournal;

  if (existingCount >= journal.entries.length) return;

  const missing = journal.entries.slice(existingCount);
  const insert = db.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  );
  const tx = db.transaction((entries: DrizzleJournalEntry[]) => {
    for (const entry of entries) {
      const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      const hash = crypto.createHash('sha256').update(sql).digest('hex');
      insert.run(hash, entry.when);
    }
  });
  tx(missing);
}

/**
 * Pick the right pre-built native binding for the current runtime.
 *
 * Electron and standalone Node speak different NODE_MODULE_VERSION ABIs
 * (Electron 33 → 130, Node 24 → 137). better-sqlite3 ships a single .node
 * per install; we keep two side-by-side and let the runtime pick.
 *
 *   build/Release/better_sqlite3.node          → Node ABI (default prebuild)
 *   build/Release/better_sqlite3-electron.node  → Electron ABI (rebuilt via
 *                                                  @electron/rebuild)
 *
 * Falls back to better-sqlite3's own bindings.gyp loader if the
 * Electron-specific file is missing — packaged apps only need one.
 */
function resolveNativeBinding(): string | undefined {
  const isElectron =
    typeof process.versions['electron'] === 'string' &&
    process.versions['electron'].length > 0;
  if (!isElectron) return undefined;
  // Walk up from this file looking for node_modules/better-sqlite3 since the
  // depth differs between tsx (src/main/db/index.ts → ../../../node_modules)
  // and the bundled main.cjs (dist/main.cjs → ../node_modules).
  let dir = _dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(
      dir,
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3-electron.node',
    );
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Returns the shared drizzle DB handle, creating it on first call.
 */
export function getDb(): DB {
  if (_db && _sqlite) return _db;

  ensureDirs();

  const nativeBinding = resolveNativeBinding();
  // SQLITE_BUSY timeout: better-sqlite3 defaults to throwing immediately on
  // contention. With backup snapshots, the watcher, the monitor, and the
  // API server all writing, a 10s retry window absorbs every realistic
  // contention case while still failing fast on a genuine deadlock.
  //
  // Boot probe is split into TWO checks with distinct error messages:
  //   1. Constructor + pragmas — failure here means the native binding
  //      didn't load (ABI mismatch, missing DLL). Tell the user to rebuild.
  //   2. SELECT 1 — failure here means the binding loaded but the DB file
  //      itself is sick (corruption, lock contention, schema state).
  //      Tell the user to inspect the DB / restore from backup.
  let sqlite: Database.Database;
  try {
    sqlite = nativeBinding
      ? new Database(DB_PATH, { nativeBinding, timeout: 10_000 })
      : new Database(DB_PATH, { timeout: 10_000 });
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
  } catch (err) {
    const msg = (err as Error).message;
    // Native binding failures look like ERR_DLOPEN_FAILED, "Cannot find
    // module", or "Could not locate the bindings file".
    const looksLikeNativeIssue =
      /ERR_DLOPEN_FAILED|not a valid Win32 application|Cannot find module|bindings file|NODE_MODULE_VERSION/i.test(
        msg,
      );
    if (looksLikeNativeIssue) {
      throw new Error(
        `[taskpilot] sqlite native binding failed to load: ${msg}. ` +
          'Run `npm run rebuild:native` to rebuild for the current ABI.',
      );
    }
    throw new Error(
      `[taskpilot] failed to open SQLite at ${DB_PATH}: ${msg}. ` +
        'The database file may be corrupt or locked by another process. ' +
        'Check ~/.taskpilot/backups for a recent snapshot.',
    );
  }
  // Step 2: probe SQL execution. Failure here is a DB integrity / schema
  // problem, not a binding issue.
  try {
    sqlite.prepare('SELECT 1').get();
  } catch (err) {
    throw new Error(
      `[taskpilot] SQLite is open at ${DB_PATH} but the boot probe failed: ${(err as Error).message}. ` +
        'The database may be corrupted. Try restoring from ~/.taskpilot/backups, ' +
        'or remove the file to let TaskPilot recreate it (you will lose local data).',
    );
  }

  const db = drizzle(sqlite, { schema });

  // Step 1: make sure the schema-version ledger exists before anything else
  // touches it. Cheap (CREATE TABLE IF NOT EXISTS).
  ensureSchemaVersionTable(sqlite);

  // Step 2: read the current applied version. 0 = "fresh DB" (or upgraded
  // from a pre-Wave-12 install that didn't have the ledger).
  const versionBefore = getCurrentVersion(sqlite);
  const drizzleFolder = resolveMigrationsFolder();

  // Step 3: inline baseline only runs when the ledger says we're at v0. The
  // migration runner itself also checks `sqlite_master` so it short-circuits
  // when an older DB already carries the baseline tables but no ledger.
  if (versionBefore < CURRENT_SCHEMA_VERSION) {
    runInlineMigrations(sqlite);
  }

  // Step 4: layer drizzle-generated migrations on top if they exist. Drizzle
  // keeps its own bookkeeping in `__drizzle_migrations`, so a no-op pass is
  // cheap. When it actually applies a migration we stamp the ledger so
  // `db:status` reflects the change.
  //
  // Skip the drizzle pass entirely when the inline runner already brought the
  // schema to (or past) `CURRENT_SCHEMA_VERSION` AND drizzle's own ledger is
  // empty. Without this guard drizzle would try to re-apply 0000 from scratch
  // — every CREATE is `IF NOT EXISTS` so it didn't break anything, but the
  // migrator throws on the first statement and we logged a noisy warning on
  // every boot. We seed the drizzle journal so subsequent boots (and any
  // future `migrate.ts` runs) see the baseline migrations as already applied.
  if (drizzleFolder) {
    const versionAfterInline = getCurrentVersion(sqlite);
    // Trust the inline runner: if it brought us to (or past)
    // CURRENT_SCHEMA_VERSION, every table now exists. Backfill drizzle's
    // ledger for any missing journal entries instead of letting migrate()
    // try (and fail) to CREATE TABLE again. Works on both fresh installs
    // (ledger empty → seed all) and upgrades (ledger partial → seed tail).
    const inlineCoveredEverything =
      versionAfterInline >= CURRENT_SCHEMA_VERSION;

    if (inlineCoveredEverything) {
      // Inline owns the schema; seed drizzle's ledger to match the journal so
      // it considers every migration applied. Future drizzle generations
      // (versions > CURRENT_SCHEMA_VERSION-aligned tags) will run naturally.
      try {
        seedDrizzleLedger(sqlite, drizzleFolder);
      } catch (err) {
        // Non-fatal — worst case the next boot logs the same warning again.
        // eslint-disable-next-line no-console
        console.warn(
          '[taskpilot:db] could not seed drizzle ledger, schema is fine but next boot may re-warn:',
          err,
        );
      }
    } else {
      try {
        migrate(db, { migrationsFolder: drizzleFolder });
        const versionAfter = getCurrentVersion(sqlite);
        if (versionAfter < CURRENT_SCHEMA_VERSION) {
          // Stamp the ledger to acknowledge the drizzle pass — keeps the
          // "current version" matching what the code expects.
          setVersion(sqlite, CURRENT_SCHEMA_VERSION, 'drizzle migrate');
        }
      } catch (err) {
        // Don't crash boot if drizzle migrations are malformed — log and continue
        // on the inline-baseline schema. The standalone `migrate.ts` script is
        // the right place to surface those errors loudly.
        // eslint-disable-next-line no-console
        console.warn(
          '[taskpilot:db] drizzle migrate failed, continuing on inline schema:',
          err,
        );
      }
    }
  }

  _sqlite = sqlite;
  _db = db;
  return db;
}

/**
 * Underlying better-sqlite3 handle. Some callers (raw SQL, pragmas, vacuum)
 * need direct access. Triggers DB initialization if not already open.
 */
export function getSqlite(): Database.Database {
  if (!_sqlite) getDb();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return _sqlite!;
}

/**
 * Close the database. Used by the standalone CLI/server on shutdown and by
 * tests/scripts that need a deterministic teardown.
 */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
