/**
 * Feedback repository.
 *
 * Insert + query helpers for the `feedback` table. The derive flow reads
 * recent rejections for similar tasks via `@/main/feedback#summarizeRejections`
 * and folds them into the derive request as "Past rejections" guidance.
 */

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { feedback, type FeedbackRow } from '../../../shared/schema.js';
import type { FeedbackEntry, FeedbackKind } from '../../../shared/types.js';

import { getDb } from '../index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function rowToFeedback(row: FeedbackRow): FeedbackEntry {
  return {
    id: row.id,
    task_id: row.task_id,
    kind: row.kind,
    reason: row.reason,
    details: row.details,
    at: row.at,
  };
}

export interface CreateFeedbackInput {
  id?: string;
  task_id: string;
  kind: FeedbackKind;
  reason?: string | null;
  details?: string | null;
  at?: string;
}

export function createFeedback(input: CreateFeedbackInput): FeedbackEntry {
  const db = getDb();
  const id = input.id ?? newId();
  const at = input.at ?? nowIso();
  db.insert(feedback)
    .values({
      id,
      task_id: input.task_id,
      kind: input.kind,
      reason: input.reason ?? null,
      details: input.details ?? null,
      at,
    })
    .run();
  const row = db.select().from(feedback).where(eq(feedback.id, id)).get();
  if (!row) {
    throw new Error(`Failed to insert feedback ${id}`);
  }
  return rowToFeedback(row);
}

export interface ListFeedbackFilter {
  task_id?: string;
  task_ids?: string[];
  kinds?: FeedbackKind[];
  from?: string;
  limit?: number;
}

export function listFeedback(filter: ListFeedbackFilter = {}): FeedbackEntry[] {
  const db = getDb();
  const conditions = [];
  if (filter.task_id) conditions.push(eq(feedback.task_id, filter.task_id));
  if (filter.task_ids && filter.task_ids.length > 0) {
    conditions.push(inArray(feedback.task_id, filter.task_ids));
  }
  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(inArray(feedback.kind, filter.kinds));
  }
  if (filter.from) conditions.push(gte(feedback.at, filter.from));
  const base = db
    .select()
    .from(feedback)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(feedback.at));
  const limited =
    filter.limit !== undefined && filter.limit > 0 ? base.limit(filter.limit) : base;
  return limited.all().map(rowToFeedback);
}

export function getFeedback(id: string): FeedbackEntry | null {
  const db = getDb();
  const row = db.select().from(feedback).where(eq(feedback.id, id)).get();
  return row ? rowToFeedback(row) : null;
}

export const feedbackRepository = {
  create: createFeedback,
  list: listFeedback,
  get: getFeedback,
  findById: getFeedback,
};
