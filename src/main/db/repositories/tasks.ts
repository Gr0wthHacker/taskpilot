/**
 * Tasks repository.
 *
 * All DB access for the `tasks` table goes through here — callers never see
 * raw SQL or the JSON-stringified shape of `context` / `tags`. Drizzle handles
 * the SQL; this module owns the (de)serialization boundary between the storage
 * row and the public `Task` type from `src/shared/types.ts`.
 *
 * better-sqlite3 is synchronous, so every function returns immediately.
 */

import { and, asc, desc, eq, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { tasks, type TaskRow } from '../../../shared/schema.js';
import type {
  CreateTaskInput,
  Task,
  TaskFilter,
  TaskStatus,
  TaskSummary,
  UpdateTaskInput,
} from '../../../shared/types.js';

import { getDb, getSqlite } from '../index.js';

/* -------------------------------------------------------------------------- */
/*  Serialization helpers                                                     */
/* -------------------------------------------------------------------------- */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  // 12 chars matches the spec.
  return nanoid(12);
}

function serializeContext(
  context: Record<string, unknown> | null | undefined,
): string | null {
  if (context === null || context === undefined) return null;
  return JSON.stringify(context);
}

function parseContext(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function serializeTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags);
}

function parseTags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Convert a raw DB row to the public `Task` shape.
 */
function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due: row.due,
    calendar_event_id: row.calendar_event_id,
    parent_id: row.parent_id,
    agent_executable: row.agent_executable,
    agent_method: row.agent_method,
    agent_instructions: row.agent_instructions,
    agent_status: row.agent_status,
    context: parseContext(row.context),
    tags: parseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToSummary(row: Pick<TaskRow,
  | 'id' | 'title' | 'status' | 'priority' | 'due' | 'parent_id'
  | 'agent_executable' | 'agent_method' | 'agent_status' | 'tags'
  | 'created_at' | 'updated_at'>): TaskSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    due: row.due,
    parent_id: row.parent_id,
    agent_executable: row.agent_executable,
    agent_method: row.agent_method,
    agent_status: row.agent_status,
    tags: parseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Cursor helpers (keyset pagination)                                        */
/* -------------------------------------------------------------------------- */

/**
 * The list order is `created_at DESC, id ASC`. A cursor captures the
 * (created_at, id) of the LAST row returned; the next page asks for rows
 * strictly after it.
 *
 * Format is opaque base64-url of `<created_at>|<id>`. Decoding is best-effort:
 * a malformed cursor is treated as "no cursor" (the page starts fresh) rather
 * than throwing, so callers don't need to worry about stale links.
 */
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
    // Basic ISO sanity — won't catch every malformed value but blocks SQL-bad
    // characters (the cursor flows into a parameterized query so it can't be
    // injected, but garbage-in shouldn't silently scan the whole table either).
    if (!/^\d{4}-\d{2}-\d{2}T/.test(created_at)) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export function listTasks(filter: TaskFilter = {}): Task[] {
  const db = getDb();
  const conditions = [];

  // Archived tasks are excluded by default. A caller can explicitly filter
  // FOR archived (status='archived') or pass `include_archived: true` to see
  // them mixed in. Same treatment for `cancelled` — both statuses sit
  // outside normal workflow and only matter when a caller asks for them.
  // This keeps inbox/board/queue lists tidy without forcing every view to
  // remember.
  const wantArchived =
    filter.include_archived === true ||
    filter.status === 'archived' ||
    (Array.isArray(filter.status) && filter.status.includes('archived'));
  const wantCancelled =
    filter.include_cancelled === true ||
    filter.status === 'cancelled' ||
    (Array.isArray(filter.status) && filter.status.includes('cancelled'));

  if (filter.status !== undefined) {
    if (Array.isArray(filter.status)) {
      if (filter.status.length > 0) conditions.push(inArray(tasks.status, filter.status));
    } else {
      conditions.push(eq(tasks.status, filter.status));
    }
  } else {
    if (!wantArchived) conditions.push(ne(tasks.status, 'archived'));
    if (!wantCancelled) conditions.push(ne(tasks.status, 'cancelled'));
  }

  if (filter.priority !== undefined) {
    if (Array.isArray(filter.priority)) {
      if (filter.priority.length > 0) conditions.push(inArray(tasks.priority, filter.priority));
    } else {
      conditions.push(eq(tasks.priority, filter.priority));
    }
  }

  if (filter.parent !== undefined) {
    if (filter.parent === null) {
      conditions.push(isNull(tasks.parent_id));
    } else {
      conditions.push(eq(tasks.parent_id, filter.parent));
    }
  }

  if (filter.agent_only === true) {
    conditions.push(eq(tasks.agent_executable, true));
  }

  if (filter.tag !== undefined && filter.tag !== '') {
    // tags column is JSON-stringified — a simple LIKE on the quoted token
    // catches exact tag membership without needing a separate index table.
    //
    // SECURITY: the tag value is interpolated into the LIKE pattern, so it
    // MUST be constrained to a safe alphabet (no `%`, `_`, `\`, or `"`).
    // We validate against the same regex Zod uses for `tagSchema` and reject
    // anything else with an empty result rather than executing a wildcarded
    // query. Callers that hit the HTTP layer are pre-validated by Zod; this
    // is defense in depth for direct repo callers (CLI, MCP tools).
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(filter.tag)) {
      return [];
    }
    conditions.push(like(tasks.tags, `%"${filter.tag}"%`));
  }

  if (filter.goal_id !== undefined && filter.goal_id !== '') {
    // `context` is JSON-stringified and holds `{"goal_id":"<id>", ...}` for
    // tasks explicitly attached to a goal. A quoted LIKE catches the exact
    // value without a join table — same alphabet constraint as `tag` so the
    // interpolated value can never carry a wildcard or quote (defense in
    // depth for direct repo callers; HTTP callers are pre-validated by Zod).
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(filter.goal_id)) {
      return [];
    }
    conditions.push(like(tasks.context, `%"goal_id":"${filter.goal_id}"%`));
  }

  const baseQuery = db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.created_at), asc(tasks.id));

  const withLimit =
    filter.limit !== undefined ? baseQuery.limit(filter.limit) : baseQuery;
  const withOffset =
    filter.offset !== undefined ? withLimit.offset(filter.offset) : withLimit;

  const rows = withOffset.all();
  return rows.map(rowToTask);
}

