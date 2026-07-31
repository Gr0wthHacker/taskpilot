/**
 * Search index maintenance (Wave 17 — search).
 *
 * Owns writes to the `search_index` FTS5 table: full rebuilds at boot, and
 * incremental upserts when a task / decision / execution result changes. The
 * query side lives in `./index.ts`.
 *
 * Every function is a no-op when FTS5 isn't available (the query side uses the
 * LIKE scan in that case, so there's nothing to maintain). Every function is
 * also wrapped so a failure NEVER propagates to its caller — indexing is
 * derived bookkeeping that must not block task writes or result ingestion.
 *
 * Indexed entities (matching the search engine):
 *   - `task`       — one row; body = description + agent_instructions
 *   - `attachment` — one row per attachment filename on the task
 *   - `decision`   — one row; body = entry text
 *   - `execution`  — one row per execution log with a non-empty output
 *
 * Goals (Wave 17 G) are indexed OPTIONALLY: if a `goals` table exists we add
 * `goal` rows, but we never hard-depend on it (defensive table probe).
 */

import type Database from 'better-sqlite3';

import { getSqlite } from '@/main/db';

import { isFtsAvailable, extractAttachmentFilenames } from './index';
import { readCachedTextSync } from '@/main/attachments/extract';

/**
 * Cap on extracted-text bytes folded into a single attachment index row.
 * Keeps a single huge PDF from dominating the FTS5 table. The full extracted
 * text remains available via `taskpilot_attachment_read` / the HTTP route.
 */
const MAX_INDEXED_ATTACHMENT_BYTES = 256 * 1024;

/* -------------------------------------------------------------------------- */
/*  Low-level row helpers                                                     */
/* -------------------------------------------------------------------------- */

interface IndexRow {
  entity_type: string;
  entity_id: string;
  task_id: string;
  title: string;
  body: string;
  matched_field: string;
}

/**
 * Delete every `search_index` row for a given entity. Used before re-inserting
 * (upsert pattern) and by `removeEntity`. Tasks fan out to their attachments,
 * so a task delete must also wipe the per-filename attachment rows.
 */
function deleteRows(db: Database.Database, entityType: string, entityId: string): void {
  db.prepare(
    'DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?',
  ).run(entityType, entityId);
}

