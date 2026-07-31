/**
 * Memory subsystem — DB access layer.
 *
 * Sits next to the task and conversation repositories. Owns the
 * `memory_items` and `memory_links` tables. Callers never see raw SQL;
 * the public surface is types from `@/shared/types`.
 *
 * Storage choices mirror what worked for tasks: cursor pagination on
 * `(created_at DESC, id ASC)`, `?fields=summary` projection for list views,
 * dedup by `content_hash` so the same paste doesn't bloat the inbox.
 */

import crypto from 'node:crypto';
import { nanoid } from 'nanoid';

import { getSqlite } from '@/main/db';
import type {
  CreateMemoryInput,
  MemoryFilter,
  MemoryItem,
  MemoryItemSummary,
  MemoryKind,
  MemoryLink,
  MemoryLinkKind,
  MemoryLinkTargetKind,
  MemoryStatus,
  UpdateMemoryInput,
} from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

export const MEMORY_MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;
const RAW_CONTENT_MAX_BYTES = 1_000_000; // 1 MB cap per item

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content.trim()).digest('hex');
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    /* fall through */
  }
  return [];
}

function parseEntities(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

interface FullRow {
  id: string;
  kind: MemoryKind;
  title: string | null;
  raw_content: string;
  summary: string | null;
  tags: string | null;
  entities: string | null;
  source_url: string | null;
  source_path: string | null;
  content_hash: string;
  status: MemoryStatus;
  enrichment_error: string | null;
  created_at: string;
  updated_at: string;
  enriched_at: string | null;
}

interface SummaryRow {
  id: string;
  kind: MemoryKind;
  title: string | null;
  summary: string | null;
  tags: string | null;
  source_url: string | null;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  enriched_at: string | null;
}

function rowToItem(row: FullRow): MemoryItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    raw_content: row.raw_content,
    summary: row.summary,
    tags: parseTags(row.tags),
    entities: parseEntities(row.entities),
    source_url: row.source_url,
    source_path: row.source_path,
    content_hash: row.content_hash,
    status: row.status,
    enrichment_error: row.enrichment_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    enriched_at: row.enriched_at,
  };
}

function rowToSummary(row: SummaryRow): MemoryItemSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    tags: parseTags(row.tags),
    source_url: row.source_url,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    enriched_at: row.enriched_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Cursor helpers (same shape as tasks repo)                                 */
/* -------------------------------------------------------------------------- */

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { created_at: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx < 0) return null;
    const created_at = raw.slice(0, idx);
    const id = raw.slice(idx + 1);
    if (!created_at || !id) return null;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(created_at)) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Write listeners — feed memory_stats + FTS + SSE                           */
/* -------------------------------------------------------------------------- */

type WriteHook = (id: string, op: 'create' | 'update' | 'delete') => void;
const writeListeners: WriteHook[] = [];

export function addOnMemoryWritten(hook: WriteHook): () => void {
  writeListeners.push(hook);
  return () => {
    const idx = writeListeners.indexOf(hook);
    if (idx >= 0) writeListeners.splice(idx, 1);
  };
}

