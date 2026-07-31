/**
 * Thin wrapper around `google.calendar('v3')`.
 *
 * Normalizes the noisy Calendar API response shapes into the flat
 * `CalendarEvent` used by the rest of TaskPilot. All functions throw
 * `CalendarApiError` on remote failure and `CalendarNotConfiguredError` /
 * `CalendarAuthError` if the OAuth state isn't usable.
 *
 * v1 always operates on the primary calendar. Multi-calendar support is
 * tracked as a deferred open question in the PRD.
 */

import { google, type calendar_v3 } from 'googleapis';

import { CalendarApiError } from './errors';
import { getOauthClient } from './oauth';

/* -------------------------------------------------------------------------- */
/*  Public shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Marker stored under `extendedProperties.private` so the calendar event can
 * be matched back to a TaskPilot task during reverse sync.
 */
export const TASK_ID_PROP = 'taskpilot_task_id';

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  /** ISO 8601 datetime for the event start (dateTime or date). */
  start: string;
  /** ISO 8601 datetime for the event end (dateTime or date). */
  end: string;
  attendees: string[];
  extendedProperties: {
    private: Record<string, string>;
    shared: Record<string, string>;
  };
  /** ISO 8601 timestamp from the Google response (used for change detection). */
  updated: string | null;
  /** True if this event was created by TaskPilot (has our extended property). */
  taskId: string | null;
}

export interface CreateEventInput {
  summary: string;
  start: Date | string;
  end: Date | string;
  description?: string;
  attendees?: string[];
  taskId?: string;
}

export interface UpdateEventPatch {
  summary?: string;
  start?: Date | string;
  end?: Date | string;
  description?: string;
  attendees?: string[];
}

const DEFAULT_CALENDAR_ID = 'primary';

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

async function getClient(): Promise<calendar_v3.Calendar> {
  const auth = await getOauthClient();
  return google.calendar({ version: 'v3', auth });
}

function toIso(input: Date | string): string {
  if (input instanceof Date) return input.toISOString();
  return input;
}

function normalizeAttendees(input: string[] | undefined): calendar_v3.Schema$EventAttendee[] | undefined {
  if (!input || input.length === 0) return undefined;
  return input.map((email) => ({ email }));
}

function readAttendees(
  attendees: calendar_v3.Schema$EventAttendee[] | undefined,
): string[] {
  if (!attendees) return [];
  return attendees
    .map((a) => a.email)
    .filter((email): email is string => typeof email === 'string' && email.length > 0);
}

function readBoundary(
  point: calendar_v3.Schema$EventDateTime | undefined,
): string {
  if (!point) return '';
  return point.dateTime ?? point.date ?? '';
}

function readExtProps(
  ext: calendar_v3.Schema$Event['extendedProperties'],
): { private: Record<string, string>; shared: Record<string, string> } {
  return {
    private: filterStringRecord(ext?.private),
    shared: filterStringRecord(ext?.shared),
  };
}