/* -------------------------------------------------------------------------- */
/*  Paginated list                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on a single page. The HTTP route layer also caps requests at
 * this number; this is the authoritative limit for direct repo callers.
 */
export const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 100;

export interface TaskPage {
  tasks: Task[] | TaskSummary[];
  next_cursor: string | null;
}

/**
 * Cursor-paginated, projection-aware list. Use this for any UI surface that
 * doesn't need every task at once (inbox, board, search, agent queue). The
 * cursor is opaque and stable across calls so `useInfiniteQuery` can chain.
 *
 * Filter semantics match `listTasks()` for all shared fields. `limit` is
 * clamped to [1, MAX_PAGE_LIMIT]; `fields: 'summary'` returns the lighter
 * `TaskSummary` shape (drops description + agent_instructions + context).
 */
export function listTasksPage(filter: TaskFilter = {}): TaskPage {
  const db = getDb();
  const conditions = [];

  const wantArchived =
    filter.include_archived === true ||
    filter.status === 'archived' ||
    (Array.isArray(filter.status) && filter.status.includes('archived'));
  const wantCancelled =
    filter.include_cancelled === true ||
    filter.status === 'cancelled' ||
    (Array.isArray(filter.status) && filter.status.includes('cancelled'));

  if (filter.status !== undefined) {
    if (Array.isArray(filter.status)) {
      if (filter.status.length > 0) conditions.push(inArray(tasks.status, filter.status));
    } else {
      conditions.push(eq(tasks.status, filter.status));
    }
  } else {
    if (!wantArchived) conditions.push(ne(tasks.status, 'archived'));
    if (!wantCancelled) conditions.push(ne(tasks.status, 'cancelled'));
  }

  if (filter.priority !== undefined) {
    if (Array.isArray(filter.priority)) {
      if (filter.priority.length > 0) conditions.push(inArray(tasks.priority, filter.priority));
    } else {
      conditions.push(eq(tasks.priority, filter.priority));
    }
  }

  if (filter.parent !== undefined) {
    if (filter.parent === null) {
      conditions.push(isNull(tasks.parent_id));
    } else {
      conditions.push(eq(tasks.parent_id, filter.parent));
    }
  }

  if (filter.agent_only === true) {
    conditions.push(eq(tasks.agent_executable, true));
  }

  if (filter.tag !== undefined && filter.tag !== '') {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(filter.tag)) {
      return { tasks: [], next_cursor: null };
    }
    conditions.push(like(tasks.tags, `%"${filter.tag}"%`));
  }

  if (filter.goal_id !== undefined && filter.goal_id !== '') {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(filter.goal_id)) {
      return { tasks: [], next_cursor: null };
    }
    conditions.push(like(tasks.context, `%"goal_id":"${filter.goal_id}"%`));
  }

  // Cursor: (created_at < C) OR (created_at = C AND id > I)
  // matches the ORDER BY (created_at DESC, id ASC) sort.
  if (filter.cursor !== undefined) {
    const decoded = decodeCursor(filter.cursor);
    if (decoded !== null) {
      conditions.push(
        or(
          lt(tasks.created_at, decoded.created_at),
          and(eq(tasks.created_at, decoded.created_at), sql`${tasks.id} > ${decoded.id}`),
        )!,
      );
    }
  }

  const limit = Math.min(
    Math.max(1, Math.floor(filter.limit ?? DEFAULT_PAGE_LIMIT)),
    MAX_PAGE_LIMIT,
  );
  // Fetch one extra row to detect "has next page" without a second query.
  const fetchLimit = limit + 1;

  const summaryMode = filter.fields === 'summary';

  // Build the base query. Summary mode selects only the columns we need —
  // skips the heavy description + agent_instructions + context blobs.
  const columns = summaryMode
    ? {
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        due: tasks.due,
        parent_id: tasks.parent_id,
        agent_executable: tasks.agent_executable,
        agent_method: tasks.agent_method,
        agent_status: tasks.agent_status,
        tags: tasks.tags,
        created_at: tasks.created_at,
        updated_at: tasks.updated_at,
      }
    : undefined;

  const rows = (columns
    ? db.select(columns).from(tasks)
    : db.select().from(tasks))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.created_at), asc(tasks.id))
    .limit(fetchLimit)
    .all() as TaskRow[];

  let next_cursor: string | null = null;
  let pageRows = rows;
  if (rows.length > limit) {
    pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1]!;
    next_cursor = encodeCursor(last.created_at, last.id);
  }

  const out = summaryMode
    ? (pageRows.map(rowToSummary) as TaskSummary[])
    : (pageRows.map(rowToTask) as Task[]);
  return { tasks: out, next_cursor };
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? rowToTask(row) : null;
}

