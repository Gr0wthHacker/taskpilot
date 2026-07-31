/**
 * Convenience wrapper: take a task and either an explicit start time or an
 * "auto-pick" request, and produce a calendar event linked back to the task.
 *
 * Consumers (HTTP layer, MCP tools) call `scheduleTask` rather than wiring
 * `proposeSchedule` + `createEvent` themselves. This keeps the "link a task
 * to my calendar" semantic in one place.
 */

import type { Task } from '@/shared/types';

import { CalendarApiError } from './errors';
import { createEvent, type CalendarEvent } from './google';
import { proposeSchedule } from './smart-schedule';

export interface ScheduleTaskOptions {
  /** Explicit start time. Overrides auto-picking. */
  start?: string | Date;
  /** Duration in minutes. Defaults to 30 (or `context.estimated_minutes`). */
  duration_minutes?: number;
  /** Target calendar. Defaults to the primary calendar. */
  calendar_id?: string;
  /** Override the event title. Defaults to the task title. */
  summary?: string;
  /** Override the event description. Defaults to a task excerpt. */
  description?: string;
}

export interface ScheduleTaskResult {
  event: CalendarEvent;
  start: string;
  end: string;
  /** Convenience link to the event in Google's web UI. */
  calendar_url: string;
}

const DEFAULT_DURATION_MINUTES = 30;

/**
 * Pull a duration from the task's context blob (set by the derivation step)
 * with a hard floor / ceiling. Returns the requested value, then the context
 * value, then the default.
 */
function resolveDurationMinutes(
  task: Task,
  requested: number | undefined,
): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.ceil(requested), 24 * 60);
  }
  const ctx = task.context;
  if (ctx && typeof ctx === 'object') {
    const raw = (ctx as Record<string, unknown>)['estimated_minutes'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.min(Math.ceil(raw), 24 * 60);
    }
  }
  return DEFAULT_DURATION_MINUTES;
}

function toIso(input: string | Date): string {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new CalendarApiError('Invalid start date');
    }
    return input.toISOString();
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new CalendarApiError(`Invalid start date "${input}"`);
  }
  return d.toISOString();
}

/**
 * Build a sensible default description from the task. Pulls the first chunk
 * of the description and links to the TaskPilot task id so the user can
 * trace the event back to the task.
 */
function buildEventDescription(task: Task): string {
  const lines: string[] = [];
  if (task.description) {
    const excerpt = task.description.trim().split('\n').slice(0, 5).join('\n');
    if (excerpt.length > 0) {
      lines.push(excerpt);
      lines.push('');
    }
  }
  lines.push(`TaskPilot task: ${task.id}`);
  return lines.join('\n');
}

/**
 * Build a Google Calendar event link from an event id. Google's web UI
 * accepts the base64url-encoded `<event_id> <calendar_id>` string in the
 * `eid` query param. For non-primary calendars Jack would also need the
 * calendar id encoded in; we punt on that and return the simpler form which
 * works for the primary calendar (the v1 default).
 */
function buildEventUrl(eventId: string): string {
  const eid = Buffer.from(eventId, 'utf8').toString('base64url');
  return `https://calendar.google.com/calendar/event?eid=${eid}`;
}

/**
 * Reserve a calendar slot for the task and link the resulting event back via
 * the `taskpilot_task_id` extended property.
 *
 * Behavior:
 *   - When `options.start` is supplied, use that ± duration.
 *   - Otherwise call `proposeSchedule` and use the first proposal.
 *
 * Throws `CalendarNotConfiguredError` when the OAuth state isn't usable
 * (transparent passthrough from `createEvent`).
 */
export async function scheduleTask(
  task: Task,
  options: ScheduleTaskOptions = {},
): Promise<ScheduleTaskResult> {
  const durationMinutes = resolveDurationMinutes(task, options.duration_minutes);

  let startIso: string;
  let endIso: string;

  if (options.start !== undefined) {
    startIso = toIso(options.start);
    const endMs = new Date(startIso).getTime() + durationMinutes * 60 * 1_000;
    endIso = new Date(endMs).toISOString();
  } else {
    // Auto-pick: thread the requested duration into the task context so
    // `proposeSchedule` picks an appropriately sized slot.
    const overlayTask: Task = {
      ...task,
      context: {
        ...(task.context && typeof task.context === 'object'
          ? (task.context as Record<string, unknown>)
          : {}),
        estimated_minutes: durationMinutes,
      },
    };
    const proposals = await proposeSchedule([overlayTask], {
      defaultMinutes: durationMinutes,
    });
    const first = proposals[0];
    if (!first) {
      throw new CalendarApiError(
        'No availability windows in the next 14 days',
      );
    }
    startIso = first.start;
    endIso = first.end;
  }

  const event = await createEvent(
    {
      summary: options.summary ?? task.title,
      start: startIso,
      end: endIso,
      description: options.description ?? buildEventDescription(task),
      taskId: task.id,
    },
    options.calendar_id ?? 'primary',
  );

  return {
    event,
    start: event.start || startIso,
    end: event.end || endIso,
    calendar_url: buildEventUrl(event.id),
  };
}
