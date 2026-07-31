/**
 * Conversations repository (Wave 18).
 *
 * All DB access for the `conversations` and `conversation_task_links` tables.
 * Same conventions as the tasks repository: callers see typed shapes,
 * (de)serialization of JSON-encoded TEXT columns (`topics`, `key_decisions`,
 * `files_touched`) lives here, raw SQL never leaks out.
 */

import { and, desc, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import {
  conversations,
  conversationTaskLinks,
  type ConversationRow,
  type ConversationTaskLinkRow,
} from '../../../shared/schema.js';
import type {
  Conversation,
  ConversationFilter,
  ConversationLinkKind,
  ConversationSource,
  ConversationTaskLink,
  CreateConversationInput,
  UpdateConversationInput,
} from '../../../shared/types.js';

import { getDb, getSqlite } from '../index.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function serializeStringArray(arr: string[] | null | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr);
}

function parseStringArray(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    source: row.source as ConversationSource,
    source_id: row.source_id,
    source_path: row.source_path,
    project_path: row.project_path,
    title: row.title,
    started_at: row.started_at,
    ended_at: row.ended_at,
    model: row.model,
    message_count: row.message_count,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    cost_usd: row.cost_usd,
    digest: row.digest,
    topics: parseStringArray(row.topics),
    key_decisions: parseStringArray(row.key_decisions),
    files_touched: parseStringArray(row.files_touched),
    compressed_at: row.compressed_at,
    archived_at: row.archived_at,
    content_hash: row.content_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToLink(row: ConversationTaskLinkRow): ConversationTaskLink {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    task_id: row.task_id,
    kind: row.kind as ConversationLinkKind,
    confidence: row.confidence,
    created_at: row.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Conversations                                                             */
/* -------------------------------------------------------------------------- */

export function getConversation(id: string): Conversation | null {
  const db = getDb();
  const row = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return row ? rowToConversation(row) : null;
}

export function findBySourceId(
  source: ConversationSource,
  sourceId: string,
): Conversation | null {
  const db = getDb();
  const row = db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.source, source), eq(conversations.source_id, sourceId)),
    )
    .get();
  return row ? rowToConversation(row) : null;
}

export function listConversations(
  filter: ConversationFilter = {},
): Conversation[] {
  const db = getDb();
  const limit = Math.min(filter.limit ?? 200, 1000);
  const offset = Math.max(filter.offset ?? 0, 0);

  const conditions = [];
  if (filter.source) conditions.push(eq(conversations.source, filter.source));
  if (filter.project_path)
    conditions.push(eq(conversations.project_path, filter.project_path));
  if (filter.compressed === true)
    conditions.push(sql`${conversations.compressed_at} IS NOT NULL`);
  if (filter.compressed === false)
    conditions.push(isNull(conversations.compressed_at));
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(
      or(
        like(conversations.title, pattern),
        like(conversations.digest, pattern),
        like(conversations.topics, pattern),
      )!,
    );
  }
  if (filter.topic) {
    // topics is JSON-stringified — LIKE the JSON literal of the tag.
    const needle = `%${JSON.stringify(filter.topic).slice(1, -1)}%`;
    conditions.push(like(conversations.topics, `%${needle}%`));
  }

  let query = db.select().from(conversations).$dynamic();
  if (conditions.length > 0) query = query.where(and(...conditions));
  const rows = query
    .orderBy(desc(conversations.ended_at))
    .limit(limit)
    .offset(offset)
    .all();

  if (filter.task_id) {
    // Filter post-fetch via link table — simpler than a join here.
    const taskLinks = db
      .select()
      .from(conversationTaskLinks)
      .where(eq(conversationTaskLinks.task_id, filter.task_id))
      .all();
    const ids = new Set(taskLinks.map((l) => l.conversation_id));
    return rows.filter((r) => ids.has(r.id)).map(rowToConversation);
  }

  return rows.map(rowToConversation);
}

export function createConversation(input: CreateConversationInput): Conversation {
  const db = getDb();
  const now = nowIso();
  const row: ConversationRow = {
    id: input.id || newId(),
    source: input.source,
    source_id: input.source_id,
    source_path: input.source_path ?? null,
    project_path: input.project_path ?? null,
    title: input.title ?? null,
    started_at: input.started_at,
    ended_at: input.ended_at,
    model: input.model ?? null,
    message_count: input.message_count ?? 0,
    input_tokens: input.input_tokens ?? null,
    output_tokens: input.output_tokens ?? null,
    cache_read_tokens: input.cache_read_tokens ?? null,
    cache_creation_tokens: input.cache_creation_tokens ?? null,
    cost_usd: input.cost_usd ?? null,
    digest: input.digest ?? null,
    topics: serializeStringArray(input.topics),
    key_decisions: serializeStringArray(input.key_decisions),
    files_touched: serializeStringArray(input.files_touched),
    compressed_at: input.compressed_at ?? null,
    archived_at: input.archived_at ?? null,
    content_hash: input.content_hash ?? null,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  };
  db.insert(conversations).values(row).run();
  return rowToConversation(row);
}