function fireWrite(id: string, op: 'create' | 'update' | 'delete'): void {
  for (const fn of writeListeners) {
    try {
      fn(id, op);
    } catch {
      /* best-effort */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  CRUD                                                                      */
/* -------------------------------------------------------------------------- */

export class MemoryContentTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Memory content too large: ${bytes} bytes (max ${RAW_CONTENT_MAX_BYTES})`);
    this.name = 'MemoryContentTooLargeError';
  }
}

export class MemoryDuplicateError extends Error {
  constructor(public readonly existingId: string) {
    super(`Memory item with the same content already exists: ${existingId}`);
    this.name = 'MemoryDuplicateError';
  }
}

export function createMemory(input: CreateMemoryInput): MemoryItem {
  if (Buffer.byteLength(input.raw_content, 'utf8') > RAW_CONTENT_MAX_BYTES) {
    throw new MemoryContentTooLargeError(
      Buffer.byteLength(input.raw_content, 'utf8'),
    );
  }
  const db = getSqlite();
  const hash = hashContent(input.raw_content);

  // Dedup on content_hash — same paste twice should surface the existing row.
  const existing = db
    .prepare('SELECT id FROM memory_items WHERE content_hash = ?')
    .get(hash) as { id: string } | undefined;
  if (existing) {
    throw new MemoryDuplicateError(existing.id);
  }

  const id = newId();
  const now = nowIso();
  const tagsJson =
    input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;

  db.prepare(
    `INSERT INTO memory_items
       (id, kind, title, raw_content, tags, source_url, source_path,
        content_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'raw', ?, ?)`,
  ).run(
    id,
    input.kind,
    input.title ?? null,
    input.raw_content,
    tagsJson,
    input.source_url ?? null,
    input.source_path ?? null,
    hash,
    now,
    now,
  );

  fireWrite(id, 'create');

  // Read back so callers get the full row (defaults filled in).
  return getMemory(id)!;
}

export function getMemory(id: string): MemoryItem | null {
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT id, kind, title, raw_content, summary, tags, entities,
              source_url, source_path, content_hash, status,
              enrichment_error, created_at, updated_at, enriched_at
       FROM memory_items WHERE id = ?`,
    )
    .get(id) as FullRow | undefined;
  return row ? rowToItem(row) : null;
}

export function updateMemory(
  id: string,
  patch: UpdateMemoryInput,
): MemoryItem | null {
  const existing = getMemory(id);
  if (!existing) return null;

  const db = getSqlite();
  const sets: string[] = ['updated_at = ?'];
  const args: unknown[] = [nowIso()];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    args.push(patch.title);
  }
  if (patch.summary !== undefined) {
    sets.push('summary = ?');
    args.push(patch.summary);
  }
  if (patch.tags !== undefined) {
    sets.push('tags = ?');
    args.push(patch.tags.length > 0 ? JSON.stringify(patch.tags) : null);
  }
  if (patch.entities !== undefined) {
    sets.push('entities = ?');
    args.push(patch.entities ? JSON.stringify(patch.entities) : null);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(patch.status);
    if (patch.status === 'enriched') {
      sets.push('enriched_at = ?');
      args.push(nowIso());
    }
  }
  if (patch.enrichment_error !== undefined) {
    sets.push('enrichment_error = ?');
    args.push(patch.enrichment_error);
  }

  args.push(id);
  db.prepare(`UPDATE memory_items SET ${sets.join(', ')} WHERE id = ?`).run(
    ...args,
  );

  fireWrite(id, 'update');
  return getMemory(id);
}

