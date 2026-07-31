/**
 * Bidirectional sync between TaskPilot tasks (with due dates) and Google
 * Calendar events.
 *
 *   Task -> Calendar: every task with a `due` and (status != done|failed) gets
 *     a calendar event. New tasks get an event created and `calendar_event_id`
 *     written back. Existing-but-changed tasks get their event patched.
 *
 *   Calendar -> Task: events tagged with our `taskpilot_task_id` private
 *     extended property propagate title/time changes back into the task.
 *     Untagged events optionally create inbox tasks if the user opts in via
 *     the `calendar_to_task_import` setting (default false).
 *
 * The sync runs:
 *   - Once on startup (`startCalendarSync`)
 *   - Every 5 minutes via setInterval
 *   - Debounced after any `pipeline_changed` event from the I/O bus
 */

import { addDays } from 'date-fns';

import { ioEvents } from '@/main/io/events';
import * as calendarSyncRepo from '@/main/db/repositories/calendar-sync';
import * as settingsRepo from '@/main/db/repositories/settings';
import * as tasksRepo from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

import { CalendarAuthError, CalendarNotConfiguredError } from './errors';
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  updateEvent,
  type CalendarEvent,
} from './google';
import { isAuthenticated } from './oauth';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SYNC_INTERVAL_MS = 5 * 60 * 1_000;
const DEBOUNCE_MS = 5_000;
const DEFAULT_DURATION_MINUTES = 30;
const FORWARD_LOOKAHEAD_DAYS = 30;
const PRIMARY_CALENDAR = 'primary';

/* -------------------------------------------------------------------------- */
/*  Result shape                                                              */
/* -------------------------------------------------------------------------- */

export interface SyncError {
  taskId?: string;
  eventId?: string;
  error: string;
}

export interface SyncResult {
  synced: number;
  errors: SyncError[];
}

/* -------------------------------------------------------------------------- */
/*  Internal state                                                            */
/* -------------------------------------------------------------------------- */

let intervalHandle: NodeJS.Timeout | null = null;
let debounceHandle: NodeJS.Timeout | null = null;
let running = false;
let pipelineListener: (() => void) | null = null;

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Kick off background sync. Idempotent — repeated calls are no-ops.
 * Does NOT throw if the user hasn't set up OAuth yet; instead, the periodic
 * sync becomes a quiet no-op until credentials appear.
 */
export async function startCalendarSync(): Promise<void> {
  if (intervalHandle !== null) return;

  // Run one sync immediately. Swallow errors so app boot isn't blocked.
  void runSyncSafely('startup');

  intervalHandle = setInterval(() => {
    void runSyncSafely('interval');
  }, SYNC_INTERVAL_MS);

  // Debounce sync on pipeline changes so a flurry of task updates doesn't
  // hammer the Calendar API.
  pipelineListener = (): void => {
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      void runSyncSafely('pipeline_changed');
    }, DEBOUNCE_MS);
  };
  ioEvents.on('pipeline_changed', pipelineListener);
}

export function stopCalendarSync(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle);
    debounceHandle = null;
  }
  if (pipelineListener) {
    ioEvents.off('pipeline_changed', pipelineListener);
    pipelineListener = null;
  }
}

