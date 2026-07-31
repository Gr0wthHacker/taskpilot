/**
 * Per-test DB mocking helper.
 *
 * Repositories under `src/main/db/repositories/*` all call `getDb()` from
 * `@/main/db/index.ts` at request time (not at import time), so we can swap
 * the underlying implementation per test by mocking that module.
 *
 * Usage:
 *
 *   import { useMockedDb } from '../helpers/mock-db';
 *
 *   useMockedDb(); // call once at top of describe block
 *
 *   // each test gets a fresh in-memory DB
 */

import { afterEach, beforeEach, vi } from 'vitest';

import { createInMemoryDb, type InMemoryDbHandle } from './db-factory';

let current: InMemoryDbHandle | null = null;

vi.mock('@/main/db', () => {
  return {
    getDb: () => {
      if (!current) {
        throw new Error(
          'getDb() called before mock-db beforeEach. Did you forget to call useMockedDb()?',
        );
      }
      return current.db;
    },
    getSqlite: () => {
      if (!current) {
        throw new Error('getSqlite() called before mock-db beforeEach');
      }
      return current.sqlite;
    },
    closeDb: () => {
      if (current) {
        current.close();
        current = null;
      }
    },
  };
});

export function useMockedDb(): { current: () => InMemoryDbHandle } {
  beforeEach(() => {
    current = createInMemoryDb();
  });
  afterEach(() => {
    if (current) {
      current.close();
      current = null;
    }
  });
  return {
    current: () => {
      if (!current) throw new Error('No active mocked DB');
      return current;
    },
  };
}