export function deleteMemory(id: string): boolean {
  const db = getSqlite();
  // ON DELETE CASCADE on memory_links takes care of edges.
  const r = db.prepare('DELETE FROM memory_items WHERE id = ?').run(id) as {
    changes: number;
  };
  if (r.changes > 0) {
    fireWrite(id, 'delete');
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Paginated list                                                            */
/* -------------------------------------------------------------------------- */

export interface MemoryPage {
  items: MemoryItem[] | MemoryItemSummary[];
  next_cursor: string | null;
}

const STATUS_VALUES: ReadonlySet<MemoryStatus> = new Set([
  'raw',
  'enriched',
  'failed',
]);
const KIND_VALUES: ReadonlySet<MemoryKind> = new Set(['text', 'url', 'file']);

export function listMemoryPage(filter: MemoryFilter = {}): MemoryPage {
  const db = getSqlite();
  const where: string[] = [];
  const args: unknown[] = [];

  if (filter.status !== undefined) {
    const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
    const valid = arr.filter((s) => STATUS_VALUES.has(s));
    if (valid.length === 0) return { items: [], next_cursor: null };
    where.push(`status IN (${valid.map(() => '?').join(',')})`);
    args.push(...valid);
  }

  if (filter.kind !== undefined) {
    const arr = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    const valid = arr.filter((k) => KIND_VALUES.has(k));
    if (valid.length === 0) return { items: [], next_cursor: null };
    where.push(`kind IN (${valid.map(() => '?').join(',')})`);
    args.push(...valid);
  }

  if (filter.tag !== undefined && filter.tag !== '') {
    // Same defense-in-depth alphabet as tasks repo — no `%` / `_` / `"`.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(filter.tag)) {
      return { items: [], next_cursor: null };
    }
    where.push('tags LIKE ?');
    args.push(`%"${filter.tag}"%`);
  }

  if (filter.search !== undefined && filter.search.trim() !== '') {
    // Server-side LIKE fallback for list-mode search. FTS5 is the real
    // search path (see search engine integration) — this just lets the
    // memory list filter without round-tripping to FTS.
    where.push('(title LIKE ? OR summary LIKE ? OR raw_content LIKE ?)');
    const like = `%${filter.search.trim().replace(/[%_]/g, '')}%`;
    args.push(like, like, like);
  }

  if (filter.cursor !== undefined) {
    const decoded = decodeCursor(filter.cursor);
    if (decoded !== null) {
      where.push('(created_at < ? OR (created_at = ? AND id > ?))');
      args.push(decoded.created_at, decoded.created_at, decoded.id);
    }
  }

  const limit = Math.min(
    Math.max(1, Math.floor(filter.limit ?? DEFAULT_PAGE_LIMIT)),
    MEMORY_MAX_PAGE_LIMIT,
  );
  const fetchLimit = limit + 1;

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const summaryMode = filter.fields === 'summary';

  if (summaryMode) {
    const rows = db
      .prepare(
        `SELECT id, kind, title, summary, tags, source_url, status,
                created_at, updated_at, enriched_at
         FROM memory_items
         ${whereSql}
         ORDER BY created_at DESC, id ASC
         LIMIT ?`,
      )
      .all(...args, fetchLimit) as SummaryRow[];
    let next_cursor: string | null = null;
    let page = rows;
    if (rows.length > limit) {
      page = rows.slice(0, limit);
      const last = page[page.length - 1]!;
      next_cursor = encodeCursor(last.created_at, last.id);
    }
    return { items: page.map(rowToSummary), next_cursor };
  }

  const rows = db
    .prepare(
      `SELECT id, kind, title, raw_content, summary, tags, entities,
              source_url, source_path, content_hash, status,
              enrichment_error, created_at, updated_at, enriched_at
       FROM memory_items
       ${whereSql}
       ORDER BY created_at DESC, id ASC
       LIMIT ?`,
    )
    .all(...args, fetchLimit) as FullRow[];
  let next_cursor: string | null = null;
  let page = rows;
  if (rows.length > limit) {
    page = rows.slice(0, limit);
    const last = page[page.length - 1]!;
    next_cursor = encodeCursor(last.created_at, last.id);
  }
  return { items: page.map(rowToItem), next_cursor };
}

/* -------------------------------------------------------------------------- */
/*  Links                                                                     */
/* -------------------------------------------------------------------------- */

export function addMemoryLink(input: {
  source_id: string;
  target_kind: MemoryLinkTargetKind;
  target_id: string;
  link_kind: MemoryLinkKind;
  score?: number;
}): MemoryLink {
  const db = getSqlite();
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO memory_links
       (id, source_id, target_kind, target_id, link_kind, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.source_id,
    input.target_kind,
    input.target_id,
    input.link_kind,
    input.score ?? 1.0,
    now,
  );
  // Read back — INSERT OR IGNORE may have skipped if the unique constraint
  // matched an existing edge. Return whichever row is there.
  const row = db
    .prepare(
      `SELECT id, source_id, target_kind, target_id, link_kind, score, created_at
       FROM memory_links
       WHERE source_id = ? AND target_kind = ? AND target_id = ? AND link_kind = ?`,
    )
    .get(
      input.source_id,
      input.target_kind,
      input.target_id,
      input.link_kind,
    ) as MemoryLink;
  return row;
}

export function listLinksFor(source_id: string): MemoryLink[] {
  const db = getSqlite();
  return db
    .prepare(
      `SELECT id, source_id, target_kind, target_id, link_kind, score, created_at
       FROM memory_links WHERE source_id = ? ORDER BY score DESC, created_at DESC`,
    )
    .all(source_id) as MemoryLink[];
}

export function removeMemoryLink(linkId: string): boolean {
  const db = getSqlite();
  const r = db
    .prepare('DELETE FROM memory_links WHERE id = ?')
    .run(linkId) as { changes: number };
  return r.changes > 0;
}