async function runSyncSafely(reason: string): Promise<void> {
  if (running) return; // never overlap a sync
  running = true;
  try {
    if (!(await isAuthenticated())) {
      return; // quiet no-op while user hasn't authenticated
    }
    const result = await fullSync();
    if (result.synced > 0 || result.errors.length > 0) {
      console.log(
        `[calendar/sync] ${reason}: synced=${result.synced} errors=${result.errors.length}`,
      );
      for (const err of result.errors) {
        console.warn('[calendar/sync] error', err);
      }
    }
  } catch (err: unknown) {
    if (err instanceof CalendarNotConfiguredError) {
      // Expected when user hasn't set things up — stay quiet.
      return;
    }
    if (err instanceof CalendarAuthError) {
      // Auth failure (revoked token, refresh denied) — surface so the
      // renderer can prompt a reconnect. Best-effort emit; never throw.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ioEvents } = require('@/main/io/events') as typeof import('@/main/io/events');
        ioEvents.emit('integration_status', {
          integration: 'calendar',
          status: 'disconnected',
          message: err.message,
          at: new Date().toISOString(),
        });
      } catch {
        /* event bus unavailable — keep the original quiet behavior */
      }
      return;
    }
    console.error('[calendar/sync] unexpected:', (err as Error).message);
  } finally {
    running = false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Full sync                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run a complete pass:
 *   - All tasks with a `due` are pushed up (create or update).
 *   - All events for the next 30 days are pulled down (apply to tasks, or
 *     optionally import as inbox tasks).
 */
export async function fullSync(): Promise<SyncResult> {
  const errors: SyncError[] = [];
  let synced = 0;

  // ---- Task -> Calendar ---------------------------------------------------
  const tasks = listDueTasks();
  for (const task of tasks) {
    try {
      const changed = await pushTask(task);
      if (changed) synced += 1;
    } catch (err: unknown) {
      errors.push({ taskId: task.id, error: (err as Error).message });
    }
  }

  // ---- Calendar -> Task ---------------------------------------------------
  const now = new Date();
  const horizon = addDays(now, FORWARD_LOOKAHEAD_DAYS);
  let events: CalendarEvent[] = [];
  try {
    events = await listEvents(now, horizon);
  } catch (err: unknown) {
    errors.push({ error: `listEvents failed: ${(err as Error).message}` });
  }

  const importInbox = readImportInboxSetting();

  for (const event of events) {
    try {
      if (event.taskId) {
        const changed = pullTaggedEvent(event);
        if (changed) synced += 1;
      } else if (importInbox) {
        const created = pullUntaggedEvent(event);
        if (created) synced += 1;
      }
    } catch (err: unknown) {
      errors.push({ eventId: event.id, error: (err as Error).message });
    }
  }

  return { synced, errors };
}

/* -------------------------------------------------------------------------- */
/*  Incremental hooks                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Called after a task changes. Push the change up to Google Calendar.
 * Safe to call when calendar isn't configured (no-op).
 */
export async function taskUpdated(taskId: string): Promise<void> {
  if (!(await isAuthenticated())) return;
  const task = tasksRepo.getTask(taskId);
  if (!task) return;
  try {
    await pushTask(task);
  } catch (err: unknown) {
    console.warn('[calendar/sync] taskUpdated failed', { taskId, error: (err as Error).message });
  }
}

/**
 * Called after a task is deleted. If the task had a linked event, remove it.
 */
export async function taskDeleted(taskId: string): Promise<void> {
  if (!(await isAuthenticated())) return;
  const row = calendarSyncRepo.getByTask(taskId);
  if (!row) return;
  try {
    await deleteEvent(row.event_id, row.calendar_id);
  } catch (err: unknown) {
    console.warn('[calendar/sync] taskDeleted: delete failed', { taskId, error: (err as Error).message });
  }
  calendarSyncRepo.deleteByTask(taskId);
}

/* -------------------------------------------------------------------------- */
/*  Internals: Task -> Calendar                                               */
/* -------------------------------------------------------------------------- */

function listDueTasks(): Task[] {
  // Pull everything once and filter in-memory. Faster than two queries and
  // sidesteps the limit/offset paging concerns for typical task volumes.
  const all = tasksRepo.listTasks({});
  return all.filter(
    (t) => t.due !== null && t.status !== 'done' && t.status !== 'failed',
  );
}

function dueWindow(task: Task): { start: Date; end: Date } | null {
  if (!task.due) return null;
  const start = new Date(task.due);
  if (Number.isNaN(start.getTime())) return null;

  const minutes = readEstimatedMinutes(task);
  const end = new Date(start.getTime() + minutes * 60 * 1_000);
  return { start, end };
}

function readEstimatedMinutes(task: Task): number {
  const ctx = task.context;
  if (ctx && typeof ctx === 'object') {
    const raw = (ctx as Record<string, unknown>)['estimated_minutes'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.ceil(raw);
    }
  }
  return DEFAULT_DURATION_MINUTES;
}

/**
 * Push one task to Calendar. Creates an event if none is linked, updates the
 * existing event otherwise. Returns true if anything was written to Google.
 */
async function pushTask(task: Task): Promise<boolean> {
  const slot = dueWindow(task);
  if (!slot) return false;

  const existingLink = calendarSyncRepo.getByTask(task.id);
  const eventId = task.calendar_event_id ?? existingLink?.event_id ?? null;

  if (!eventId) {
    const created = await createEvent({
      summary: task.title,
      start: slot.start,
      end: slot.end,
      description: task.description ?? undefined,
      taskId: task.id,
    });
    tasksRepo.updateTask(task.id, { calendar_event_id: created.id });
    calendarSyncRepo.upsertSync({
      task_id: task.id,
      event_id: created.id,
      calendar_id: PRIMARY_CALENDAR,
      sync_direction: 'task_to_cal',
    });
    return true;
  }

  // Compare against the stored remote event to avoid no-op patches.
  let remote: CalendarEvent | null = null;
  try {
    remote = await getEvent(eventId);
  } catch {
    remote = null;
  }

  if (!remote) {
    // Event was deleted on the calendar side. Recreate.
    const created = await createEvent({
      summary: task.title,
      start: slot.start,
      end: slot.end,
      description: task.description ?? undefined,
      taskId: task.id,
    });
    tasksRepo.updateTask(task.id, { calendar_event_id: created.id });
    calendarSyncRepo.upsertSync({
      task_id: task.id,
      event_id: created.id,
      calendar_id: PRIMARY_CALENDAR,
      sync_direction: 'task_to_cal',
    });
    return true;
  }

  const needsUpdate =
    remote.summary !== task.title ||
    !sameInstant(remote.start, slot.start) ||
    !sameInstant(remote.end, slot.end) ||
    (remote.description ?? null) !== (task.description ?? null);

  if (!needsUpdate) {
    return false;
  }

  await updateEvent(eventId, {
    summary: task.title,
    start: slot.start,
    end: slot.end,
    description: task.description ?? '',
  });
  calendarSyncRepo.upsertSync({
    task_id: task.id,
    event_id: eventId,
    calendar_id: PRIMARY_CALENDAR,
    sync_direction: 'task_to_cal',
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Internals: Calendar -> Task                                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply a Google Calendar event back to its linked task. Title and due-time
 * changes propagate; status/priority etc. stay TaskPilot-side authoritative.
 *
 * Returns true if the task was updated.
 */
function pullTaggedEvent(event: CalendarEvent): boolean {
  const taskId = event.taskId;
  if (!taskId) return false;
  const task = tasksRepo.getTask(taskId);
  if (!task) return false;

  const remoteStart = event.start || null;

  const titleChanged = event.summary.length > 0 && event.summary !== task.title;
  const dueChanged = remoteStart !== null && !sameInstantStrings(remoteStart, task.due);

  if (!titleChanged && !dueChanged) {
    // Still record that we've seen it so the sync table tracks freshness.
    calendarSyncRepo.upsertSync({
      task_id: task.id,
      event_id: event.id,
      calendar_id: PRIMARY_CALENDAR,
      sync_direction: 'cal_to_task',
    });
    return false;
  }

  const patch: Parameters<typeof tasksRepo.updateTask>[1] = {};
  if (titleChanged) patch.title = event.summary;
  if (dueChanged) patch.due = remoteStart;

  // Ensure the task knows about the event id even if it was created on Google's side.
  if (task.calendar_event_id !== event.id) {
    patch.calendar_event_id = event.id;
  }

  tasksRepo.updateTask(task.id, patch);
  calendarSyncRepo.upsertSync({
    task_id: task.id,
    event_id: event.id,
    calendar_id: PRIMARY_CALENDAR,
    sync_direction: 'cal_to_task',
  });
  return true;
}

/**
 * Optional: turn an untagged calendar event into an inbox task. Idempotent —
 * if a task with this event_id already exists, do nothing.
 *
 * Returns true if a new task was created.
 */
function pullUntaggedEvent(event: CalendarEvent): boolean {
  // De-dup: don't import an event we've already imported.
  const existingLink = calendarSyncRepo.getByEvent(event.id);
  if (existingLink) return false;

  // Don't import all-day or empty-titled events.
  if (!event.summary || event.summary.length === 0) return false;
  if (!event.start) return false;

  const task = tasksRepo.createTask({
    title: event.summary,
    description: event.description,
    status: 'inbox',
    priority: 'p2',
    due: event.start,
    calendar_event_id: event.id,
    tags: ['from-calendar'],
  });

  calendarSyncRepo.upsertSync({
    task_id: task.id,
    event_id: event.id,
    calendar_id: PRIMARY_CALENDAR,
    sync_direction: 'cal_to_task',
  });
  return true;
}

function sameInstant(a: string, b: Date): boolean {
  if (!a) return false;
  const parsed = new Date(a);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() === b.getTime();
}

function sameInstantStrings(a: string, b: string | null): boolean {
  if (b === null) return false;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return false;
  return da === db;
}

function readImportInboxSetting(): boolean {
  try {
    const raw = settingsRepo.get<unknown>('calendar_to_task_import');
    if (typeof raw === 'boolean') return raw;
  } catch {
    // ignore
  }
  return false;
}