export function updateConversation(
  id: string,
  patch: UpdateConversationInput,
): Conversation | null {
  const db = getDb();
  const existing = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!existing) return null;

  const updates: Partial<ConversationRow> = { updated_at: nowIso() };
  if (patch.source_path !== undefined) updates.source_path = patch.source_path;
  if (patch.project_path !== undefined) updates.project_path = patch.project_path;
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.started_at !== undefined) updates.started_at = patch.started_at;
  if (patch.ended_at !== undefined) updates.ended_at = patch.ended_at;
  if (patch.model !== undefined) updates.model = patch.model;
  if (patch.message_count !== undefined) updates.message_count = patch.message_count;
  if (patch.input_tokens !== undefined) updates.input_tokens = patch.input_tokens;
  if (patch.output_tokens !== undefined) updates.output_tokens = patch.output_tokens;
  if (patch.cache_read_tokens !== undefined)
    updates.cache_read_tokens = patch.cache_read_tokens;
  if (patch.cache_creation_tokens !== undefined)
    updates.cache_creation_tokens = patch.cache_creation_tokens;
  if (patch.cost_usd !== undefined) updates.cost_usd = patch.cost_usd;
  if (patch.digest !== undefined) updates.digest = patch.digest;
  if (patch.topics !== undefined)
    updates.topics = serializeStringArray(patch.topics);
  if (patch.key_decisions !== undefined)
    updates.key_decisions = serializeStringArray(patch.key_decisions);
  if (patch.files_touched !== undefined)
    updates.files_touched = serializeStringArray(patch.files_touched);
  if (patch.compressed_at !== undefined)
    updates.compressed_at = patch.compressed_at;
  if (patch.archived_at !== undefined) updates.archived_at = patch.archived_at;
  if (patch.content_hash !== undefined) updates.content_hash = patch.content_hash;

  db.update(conversations).set(updates).where(eq(conversations.id, id)).run();
  const fresh = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  return fresh ? rowToConversation(fresh) : null;
}

export function deleteConversation(id: string): boolean {
  // Same shape as deleteTask: drop link rows + the parent in one transaction
  // so a crash between the two can't leave orphans pointing at a missing row.
  const sqlite = getSqlite();
  const tx = sqlite.transaction((conversationId: string) => {
    sqlite
      .prepare('DELETE FROM conversation_task_links WHERE conversation_id = ?')
      .run(conversationId);
    return sqlite
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(conversationId);
  });
  const result = tx(id) as { changes: number };
  if (result.changes > 0) {
    // Best-effort FTS5 cleanup. Lazy import keeps the search module out of
    // the repo's import graph (and breaks an otherwise circular dep through
    // search/indexer → @/main/db).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const indexer = require('../../search/indexer') as {
        removeEntity?: (entityType: string, entityId: string) => void;
      };
      if (typeof indexer.removeEntity === 'function') {
        indexer.removeEntity('conversation', id);
      }
    } catch {
      /* search index optional — non-fatal */
    }
  }
  return result.changes > 0;
}

/**
 * Conversations old enough to compress but not yet compressed.
 * `olderThanIso` is the cutoff — anything with `ended_at < olderThanIso`
 * and `compressed_at IS NULL` is a candidate.
 */
export function listPendingCompaction(olderThanIso: string, limit = 50): Conversation[] {
  const db = getDb();
  const rows = db
    .select()
    .from(conversations)
    .where(
      and(
        isNull(conversations.compressed_at),
        lt(conversations.ended_at, olderThanIso),
      ),
    )
    .orderBy(desc(conversations.ended_at))
    .limit(limit)
    .all();
  return rows.map(rowToConversation);
}

/**
 * Conversations old enough to archive their source_path (retention).
 * Optional — `null` retention means never archive.
 */
export function listPendingArchive(olderThanIso: string, limit = 100): Conversation[] {
  const db = getDb();
  const rows = db
    .select()
    .from(conversations)
    .where(
      and(
        isNull(conversations.archived_at),
        lt(conversations.ended_at, olderThanIso),
        sql`${conversations.source_path} IS NOT NULL`,
      ),
    )
    .limit(limit)
    .all();
  return rows.map(rowToConversation);
}

/* -------------------------------------------------------------------------- */
/*  Links                                                                     */
/* -------------------------------------------------------------------------- */

export interface LinkInput {
  conversation_id: string;
  task_id: string;
  kind: ConversationLinkKind;
  confidence?: number;
}

