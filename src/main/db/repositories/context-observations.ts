/**
 * Context observations repository (v6 — ambient monitor).
 *
 * Owns all DB access for the append-only `context_observations` table.
 * Mirrors the shape of `repositories/feedback.ts` and
 * `repositories/decisions.ts`: a thin drizzle wrapper that handles the
 * row ↔ public-type boundary, including the JSON-encoded `metadata` column.
 *
 * Reads are time-ordered (newest first) since both the Watch view and the
 * monitor's batching logic care about recency. `insertMany()` is wrapped in
 * a single SQLite transaction so the batched API endpoint stays atomic.
 */

import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import {
  contextObservations,
  type ContextObservationRow,
} from '../../../shared/schema.js';
import type {
  ContextObservation,
  ContextObservationSource,
} from '../../../shared/types.js';

import { getDb } from '../index.js';
import { appendAuditEventSafe } from '../../audit/log.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function newId(): string {
  return nanoid(12);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parse the JSON metadata blob defensively — a malformed row should surface
 * as `null` rather than crash callers.
 */
function parseMetadata(raw: string | null): Record<string, unknown> | null {
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

function serializeMetadata(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function rowToObservation(row: ContextObservationRow): ContextObservation {
  return {
    id: row.id,
    source: row.source as ContextObservationSource,
    captured_at: row.captured_at,
    app_name: row.app_name,
    window_title: row.window_title,
    url: row.url,
    page_title: row.page_title,
    h1: row.h1,
    meta_description: row.meta_description,
    selection: row.selection,
    screenshot_path: row.screenshot_path,
    batch_id: row.batch_id,
    metadata: parseMetadata(row.metadata),
    workspace_id: row.workspace_id,
  };
}

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateContextObservationInput {
  id?: string;
  source: ContextObservationSource;
  captured_at?: string;
  app_name?: string | null;
  window_title?: string | null;
  url?: string | null;
  page_title?: string | null;
  h1?: string | null;
  meta_description?: string | null;
  selection?: string | null;
  screenshot_path?: string | null;
  batch_id?: string | null;
  metadata?: Record<string, unknown> | null;
  workspace_id?: string | null;
}

export interface ListContextObservationsFilter {
  source?: ContextObservationSource;
  since?: string;
  batch_id?: string;
  workspace_id?: string;
  /** When true, only rows with no batch_id (i.e. not yet deliberated). */
  unbatched_only?: boolean;
  limit?: number;
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

interface InsertValues {
  id: string;
  source: ContextObservationSource;
  captured_at: string;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  page_title: string | null;
  h1: string | null;
  meta_description: string | null;
  selection: string | null;
  screenshot_path: string | null;
  batch_id: string | null;
  metadata: string | null;
  workspace_id: string | null;
}

function buildInsertValues(input: CreateContextObservationInput): {
  id: string;
  values: InsertValues;
} {
  const id = input.id ?? newId();
  const values: InsertValues = {
    id,
    source: input.source,
    captured_at: input.captured_at ?? nowIso(),
    app_name: input.app_name ?? null,
    window_title: input.window_title ?? null,
    url: input.url ?? null,
    page_title: input.page_title ?? null,
    h1: input.h1 ?? null,
    meta_description: input.meta_description ?? null,
    selection: input.selection ?? null,
    screenshot_path: input.screenshot_path ?? null,
    batch_id: input.batch_id ?? null,
    metadata: serializeMetadata(input.metadata ?? null),
    workspace_id: input.workspace_id ?? null,
  };
  return { id, values };
}

export function createObservation(
  input: CreateContextObservationInput,
): ContextObservation {
  const db = getDb();
  const { id, values } = buildInsertValues(input);
  db.insert(contextObservations).values(values).run();
  const row = db
    .select()
    .from(contextObservations)
    .where(eq(contextObservations.id, id))
    .get();
  if (!row) {
    throw new Error(`Failed to insert context observation ${id}`);
  }
  const observation = rowToObservation(row);
  // Append-only audit log. Wrapped in appendAuditEventSafe so any disk failure
  // surfaces as a console.warn rather than blocking the observation write.
  appendAuditEventSafe({
    kind: 'observation_created',
    payload: {
      id: observation.id,
      source: observation.source,
      ...(observation.app_name !== null
        ? { app_name: observation.app_name }
        : {}),
      ...(observation.batch_id !== null
        ? { batch_id: observation.batch_id }
        : {}),
    },
  });
  return observation;
}

/**
 * Atomic batched insert — the Chrome extension's queued-flush endpoint relies
 * on this so a partial failure doesn't leave the DB half-populated.
 */
export function insertManyObservations(
  inputs: CreateContextObservationInput[],
): ContextObservation[] {
  if (inputs.length === 0) return [];
  const db = getDb();
  const ids: string[] = [];
  db.transaction(() => {
    for (const input of inputs) {
      const { id, values } = buildInsertValues(input);
      db.insert(contextObservations).values(values).run();
      ids.push(id);
    }
  });
  const out: ContextObservation[] = [];
  for (const id of ids) {
    const row = db
      .select()
      .from(contextObservations)
      .where(eq(contextObservations.id, id))
      .get();
    if (row) out.push(rowToObservation(row));
  }
  // One audit row per inserted observation. Cheap: the audit append is sync
  // and self-contained, so we don't need to roll it into the SQLite txn —
  // worst case is a partial audit trail if the disk dies mid-loop.
  for (const obs of out) {
    appendAuditEventSafe({
      kind: 'observation_created',
      payload: {
        id: obs.id,
        source: obs.source,
        ...(obs.app_name !== null ? { app_name: obs.app_name } : {}),
        ...(obs.batch_id !== null ? { batch_id: obs.batch_id } : {}),
      },
    });
  }
  return out;
}

/**
 * Stamp a deliberation batch id onto a set of observations. Called once the
 * monitor decides to flush a batch — flips the rows from "unbatched" to
 * "belongs to <batch_id>".
 */
export function markObservationsBatched(
  observationIds: string[],
  batchId: string,
): number {
  if (observationIds.length === 0) return 0;
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    for (const id of observationIds) {
      const result = db
        .update(contextObservations)
        .set({ batch_id: batchId })
        .where(eq(contextObservations.id, id))
        .run();
      changes += result.changes;
    }
  });
  return changes;
}

/**
 * Delete a single observation by id. The caller is responsible for removing
 * any on-disk screenshot file at `row.screenshot_path` if `source` was
 * `'screenshot'`.
 */
export function deleteObservation(id: string): ContextObservation | null {
  const db = getDb();
  const existing = db
    .select()
    .from(contextObservations)
    .where(eq(contextObservations.id, id))
    .get();
  if (!existing) return null;
  db.delete(contextObservations).where(eq(contextObservations.id, id)).run();
  return rowToObservation(existing);
}

/**
 * Bulk delete by captured_at < cutoff. Used by the retention sweep. Returns
 * the rows that were deleted (so the caller can unlink their screenshot
 * files) — capped at `limit` to keep the sweep bounded.
 */
export function deleteObservationsOlderThan(
  cutoffIso: string,
  limit = 1_000,
): ContextObservation[] {
  const db = getDb();
  // Fetch first so the caller can unlink any on-disk screenshot files; then
  // delete in a single transaction. Cap at `limit` so the sweep stays bounded
  // even when the table is huge.
  const rows = db
    .select()
    .from(contextObservations)
    .where(lt(contextObservations.captured_at, cutoffIso))
    .limit(limit)
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  db.transaction(() => {
    for (const id of ids) {
      db.delete(contextObservations).where(eq(contextObservations.id, id)).run();
    }
  });
  return rows.map(rowToObservation);
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export function getObservation(id: string): ContextObservation | null {
  const db = getDb();
  const row = db
    .select()
    .from(contextObservations)
    .where(eq(contextObservations.id, id))
    .get();
  return row ? rowToObservation(row) : null;
}

export function listObservations(
  filter: ListContextObservationsFilter = {},
): ContextObservation[] {
  const db = getDb();
  const conditions = [];
  if (filter.source) conditions.push(eq(contextObservations.source, filter.source));
  if (filter.since) conditions.push(gte(contextObservations.captured_at, filter.since));
  if (filter.batch_id) conditions.push(eq(contextObservations.batch_id, filter.batch_id));
  if (filter.workspace_id) {
    conditions.push(eq(contextObservations.workspace_id, filter.workspace_id));
  }
  if (filter.unbatched_only) {
    conditions.push(isNull(contextObservations.batch_id));
  }
  const base = db
    .select()
    .from(contextObservations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(contextObservations.captured_at), desc(contextObservations.id));
  const limited =
    filter.limit !== undefined && filter.limit > 0
      ? base.limit(filter.limit)
      : base;
  return limited.all().map(rowToObservation);
}

/** Count rows matching a filter — used by the status endpoint. */
export function countObservations(
  filter: ListContextObservationsFilter = {},
): number {
  const db = getDb();
  const conditions = [];
  if (filter.source) conditions.push(eq(contextObservations.source, filter.source));
  if (filter.since) conditions.push(gte(contextObservations.captured_at, filter.since));
  if (filter.batch_id) conditions.push(eq(contextObservations.batch_id, filter.batch_id));
  if (filter.workspace_id) {
    conditions.push(eq(contextObservations.workspace_id, filter.workspace_id));
  }
  if (filter.unbatched_only) {
    conditions.push(isNull(contextObservations.batch_id));
  }
  const rows = db
    .select({ id: contextObservations.id })
    .from(contextObservations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();
  return rows.length;
}

/**
 * Most recent observation across all sources, or null when the table is
 * empty. Used by `/api/context/status` to power the "last_observation_at"
 * field.
 */
export function getLastObservation(): ContextObservation | null {
  const db = getDb();
  const row = db
    .select()
    .from(contextObservations)
    .orderBy(desc(contextObservations.captured_at), desc(contextObservations.id))
    .limit(1)
    .get();
  return row ? rowToObservation(row) : null;
}

/* -------------------------------------------------------------------------- */
/*  Namespace export                                                          */
/* -------------------------------------------------------------------------- */

export const contextObservationsRepository = {
  create: createObservation,
  insertMany: insertManyObservations,
  markBatched: markObservationsBatched,
  delete: deleteObservation,
  deleteOlderThan: deleteObservationsOlderThan,
  get: getObservation,
  findById: getObservation,
  list: listObservations,
  count: countObservations,
  getLast: getLastObservation,
};
