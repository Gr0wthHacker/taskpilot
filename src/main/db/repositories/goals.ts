/**
 * Goals repository.
 *
 * All DB access for the `goals` table goes through here. Like the tasks repo,
 * this module owns the (de)serialization boundary for the JSON-encoded `tags`
 * column and surfaces the public {@link Goal} shape from `src/shared/types.ts`.
 *
 * Goals deliberately do NOT cascade to tasks. Membership is computed at read
 * time by the domain layer (`@/main/goals`) — the repo only stores the goal
 * row. Deleting a goal here removes only the row; detaching member tasks is
 * the domain layer's job (it clears `context.goal_id`).
 *
 * better-sqlite3 is synchronous, so every function returns immediately.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { goals, type GoalRow } from '../../../shared/schema.js';
import type {
  CreateGoalInput,
  Goal,
  GoalFilter,
  UpdateGoalInput,
} from '../../../shared/types.js';

import { getDb } from '../index.js';

/* -------------------------------------------------------------------------- */
/*  Serialization helpers                                                     */
/* -------------------------------------------------------------------------- */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function serializeTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags);
}

function parseTags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    target_date: row.target_date,
    workspace: row.workspace,
    tags: parseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export function listGoals(filter: GoalFilter = {}): Goal[] {
  const db = getDb();
  const conditions = [];

  if (filter.status !== undefined) {
    if (Array.isArray(filter.status)) {
      if (filter.status.length > 0) {
        conditions.push(inArray(goals.status, filter.status));
      }
    } else {
      conditions.push(eq(goals.status, filter.status));
    }
  }

  if (filter.workspace !== undefined && filter.workspace !== '') {
    conditions.push(eq(goals.workspace, filter.workspace));
  }

  const rows = db
    .select()
    .from(goals)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // Active goals first, then by most-recently-touched.
    .orderBy(asc(goals.status), desc(goals.updated_at))
    .all();
  return rows.map(rowToGoal);
}

export function getGoal(id: string): Goal | null {
  const db = getDb();
  const row = db.select().from(goals).where(eq(goals.id, id)).get();
  return row ? rowToGoal(row) : null;
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

export function createGoal(input: CreateGoalInput): Goal {
  const db = getDb();
  const now = nowIso();
  const id = input.id ?? newId();

  db.insert(goals)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'active',
      target_date: input.target_date ?? null,
      workspace: input.workspace ?? null,
      tags: serializeTags(input.tags),
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
    })
    .run();

  const created = getGoal(id);
  if (!created) throw new Error(`Failed to create goal ${id}`);
  return created;
}

/**
 * Patch-style update. Only the fields present in `patch` are written;
 * everything else is left untouched. `updated_at` is always refreshed.
 */
export function updateGoal(id: string, patch: UpdateGoalInput): Goal | null {
  const existing = getGoal(id);
  if (!existing) return null;

  const db = getDb();
  const updates: Record<string, unknown> = { updated_at: nowIso() };

  if ('name' in patch && patch.name !== undefined) updates.name = patch.name;
  if ('description' in patch) updates.description = patch.description ?? null;
  if ('status' in patch && patch.status !== undefined) {
    updates.status = patch.status;
  }
  if ('target_date' in patch) updates.target_date = patch.target_date ?? null;
  if ('workspace' in patch) updates.workspace = patch.workspace ?? null;
  if ('tags' in patch) updates.tags = serializeTags(patch.tags);

  db.update(goals).set(updates).where(eq(goals.id, id)).run();
  return getGoal(id);
}

export function deleteGoal(id: string): boolean {
  const db = getDb();
  const result = db.delete(goals).where(eq(goals.id, id)).run();
  return result.changes > 0;
}

/* -------------------------------------------------------------------------- */
/*  Re-exports for tests / advanced callers                                   */
/* -------------------------------------------------------------------------- */

export const __internals = {
  rowToGoal,
  parseTags,
  serializeTags,
};

/* -------------------------------------------------------------------------- */
/*  Namespace object                                                          */
/* -------------------------------------------------------------------------- */

export const goalsRepository = {
  list: listGoals,
  get: getGoal,
  findById: getGoal,
  create: createGoal,
  update: updateGoal,
  delete: deleteGoal,
};
