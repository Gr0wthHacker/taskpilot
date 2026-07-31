/**
 * Compute free time slots from the user's calendar.
 *
 * Algorithm:
 *   1. Build candidate windows per day inside `[from, to]`, clipped to the
 *      user's configured agent hours (default 9:00 - 18:00 local).
 *   2. Skip weekend days unless the `agent_weekends` setting is true.
 *   3. Pull busy ranges from Google freebusy.
 *   4. Subtract busy ranges from each candidate window.
 *   5. Emit any remaining slot that is at least `durationMinutes` long.
 *
 * "Local" times come from the system clock. Multi-timezone support is
 * deferred — see PRD open questions.
 */

import { get as getSetting } from '@/main/db/repositories/settings';

import { freeBusy } from './google';

export interface AvailabilitySlot {
  start: string; // ISO 8601
  end: string;   // ISO 8601
}

interface AgentHours {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

const DEFAULT_HOURS: AgentHours = { start: '09:00', end: '18:00' };

/* -------------------------------------------------------------------------- */
/*  Settings access                                                           */
/* -------------------------------------------------------------------------- */

function readAgentHours(): AgentHours {
  try {
    const raw = getSetting<unknown>('agent_hours');
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const start = typeof obj.start === 'string' ? obj.start : DEFAULT_HOURS.start;
      const end = typeof obj.end === 'string' ? obj.end : DEFAULT_HOURS.end;
      return { start, end };
    }
  } catch {
    // settings module not booted in some test contexts — fall through to defaults
  }
  return DEFAULT_HOURS;
}

function readAgentWeekends(): boolean {
  try {
    const raw = getSetting<unknown>('agent_weekends');
    if (typeof raw === 'boolean') return raw;
  } catch {
    // ignore
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Time math                                                                 */
/* -------------------------------------------------------------------------- */

function parseHM(input: string, fallback: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback);
  if (!match) return { hour: 9, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number.parseInt(match[1] ?? '9', 10)));
  const minute = Math.min(59, Math.max(0, Number.parseInt(match[2] ?? '0', 10)));
  return { hour, minute };
}

function setLocalTime(date: Date, hour: number, minute: number): Date {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function startOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

interface Range {
  start: Date;
  end: Date;
}

function buildDailyWindows(from: Date, to: Date, hours: AgentHours, includeWeekends: boolean): Range[] {
  const startHm = parseHM(hours.start, DEFAULT_HOURS.start);
  const endHm = parseHM(hours.end, DEFAULT_HOURS.end);

  const windows: Range[] = [];
  let cursor = startOfLocalDay(from);
  const limit = startOfLocalDay(addDays(to, 1));

  while (cursor < limit) {
    if (includeWeekends || !isWeekend(cursor)) {
      const winStart = setLocalTime(cursor, startHm.hour, startHm.minute);
      const winEnd = setLocalTime(cursor, endHm.hour, endHm.minute);
      // Clip to the [from, to] bound.
      const clippedStart = winStart < from ? from : winStart;
      const clippedEnd = winEnd > to ? to : winEnd;
      if (clippedStart < clippedEnd) {
        windows.push({ start: clippedStart, end: clippedEnd });
      }
    }
    cursor = addDays(cursor, 1);
  }
  return windows;
}

function subtractBusy(windows: Range[], busy: Range[]): Range[] {
  // For each window, walk through busy ranges that overlap it and emit
  // the gaps between them.
  const out: Range[] = [];
  const sortedBusy = busy.slice().sort((a, b) => a.start.getTime() - b.start.getTime());

  for (const win of windows) {
    let cursor = win.start;
    for (const b of sortedBusy) {
      if (b.end <= cursor) continue;
      if (b.start >= win.end) break;
      const busyStart = b.start < cursor ? cursor : b.start;
      const busyEnd = b.end > win.end ? win.end : b.end;
      if (busyStart > cursor) {
        out.push({ start: cursor, end: busyStart });
      }
      if (busyEnd > cursor) cursor = busyEnd;
    }
    if (cursor < win.end) {
      out.push({ start: cursor, end: win.end });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Return free slots of at least `durationMinutes` minutes between `from` and
 * `to`, respecting the user's configured working hours and weekend setting.
 */
export async function getAvailability(
  from: Date,
  to: Date,
  durationMinutes: number,
): Promise<AvailabilitySlot[]> {
  if (durationMinutes <= 0) return [];
  if (!(from instanceof Date) || !(to instanceof Date)) return [];
  if (to <= from) return [];

  const hours = readAgentHours();
  const includeWeekends = readAgentWeekends();

  const windows = buildDailyWindows(from, to, hours, includeWeekends);
  if (windows.length === 0) return [];

  const busyIso = await freeBusy(from, to);
  const busy: Range[] = busyIso.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));

  const gaps = subtractBusy(windows, busy);
  const minMs = durationMinutes * 60 * 1_000;

  const out: AvailabilitySlot[] = [];
  for (const gap of gaps) {
    if (gap.end.getTime() - gap.start.getTime() >= minMs) {
      out.push({ start: gap.start.toISOString(), end: gap.end.toISOString() });
    }
  }
  return out;
}
