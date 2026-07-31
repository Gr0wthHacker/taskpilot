/**
 * Standalone migration runner — invoked by `npm run db:migrate`.
 *
 * Opens the DB, runs the inline baseline (always safe), then applies any
 * drizzle-kit generated migrations from `./drizzle/`. Exits non-zero on any
 * failure so CI/scripts can detect it.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { DB_PATH, ensureDirs } from '../../shared/constants.js';
import { schema } from '../../shared/schema.js';

import { runInlineMigrations } from './migrations.js';

function main(): void {
  ensureDirs();

  // eslint-disable-next-line no-console
  console.log(`[taskpilot:migrate] opening db at ${DB_PATH}`);

  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  // eslint-disable-next-line no-console
  console.log('[taskpilot:migrate] applying inline baseline schema');
  runInlineMigrations(sqlite);

  const migrationsFolder = path.resolve(process.cwd(), 'drizzle');
  const journal = path.join(migrationsFolder, 'meta', '_journal.json');

  if (fs.existsSync(journal)) {
    // eslint-disable-next-line no-console
    console.log(
      `[taskpilot:migrate] applying drizzle migrations from ${migrationsFolder}`,
    );
    migrate(db, { migrationsFolder });
  } else {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:migrate] no drizzle migrations found (run `npm run db:generate` to create them); inline baseline applied',
    );
  }

  sqlite.close();
  // eslint-disable-next-line no-console
  console.log('[taskpilot:migrate] done');
}

try {
  main();
  process.exit(0);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[taskpilot:migrate] failed:', err);
  process.exit(1);
}