export function linkConversationToTask(input: LinkInput): ConversationTaskLink {
  const db = getDb();
  // Upsert via natural key (conversation_id, task_id).
  const existing = db
    .select()
    .from(conversationTaskLinks)
    .where(
      and(
        eq(conversationTaskLinks.conversation_id, input.conversation_id),
        eq(conversationTaskLinks.task_id, input.task_id),
      ),
    )
    .get();
  if (existing) {
    // Upgrade kind/confidence if the new link is stronger (manual > session_pin
    // > execute_result > cwd_match > tag_match).
    const priority = (k: ConversationLinkKind): number =>
      k === 'manual'
        ? 5
        : k === 'session_pin'
          ? 4
          : k === 'execute_result'
            ? 3
            : k === 'cwd_match'
              ? 2
              : 1;
    if (
      priority(input.kind) > priority(existing.kind as ConversationLinkKind) ||
      (input.confidence ?? 1) > existing.confidence
    ) {
      db.update(conversationTaskLinks)
        .set({ kind: input.kind, confidence: input.confidence ?? 1 })
        .where(eq(conversationTaskLinks.id, existing.id))
        .run();
    }
    const fresh = db
      .select()
      .from(conversationTaskLinks)
      .where(eq(conversationTaskLinks.id, existing.id))
      .get();
    return rowToLink(fresh!);
  }

  const row: ConversationTaskLinkRow = {
    id: newId(),
    conversation_id: input.conversation_id,
    task_id: input.task_id,
    kind: input.kind,
    confidence: input.confidence ?? 1,
    created_at: nowIso(),
  };
  db.insert(conversationTaskLinks).values(row).run();
  return rowToLink(row);
}

export function unlinkConversationFromTask(
  conversationId: string,
  taskId: string,
): boolean {
  const db = getDb();
  const result = db
    .delete(conversationTaskLinks)
    .where(
      and(
        eq(conversationTaskLinks.conversation_id, conversationId),
        eq(conversationTaskLinks.task_id, taskId),
      ),
    )
    .run();
  return result.changes > 0;
}

export function listLinksForConversation(
  conversationId: string,
): ConversationTaskLink[] {
  const db = getDb();
  const rows = db
    .select()
    .from(conversationTaskLinks)
    .where(eq(conversationTaskLinks.conversation_id, conversationId))
    .all();
  return rows.map(rowToLink);
}

export function listLinksForTask(taskId: string): ConversationTaskLink[] {
  const db = getDb();
  const rows = db
    .select()
    .from(conversationTaskLinks)
    .where(eq(conversationTaskLinks.task_id, taskId))
    .all();
  return rows.map(rowToLink);
}

/* -------------------------------------------------------------------------- */
/*  Aggregations                                                              */
/* -------------------------------------------------------------------------- */

export interface TopicAggregate {
  topic: string;
  conversation_count: number;
  total_tokens: number;
  total_cost_usd: number;
  latest_at: string;
}

/**
 * Aggregate every topic that appears in any conversation. Iterates rows
 * in-process (the topics column is JSON-encoded TEXT so SQL aggregation
 * isn't ergonomic). Capped at 5000 source rows — beyond that the user
 * should narrow with a filter.
 */
export function aggregateTopics(limit = 5_000): TopicAggregate[] {
  const db = getDb();
  const rows = db
    .select({
      topics: conversations.topics,
      input_tokens: conversations.input_tokens,
      output_tokens: conversations.output_tokens,
      cache_read_tokens: conversations.cache_read_tokens,
      cache_creation_tokens: conversations.cache_creation_tokens,
      cost_usd: conversations.cost_usd,
      ended_at: conversations.ended_at,
    })
    .from(conversations)
    .limit(limit)
    .all();

  const byTopic = new Map<
    string,
    {
      conversation_count: number;
      total_tokens: number;
      total_cost_usd: number;
      latest_at: string;
    }
  >();
  for (const row of rows) {
    const topics = parseStringArray(row.topics);
    if (topics.length === 0) continue;
    const tokens =
      (row.input_tokens ?? 0) +
      (row.output_tokens ?? 0) +
      (row.cache_read_tokens ?? 0) +
      (row.cache_creation_tokens ?? 0);
    const cost = row.cost_usd ?? 0;
    for (const t of topics) {
      const prev = byTopic.get(t);
      if (!prev) {
        byTopic.set(t, {
          conversation_count: 1,
          total_tokens: tokens,
          total_cost_usd: cost,
          latest_at: row.ended_at,
        });
      } else {
        prev.conversation_count += 1;
        prev.total_tokens += tokens;
        prev.total_cost_usd += cost;
        if (row.ended_at > prev.latest_at) prev.latest_at = row.ended_at;
      }
    }
  }
  return Array.from(byTopic.entries())
    .map(([topic, v]) => ({ topic, ...v }))
    .sort((a, b) => b.conversation_count - a.conversation_count);
}

