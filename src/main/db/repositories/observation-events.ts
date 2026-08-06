/**
 * Observation events repository.
 * All inserts; no updates (events are immutable).
 * Auto-prune events older than 30 days.
 */

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { observationEvents, type CreateObservationEvent, type ObservationEvent } from '@/shared/schema-v2';
import { getDb } from '../index';

const RETENTION_DAYS = 30;

/**
 * Create a new observation event.
 */
export function createObservationEvent(
  input: Omit<CreateObservationEvent, 'id' | 'created_at'>
): ObservationEvent {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  const row = db
    .insert(observationEvents)
    .values({
      id,
      timestamp: input.timestamp,
      source: input.source,
      type: input.type,
      data: input.data,
      raw: input.raw,
      tags: input.tags,
      confidence: input.confidence ?? 1.0,
      created_at: now,
    })
    .returning()
    .get();

  return row;
}

/**
 * List events within a time range, optionally filtered by source/type.
 */
export interface ListObservationEventsFilter {
  source?: string;
  type?: string;
  startTime?: string; // ISO 8601
  endTime?: string; // ISO 8601
  limit?: number;
  offset?: number;
}

export function listObservationEvents(filter: ListObservationEventsFilter = {}): ObservationEvent[] {
  const db = getDb();
  const conditions: any[] = [];

  if (filter.source) {
    conditions.push(eq(observationEvents.source, filter.source as any));
  }

  if (filter.type) {
    conditions.push(eq(observationEvents.type, filter.type as any));
  }

  if (filter.startTime) {
    conditions.push(gte(observationEvents.timestamp, filter.startTime));
  }

  if (filter.endTime) {
    conditions.push(lt(observationEvents.timestamp, filter.endTime));
  }

  const limit = filter.limit ?? 1000;
  const offset = filter.offset ?? 0;

  let query = db
    .select()
    .from(observationEvents) as any;

  if (conditions.length > 0) {
    query = query.where(and(...(conditions as any)));
  }

  return query
    .orderBy(desc(observationEvents.timestamp))
    .limit(limit)
    .offset(offset)
    .all();
}

/**
 * Get a single event by ID.
 */
export function getObservationEvent(id: string): ObservationEvent | null {
  const db = getDb();
  return db
    .select()
    .from(observationEvents)
    .where(eq(observationEvents.id, id))
    .get() ?? null;
}

/**
 * Count events in a time range, grouped by source.
 */
export function countObservationEventsBySource(
  startTime: string,
  endTime: string
): Record<string, number> {
  const db = getDb();
  const rows = db
    .select({
      source: observationEvents.source,
      count: sql<number>`COUNT(*)`,
    })
    .from(observationEvents)
    .where(
      and(
        gte(observationEvents.timestamp, startTime),
        lt(observationEvents.timestamp, endTime)
      )
    )
    .groupBy(observationEvents.source)
    .all();

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.source ?? 'unknown'] = row.count;
  }
  return result;
}

/**
 * Prune events older than RETENTION_DAYS.
 * Call this periodically (e.g., midnight).
 */
export function pruneOldObservationEvents(): number {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffIso = cutoff.toISOString();

  const result = db
    .delete(observationEvents)
    .where(lt(observationEvents.timestamp, cutoffIso))
    .run();

  return result.changes;
}