export function getChildren(parentId: string): Task[] {
  const db = getDb();
  const rows = db
    .select()
    .from(tasks)
    .where(eq(tasks.parent_id, parentId))
    .orderBy(asc(tasks.created_at))
    .all();
  return rows.map(rowToTask);
}

export function listAgentExecutable(): Task[] {
  const db = getDb();
  const rows = db
    .select()
    .from(tasks)
    .where(eq(tasks.agent_executable, true))
    .orderBy(asc(tasks.priority), desc(tasks.created_at))
    .all();
  return rows.map(rowToTask);
}

export function listByStatus(status: TaskStatus): Task[] {
  return listTasks({ status });
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const now = nowIso();
  const id = input.id ?? newId();

  const insertValues = {
    id,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? 'inbox',
    priority: input.priority ?? 'p2',
    due: input.due ?? null,
    calendar_event_id: input.calendar_event_id ?? null,
    parent_id: input.parent_id ?? null,
    agent_executable: input.agent_executable ?? false,
    agent_method: input.agent_method ?? 'human_only',
    agent_instructions: input.agent_instructions ?? null,
    agent_status: input.agent_status ?? 'pending',
    context: serializeContext(input.context),
    tags: serializeTags(input.tags),
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  } as const;

  db.insert(tasks).values(insertValues).run();

  const created = getTask(id);
  if (!created) {
    throw new Error(`Failed to create task ${id}`);
  }
  fireTaskWritten(created.id);
  return created;
}

/**
 * Patch-style update. Only the fields present in `patch` are written; everything
 * else is left untouched. `updated_at` is always refreshed.
 */
/**
 * Read the `recurrence` rule (if any) stored under `task.context.recurrence`.
 * Returns `null` if the task has no context, no recurrence, or the recurrence
 * value isn't a plain object.
 */
function readRecurrenceRule(
  task: Task,
): import('../../../shared/types.js').RecurrenceRule | null {
  const ctx = task.context;
  if (!ctx || typeof ctx !== 'object') return null;
  const recurrence = (ctx as Record<string, unknown>)['recurrence'];
  if (!recurrence || typeof recurrence !== 'object') return null;
  const rule = recurrence as Record<string, unknown>;
  const kind = rule['kind'];
  if (
    kind !== 'daily' &&
    kind !== 'weekdays' &&
    kind !== 'weekly' &&
    kind !== 'monthly'
  ) {
    return null;
  }
  return rule as unknown as import('../../../shared/types.js').RecurrenceRule;
}

