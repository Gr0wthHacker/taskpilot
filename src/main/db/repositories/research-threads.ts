/**
 * Research threads repository.
 * Tracks long-running investigations and learnings.
 */

import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { researchThreads, type ResearchThread, type CreateResearchThread } from '@/shared/schema-v2';
import { getDb } from '../index';

export function createResearchThread(input: Omit<CreateResearchThread, 'id' | 'created_at'>): ResearchThread {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  const row = db
    .insert(researchThreads)
    .values({
      id,
      query: input.query,
      started_at: input.started_at,
      last_active: input.last_active,
      status: input.status ?? 'active',
      findings: input.findings,
      observation_event_ids: input.observation_event_ids,
      created_at: now,
    })
    .returning()
    .get();

  return row;
}

export function getResearchThread(id: string): ResearchThread | null {
  const db = getDb();
  return db
    .select()
    .from(researchThreads)
    .where(eq(researchThreads.id, id))
    .get() ?? null;
}

export interface ListResearchThreadsFilter {
  status?: 'active' | 'paused' | 'concluded';
  limit?: number;
}

export function listResearchThreads(filter: ListResearchThreadsFilter = {}): ResearchThread[] {
  const db = getDb();
  const limit = filter.limit ?? 100;

  let query = db.select().from(researchThreads);

  if (filter.status) {
    query = query.where(eq(researchThreads.status, filter.status)) as typeof query;
  }

  return query.orderBy(desc(researchThreads.last_active)).limit(limit).all();
}

/**
 * Get active threads (status='active' and last_active within timeframe).
 */
export function getActiveResearchThreads(withinMinutes: number = 120): ResearchThread[] {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setMinutes(cutoff.getMinutes() - withinMinutes);
  const cutoffIso = cutoff.toISOString();

  return db
    .select()
    .from(researchThreads)
    .where(
      and(
        eq(researchThreads.status, 'active'),
        gt(researchThreads.last_active, cutoffIso)
      )
    )
    .orderBy(desc(researchThreads.last_active))
    .all();
}

/**
 * Find thread by query (similarity check).
 * For now, exact match; later can use embeddings.
 */
export function findResearchThreadByQuery(query: string): ResearchThread | null {
  const db = getDb();
  return db
    .select()
    .from(researchThreads)
    .where(eq(researchThreads.query, query))
    .get() ?? null;
}

export function updateResearchThread(
  id: string,
  updates: Partial<Omit<ResearchThread, 'id' | 'created_at'>>
): ResearchThread | null {
  const db = getDb();

  db.update(researchThreads)
    .set(updates)
    .where(eq(researchThreads.id, id))
    .run();

  return getResearchThread(id);
}

/**
 * Parse JSON fields from thread.
 */
export function getResearchThreadDecoded(thread: ResearchThread) {
  return {
    ...thread,
    findings: JSON.parse(thread.findings ?? '[]') as unknown[],
    observation_event_ids: JSON.parse(thread.observation_event_ids ?? '[]') as string[],
  };
}
