/**
 * MCP tools for the user's Google Calendar.
 *
 * Each tool surfaces the calendar module's public API through MCP, gated by
 * a single auth check: if Calendar isn't configured, we return a structured
 * error so Claude can tell the user to run the OAuth flow instead of letting
 * the underlying googleapis error propagate.
 */

import { z } from 'zod';

import {
  createEvent,
  getAvailability,
  isAuthenticated,
  listEvents,
} from '@/main/calendar';
import { CalendarNotConfiguredError } from '@/main/calendar';
import { taskIdSchema } from '@/shared/io-schemas';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const eventsInput = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  calendar_id: z.string().optional(),
});

const availabilityInput = z.object({
  from: z.string(),
  to: z.string(),
  duration_minutes: z.number(),
});

const createEventInput = z.object({
  summary: z.string().min(1).max(500),
  start: z.string().min(1).max(64),
  end: z.string().min(1).max(64),
  description: z.string().max(50_000).optional(),
  attendees: z.array(z.string().email()).max(100).optional(),
  task_id: taskIdSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function ensureCalendarReady(): Promise<void> {
  let ready = false;
  try {
    ready = await isAuthenticated();
  } catch {
    ready = false;
  }
  if (!ready) {
    throw new CalendarNotConfiguredError(
      'Google Calendar is not configured. Run the OAuth flow from Settings or `taskpilot cal sync` before using calendar tools.',
    );
  }
}

function parseDateOr(input: string | undefined, fallback: Date): Date {
  if (input === undefined) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date "${input}"`);
  }
  return d;
}

function parseDateRequired(input: string, label: string): Date {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${label} date "${input}"`);
  }
  return d;
}

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const eventsTool: McpTool<typeof eventsInput> = {
  name: 'taskpilot_calendar_events',
  description:
    "List events on the user's Google Calendar between `from` and `to` (ISO 8601). Defaults to today through today+7 days when no range is given. Use when the user asks what's on their calendar, what meetings they have today/this week, or when checking schedule before scheduling something new.",
  inputSchema: eventsInput,
  async handler(input) {
    await ensureCalendarReady();
    const now = new Date();
    const defaultTo = new Date(now);
    defaultTo.setDate(defaultTo.getDate() + 7);
    const from = parseDateOr(input.from, now);
    const to = parseDateOr(input.to, defaultTo);
    const events = await listEvents(from, to);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      count: events.length,
      events,
    };
  },
};

const availabilityTool: McpTool<typeof availabilityInput> = {
  name: 'taskpilot_calendar_availability',
  description:
    "Find free time slots on the user's calendar between `from` and `to` (ISO 8601) of at least `duration_minutes` minutes, respecting their configured working hours. Use to answer 'when am I free this week?' or to find a slot before booking a meeting.",
  inputSchema: availabilityInput,
  async handler(input) {
    await ensureCalendarReady();
    const from = parseDateRequired(input.from, 'from');
    const to = parseDateRequired(input.to, 'to');
    if (input.duration_minutes <= 0) {
      throw new Error('duration_minutes must be positive');
    }
    const slots = await getAvailability(from, to, input.duration_minutes);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      duration_minutes: input.duration_minutes,
      count: slots.length,
      slots,
    };
  },
};

const createEventTool: McpTool<typeof createEventInput> = {
  name: 'taskpilot_calendar_create_event',
  description:
    "Create a new event on the user's primary Google Calendar. Use when the user asks to schedule, book, or block off time. Pass `task_id` to link the event back to a TaskPilot task — the link is stored in the event's extended properties and used by the sync subsystem.",
  inputSchema: createEventInput,
  async handler(input) {
    await ensureCalendarReady();
    const event = await createEvent({
      summary: input.summary,
      start: input.start,
      end: input.end,
      ...(input.description !== undefined && { description: input.description }),
      ...(input.attendees !== undefined && { attendees: input.attendees }),
      ...(input.task_id !== undefined && { taskId: input.task_id }),
    });
    return { event };
  },
};

export const calendarTools: McpTool[] = [
  eventsTool as unknown as McpTool,
  availabilityTool as unknown as McpTool,
  createEventTool as unknown as McpTool,
];
