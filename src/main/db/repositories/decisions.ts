/**
 * Decisions repository (Wave 16 — decision log).
 *
 * Insert + query helpers for the append-only `decisions` table. Rows are
 * never updated in place — a correction appends a new entry. Deletion is
 * supported (the user can prune a mistaken note from TaskDetail) but is the
 * only mutation beyond create.
 *
 * Mirrors the shape of `repositories/feedback.ts`: a thin drizzle wrapper
 * that owns the row ↔ public-type boundary.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { decisions, type DecisionRow } from '../../../shared/schema.js';
import type { DecisionCategory, DecisionEntry } from '../../../shared/types.js';

import { getDb } from '../index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function rowToDecision(row: DecisionRow): DecisionEntry {
  return {
    id: row.id,
    task_id: row.task_id,
    category: row.category,
    text: row.text,
    author: row.author,
    link: row.link,
    created_at: row.created_at,
  };
}

export interface CreateDecisionInput {
  id?: string;
  task_id: string;
  category?: DecisionCategory;
  text: string;
  author?: string | null;
  link?: string | null;
  created_at?: string;
}

/**
 * Write-hook registry (Wave 17 — search). Fires after a decision is created
 * or deleted so the full-text search index can refresh that entry. Mirrors the
 * tasks repo pattern: append-to-subscribe, returned fn unsubscribes, throwing
 * hooks swallowed. `(id, op)` lets a listener distinguish create from delete.
 */
type DecisionWriteHook = (id: string, op: 'create' | 'delete') => void;
const decisionWriteListeners: DecisionWriteHook[] = [];

export function addOnDecisionWritten(hook: DecisionWriteHook): () => void {
  decisionWriteListeners.push(hook);
  return () => {
    const idx = decisionWriteListeners.indexOf(hook);
    if (idx >= 0) decisionWriteListeners.splice(idx, 1);
  };
}

function fireDecisionWritten(id: string, op: 'create' | 'delete'): void {
  for (const listener of decisionWriteListeners) {
    try {
      listener(id, op);
    } catch {
      // Best-effort — never block the write.
    }
  }
}

/** Test-only: drop every decision write listener. */
export function __clearDecisionWriteListeners(): void {
  decisionWriteListeners.length = 0;
}

export function createDecision(input: CreateDecisionInput): DecisionEntry {
  const db = getDb();
  const id = input.id ?? newId();
  const createdAt = input.created_at ?? nowIso();
  db.insert(decisions)
    .values({
      id,
      task_id: input.task_id,
      category: input.category ?? 'note',
      text: input.text,
      author: input.author ?? 'user',
      link: input.link ?? null,
      created_at: createdAt,
    })
    .run();
  const row = db.select().from(decisions).where(eq(decisions.id, id)).get();
  if (!row) {
    throw new Error(`Failed to insert decision ${id}`);
  }
  fireDecisionWritten(id, 'create');
  return rowToDecision(row);
}

export interface ListDecisionsFilter {
  task_id?: string;
  task_ids?: string[];
  categories?: DecisionCategory[];
  limit?: number;
}

/**
 * List decision entries newest-first. The decision log is rendered head-down
 * (most recent at top) so we order by `created_at DESC`, breaking ties on the
 * id so identical timestamps stay stable across fetches.
 */
export function listDecisions(filter: ListDecisionsFilter = {}): DecisionEntry[] {
  const db = getDb();
  const conditions = [];
  if (filter.task_id) conditions.push(eq(decisions.task_id, filter.task_id));
  if (filter.task_ids && filter.task_ids.length > 0) {
    conditions.push(inArray(decisions.task_id, filter.task_ids));
  }
  if (filter.categories && filter.categories.length > 0) {
    conditions.push(inArray(decisions.category, filter.categories));
  }
  const base = db
    .select()
    .from(decisions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(decisions.created_at), desc(decisions.id));
  const limited =
    filter.limit !== undefined && filter.limit > 0
      ? base.limit(filter.limit)
      : base;
  return limited.all().map(rowToDecision);
}

export function getDecision(id: string): DecisionEntry | null {
  const db = getDb();
  const row = db.select().from(decisions).where(eq(decisions.id, id)).get();
  return row ? rowToDecision(row) : null;
}

/**
 * Delete a single decision by id. Returns true when a row was removed.
 */
export function deleteDecision(id: string): boolean {
  const db = getDb();
  const existing = db.select().from(decisions).where(eq(decisions.id, id)).get();
  if (!existing) return false;
  db.delete(decisions).where(eq(decisions.id, id)).run();
  fireDecisionWritten(id, 'delete');
  return true;
}

export const decisionsRepository = {
  create: createDecision,
  list: listDecisions,
  get: getDecision,
  findById: getDecision,
  delete: deleteDecision,
};