/**
 * Hook registry — the recurrence engine calls `registerOnTaskCompleted` at
 * module load time so we can spawn the next occurrence without importing the
 * engine here (which would cycle). Tests can override or clear the hook.
 *
 * `registerOnTaskCompleted` is single-slot and preserved for backward
 * compatibility (recurrence calls it on load). Additional listeners — the
 * Wave 13 GitHub issue sync-back, for example — should use
 * `addOnTaskCompleted` instead so they don't clobber recurrence or each
 * other. All fan-out listeners fire on EVERY task that transitions into
 * `done`, regardless of recurrence rule.
 */
type CompletionHook = (taskId: string) => void;
let onTaskCompleted: CompletionHook | null = null;
const completionListeners: CompletionHook[] = [];

export function registerOnTaskCompleted(hook: CompletionHook | null): void {
  onTaskCompleted = hook;
}

/**
 * Add a fan-out completion listener. Returns an unsubscribe function so
 * tests can clean up between cases. Fires on every task that completes.
 */
export function addOnTaskCompleted(hook: CompletionHook): () => void {
  completionListeners.push(hook);
  return () => {
    const idx = completionListeners.indexOf(hook);
    if (idx >= 0) completionListeners.splice(idx, 1);
  };
}

/**
 * Write-hook registry (Wave 17 — search). Fires after a task is created or
 * updated so derived bookkeeping (the full-text search index) can refresh that
 * one task without polling. Same fan-out pattern as the completion listeners:
 * each call appends, the returned function unsubscribes, and a throwing hook is
 * swallowed so it can't break the write path. Tests clear via
 * `__clearWriteListeners`.
 */
type WriteHook = (taskId: string) => void;
const writeListeners: WriteHook[] = [];

export function addOnTaskWritten(hook: WriteHook): () => void {
  writeListeners.push(hook);
  return () => {
    const idx = writeListeners.indexOf(hook);
    if (idx >= 0) writeListeners.splice(idx, 1);
  };
}

function fireTaskWritten(taskId: string): void {
  for (const listener of writeListeners) {
    try {
      listener(taskId);
    } catch {
      // Best-effort — one bad listener can't block the write or others.
    }
  }
}

/** Test-only: drop every write listener. */
export function __clearWriteListeners(): void {
  writeListeners.length = 0;
}

/**
 * Test-only escape hatch: drop every fan-out listener. The single-slot
 * recurrence hook is left intact so the side-effect import keeps
 * working across test files.
 */
export function __clearCompletionListeners(): void {
  completionListeners.length = 0;
}

export function updateTask(id: string, patch: UpdateTaskInput): Task | null {
  const existing = getTask(id);
  if (!existing) return null;

  const db = getDb();
  const updates: Record<string, unknown> = { updated_at: nowIso() };

  if ('title' in patch && patch.title !== undefined) updates.title = patch.title;
  if ('description' in patch) updates.description = patch.description ?? null;
  if ('status' in patch && patch.status !== undefined) updates.status = patch.status;
  if ('priority' in patch && patch.priority !== undefined) updates.priority = patch.priority;
  if ('due' in patch) updates.due = patch.due ?? null;
  if ('calendar_event_id' in patch) updates.calendar_event_id = patch.calendar_event_id ?? null;
  if ('parent_id' in patch) updates.parent_id = patch.parent_id ?? null;
  if ('agent_executable' in patch && patch.agent_executable !== undefined) {
    updates.agent_executable = patch.agent_executable;
  }
  if ('agent_method' in patch && patch.agent_method !== undefined) {
    updates.agent_method = patch.agent_method;
  }
  if ('agent_instructions' in patch) {
    updates.agent_instructions = patch.agent_instructions ?? null;
  }
  if ('agent_status' in patch && patch.agent_status !== undefined) {
    updates.agent_status = patch.agent_status;
  }
  if ('context' in patch) updates.context = serializeContext(patch.context);
  if ('tags' in patch) updates.tags = serializeTags(patch.tags);

  db.update(tasks).set(updates).where(eq(tasks.id, id)).run();

  const updated = getTask(id);

  // Status just flipped to `done`? Fire the hooks. The single-slot
  // recurrence hook only runs when the task carries a recurrence rule
  // (matching the previous behavior). The fan-out listeners run on every
  // completion — that's where the GitHub issue sync-back lives.
  if (updated && patch.status === 'done' && existing.status !== 'done') {
    if (readRecurrenceRule(updated) && onTaskCompleted) {
      try {
        onTaskCompleted(updated.id);
      } catch {
        // Recurrence is best-effort — never block the user's completion.
      }
    }
    for (const listener of completionListeners) {
      try {
        listener(updated.id);
      } catch {
        // Fan-out listeners are best-effort — swallow individually so one
        // bad listener can't block another from firing.
      }
    }
  }

  // Wave 17: fire the write hook so the search index re-syncs this task's
  // title/description/instructions/attachments. Fires on every successful
  // update regardless of which fields changed (cheap to re-index one task).
  if (updated) fireTaskWritten(updated.id);

  return updated;
}

