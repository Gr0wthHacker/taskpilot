/**
 * `taskpilot cal ...` subcommands.
 *
 * Calendar interactions through the local HTTP API. Times are displayed in the
 * user's local timezone in pretty mode; ISO strings are returned as-is in JSON.
 */

import { Command } from 'commander';
import { apiGet, apiPost } from '../api-client.js';
import { printJson, printTable, pickPretty } from '../format.js';
import type { TableColumn } from '../format.js';

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;             // ISO
  end: string;               // ISO
  description?: string | null;
  attendees?: string[] | null;
  location?: string | null;
}

interface FreeSlot {
  start: string;
  end: string;
  duration_minutes?: number;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parse a duration string. Accepts forms like:
 *   "60m"      → 60
 *   "1h30m"    → 90
 *   "2h"       → 120
 *   "90"       → 90 (bare minutes)
 */
export function parseDurationMinutes(input: string): number {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) throw new Error('Duration cannot be empty');

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

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
  if (!matched) throw new Error(`Could not parse duration "${input}"`);
  return total;
}

function fmtLocalTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function startEndForToday(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

function startEndForWeek(): { from: string; to: string } {
  const now = new Date();
  // ISO week: Monday → Sunday
  const day = now.getDay(); // 0 = Sun, 1 = Mon, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { from: monday.toISOString(), to: sunday.toISOString() };
}

function emitEvents(events: CalendarEvent[]): void {
  if (!pickPretty()) {
    printJson(events);
    return;
  }
  const columns: TableColumn<CalendarEvent>[] = [
    { header: 'START', get: (e) => fmtLocalTime(e.start), width: 22 },
    { header: 'END', get: (e) => fmtLocalTime(e.end), width: 22 },
    { header: 'SUMMARY', get: (e) => e.summary, width: 60 },
  ];
  printTable(events, columns);
}

function emitSlots(slots: FreeSlot[]): void {
  if (!pickPretty()) {
    printJson(slots);
    return;
  }
  const columns: TableColumn<FreeSlot>[] = [
    { header: 'START', get: (s) => fmtLocalTime(s.start), width: 22 },
    { header: 'END', get: (s) => fmtLocalTime(s.end), width: 22 },
    { header: 'MIN', get: (s) => (s.duration_minutes !== undefined ? String(s.duration_minutes) : '-'), width: 6 },
  ];
  printTable(slots, columns);
}

/* -------------------------------------------------------------------------- */
/*  Command registration                                                      */
/* -------------------------------------------------------------------------- */

export function registerCalCommand(program: Command): void {
  const cal = program.command('cal').description('Calendar commands');

  cal
    .command('today')
    .description("Events for today")
    .action(async () => {
      const { from, to } = startEndForToday();
      const res = await apiGet<{ events: CalendarEvent[] } | CalendarEvent[]>(
        '/api/calendar/events',
        { from, to },
      );
      const events = Array.isArray(res) ? res : res.events;
      emitEvents(events);
    });

  cal
    .command('week')
    .description('Events for current ISO week')
    .action(async () => {
      const { from, to } = startEndForWeek();
      const res = await apiGet<{ events: CalendarEvent[] } | CalendarEvent[]>(
        '/api/calendar/events',
        { from, to },
      );
      const events = Array.isArray(res) ? res : res.events;
      emitEvents(events);
    });

  cal
    .command('free')
    .description('Find open slots in the calendar')
    .requiredOption('--duration <duration>', 'Minimum slot length (e.g. 60m, 1h30m, 90)')
    .option('--from <iso>', 'Start of search window (defaults to now)')
    .option('--to <iso>', 'End of search window (defaults to +7 days)')
    .action(async (opts: { duration: string; from?: string; to?: string }) => {
      const minutes = parseDurationMinutes(opts.duration);
      const now = new Date();
      const defaultTo = new Date(now);
      defaultTo.setDate(defaultTo.getDate() + 7);
      const query: Record<string, string | number> = {
        duration: minutes,
        from: opts.from ?? now.toISOString(),
        to: opts.to ?? defaultTo.toISOString(),
      };
      const res = await apiGet<{ windows: FreeSlot[] } | FreeSlot[]>(
        '/api/calendar/availability',
        query,
      );
      const slots = Array.isArray(res) ? res : res.windows;
      emitSlots(slots);
    });

  cal
    .command('add <title>')
    .description('Create a calendar event')
    .requiredOption('--at <iso>', 'Start time (ISO 8601)')
    .requiredOption('--duration <duration>', 'Length (e.g. 60m, 1h30m, 90)')
    .option('--description <text>')
    .option('--attendees <list>', 'Comma-separated emails')
    .action(async (title: string, opts: {
      at: string;
      duration: string;
      description?: string;
      attendees?: string;
    }) => {
      const start = new Date(opts.at);
      if (Number.isNaN(start.getTime())) {
        throw new Error(`Invalid --at value "${opts.at}"`);
      }
      const minutes = parseDurationMinutes(opts.duration);
      const end = new Date(start.getTime() + minutes * 60_000);
      const body: Record<string, unknown> = {
        summary: title,
        start: start.toISOString(),
        end: end.toISOString(),
      };
      if (opts.description) body.description = opts.description;
      if (opts.attendees) {
        body.attendees = opts.attendees.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const res = await apiPost<{ event: CalendarEvent } | CalendarEvent>(
        '/api/calendar/events',
        body,
      );
      const event = 'event' in (res as object)
        ? (res as { event: CalendarEvent }).event
        : (res as CalendarEvent);
      if (pickPretty()) {
        process.stdout.write(`Created event ${event.id}: ${event.summary}\n`);
        process.stdout.write(`  ${fmtLocalTime(event.start)} → ${fmtLocalTime(event.end)}\n`);
      } else {
        printJson(event);
      }
    });

  cal
    .command('sync')
    .description('Trigger a full Google Calendar sync')
    .action(async () => {
      const result = await apiPost<unknown>('/api/calendar/sync');
      if (pickPretty()) {
        process.stdout.write('Calendar sync triggered\n');
      } else {
        printJson(result ?? { ok: true });
      }
    });
}
