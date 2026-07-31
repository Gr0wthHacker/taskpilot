/**
 * `/api/calendar/...` routes.
 *
 * Wave 2F owns the actual Google Calendar plumbing. We defer-import its module
 * so the API stays usable even when the calendar subsystem hasn't been wired
 * up yet — every endpoint returns a 503 with `code='calendar_not_initialized'`
 * in that case.
 */

import { Router } from 'express';
import { z } from 'zod';

import type {
  AvailabilityResponse,
  AvailabilityWindow,
  CalendarEvent,
  CalendarSyncResponse,
  CreateCalendarEventResponse,
  DeleteCalendarEventResponse,
  ListCalendarEventsResponse,
  UpdateCalendarEventResponse,
} from '@/shared/api-contract';
import { taskIdSchema } from '@/shared/io-schemas';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Soft module loader                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Module surface we'll opportunistically pull off `@/main/calendar/sync` and
 * `@/main/calendar/google`. Everything is optional — handlers below check for
 * the specific function before invoking it.
 */
/**
 * Internal calendar-event shape produced by `@/main/calendar/google.ts`.
 * Has nullable description, full extendedProperties, etc. We normalize it
 * to the wire shape at the route boundary via `toWireEvent()`.
 */
interface InternalCalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: string;
  end: string;
  attendees: string[];
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
  updated?: string | null;
  taskId?: string | null;
}

function toWireEvent(internal: InternalCalendarEvent): CalendarEvent {
  const out: CalendarEvent = {
    id: internal.id,
    summary: internal.summary,
    start: internal.start,
    end: internal.end,
  };
  if (internal.description != null) out.description = internal.description;
  if (internal.attendees && internal.attendees.length > 0) out.attendees = internal.attendees;
  if (internal.taskId != null) out.task_id = internal.taskId;
  return out;
}

interface CalendarModule {
  listEvents?: (from: Date, to: Date) => Promise<InternalCalendarEvent[]>;
  createEvent?: (input: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    attendees?: string[];
    taskId?: string;
  }) => Promise<InternalCalendarEvent>;
  updateEvent?: (
    id: string,
    patch: Partial<{
      summary: string;
      start: string;
      end: string;
      description: string;
      attendees: string[];
    }>,
  ) => Promise<InternalCalendarEvent>;
  deleteEvent?: (id: string) => Promise<void>;
  syncCalendar?: () => Promise<{
    synced: number;
    errors?: Array<{ taskId?: string; eventId?: string; error: string }>;
  }>;
  /**
   * Signature mirrors `getAvailability(from, to, durationMinutes)` in
   * `@/main/calendar/availability` — re-exported there as `findAvailability`.
   * Positional args, NOT an object.
   */
  findAvailability?: (
    from: Date,
    to: Date,
    durationMinutes: number,
  ) => Promise<AvailabilityWindow[]>;
}

const CANDIDATE_SPECIFIERS = [
  '@/main/calendar/sync',
  '@/main/calendar/google',
  '@/main/calendar/index',
] as const;

let cachedMod: CalendarModule | null = null;
let loadAttempted = false;

async function loadCalendarModule(): Promise<CalendarModule | null> {
  if (cachedMod) return cachedMod;
  if (loadAttempted) return null;
  loadAttempted = true;

  const merged: CalendarModule = {};
  for (const specifier of CANDIDATE_SPECIFIERS) {
    try {
      const mod = (await import(specifier)) as unknown;
      if (mod && typeof mod === 'object') {
        const record = mod as Record<string, unknown>;
        if (typeof record['listEvents'] === 'function')
          merged.listEvents = record['listEvents'] as CalendarModule['listEvents'];
        if (typeof record['createEvent'] === 'function')
          merged.createEvent = record['createEvent'] as CalendarModule['createEvent'];
        if (typeof record['updateEvent'] === 'function')
          merged.updateEvent = record['updateEvent'] as CalendarModule['updateEvent'];
        if (typeof record['deleteEvent'] === 'function')
          merged.deleteEvent = record['deleteEvent'] as CalendarModule['deleteEvent'];
        if (typeof record['syncCalendar'] === 'function')
          merged.syncCalendar = record['syncCalendar'] as CalendarModule['syncCalendar'];
        if (typeof record['findAvailability'] === 'function')
          merged.findAvailability = record['findAvailability'] as CalendarModule['findAvailability'];
      }
    } catch {
      // Module not present yet — try the next specifier.
    }
  }

  if (
    !merged.listEvents &&
    !merged.createEvent &&
    !merged.updateEvent &&
    !merged.deleteEvent &&
    !merged.syncCalendar &&
    !merged.findAvailability
  ) {
    return null;
  }
  cachedMod = merged;
  return merged;
}

function calendarNotReady(detail = 'Calendar subsystem has not been initialized'): never {
  throw new ApiHttpError(503, 'calendar_not_initialized', detail);
}

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const listEventsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * Body schema for create-event. Accepts the canonical `task_id` wire field
 * but also tolerates a camelCase `taskId` for older callers — the route
 * normalizes both into the `taskId` form the calendar module expects.
 */
const createEventBodySchema = z
  .object({
    summary: z.string().min(1).max(500),
    start: z.string().min(1).max(64),
    end: z.string().min(1).max(64),
    description: z.string().max(50_000).optional(),
    attendees: z.array(z.string().email()).max(100).optional(),
    task_id: taskIdSchema.nullable().optional(),
    taskId: taskIdSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.task_id != null && value.taskId != null && value.task_id !== value.taskId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task_id and taskId disagree',
        path: ['task_id'],
      });
    }
  });

