/**
 * Cost events repository.
 *
 * Insert + query helpers for the `cost_events` table. Aggregations
 * (by tag/workspace/window) live in `@/main/cost-tracking/index.ts` —
 * this module is a thin wrapper around drizzle.
 */

import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { costEvents, type CostEventRow } from '../../../shared/schema.js';
import type { CostEvent } from '../../../shared/types.js';

import { getDb } from '../index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function rowToCostEvent(row: CostEventRow): CostEvent {
  return {
    id: row.id,
    task_id: row.task_id,
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    cost_usd: row.cost_usd,
    source: row.source,
    third_party_label: row.third_party_label,
    third_party_cost_usd: row.third_party_cost_usd,
    at: row.at,
  };
}

export interface CreateCostEventInput {
  id?: string;
  task_id: string;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  cost_usd?: number | null;
  source?: string | null;
  third_party_label?: string | null;
  third_party_cost_usd?: number | null;
  at?: string;
}

export function createCostEvent(input: CreateCostEventInput): CostEvent {
  const db = getDb();
  const id = input.id ?? newId();
  const at = input.at ?? nowIso();
  db.insert(costEvents)
    .values({
      id,
      task_id: input.task_id,
      model: input.model ?? null,
      input_tokens: input.input_tokens ?? null,
      output_tokens: input.output_tokens ?? null,
      cache_read_tokens: input.cache_read_tokens ?? null,
      cache_creation_tokens: input.cache_creation_tokens ?? null,
      cost_usd: input.cost_usd ?? null,
      source: input.source ?? null,
      third_party_label: input.third_party_label ?? null,
      third_party_cost_usd: input.third_party_cost_usd ?? null,
      at,
    })
    .run();
  const row = db
    .select()
    .from(costEvents)
    .where(eq(costEvents.id, id))
    .get();
  if (!row) {
    throw new Error(`Failed to insert cost_event ${id}`);
  }
  return rowToCostEvent(row);
}

export interface ListCostEventsFilter {
  task_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function listCostEvents(filter: ListCostEventsFilter = {}): CostEvent[] {
  const db = getDb();
  const conditions = [];
  if (filter.task_id) conditions.push(eq(costEvents.task_id, filter.task_id));
  if (filter.from) conditions.push(gte(costEvents.at, filter.from));
  if (filter.to) conditions.push(lte(costEvents.at, filter.to));
  const base = db
    .select()
    .from(costEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(costEvents.at));
  const limited =
    filter.limit !== undefined && filter.limit > 0 ? base.limit(filter.limit) : base;
  return limited.all().map(rowToCostEvent);
}

export function getCostEvent(id: string): CostEvent | null {
  const db = getDb();
  const row = db.select().from(costEvents).where(eq(costEvents.id, id)).get();
  return row ? rowToCostEvent(row) : null;
}

export const costEventsRepository = {
  create: createCostEvent,
  list: listCostEvents,
  get: getCostEvent,
  findById: getCostEvent,
};
