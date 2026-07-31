/**
 * In-memory SQLite factory for tests.
 *
 * Each call returns a fresh `:memory:` better-sqlite3 connection wired to
 * Drizzle and primed with the inline migrations from
 * `src/main/db/migrations.ts`. Tests can either pass the returned `db` handle
 * directly to repo helpers (if they support injection) or mock the `getDb`
 * singleton so it returns this instance.
 */

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { runInlineMigrations } from '@/main/db/migrations';
import { schema, type DB } from '@/shared/schema';

export interface InMemoryDbHandle {
  sqlite: Database.Database;
  db: DB;
  close: () => void;
}

export function createInMemoryDb(): InMemoryDbHandle {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  runInlineMigrations(sqlite);

  const db = drizzle(sqlite, { schema }) as BetterSQLite3Database<typeof schema>;

  return {
    sqlite,
    db,
    close: () => {
      try {
        sqlite.close();
      } catch {
        // ignore double-close
      }
    },
  };
}
