/**
 * Execution logs repository.
 *
 * Each agent execution attempt creates a log row at `startLog()` and is updated
 * to its terminal state via `completeLog()`. Logs are queryable per task.
 */

import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { executionLogs, type ExecutionLogRow } from '../../../shared/schema.js';
import type {
  ExecutionLog,
  ExecutionMethod,
  ExecutionStatus,
} from '../../../shared/types.js';

import { getDb } from '../index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function rowToLog(row: ExecutionLogRow): ExecutionLog {
  return {
    id: row.id,
    task_id: row.task_id,
    started_at: row.started_at ?? '',
    completed_at: row.completed_at,
    // `method` and `status` are nullable in the DB but always set by repo flows.
    // Default the in-memory representation to safe values when missing.
    method: (row.method ?? 'cli') as ExecutionMethod,
    status: (row.status ?? 'needs_review') as ExecutionStatus,
    output: row.output,
    error: row.error,
    log_path: row.log_path,
  };
}

export interface StartLogInput {
  task_id: string;
  method: ExecutionMethod;
  started_at?: string;
}

/**
 * Insert a new log row in the "running" state. Returns the new log id.
 */
export function startLog(input: StartLogInput): string {
  const db = getDb();
  const id = newId();
  db.insert(executionLogs)
    .values({
      id,
      task_id: input.task_id,
      started_at: input.started_at ?? nowIso(),
      method: input.method,
      status: null,
      completed_at: null,
      output: null,
      error: null,
      log_path: null,
    })
    .run();
  return id;
}

export interface CompleteLogInput {
  status: ExecutionStatus;
  output?: string | null;
  error?: string | null;
  log_path?: string | null;
  completed_at?: string;
}

/**
 * Mark a log row as complete with terminal status/output.
 * Returns the updated log row, or null if no log with that id exists.
 */
export function completeLog(
  id: string,
  input: CompleteLogInput,
): ExecutionLog | null {
  const db = getDb();
  db.update(executionLogs)
    .set({
      status: input.status,
      output: input.output ?? null,
      error: input.error ?? null,
      log_path: input.log_path ?? null,
      completed_at: input.completed_at ?? nowIso(),
    })
    .where(eq(executionLogs.id, id))
    .run();

  const row = db
    .select()
    .from(executionLogs)
    .where(eq(executionLogs.id, id))
    .get();
  return row ? rowToLog(row) : null;
}

export function getLog(id: string): ExecutionLog | null {
  const db = getDb();
  const row = db
    .select()
    .from(executionLogs)
    .where(eq(executionLogs.id, id))
    .get();
  return row ? rowToLog(row) : null;
}

export function getLogsForTask(taskId: string): ExecutionLog[] {
  const db = getDb();
  const rows = db
    .select()
    .from(executionLogs)
    .where(eq(executionLogs.task_id, taskId))
    .orderBy(desc(executionLogs.started_at))
    .all();
  return rows.map(rowToLog);
}

/* -------------------------------------------------------------------------- */
/*  Single-call `create` adapter — used by io/ingestion.ts                    */
/* -------------------------------------------------------------------------- */

export interface CreateLogInput {
  id?: string;
  task_id: string;
  method: ExecutionMethod;
  status: ExecutionStatus;
  output?: string | null;
  error?: string | null;
  log_path?: string | null;
  started_at?: string;
  completed_at?: string;
}

/**
 * One-shot insert. Convenience for callers (ingestion) that already have a
 * terminal status and don't want to start + complete the row in two calls.
 *
 * Returns the new log id.
 */
export function createLog(input: CreateLogInput): string {
  const db = getDb();
  const id = input.id ?? newId();
  const now = nowIso();
  db.insert(executionLogs)
    .values({
      id,
      task_id: input.task_id,
      started_at: input.started_at ?? now,
      completed_at: input.completed_at ?? now,
      method: input.method,
      status: input.status,
      output: input.output ?? null,
      error: input.error ?? null,
      log_path: input.log_path ?? null,
    })
    .run();
  return id;
}

/* -------------------------------------------------------------------------- */
/*  Namespace object                                                          */
/* -------------------------------------------------------------------------- */

export const executionLogsRepository = {
  startLog,
  completeLog,
  create: createLog,
  get: getLog,
  findById: getLog,
  getForTask: getLogsForTask,
  list: getLogsForTask,
};
