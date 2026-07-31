/**
 * Settings repository.
 *
 * Key/value store for arbitrary app settings. Values are JSON-serialized so any
 * JSON-compatible value (string, number, boolean, array, object, null) round-trips.
 */

import { eq } from 'drizzle-orm';

import { settings } from '../../../shared/schema.js';

import { getDb } from '../index.js';

/**
 * Returns the parsed value for a key, or `null` if the key does not exist.
 *
 * The generic lets callers narrow the return type when they know the schema
 * for a particular key (e.g. `get<{ google: string }>('credentials')`).
 */
export function get<T = unknown>(key: string): T | null {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  if (row.value === null || row.value === '') return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    // Treat un-parseable values as raw strings — older settings written before
    // JSON-serialization landed will still be readable.
    return row.value as unknown as T;
  }
}

/**
 * Insert or update a setting. Passing `null` clears the stored value but leaves
 * the row in place; use `del(key)` to remove the row entirely.
 */
export function set(key: string, value: unknown): void {
  const db = getDb();
  const serialized = value === null || value === undefined ? null : JSON.stringify(value);

  const existing = db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .get();

  if (existing) {
    db.update(settings)
      .set({ value: serialized })
      .where(eq(settings.key, key))
      .run();
  } else {
    db.insert(settings).values({ key, value: serialized }).run();
  }
}

/**
 * Remove a setting row entirely.
 */
export function del(key: string): boolean {
  const db = getDb();
  const result = db.delete(settings).where(eq(settings.key, key)).run();
  return result.changes > 0;
}

/**
 * Return every setting as a single record. Values are JSON-parsed; un-parseable
 * values fall back to their raw string form.
 */
export function getAll(): Record<string, unknown> {
  const db = getDb();
  const rows = db.select().from(settings).all();
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.value === null || row.value === '') {
      out[row.key] = null;
      continue;
    }
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Namespace object                                                          */
/* -------------------------------------------------------------------------- */

export const settingsRepository = {
  get,
  set,
  delete: del,
  getAll,
};
