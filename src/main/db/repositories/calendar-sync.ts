/**
 * Calendar sync repository.
 *
 * Maps tasks to Google Calendar events. There is at most one event per task
 * (PRIMARY KEY on task_id), so writes are UPSERT-by-task.
 */

import { eq } from 'drizzle-orm';

import { calendarSync } from '../../../shared/schema.js';
import type { CalendarSyncRow, SyncDirection } from '../../../shared/types.js';

import { getDb } from '../index.js';

function nowIso(): string {
  return new Date().toISOString();
}

export interface UpsertSyncInput {
  task_id: string;
  event_id: string;
  calendar_id: string;
  sync_direction: SyncDirection;
  last_synced?: string;
}

/**
 * Insert or update the sync row for a given task. Returns the resulting row.
 */
export function upsertSync(input: UpsertSyncInput): CalendarSyncRow {
  const db = getDb();
  const last_synced = input.last_synced ?? nowIso();

  const existing = db
    .select()
    .from(calendarSync)
    .where(eq(calendarSync.task_id, input.task_id))
    .get();

  if (existing) {
    db.update(calendarSync)
      .set({
        event_id: input.event_id,
        calendar_id: input.calendar_id,
        sync_direction: input.sync_direction,
        last_synced,
      })
      .where(eq(calendarSync.task_id, input.task_id))
      .run();
  } else {
    db.insert(calendarSync)
      .values({
        task_id: input.task_id,
        event_id: input.event_id,
        calendar_id: input.calendar_id,
        sync_direction: input.sync_direction,
        last_synced,
      })
      .run();
  }

  // Type-safe re-read (existing row may have been updated).
  const row = db
    .select()
    .from(calendarSync)
    .where(eq(calendarSync.task_id, input.task_id))
    .get();

  if (!row) {
    throw new Error(`Failed to upsert calendar_sync for task ${input.task_id}`);
  }
  return row;
}

export function getByTask(taskId: string): CalendarSyncRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(calendarSync)
    .where(eq(calendarSync.task_id, taskId))
    .get();
  return row ?? null;
}

export function getByEvent(eventId: string): CalendarSyncRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(calendarSync)
    .where(eq(calendarSync.event_id, eventId))
    .get();
  return row ?? null;
}

export function deleteByTask(taskId: string): boolean {
  const db = getDb();
  const result = db
    .delete(calendarSync)
    .where(eq(calendarSync.task_id, taskId))
    .run();
  return result.changes > 0;
}

export function listAll(): CalendarSyncRow[] {
  const db = getDb();
  return db.select().from(calendarSync).all();
}

/* -------------------------------------------------------------------------- */
/*  Namespace object                                                          */
/* -------------------------------------------------------------------------- */

export const calendarSyncRepository = {
  upsert: upsertSync,
  getByTask,
  getByEvent,
  deleteByTask,
  listAll,
  list: listAll,
};
