/**
 * `npm run db:status` and `npm run db:rollback` entry points.
 *
 * `status` prints the current schema version, the version the code expects,
 * and the full applied-migrations ledger so Jack can see what was migrated
 * and when. `rollback` removes the most recent ledger row — there are no
 * down-migrations (drizzle-kit doesn't generate them), so this is "best
 * effort": the underlying tables stay in place, only the ledger row is
 * removed. Useful for re-running a migration during local dev.
 */

import Database from 'better-sqlite3';

import { DB_PATH, ensureDirs } from '../../shared/constants.js';

import {
  CURRENT_SCHEMA_VERSION,
  getCurrentVersion,
  listAppliedMigrations,
  rollbackLastVersion,
} from './schema-version.js';

interface RunResult {
  exitCode: number;
}

function openSqlite(): Database.Database {
  ensureDirs();
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

export function runStatus(): RunResult {
  const sqlite = openSqlite();
  try {
    const current = getCurrentVersion(sqlite);
    const applied = listAppliedMigrations(sqlite);

    // eslint-disable-next-line no-console
    console.log(`[taskpilot:db] db path:         ${DB_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`[taskpilot:db] current version: ${current}`);
    // eslint-disable-next-line no-console
    console.log(
      `[taskpilot:db] code expects:    ${CURRENT_SCHEMA_VERSION}`,
    );

    if (current === CURRENT_SCHEMA_VERSION) {
      // eslint-disable-next-line no-console
      console.log('[taskpilot:db] status:          up to date');
    } else if (current < CURRENT_SCHEMA_VERSION) {
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:db] status:          behind by ${CURRENT_SCHEMA_VERSION - current} (run db:migrate)`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:db] status:          ahead of code (${current} > ${CURRENT_SCHEMA_VERSION}) — consider upgrading the app`,
      );
    }

    if (applied.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[taskpilot:db] no migrations recorded');
    } else {
      // eslint-disable-next-line no-console
      console.log('[taskpilot:db] applied migrations (newest first):');
      for (const row of applied) {
        const note = row.note ? ` — ${row.note}` : '';
        // eslint-disable-next-line no-console
        console.log(`  v${row.version}  ${row.applied_at}${note}`);
      }
    }
    return { exitCode: 0 };
  } finally {
    try {
      sqlite.close();
    } catch {
      // ignore close failures
    }
  }
}

export function runRollback(): RunResult {
  const sqlite = openSqlite();
  try {
    const removed = rollbackLastVersion(sqlite);
    if (removed === null) {
      // eslint-disable-next-line no-console
      console.log('[taskpilot:db] nothing to roll back — ledger is empty');
      return { exitCode: 0 };
    }
    // eslint-disable-next-line no-console
    console.log(
      `[taskpilot:db] removed ledger row for v${removed}. Tables are unchanged; re-run db:migrate to re-stamp.`,
    );
    return { exitCode: 0 };
  } finally {
    try {
      sqlite.close();
    } catch {
      // ignore close failures
    }
  }
}

function main(): void {
  const arg = (process.argv[2] ?? '').toLowerCase();
  let result: RunResult;
  switch (arg) {
    case 'status':
      result = runStatus();
      break;
    case 'rollback':
      result = runRollback();
      break;
    default:
      // eslint-disable-next-line no-console
      console.error('Usage: tsx src/main/db/cli.ts <status|rollback>');
      result = { exitCode: 2 };
  }
  process.exit(result.exitCode);
}

// Run only when invoked directly (`tsx src/main/db/cli.ts ...`).
// Importers (tests, other scripts) get the exported helpers without the
// side effect.
//
// tsx normalizes argv[1] to the absolute path of the file it runs, so we can
// just check whether the file we are matches. The replace handles cross-platform
// path separators on Windows.
function invokedDirectly(): boolean {
  if (typeof process === 'undefined') return false;
  const entry = String(process.argv[1] ?? '').replace(/\\/g, '/');
  if (entry.length === 0) return false;
  return /\/db\/cli(\.ts|\.js|\.cjs|\.mjs)?$/.test(entry);
}

if (invokedDirectly()) {
  try {
    main();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[taskpilot:db] cli failed:', err);
    process.exit(1);
  }
}