function insertRow(db: Database.Database, row: IndexRow): void {
  db.prepare(
    `INSERT INTO search_index
       (entity_type, entity_id, task_id, title, body, matched_field)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.entity_type,
    row.entity_id,
    row.task_id,
    row.title,
    row.body,
    row.matched_field,
  );
}

/* -------------------------------------------------------------------------- */
/*  Per-entity indexers                                                       */
/* -------------------------------------------------------------------------- */

interface TaskIndexRow {
  id: string;
  title: string;
  description: string | null;
  agent_instructions: string | null;
  context: string | null;
}

/**
 * Map of `${taskId}:${filename}` → cached extracted text. Passed into
 * `rowsForTask` during `rebuildIndex` so the sync disk I/O happens BEFORE
 * the SQLite write transaction opens — otherwise the lock is held during
 * potentially-large file reads across every attachment in the workspace.
 *
 * `null` (the default) means do the sync read inline — that's the
 * incremental path (`indexTask` for a single task), where one extra sync
 * read is negligible.
 */
type AttachmentTextCache = Map<string, string> | null;

function rowsForTask(t: TaskIndexRow, textCache: AttachmentTextCache = null): IndexRow[] {
  const body = [t.description ?? '', t.agent_instructions ?? '']
    .filter((s) => s.length > 0)
    .join('\n');
  const rows: IndexRow[] = [
    {
      entity_type: 'task',
      entity_id: t.id,
      task_id: t.id,
      title: t.title,
      body,
      matched_field: 'task',
    },
  ];
  for (const filename of extractAttachmentFilenames(t.context)) {
    // Pull cached extracted text — keeps PDF/DOCX/XLSX content searchable
    // alongside the filename. `matched_field` stays 'filename' (not
    // 'attachment') so consumers — including the LIKE fallback in
    // src/main/search/index.ts and any UI filter keying off this value —
    // see one consistent label regardless of whether extraction has run yet.
    const key = `${t.id}:${filename}`;
    const cached =
      textCache !== null ? (textCache.get(key) ?? '') : (readCachedTextSync(t.id, filename) ?? '');
    const clipped =
      cached.length > MAX_INDEXED_ATTACHMENT_BYTES
        ? cached.slice(0, MAX_INDEXED_ATTACHMENT_BYTES)
        : cached;
    rows.push({
      entity_type: 'attachment',
      entity_id: `${t.id}:${filename}`,
      task_id: t.id,
      title: filename,
      body: clipped.length > 0 ? `${filename}\n${clipped}` : filename,
      matched_field: 'filename',
    });
  }
  return rows;
}

/**
 * Pre-load every attachment's cached extracted text into a Map keyed by
 * `${taskId}:${filename}`. Called once before the rebuild transaction so
 * the sync reads don't hold the SQLite write lock.
 */
function preloadAttachmentTexts(taskRows: TaskIndexRow[]): Map<string, string> {
  const cache = new Map<string, string>();
  for (const t of taskRows) {
    for (const filename of extractAttachmentFilenames(t.context)) {
      const text = readCachedTextSync(t.id, filename);
      if (text !== null) cache.set(`${t.id}:${filename}`, text);
    }
  }
  return cache;
}

/**
 * (Re)index a single task: its own row plus one row per attachment filename.
 * Best-effort; swallows errors. Safe to call on create, update, and after
 * result ingestion (the agent may have mutated context/instructions).
 */
export function indexTask(taskId: string): void {
  if (!isFtsAvailable()) return;
  try {
    const db = getSqlite();
    const t = db
      .prepare(
        'SELECT id, title, description, agent_instructions, context FROM tasks WHERE id = ?',
      )
      .get(taskId) as TaskIndexRow | undefined;

    // Wipe the task row + any stale attachment rows for this task first.
    deleteRows(db, 'task', taskId);
    db.prepare(
      "DELETE FROM search_index WHERE entity_type = 'attachment' AND task_id = ?",
    ).run(taskId);

    if (!t) return; // task gone — leaving it deleted is correct.
    for (const row of rowsForTask(t)) insertRow(db, row);
  } catch {
    /* non-fatal — index is derived */
  }
}

interface DecisionIndexRow {
  id: string;
  task_id: string;
  category: string;
  text: string;
}

/**
 * (Re)index a single decision-log entry. Best-effort.
 */
export function indexDecision(decisionId: string): void {
  if (!isFtsAvailable()) return;
  try {
    const db = getSqlite();
    const d = db
      .prepare('SELECT id, task_id, category, text FROM decisions WHERE id = ?')
      .get(decisionId) as DecisionIndexRow | undefined;
    deleteRows(db, 'decision', decisionId);
    if (!d) return;
    insertRow(db, {
      entity_type: 'decision',
      entity_id: d.id,
      task_id: d.task_id,
      title: `${capitalize(d.category)} note`,
      body: d.text,
      matched_field: 'decision',
    });
  } catch {
    /* non-fatal */
  }
}

interface ConversationIndexRow {
  id: string;
  title: string | null;
  digest: string | null;
  topics: string | null;
  key_decisions: string | null;
}

/**
 * (Re)index a single conversation. `task_id` is empty — conversations stand
 * alone in the index; the search engine treats them as a separate entity type
 * but they show up in the unified result list. Best-effort.
 */
export function indexConversation(conversationId: string): void {
  if (!isFtsAvailable()) return;
  try {
    const db = getSqlite();
    const c = db
      .prepare(
        'SELECT id, title, digest, topics, key_decisions FROM conversations WHERE id = ?',
      )
      .get(conversationId) as ConversationIndexRow | undefined;
    deleteRows(db, 'conversation', conversationId);
    if (!c) return;
    const bodyParts: string[] = [];
    if (c.digest) bodyParts.push(c.digest);
    if (c.topics) {
      try {
        const arr = JSON.parse(c.topics) as unknown;
        if (Array.isArray(arr)) bodyParts.push(arr.filter((x) => typeof x === 'string').join(' '));
      } catch { /* ignore */ }
    }
    if (c.key_decisions) {
      try {
        const arr = JSON.parse(c.key_decisions) as unknown;
        if (Array.isArray(arr)) bodyParts.push(arr.filter((x) => typeof x === 'string').join(' '));
      } catch { /* ignore */ }
    }
    insertRow(db, {
      entity_type: 'conversation',
      entity_id: c.id,
      task_id: '',
      title: c.title ?? '(untitled session)',
      body: bodyParts.join('\n').slice(0, 256 * 1024),
      matched_field: 'conversation',
    });
  } catch {
    /* non-fatal */
  }
}

interface MemoryIndexRow {
  id: string;
  title: string | null;
  summary: string | null;
  tags: string | null;
  raw_content: string;
  source_url: string | null;
}

/**
 * Re-index a single memory item. Called on create + enrichment. Best-effort —
 * any FTS write that throws falls back to the LIKE-scan path. Body is built
 * from summary (preferred) + raw_content + tags so search hits land on
 * intent-bearing prose rather than e.g. a long URL fetch.
 */
export function indexMemory(memoryId: string): void {
  if (!isFtsAvailable()) return;
  try {
    const db = getSqlite();
    const m = db
      .prepare(
        `SELECT id, title, summary, tags, raw_content, source_url
         FROM memory_items WHERE id = ?`,
      )
      .get(memoryId) as MemoryIndexRow | undefined;
    deleteRows(db, 'memory', memoryId);
    if (!m) return;
    const bodyParts: string[] = [];
    if (m.summary) bodyParts.push(m.summary);
    if (m.tags) {
      try {
        const arr = JSON.parse(m.tags) as unknown;
        if (Array.isArray(arr)) {
          bodyParts.push(arr.filter((x) => typeof x === 'string').join(' '));
        }
      } catch {
        /* ignore */
      }
    }
    if (m.source_url) bodyParts.push(m.source_url);
    // Cap raw_content contribution at 64 KB so a giant URL-fetched page
    // doesn't dominate the FTS table.
    if (m.raw_content) {
      bodyParts.push(m.raw_content.slice(0, 64 * 1024));
    }
    insertRow(db, {
      entity_type: 'memory',
      entity_id: m.id,
      task_id: '',
      title: m.title ?? m.summary?.slice(0, 120) ?? '(memory)',
      body: bodyParts.join('\n').slice(0, 256 * 1024),
      matched_field: 'memory',
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Re-index every execution-log row for a task. Called after result ingestion
 * (which inserts a fresh execution log) rather than per-log because ingestion
 * already keys off the task id. Best-effort.
 */
export function indexExecutionsForTask(taskId: string): void {
  if (!isFtsAvailable()) return;
  try {
    const db = getSqlite();
    db.prepare(
      "DELETE FROM search_index WHERE entity_type = 'execution' AND task_id = ?",
    ).run(taskId);
    const rows = db
      .prepare(
        "SELECT id, task_id, output FROM execution_logs WHERE task_id = ? AND output IS NOT NULL AND output <> ''",
      )
      .all(taskId) as Array<{ id: string; task_id: string; output: string }>;
    for (const e of rows) {
      insertRow(db, {
        entity_type: 'execution',
        entity_id: e.id,
        task_id: e.task_id,
        title: 'Execution output',
        body: e.output,
        matched_field: 'output',
      });
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Remove every index row for an entity. For a `task` this also removes the
 * task's attachment / decision / execution rows so a deleted task leaves no
 * orphans in the index. Best-effort.
 */
export function removeEntity(
  entityType: 'task' | 'decision' | 'execution' | 'attachment' | 'memory',
  entityId: string,
): void {
  if (!isFtsAvailable()) return;
  try {
    const db = getSqlite();
    if (entityType === 'task') {
      // entityId is the task id; cascade to everything keyed by task_id.
      db.prepare('DELETE FROM search_index WHERE task_id = ?').run(entityId);
      return;
    }
    deleteRows(db, entityType, entityId);
  } catch {
    /* non-fatal */
  }
}

/* -------------------------------------------------------------------------- */
/*  Optional: goals (Wave 17 G — indexed only if the table exists)            */
/* -------------------------------------------------------------------------- */

function goalsTableExists(db: Database.Database): boolean {
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='goals'",
      )
      .get();
    return row !== undefined;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Full rebuild                                                              */
/* -------------------------------------------------------------------------- */

export interface RebuildStats {
  fts_available: boolean;
  tasks: number;
  attachments: number;
  decisions: number;
  executions: number;
  goals: number;
}

/**
 * Drop and rebuild the entire `search_index` from the source tables. Called
 * once at boot (after the DB is ready) and on demand. Runs inside a single
 * transaction so a partial rebuild can't leave the index half-populated.
 *
 * Returns row counts per entity type (zeroed when FTS5 is unavailable). Never
 * throws — a rebuild failure leaves the index as-is and the query side will
 * fall back to LIKE if needed.
 */
export function rebuildIndex(): RebuildStats {
  const stats: RebuildStats = {
    fts_available: false,
    tasks: 0,
    attachments: 0,
    decisions: 0,
    executions: 0,
    goals: 0,
  };

  if (!isFtsAvailable()) return stats;
  stats.fts_available = true;

  try {
    const db = getSqlite();
    // Pre-read task rows + warm the attachment-text cache OUTSIDE the
    // transaction. Sync disk reads inside `db.transaction` would hold the
    // SQLite write lock for the duration of (potentially tens of MB of)
    // attachment file reads, blocking concurrent UI queries during boot.
    const taskRows = db
      .prepare(
        'SELECT id, title, description, agent_instructions, context FROM tasks',
      )
      .all() as TaskIndexRow[];
    const attachmentTextCache = preloadAttachmentTexts(taskRows);

    const run = db.transaction(() => {
      db.prepare('DELETE FROM search_index').run();

      for (const t of taskRows) {
        for (const row of rowsForTask(t, attachmentTextCache)) {
          insertRow(db, row);
          if (row.entity_type === 'task') stats.tasks += 1;
          else if (row.entity_type === 'attachment') stats.attachments += 1;
        }
      }

      // Decisions.
      const decisionRows = db
        .prepare('SELECT id, task_id, category, text FROM decisions')
        .all() as DecisionIndexRow[];
      for (const d of decisionRows) {
        insertRow(db, {
          entity_type: 'decision',
          entity_id: d.id,
          task_id: d.task_id,
          title: `${capitalize(d.category)} note`,
          body: d.text,
          matched_field: 'decision',
        });
        stats.decisions += 1;
      }

      // Executions (only those with output).
      const execRows = db
        .prepare(
          "SELECT id, task_id, output FROM execution_logs WHERE output IS NOT NULL AND output <> ''",
        )
        .all() as Array<{ id: string; task_id: string; output: string }>;
      for (const e of execRows) {
        insertRow(db, {
          entity_type: 'execution',
          entity_id: e.id,
          task_id: e.task_id,
          title: 'Execution output',
          body: e.output,
          matched_field: 'output',
        });
        stats.executions += 1;
      }

      // Goals (optional — only if Wave 17 G's table is present). Indexed under
      // the `task` entity type (with task_id = goal id) so the existing result
      // shape doesn't need a new entity type; matched_field distinguishes it.
      // Defensive: any error here is swallowed by the outer try/catch.
      if (goalsTableExists(db)) {
        try {
          const goalRows = db
            .prepare('SELECT id, name, description FROM goals')
            .all() as Array<{
            id: string;
            name: string;
            description: string | null;
          }>;
          for (const g of goalRows) {
            insertRow(db, {
              entity_type: 'task',
              entity_id: `goal:${g.id}`,
              task_id: g.id,
              title: g.name,
              body: g.description ?? '',
              matched_field: 'goal',
            });
            stats.goals += 1;
          }
        } catch {
          /* goals schema differs from expectation — skip silently */
        }
      }
    });
    run();
  } catch {
    /* non-fatal — leave the index as-is */
  }

  return stats;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