function filterStringRecord(
  input: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function normalize(raw: calendar_v3.Schema$Event): CalendarEvent | null {
  if (!raw.id) return null;
  const ext = readExtProps(raw.extendedProperties);
  const taskId = ext.private[TASK_ID_PROP] ?? null;
  return {
    id: raw.id,
    summary: raw.summary ?? '',
    description: raw.description ?? null,
    start: readBoundary(raw.start),
    end: readBoundary(raw.end),
    attendees: readAttendees(raw.attendees ?? undefined),
    extendedProperties: ext,
    updated: raw.updated ?? null,
    taskId,
  };
}

function wrapError(err: unknown, fallback: string): never {
  const e = err as { message?: string; code?: number; response?: { status?: number } };
  const status = e.response?.status ?? (typeof e.code === 'number' ? e.code : undefined);
  const message = e.message ?? fallback;
  throw new CalendarApiError(message, status);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * List events between `from` and `to` (inclusive of `from`, exclusive of `to`).
 *
 * Single events only (recurring events are expanded). Results are sorted by
 * start time ascending.
 */
export async function listEvents(
  from: Date,
  to: Date,
  calendarId: string = DEFAULT_CALENDAR_ID,
): Promise<CalendarEvent[]> {
  const client = await getClient();
  try {
    const response = await client.events.list({
      calendarId,
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2_500,
    });

    const items = response.data.items ?? [];
    const out: CalendarEvent[] = [];
    for (const item of items) {
      const normalized = normalize(item);
      if (normalized) out.push(normalized);
    }
    return out;
  } catch (err: unknown) {
    return wrapError(err, 'listEvents failed');
  }
}

export async function getEvent(
  eventId: string,
  calendarId: string = DEFAULT_CALENDAR_ID,
): Promise<CalendarEvent | null> {
  const client = await getClient();
  try {
    const response = await client.events.get({ calendarId, eventId });
    return normalize(response.data);
  } catch (err: unknown) {
    const e = err as { code?: number; response?: { status?: number } };
    const status = e.response?.status ?? e.code;
    if (status === 404) return null;
    return wrapError(err, 'getEvent failed');
  }
}

export async function createEvent(
  input: CreateEventInput,
  calendarId: string = DEFAULT_CALENDAR_ID,
): Promise<CalendarEvent> {
  const client = await getClient();
  const requestBody: calendar_v3.Schema$Event = {
    summary: input.summary,
    start: { dateTime: toIso(input.start) },
    end: { dateTime: toIso(input.end) },
  };
  if (input.description !== undefined) requestBody.description = input.description;
  const attendees = normalizeAttendees(input.attendees);
  if (attendees !== undefined) requestBody.attendees = attendees;
  if (input.taskId !== undefined) {
    requestBody.extendedProperties = {
      private: { [TASK_ID_PROP]: input.taskId },
    };
  }

  try {
    const response = await client.events.insert({
      calendarId,
      requestBody,
    });
    const normalized = normalize(response.data);
    if (!normalized) {
      throw new CalendarApiError('createEvent: API returned event without id');
    }
    return normalized;
  } catch (err: unknown) {
    if (err instanceof CalendarApiError) throw err;
    return wrapError(err, 'createEvent failed');
  }
}

export async function updateEvent(
  eventId: string,
  patch: UpdateEventPatch,
  calendarId: string = DEFAULT_CALENDAR_ID,
): Promise<CalendarEvent> {
  const client = await getClient();
  const requestBody: calendar_v3.Schema$Event = {};
  if (patch.summary !== undefined) requestBody.summary = patch.summary;
  if (patch.description !== undefined) requestBody.description = patch.description;
  if (patch.start !== undefined) requestBody.start = { dateTime: toIso(patch.start) };
  if (patch.end !== undefined) requestBody.end = { dateTime: toIso(patch.end) };
  if (patch.attendees !== undefined) {
    const attendees = normalizeAttendees(patch.attendees);
    if (attendees !== undefined) requestBody.attendees = attendees;
  }

  try {
    const response = await client.events.patch({
      calendarId,
      eventId,
      requestBody,
    });
    const normalized = normalize(response.data);
    if (!normalized) {
      throw new CalendarApiError('updateEvent: API returned event without id');
    }
    return normalized;
  } catch (err: unknown) {
    if (err instanceof CalendarApiError) throw err;
    return wrapError(err, 'updateEvent failed');
  }
}

export async function deleteEvent(
  eventId: string,
  calendarId: string = DEFAULT_CALENDAR_ID,
): Promise<void> {
  const client = await getClient();
  try {
    await client.events.delete({ calendarId, eventId });
  } catch (err: unknown) {
    const e = err as { code?: number; response?: { status?: number } };
    const status = e.response?.status ?? e.code;
    // Treat already-gone as success — idempotent delete.
    if (status === 404 || status === 410) return;
    return wrapError(err, 'deleteEvent failed');
  }
}

/**
 * Raw freebusy query. Returned ranges are busy windows (ISO 8601 strings).
 * Used by `availability.ts` to compute free slots.
 */
export async function freeBusy(
  from: Date,
  to: Date,
  calendarId: string = DEFAULT_CALENDAR_ID,
): Promise<Array<{ start: string; end: string }>> {
  const client = await getClient();
  try {
    const response = await client.freebusy.query({
      requestBody: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: calendarId }],
      },
    });

    const cal = response.data.calendars?.[calendarId];
    const busy = cal?.busy ?? [];
    const out: Array<{ start: string; end: string }> = [];
    for (const b of busy) {
      if (b.start && b.end) out.push({ start: b.start, end: b.end });
    }
    return out;
  } catch (err: unknown) {
    return wrapError(err, 'freeBusy failed');
  }
}