const updateEventBodySchema = z.object({
  summary: z.string().min(1).max(500).optional(),
  start: z.string().min(1).max(64).optional(),
  end: z.string().min(1).max(64).optional(),
  description: z.string().max(50_000).optional(),
  attendees: z.array(z.string().email()).max(100).optional(),
});

const availabilityQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  duration: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/*  Duration parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Accepts `"60"`, `"60m"`, `"1h30m"`, `"2h"`. Returns minutes.
 *
 * Mirrors `parseDurationMinutes` in `src/cli/commands/cal.ts` so the CLI and
 * API stay symmetric.
 */
function parseDurationMinutes(input: string): number {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new ApiHttpError(400, 'invalid_duration', 'duration cannot be empty');
  }
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

  const re = /(\d+)\s*(h|m|hr|min|hours?|minutes?)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    matched = true;
    const n = Number.parseInt(m[1] ?? '0', 10);
    const unit = m[2] ?? '';
    if (unit.startsWith('h')) total += n * 60;
    else total += n;
  }
  if (!matched) {
    throw new ApiHttpError(400, 'invalid_duration', `Could not parse duration "${input}"`);
  }
  return total;
}

function parseDateOr(input: string | undefined, fallback: Date): Date {
  if (input === undefined) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ApiHttpError(400, 'invalid_date', `Invalid date "${input}"`);
  }
  return d;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function calendarRouter(): Router {
  const router = Router();

  // GET /api/calendar/events -----------------------------------------------
  router.get(
    '/events',
    validateQuery(listEventsQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof listEventsQuerySchema>;
      const now = new Date();
      const defaultTo = new Date(now);
      defaultTo.setDate(defaultTo.getDate() + 7);
      const from = parseDateOr(q.from, now);
      const to = parseDateOr(q.to, defaultTo);

      const mod = await loadCalendarModule();
      if (!mod?.listEvents) calendarNotReady('calendar.listEvents not available');

      const events = (await mod.listEvents(from, to)).map(toWireEvent);
      const body: ListCalendarEventsResponse = { events };
      res.json(body);
    }),
  );

  // POST /api/calendar/events ----------------------------------------------
  router.post(
    '/events',
    validateBody(createEventBodySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof createEventBodySchema>;
      const mod = await loadCalendarModule();
      if (!mod?.createEvent) calendarNotReady('calendar.createEvent not available');

      // Map the wire body to the calendar-module argument shape. The
      // calendar module reads `taskId` (camelCase); the renderer/CLI send
      // `task_id` (snake_case). Either name is accepted on the wire.
      const taskId = input.task_id ?? input.taskId ?? null;
      const createArg: Parameters<NonNullable<CalendarModule['createEvent']>>[0] = {
        summary: input.summary,
        start: input.start,
        end: input.end,
      };
      if (input.description !== undefined) createArg.description = input.description;
      if (input.attendees !== undefined) createArg.attendees = input.attendees;
      if (taskId !== null) createArg.taskId = taskId;

      const event = toWireEvent(await mod.createEvent(createArg));
      const body: CreateCalendarEventResponse = { event };
      res.status(201).json(body);
    }),
  );

  // PATCH /api/calendar/events/:id -----------------------------------------
  router.patch(
    '/events/:id',
    validateBody(updateEventBodySchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const patch = req.body as z.infer<typeof updateEventBodySchema>;
      const mod = await loadCalendarModule();
      if (!mod?.updateEvent) calendarNotReady('calendar.updateEvent not available');
      const event = toWireEvent(await mod.updateEvent(id, patch));
      const body: UpdateCalendarEventResponse = { event };
      res.json(body);
    }),
  );

  // DELETE /api/calendar/events/:id ----------------------------------------
  router.delete(
    '/events/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const mod = await loadCalendarModule();
      if (!mod?.deleteEvent) calendarNotReady('calendar.deleteEvent not available');
      await mod.deleteEvent(id);
      const body: DeleteCalendarEventResponse = { ok: true, id };
      res.json(body);
    }),
  );

  // POST /api/calendar/sync ------------------------------------------------
  router.post(
    '/sync',
    asyncHandler(async (_req, res) => {
      const mod = await loadCalendarModule();
      if (!mod?.syncCalendar) calendarNotReady('calendar.syncCalendar not available');
      const result = await mod.syncCalendar();
      const body: CalendarSyncResponse = {
        ok: true,
        synced: result.synced,
      };
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        body.errors = result.errors as CalendarSyncResponse['errors'];
      }
      res.json(body);
    }),
  );

  // GET /api/calendar/availability -----------------------------------------
  router.get(
    '/availability',
    validateQuery(availabilityQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof availabilityQuerySchema>;
      const now = new Date();
      const defaultTo = new Date(now);
      defaultTo.setDate(defaultTo.getDate() + 7);
      const from = parseDateOr(q.from, now);
      const to = parseDateOr(q.to, defaultTo);
      const durationMinutes = parseDurationMinutes(q.duration);

      const mod = await loadCalendarModule();
      if (!mod?.findAvailability) calendarNotReady('calendar.findAvailability not available');

      // Positional args — the underlying export is
      // `getAvailability(from, to, durationMinutes)`.
      const windows = await mod.findAvailability(from, to, durationMinutes);
      const body: AvailabilityResponse = { windows };
      res.json(body);
    }),
  );

  return router;
}
