/**
 * Daily plan generator.
 *
 * Synthesizes a structured plan for "today" (or any given date) by pulling:
 *   - Calendar events landing in that day (each → a `meeting` block)
 *   - Tasks due today
 *   - Overdue tasks (due < start-of-today AND status not in {done, failed})
 *   - High-priority queued tasks (p0/p1, status in {inbox, queued})
 *   - Recurrence-triggered tasks (any task whose `due` falls today)
 *
 * The free gaps between meetings get filled by `proposeSchedule()` so the
 * caller sees concrete time-block suggestions for the top tasks. Short
 * `break` blocks are interleaved between long stretches (≥2hr) of work.
 *
 * Calendar failure is non-fatal — the plan still surfaces the task buckets
 * and the markdown notes that calendar data was unavailable.
 */

import { listTasks } from '@/main/db/repositories/tasks';
import type { Task, TaskPriority } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Public shapes                                                             */
/* -------------------------------------------------------------------------- */

export type PlanBlockKind = 'meeting' | 'task' | 'focus' | 'break';

export interface PlanBlock {
  /** ISO 8601 start datetime. */
  start: string;
  /** ISO 8601 end datetime. */
  end: string;
  kind: PlanBlockKind;
  title: string;
  task_id?: string;
  event_id?: string;
  notes?: string;
}

export interface DailyPlan {
  /** YYYY-MM-DD anchor for the plan. */
  date: string;
  /** Ordered (by start) blocks. */
  blocks: PlanBlock[];
  /** Human-readable markdown synthesis of the plan. */
  markdown: string;
  /** Tasks with due < start-of-day and status not in {done, failed}. */
  overdue: Task[];
  /** Tasks whose `due` falls today. */
  due_today: Task[];
  /** P0/P1 queued/inbox tasks (deduped against `due_today` and `overdue`). */
  top_priority: Task[];
}

/* -------------------------------------------------------------------------- */
/*  Internal types                                                            */
/* -------------------------------------------------------------------------- */

/** Subset of a Google Calendar event we actually use here. */
interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function safeParse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

function comparePriority(a: Task, b: Task): number {
  const pa = PRIORITY_ORDER[a.priority] ?? 9;
  const pb = PRIORITY_ORDER[b.priority] ?? 9;
  if (pa !== pb) return pa - pb;
  const da = a.due ?? 'ÿ';
  const db = b.due ?? 'ÿ';
  if (da !== db) return da < db ? -1 : 1;
  return a.created_at < b.created_at ? -1 : 1;
}

function formatTimeRange(start: string, end: string): string {
  const s = safeParse(start);
  const e = safeParse(end);
  if (!s || !e) return `${start} – ${end}`;
  const fmt = (d: Date): string => {
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0
      ? `${h12}:00 ${ampm}`
      : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  };
  return `${fmt(s)} – ${fmt(e)}`;
}

/* -------------------------------------------------------------------------- */
/*  Calendar source (soft-loaded)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Soft-load the calendar module. Returns null when the module itself isn't
 * present; otherwise propagates any real error from `listEvents` (auth
 * failure, network, etc.) so the caller can flag the gap in the plan.
 */
async function loadCalendarEvents(
  from: Date,
  to: Date,
): Promise<CalEvent[] | null> {
  let mod: {
    listEvents?: (from: Date, to: Date) => Promise<
      Array<{ id: string; summary: string; start: string; end: string }>
    >;
  };
  try {
    mod = (await import('@/main/calendar/index')) as typeof mod;
  } catch {
    return null;
  }
  if (typeof mod.listEvents !== 'function') return null;
  const events = await mod.listEvents(from, to);
  return events.map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start,
    end: e.end,
  }));
}

/* -------------------------------------------------------------------------- */
/*  Free-window math                                                          */
/* -------------------------------------------------------------------------- */

interface Window {
  start: Date;
  end: Date;
}

/**
 * Carve out the gaps between meetings inside today's working hours
 * (08:00–18:00). Used to slot tasks into the day without overlapping events.
 */
function computeFreeWindows(day: Date, events: CalEvent[]): Window[] {
  const workStart = new Date(day);
  workStart.setHours(8, 0, 0, 0);
  const workEnd = new Date(day);
  workEnd.setHours(18, 0, 0, 0);

  // Snap event times to the day; clip out anything fully outside the
  // working window.
  const busy: Window[] = [];
  for (const ev of events) {
    const s = safeParse(ev.start);
    const e = safeParse(ev.end);
    if (!s || !e) continue;
    if (e <= workStart || s >= workEnd) continue;
    busy.push({
      start: s < workStart ? new Date(workStart) : s,
      end: e > workEnd ? new Date(workEnd) : e,
    });
  }
  busy.sort((a, b) => a.start.getTime() - b.start.getTime());

  const free: Window[] = [];
  let cursor = workStart;
  for (const b of busy) {
    if (b.start > cursor) {
      free.push({ start: cursor, end: b.start });
    }
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < workEnd) {
    free.push({ start: cursor, end: workEnd });
  }
  return free;
}

