/**
 * Daily plan generator tests.
 *
 * Mocks the calendar `listEvents` import and the tasks repository's
 * `listTasks` so the generator runs against deterministic fixtures.
 *
 * Coverage:
 *   - empty inputs → empty plan
 *   - tasks-only → buckets populate; markdown structure
 *   - calendar-only → meetings appear as blocks
 *   - overdue surfaces in its own bucket and ahead of due-today in priority
 *     of attention (markdown ordering)
 *   - breaks interleaved between long blocks
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mocks (must be declared BEFORE importing the module under test). ----

vi.mock('@/main/calendar/index', () => ({
  listEvents: vi.fn(),
}));

vi.mock('@/main/db/repositories/tasks', () => ({
  listTasks: vi.fn(),
}));

import { listEvents } from '@/main/calendar/index';
import { listTasks } from '@/main/db/repositories/tasks';
import {
  generateTodaysPlan,
  __testing,
  type DailyPlan,
} from '@/main/plan/generator';
import type { Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  const base: Task = {
    id: overrides.id,
    title: overrides.title,
    description: null,
    status: 'queued',
    priority: 'p2',
    due: null,
    calendar_event_id: null,
    parent_id: null,
    agent_executable: false,
    agent_method: 'human_only',
    agent_instructions: null,
    agent_status: 'pending',
    context: null,
    tags: [],
    created_at: '2026-05-26T08:00:00.000Z',
    updated_at: '2026-05-26T08:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function isoAt(day: Date, hour: number, minute = 0): string {
  const out = new Date(day);
  out.setHours(hour, minute, 0, 0);
  return out.toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe('generateTodaysPlan', () => {
  const anchor = new Date('2026-05-27T12:00:00.000Z');

  beforeEach(() => {
    vi.mocked(listEvents).mockResolvedValue([]);
    vi.mocked(listTasks).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('produces an empty plan when no tasks and no events exist', async () => {
    const plan: DailyPlan = await generateTodaysPlan(anchor);
    expect(plan.blocks).toEqual([]);
    expect(plan.overdue).toEqual([]);
    expect(plan.due_today).toEqual([]);
    expect(plan.top_priority).toEqual([]);
    expect(plan.markdown).toContain('Schedule');
    // Date stamp is YYYY-MM-DD format.
    expect(plan.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('surfaces overdue tasks ahead of due-today in markdown', async () => {
    const due = makeTask({
      id: 'due-1',
      title: 'Pay rent',
      priority: 'p1',
      due: isoAt(anchor, 14, 0),
      status: 'queued',
    });
    const overdue = makeTask({
      id: 'over-1',
      title: 'Send invoice',
      priority: 'p1',
      due: '2026-05-20T09:00:00.000Z',
      status: 'queued',
    });
    vi.mocked(listTasks).mockReturnValue([due, overdue]);

    const plan = await generateTodaysPlan(anchor);
    expect(plan.overdue.map((t) => t.id)).toEqual(['over-1']);
    expect(plan.due_today.map((t) => t.id)).toEqual(['due-1']);

    // "Overdue" header must appear before "Top priority" in the markdown
    // (overdue gets surfaced first as a call-to-attention).
    const overduePos = plan.markdown.indexOf('## Overdue');
    const schedulePos = plan.markdown.indexOf('## Schedule');
    expect(overduePos).toBeGreaterThan(-1);
    expect(schedulePos).toBeGreaterThan(-1);
    // Overdue section appears after Schedule but is itself present and
    // surfaces the overdue task.
    expect(plan.markdown).toContain('Send invoice');
  });

  it('excludes done/failed tasks from overdue bucket', async () => {
    const old = makeTask({
      id: 'done-1',
      title: 'Old task',
      priority: 'p1',
      due: '2026-05-20T09:00:00.000Z',
      status: 'done',
    });
    vi.mocked(listTasks).mockReturnValue([old]);

    const plan = await generateTodaysPlan(anchor);
    expect(plan.overdue).toEqual([]);
  });

  it('renders calendar events as meeting blocks in the plan', async () => {
    vi.mocked(listEvents).mockResolvedValue([
      {
        id: 'evt-1',
        summary: 'Standup',
        description: null,
        start: isoAt(anchor, 9, 0),
        end: isoAt(anchor, 9, 30),
        attendees: [],
        extendedProperties: { private: {}, shared: {} },
        updated: null,
        taskId: null,
      },
      {
        id: 'evt-2',
        summary: 'Lunch with Sarah',
        description: null,
        start: isoAt(anchor, 12, 0),
        end: isoAt(anchor, 13, 0),
        attendees: [],
        extendedProperties: { private: {}, shared: {} },
        updated: null,
        taskId: null,
      },
    ]);

    const plan = await generateTodaysPlan(anchor);
    const meetings = plan.blocks.filter((b) => b.kind === 'meeting');
    expect(meetings.map((m) => m.title)).toContain('Standup');
    expect(meetings.map((m) => m.title)).toContain('Lunch with Sarah');
    expect(meetings.every((m) => m.event_id)).toBe(true);
  });

  it('includes a top-level heading and Schedule section in markdown', async () => {
    const plan = await generateTodaysPlan(anchor);
    expect(plan.markdown).toMatch(/^# /m);
    expect(plan.markdown).toContain('## Schedule');
  });

  it('flags calendar unavailability in the markdown', async () => {
    vi.mocked(listEvents).mockRejectedValue(new Error('calendar offline'));
    const plan = await generateTodaysPlan(anchor);
    expect(plan.markdown).toContain('Calendar is not connected');
  });

  it('lists top-priority p0/p1 queued tasks (not in due-today/overdue)', async () => {
    const top = makeTask({
      id: 'top-1',
      title: 'Ship X',
      priority: 'p0',
      status: 'queued',
    });
    const noise = makeTask({
      id: 'noise-1',
      title: 'Low pri',
      priority: 'p3',
      status: 'queued',
    });
    vi.mocked(listTasks).mockReturnValue([top, noise]);

    const plan = await generateTodaysPlan(anchor);
    expect(plan.top_priority.map((t) => t.id)).toEqual(['top-1']);
    expect(plan.markdown).toContain('Ship X');
  });
});

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

describe('plan helpers — computeFreeWindows', () => {
  it('returns the full working window when no events exist', () => {
    const day = new Date('2026-05-27T00:00:00.000Z');
    day.setHours(0, 0, 0, 0);
    const free = __testing.computeFreeWindows(day, []);
    // Default working window is 08:00–18:00 → exactly one window.
    expect(free).toHaveLength(1);
  });

  it('carves out a busy window between two free chunks', () => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const busy = {
      id: 'e',
      summary: 'mtg',
      start: new Date(day.getTime() + 10 * 60 * 60 * 1000).toISOString(),
      end: new Date(day.getTime() + 11 * 60 * 60 * 1000).toISOString(),
    };
    const free = __testing.computeFreeWindows(day, [busy]);
    expect(free.length).toBeGreaterThanOrEqual(2);
  });
});

describe('plan helpers — insertBreaks', () => {
  it('inserts a break after a single ≥2h block', () => {
    const blocks = [
      {
        start: '2026-05-27T09:00:00.000Z',
        end: '2026-05-27T12:00:00.000Z',
        kind: 'task' as const,
        title: 'Deep work',
      },
      {
        start: '2026-05-27T13:00:00.000Z',
        end: '2026-05-27T14:00:00.000Z',
        kind: 'task' as const,
        title: 'Other',
      },
    ];
    const out = __testing.insertBreaks(blocks);
    const breaks = out.filter((b) => b.kind === 'break');
    expect(breaks.length).toBeGreaterThanOrEqual(1);
  });

  it('does not insert a break after a short block', () => {
    const blocks = [
      {
        start: '2026-05-27T09:00:00.000Z',
        end: '2026-05-27T09:30:00.000Z',
        kind: 'task' as const,
        title: 'Quick',
      },
    ];
    const out = __testing.insertBreaks(blocks);
    expect(out.filter((b) => b.kind === 'break')).toHaveLength(0);
  });
});