/**
 * Move a task to the `archived` status. Returns the updated task or `null`
 * if no task exists with that id. The status flip itself bumps `updated_at`,
 * which doubles as the "archived at" timestamp.
 */
export function archiveTask(id: string): Task | null {
  return updateTask(id, { status: 'archived' });
}

/**
 * Restore an archived task back to `inbox`. No-op (returns the existing row)
 * if the task isn't currently archived.
 */
export function unarchiveTask(id: string): Task | null {
  const existing = getTask(id);
  if (!existing) return null;
  if (existing.status !== 'archived') return existing;
  return updateTask(id, { status: 'inbox' });
}

/**
 * Hook fired right before a task is deleted. Used by the links module to
 * scrub references to the deleted id from every other task's
 * `context.links` block, by the attachments module to wipe the per-task
 * attachment directory, and by future cleanup callers. Same wiring pattern
 * as the recurrence completion hook above so we avoid circular imports
 * between tasks.ts and the consumer modules.
 *
 * Multiple hooks are supported — each call to `registerOnTaskPreDelete`
 * appends to an internal list, and `null` clears every registration. The
 * list is invoked in insertion order; a throwing hook is swallowed so
 * downstream hooks still run.
 */
type PreDeleteHook = (taskId: string) => void;
const preDeleteHooks: PreDeleteHook[] = [];

export function registerOnTaskPreDelete(hook: PreDeleteHook | null): void {
  if (hook === null) {
    preDeleteHooks.length = 0;
    return;
  }
  preDeleteHooks.push(hook);
}

export function deleteTask(id: string): boolean {
  // Wrap pre-delete hooks + child-row cleanup + parent delete in a SINGLE
  // transaction so:
  //   1. FOREIGN KEY constraints never fire mid-cleanup.
  //   2. A crash partway through can't leave a half-deleted task with
  //      orphan rows.
  //   3. Hook side-effects (links scrubbing, attachment dir cleanup,
  //      search index updates) get rolled back if the parent delete
  //      itself fails — otherwise we'd have already scrubbed link
  //      references to a task that still exists.
  // Hooks that touch the filesystem rather than the DB (attachments dir
  // wipe) aren't transactional — they're best-effort and rolling back a
  // directory wipe isn't possible. That's acceptable: if the transaction
  // fails, an empty attachments dir is the worst case.
  const sqlite = getSqlite();
  const tx = sqlite.transaction((taskId: string) => {
    // Pre-delete hooks first, INSIDE the transaction so their DB writes
    // are part of the same commit boundary.
    for (const hook of preDeleteHooks) {
      try {
        hook(taskId);
      } catch {
        // Best-effort — a thrown hook shouldn't block the delete.
      }
    }
    // Order matters: cascade-equivalent child rows first, then the task itself.
    // All children FK to tasks.id. calendar_sync uses task_id as its PK.
    sqlite.prepare('DELETE FROM conversation_task_links WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM execution_logs WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM cost_events WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM feedback WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM decisions WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM calendar_sync WHERE task_id = ?').run(taskId);
    // Re-parent any children pointing here so the parent FK doesn't fire.
    sqlite
      .prepare('UPDATE tasks SET parent_id = NULL WHERE parent_id = ?')
      .run(taskId);
    return sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  const result = tx(id) as { changes: number };
  return result.changes > 0;
}

/* -------------------------------------------------------------------------- */
/*  Re-exports for tests / advanced callers                                   */
/* -------------------------------------------------------------------------- */

export const __internals = {
  rowToTask,
  parseContext,
  parseTags,
  serializeContext,
  serializeTags,
};

/* -------------------------------------------------------------------------- */
/*  Namespace object — for callers that import as `tasksRepository.x`         */
/* -------------------------------------------------------------------------- */

export const tasksRepository = {
  list: listTasks,
  findById: getTask,
  get: getTask,
  create: createTask,
  update: updateTask,
  delete: deleteTask,
  archive: archiveTask,
  unarchive: unarchiveTask,
  getChildren,
  listAgentExecutable,
  listByStatus,
};