/* -------------------------------------------------------------------------- */
/*  Task slotting                                                             */
/* -------------------------------------------------------------------------- */

interface SlotInput {
  task: Task;
  minutes: number;
}

interface SlottedTask {
  task: Task;
  start: Date;
  end: Date;
}

function estimatedMinutes(task: Task, fallback: number): number {
  const ctx = task.context;
  if (ctx && typeof ctx === 'object') {
    const raw = (ctx as Record<string, unknown>)['estimated_minutes'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.ceil(raw);
    }
  }
  return fallback;
}

/**
 * Greedy first-fit slotter — keeps the implementation tiny and the result
 * deterministic. Each task picks the earliest free window large enough for
 * its estimate; the window shrinks by the consumed minutes.
 */
function slotTasksIntoWindows(
  inputs: SlotInput[],
  windows: Window[],
): SlottedTask[] {
  const pool = windows.map((w) => ({ ...w }));
  const out: SlottedTask[] = [];

  for (const { task, minutes } of inputs) {
    const blockMs = minutes * 60 * 1_000;
    let picked = -1;
    for (let i = 0; i < pool.length; i += 1) {
      const w = pool[i];
      if (!w) continue;
      const span = w.end.getTime() - w.start.getTime();
      if (span >= blockMs) {
        picked = i;
        break;
      }
    }
    if (picked === -1) continue;
    const w = pool[picked];
    if (!w) continue;
    const start = new Date(w.start);
    const end = new Date(w.start.getTime() + blockMs);
    out.push({ task, start, end });
    if (end >= w.end) {
      pool.splice(picked, 1);
    } else {
      w.start = end;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Break interleaving                                                        */
/* -------------------------------------------------------------------------- */

const BREAK_MIN_GAP_MS = 2 * 60 * 60 * 1_000; // 2 hours
const BREAK_MINUTES = 15;

/**
 * Walk the sorted blocks and insert a 15-minute `break` block after any
 * single block (or contiguous run of touching blocks) that lasts ≥2 hours,
 * provided there's at least a `BREAK_MINUTES` gap before the next block.
 */
function insertBreaks(blocks: PlanBlock[]): PlanBlock[] {
  const sorted = blocks
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start));

  const out: PlanBlock[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const b = sorted[i];
    if (!b) continue;
    out.push(b);

    if (b.kind === 'break') continue;
    const start = safeParse(b.start);
    const end = safeParse(b.end);
    if (!start || !end) continue;

    const span = end.getTime() - start.getTime();
    if (span < BREAK_MIN_GAP_MS) continue;

    // Find the next non-break block; only insert when there's room.
    let nextIdx = i + 1;
    let next: PlanBlock | undefined;
    while (nextIdx < sorted.length) {
      const candidate = sorted[nextIdx];
      if (candidate && candidate.kind !== 'break') {
        next = candidate;
        break;
      }
      nextIdx += 1;
    }
    const nextStart = next ? safeParse(next.start) : null;
    if (nextStart) {
      const gapMs = nextStart.getTime() - end.getTime();
      if (gapMs < BREAK_MINUTES * 60 * 1_000) continue;
    }

    const breakStart = new Date(end);
    const breakEnd = new Date(end.getTime() + BREAK_MINUTES * 60 * 1_000);
    out.push({
      start: breakStart.toISOString(),
      end: breakEnd.toISOString(),
      kind: 'break',
      title: 'Stretch / coffee',
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Markdown synthesis                                                        */
/* -------------------------------------------------------------------------- */

function priorityLabel(p: TaskPriority): string {
  return p.toUpperCase();
}

function renderMarkdown(args: {
  day: Date;
  blocks: PlanBlock[];
  overdue: Task[];
  dueToday: Task[];
  topPriority: Task[];
  meetingsCount: number;
  calendarAvailable: boolean;
}): string {
  const { day, blocks, overdue, dueToday, topPriority, meetingsCount, calendarAvailable } = args;
  const heading = day.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const lines: string[] = [];
  lines.push(`# ${heading}`);
  lines.push('');

  const summary: string[] = [];
  summary.push(
    meetingsCount === 1
      ? '1 meeting on the calendar'
      : `${meetingsCount} meetings on the calendar`,
  );
  summary.push(
    dueToday.length === 1
      ? '1 task due today'
      : `${dueToday.length} tasks due today`,
  );
  if (overdue.length > 0) {
    summary.push(
      overdue.length === 1
        ? '1 overdue task'
        : `${overdue.length} overdue tasks`,
    );
  }
  lines.push(summary.join(' · '));
  if (!calendarAvailable) {
    lines.push('');
    lines.push(
      '> Calendar is not connected — meetings are not included. Connect Google in Settings → Calendar.',
    );
  }
  lines.push('');

  // Time blocks --------------------------------------------------------
  lines.push('## Schedule');
  lines.push('');
  if (blocks.length === 0) {
    lines.push('_No blocks slotted. Add tasks with estimates or connect your calendar._');
  } else {
    for (const block of blocks) {
      const range = formatTimeRange(block.start, block.end);
      let marker: string;
      switch (block.kind) {
        case 'meeting':
          marker = 'Meeting';
          break;
        case 'task':
          marker = 'Task';
          break;
        case 'focus':
          marker = 'Focus';
          break;
        case 'break':
        default:
          marker = 'Break';
          break;
      }
      lines.push(`- **${range}** — ${marker}: ${block.title}`);
    }
  }
  lines.push('');

  // Overdue ------------------------------------------------------------
  if (overdue.length > 0) {
    lines.push('## Overdue');
    lines.push('');
    for (const t of overdue) {
      const due = t.due ? ` (was due ${t.due.slice(0, 10)})` : '';
      lines.push(`- **${priorityLabel(t.priority)}** ${t.title}${due}`);
    }
    lines.push('');
  }

  // Top priority -------------------------------------------------------
  if (topPriority.length > 0) {
    lines.push('## Top priority');
    lines.push('');
    for (const t of topPriority) {
      lines.push(`- **${priorityLabel(t.priority)}** ${t.title}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/* -------------------------------------------------------------------------- */
/*  Public entry                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Synthesize the daily plan for `date` (defaults to today). Never throws —
 * any failure pulling external state degrades to an empty bucket plus a
 * note in the markdown.
 */
export async function generateTodaysPlan(date?: Date): Promise<DailyPlan> {
  const anchor = date ?? new Date();
  const day = startOfDay(anchor);
  const dayEnd = endOfDay(anchor);

  // ---- Calendar ----
  let events: CalEvent[] = [];
  let calendarAvailable = false;
  try {
    const result = await loadCalendarEvents(day, dayEnd);
    if (result === null) {
      // Calendar module not loaded at all (e.g. tests / unconfigured install).
      events = [];
      calendarAvailable = false;
    } else {
      events = result;
      calendarAvailable = true;
    }
  } catch {
    // Real failure from listEvents (auth, network, etc.). Surface the gap
    // in markdown so the user knows why the plan looks thin.
    events = [];
    calendarAvailable = false;
  }

  // ---- Tasks ----
  // Pull a generous slice. The DB is local and tiny; filtering happens
  // entirely in memory so callers don't have to thread filters per bucket.
  const allTasks = listTasks({ limit: 1_000 });

  const overdue = allTasks
    .filter((t) => {
      if (!t.due) return false;
      if (t.status === 'done' || t.status === 'failed' || t.status === 'archived') {
        return false;
      }
      const due = safeParse(t.due);
      if (!due) return false;
      return due < day;
    })
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));

  const dueToday = allTasks
    .filter((t) => {
      if (!t.due) return false;
      if (t.status === 'archived') return false;
      const due = safeParse(t.due);
      if (!due) return false;
      return isSameDay(due, day);
    })
    .sort(comparePriority);

  // High-priority queued/inbox not already in due-today / overdue.
  const seen = new Set<string>([
    ...overdue.map((t) => t.id),
    ...dueToday.map((t) => t.id),
  ]);
  const topPriority = allTasks
    .filter((t) => {
      if (seen.has(t.id)) return false;
      if (t.priority !== 'p0' && t.priority !== 'p1') return false;
      if (t.status !== 'inbox' && t.status !== 'queued') return false;
      return true;
    })
    .sort(comparePriority);

  // ---- Build blocks ----
  const blocks: PlanBlock[] = [];

  // Meetings.
  for (const ev of events) {
    blocks.push({
      start: ev.start,
      end: ev.end,
      kind: 'meeting',
      title: ev.summary || '(untitled meeting)',
      event_id: ev.id,
    });
  }

  // Task slotting: take the union of overdue + due-today + top-priority,
  // sorted by priority. Slot into free windows between meetings.
  const slotCandidates: SlotInput[] = [];
  const slotSeen = new Set<string>();
  const allCandidates = [...overdue, ...dueToday, ...topPriority];
  allCandidates.sort(comparePriority);
  for (const t of allCandidates) {
    if (slotSeen.has(t.id)) continue;
    slotSeen.add(t.id);
    slotCandidates.push({ task: t, minutes: estimatedMinutes(t, 30) });
  }

  const freeWindows = computeFreeWindows(day, events);
  const slotted = slotTasksIntoWindows(slotCandidates, freeWindows);
  for (const s of slotted) {
    blocks.push({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      kind: 'task',
      title: s.task.title,
      task_id: s.task.id,
    });
  }

  // Sort by start, then thread in breaks where blocks exceed 2hrs.
  const withBreaks = insertBreaks(blocks);

  // ---- Markdown ----
  const markdown = renderMarkdown({
    day,
    blocks: withBreaks,
    overdue,
    dueToday,
    topPriority,
    meetingsCount: events.length,
    calendarAvailable,
  });

  return {
    date: isoDate(day),
    blocks: withBreaks,
    markdown,
    overdue,
    due_today: dueToday,
    top_priority: topPriority,
  };
}

/* -------------------------------------------------------------------------- */
/*  Test exports                                                              */
/* -------------------------------------------------------------------------- */

export const __testing = {
  computeFreeWindows,
  slotTasksIntoWindows,
  insertBreaks,
  estimatedMinutes,
};
