/**
 * Deliberations repository (v6 — ambient monitor).
 *
 * Owns all DB access for the `deliberations` table. Each row is one
 * deliberation request issued to Claude via the io protocol — the
 * interrupter-vs-waiter outcome plus whatever artifact (task, notification,
 * or none) was surfaced. Powers the Watch view's deliberation-history pane.
 *
 * Mirrors the shape of `repositories/decisions.ts`: a thin drizzle wrapper
 * that owns the row ↔ public-type boundary, including the JSON-encoded
 * `observation_ids` + `raw_result` columns.
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { deliberations, type DeliberationRow } from '../../../shared/schema.js';
import type {
  Deliberation,
  DeliberationDecision,
  DeliberationStatus,
  DeliberationSurfaceKind,
  DeliberationTriggerReason,
} from '../../../shared/types.js';

import { getDb } from '../index.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function newId(): string {
  return nanoid(12);
}

function nowIso(): string {
  return new Date().toISOString();
}

function serializeIds(ids: string[]): string {
  return JSON.stringify(ids);
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function serializeRawResult(
  value: Record<string, unknown> | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseRawResult(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rowToDeliberation(row: DeliberationRow): Deliberation {
  return {
    id: row.id,
    batch_id: row.batch_id,
    requested_at: row.requested_at,
    observation_ids: parseIds(row.observation_ids),
    trigger_reason: row.trigger_reason as DeliberationTriggerReason,
    status: row.status as DeliberationStatus,
    result_at: row.result_at,
    interrupter_score: row.interrupter_score,
    waiter_score: row.waiter_score,
    decision: row.decision === null ? null : (row.decision as DeliberationDecision),
    surfaced_as:
      row.surfaced_as === null ? null : (row.surfaced_as as DeliberationSurfaceKind),
    surfaced_id: row.surfaced_id,
    summary: row.summary,
    raw_result: parseRawResult(row.raw_result),
  };
}

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateDeliberationInput {
  id?: string;
  batch_id: string;
  requested_at?: string;
  observation_ids: string[];
  trigger_reason: DeliberationTriggerReason;
  /** Defaults to `'pending'`. */
  status?: DeliberationStatus;
}

export interface CompleteDeliberationInput {
  result_at?: string;
  interrupter_score: number;
  waiter_score: number;
  decision: DeliberationDecision;
  surfaced_as: DeliberationSurfaceKind;
  surfaced_id?: string | null;
  summary?: string | null;
  raw_result?: Record<string, unknown> | null;
}

export interface ListDeliberationsFilter {
  status?: DeliberationStatus;
  since?: string;
  limit?: number;
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

export function createDeliberation(input: CreateDeliberationInput): Deliberation {
  const db = getDb();
  const id = input.id ?? newId();
  const requestedAt = input.requested_at ?? nowIso();
  db.insert(deliberations)
    .values({
      id,
      batch_id: input.batch_id,
      requested_at: requestedAt,
      observation_ids: serializeIds(input.observation_ids),
      trigger_reason: input.trigger_reason,
      status: input.status ?? 'pending',
      result_at: null,
      interrupter_score: null,
      waiter_score: null,
      decision: null,
      surfaced_as: null,
      surfaced_id: null,
      summary: null,
      raw_result: null,
    })
    .run();
  const row = db.select().from(deliberations).where(eq(deliberations.id, id)).get();
  if (!row) {
    throw new Error(`Failed to insert deliberation ${id}`);
  }
  return rowToDeliberation(row);
}

/**
 * Flip a pending deliberation to `completed` with the scoring outcome and the
 * surfaced artifact (if any). Returns the updated row, or null when the id
 * doesn't exist.
 */
export function completeDeliberation(
  id: string,
  input: CompleteDeliberationInput,
): Deliberation | null {
  const db = getDb();
  const existing = db
    .select()
    .from(deliberations)
    .where(eq(deliberations.id, id))
    .get();
  if (!existing) return null;
  db.update(deliberations)
    .set({
      status: 'completed',
      result_at: input.result_at ?? nowIso(),
      interrupter_score: input.interrupter_score,
      waiter_score: input.waiter_score,
      decision: input.decision,
      surfaced_as: input.surfaced_as,
      surfaced_id: input.surfaced_id ?? null,
      summary: input.summary ?? null,
      raw_result: serializeRawResult(input.raw_result ?? null),
    })
    .where(eq(deliberations.id, id))
    .run();
  return getDeliberation(id);
}

/**
 * Flip a pending deliberation to `failed` or `skipped` with an optional
 * summary. Used when the io-protocol parse fails or the user toggles the
 * monitor off mid-batch.
 */
export function markDeliberationTerminal(
  id: string,
  status: 'failed' | 'skipped',
  summary?: string | null,
): Deliberation | null {
  const db = getDb();
  const existing = db
    .select()
    .from(deliberations)
    .where(eq(deliberations.id, id))
    .get();
  if (!existing) return null;
  db.update(deliberations)
    .set({
      status,
      result_at: nowIso(),
      summary: summary ?? null,
    })
    .where(eq(deliberations.id, id))
    .run();
  return getDeliberation(id);
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export function getDeliberation(id: string): Deliberation | null {
  const db = getDb();
  const row = db.select().from(deliberations).where(eq(deliberations.id, id)).get();
  return row ? rowToDeliberation(row) : null;
}

export function findDeliberationByBatchId(batchId: string): Deliberation | null {
  const db = getDb();
  const row = db
    .select()
    .from(deliberations)
    .where(eq(deliberations.batch_id, batchId))
    .orderBy(desc(deliberations.requested_at))
    .limit(1)
    .get();
  return row ? rowToDeliberation(row) : null;
}

export function listDeliberations(
  filter: ListDeliberationsFilter = {},
): Deliberation[] {
  const db = getDb();
  const conditions = [];
  if (filter.status) conditions.push(eq(deliberations.status, filter.status));
  if (filter.since) conditions.push(gte(deliberations.requested_at, filter.since));
  const base = db
    .select()
    .from(deliberations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(deliberations.requested_at), desc(deliberations.id));
  const limited =
    filter.limit !== undefined && filter.limit > 0
      ? base.limit(filter.limit)
      : base;
  return limited.all().map(rowToDeliberation);
}

export function countDeliberations(filter: ListDeliberationsFilter = {}): number {
  const db = getDb();
  const conditions = [];
  if (filter.status) conditions.push(eq(deliberations.status, filter.status));
  if (filter.since) conditions.push(gte(deliberations.requested_at, filter.since));
  const rows = db
    .select({ id: deliberations.id })
    .from(deliberations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/*  Namespace export                                                          */
/* -------------------------------------------------------------------------- */

export const deliberationsRepository = {
  create: createDeliberation,
  complete: completeDeliberation,
  markTerminal: markDeliberationTerminal,
  get: getDeliberation,
  findById: getDeliberation,
  findByBatchId: findDeliberationByBatchId,
  list: listDeliberations,
  count: countDeliberations,
};