export interface ProjectRollup {
  project_path: string;
  sessions: number;
  total_tokens: number;
  total_cost_usd: number;
  latest_at: string;
  models: string[];
}

/**
 * Aggregate by `project_path`. Conversations with a null project_path are
 * lumped under "(unknown)". Useful for "how much Claude-cost am I spending
 * on the Leal Health repo this month?".
 */
export function rollupByProject(limit = 5_000): ProjectRollup[] {
  const db = getDb();
  const rows = db
    .select({
      project_path: conversations.project_path,
      model: conversations.model,
      input_tokens: conversations.input_tokens,
      output_tokens: conversations.output_tokens,
      cache_read_tokens: conversations.cache_read_tokens,
      cache_creation_tokens: conversations.cache_creation_tokens,
      cost_usd: conversations.cost_usd,
      ended_at: conversations.ended_at,
    })
    .from(conversations)
    .limit(limit)
    .all();

  const byProject = new Map<
    string,
    {
      sessions: number;
      total_tokens: number;
      total_cost_usd: number;
      latest_at: string;
      models: Set<string>;
    }
  >();
  for (const row of rows) {
    const key = row.project_path ?? '(unknown)';
    let bucket = byProject.get(key);
    if (!bucket) {
      bucket = {
        sessions: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        latest_at: row.ended_at,
        models: new Set(),
      };
      byProject.set(key, bucket);
    }
    bucket.sessions += 1;
    bucket.total_tokens +=
      (row.input_tokens ?? 0) +
      (row.output_tokens ?? 0) +
      (row.cache_read_tokens ?? 0) +
      (row.cache_creation_tokens ?? 0);
    bucket.total_cost_usd += row.cost_usd ?? 0;
    if (row.ended_at > bucket.latest_at) bucket.latest_at = row.ended_at;
    if (row.model) bucket.models.add(row.model);
  }
  return Array.from(byProject.entries())
    .map(([project_path, v]) => ({
      project_path,
      sessions: v.sessions,
      total_tokens: v.total_tokens,
      total_cost_usd: v.total_cost_usd,
      latest_at: v.latest_at,
      models: Array.from(v.models),
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd || b.sessions - a.sessions);
}

export interface DayRollup {
  date: string; // YYYY-MM-DD
  sessions: number;
  total_tokens: number;
  total_cost_usd: number;
  top_topics: string[];
  top_files: string[];
}

/**
 * Per-day rollup for the past N days. Useful for a "what did I work on
 * this week" surface. Day key is derived from `ended_at` (UTC).
 */
export function rollupByDay(days = 14): DayRollup[] {
  const db = getDb();
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const rows = db
    .select({
      topics: conversations.topics,
      files_touched: conversations.files_touched,
      input_tokens: conversations.input_tokens,
      output_tokens: conversations.output_tokens,
      cache_read_tokens: conversations.cache_read_tokens,
      cache_creation_tokens: conversations.cache_creation_tokens,
      cost_usd: conversations.cost_usd,
      ended_at: conversations.ended_at,
    })
    .from(conversations)
    .where(sql`${conversations.ended_at} >= ${since}`)
    .all();

  const byDay = new Map<
    string,
    {
      sessions: number;
      total_tokens: number;
      total_cost_usd: number;
      topicCounts: Map<string, number>;
      fileCounts: Map<string, number>;
    }
  >();
  for (const row of rows) {
    const date = row.ended_at.slice(0, 10);
    let bucket = byDay.get(date);
    if (!bucket) {
      bucket = {
        sessions: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        topicCounts: new Map(),
        fileCounts: new Map(),
      };
      byDay.set(date, bucket);
    }
    bucket.sessions += 1;
    bucket.total_tokens +=
      (row.input_tokens ?? 0) +
      (row.output_tokens ?? 0) +
      (row.cache_read_tokens ?? 0) +
      (row.cache_creation_tokens ?? 0);
    bucket.total_cost_usd += row.cost_usd ?? 0;
    for (const t of parseStringArray(row.topics)) {
      bucket.topicCounts.set(t, (bucket.topicCounts.get(t) ?? 0) + 1);
    }
    for (const f of parseStringArray(row.files_touched)) {
      bucket.fileCounts.set(f, (bucket.fileCounts.get(f) ?? 0) + 1);
    }
  }

  return Array.from(byDay.entries())
    .map(([date, v]) => ({
      date,
      sessions: v.sessions,
      total_tokens: v.total_tokens,
      total_cost_usd: v.total_cost_usd,
      top_topics: Array.from(v.topicCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map((e) => e[0]),
      top_files: Array.from(v.fileCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map((e) => e[0]),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}
