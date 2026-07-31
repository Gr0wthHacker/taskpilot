/**
 * Smart-schedule greedy scheduler tests.
 *
 * The scheduler depends on `getAvailability`, which we mock to return a
 * deterministic pool of slots so the test is independent of the user's clock.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/main/calendar/availability', () => ({
  getAvailability: vi.fn(),
}));

import { getAvailability, type AvailabilitySlot } from '@/main/calendar/availability';
import { proposeSchedule } from '@/main/calendar/smart-schedule';
import type { Task } from '@/shared/types';

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
    agent_executable: true,
    agent_method: 'cli',
    agent_instructions: null,
    agent_status: 'pending',
    context: null,
    tags: [],
    created_at: '2026-05-26T08:00:00Z',
    updated_at: '2026-05-26T08:00:00Z',
  };
  return { ...base, ...overrides };
}

function slot(startIso: string, endIso: string): AvailabilitySlot {
  return { start: startIso, end: endIso };
}

describe('proposeSchedule', () => {
  it('returns [] when given no tasks', async () => {
    expect(await proposeSchedule([])).toEqual([]);
  });

  it('returns [] when no slots are available', async () => {
    vi.mocked(getAvailability).mockResolvedValue([]);
    const task = makeTask({ id: 't1', title: 'lonely' });
    expect(await proposeSchedule([task])).toEqual([]);
  });

  it('assigns highest priority to the earliest slot', async () => {
    // Two 30-min slots, sequential.
    vi.mocked(getAvailability).mockResolvedValue([
      slot('2026-05-26T09:00:00.000Z', '2026-05-26T10:00:00.000Z'),
      slot('2026-05-26T14:00:00.000Z', '2026-05-26T15:00:00.000Z'),
    ]);

    const lowPriority = makeTask({ id: 'low', title: 'low', priority: 'p3' });
    const highPriority = makeTask({ id: 'high', title: 'high', priority: 'p0' });

    const proposals = await proposeSchedule([lowPriority, highPriority]);
    // Output preserves input order.
    expect(proposals).toHaveLength(2);
    const lowProp = proposals.find((p) => p.task_id === 'low');
    const highProp = proposals.find((p) => p.task_id === 'high');
    expect(new Date(highProp!.start).getTime()).toBeLessThan(
      new Date(lowProp!.start).getTime(),
    );
  });

  it('uses context.estimated_minutes to size the slot', async () => {
    vi.mocked(getAvailability).mockResolvedValue([
      slot('2026-05-26T09:00:00.000Z', '2026-05-26T11:00:00.000Z'), // 2h
    ]);
    const task = makeTask({
      id: 't_long',
      title: 'long',
      context: { estimated_minutes: 60 },
    });
    const proposals = await proposeSchedule([task]);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    const durationMin =
      (new Date(p.end).getTime() - new Date(p.start).getTime()) / 60_000;
    expect(durationMin).toBe(60);
  });

  it('falls back to defaultMinutes when no estimate is set', async () => {
    vi.mocked(getAvailability).mockResolvedValue([
      slot('2026-05-26T09:00:00.000Z', '2026-05-26T11:00:00.000Z'),
    ]);
    const task = makeTask({ id: 't_default', title: 't' });
    const proposals = await proposeSchedule([task], { defaultMinutes: 45 });
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    const durationMin =
      (new Date(p.end).getTime() - new Date(p.start).getTime()) / 60_000;
    expect(durationMin).toBe(45);
  });

  it('does not double-book overlapping slots', async () => {
    vi.mocked(getAvailability).mockResolvedValue([
      slot('2026-05-26T09:00:00.000Z', '2026-05-26T11:00:00.000Z'), // 2h
    ]);
    const t1 = makeTask({
      id: 't1',
      title: 't1',
      context: { estimated_minutes: 60 },
    });
    const t2 = makeTask({
      id: 't2',
      title: 't2',
      context: { estimated_minutes: 60 },
    });
    const proposals = await proposeSchedule([t1, t2]);
    expect(proposals).toHaveLength(2);
    // Sort by start and check that the second starts at-or-after the first's end.
    const sorted = proposals.slice().sort((a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime(),
    );
    expect(new Date(sorted[0]!.end).getTime()).toBeLessThanOrEqual(
      new Date(sorted[1]!.start).getTime(),
    );
  });

  it('caps horizon at ABSOLUTE_MAX_HORIZON_DAYS (60)', async () => {
    vi.mocked(getAvailability).mockResolvedValue([]);
    const task = makeTask({ id: 't1', title: 'horizon test' });
    const from = new Date('2026-05-26T00:00:00Z');
    await proposeSchedule([task], { horizonDays: 9999, from });
    // Get the args getAvailability was called with — must NOT span >60 days.
    const calls = vi.mocked(getAvailability).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    if (!lastCall) return;
    const [callFrom, callTo] = lastCall;
    const spanMs = callTo.getTime() - callFrom.getTime();
    const dayMs = 86_400_000;
    expect(Math.round(spanMs / dayMs)).toBeLessThanOrEqual(60);
  });

  it('omits tasks that do not fit in any remaining slot', async () => {
    // A single 60-min slot and two 60-min tasks → only the first fits.
    vi.mocked(getAvailability).mockResolvedValue([
      slot('2026-05-26T09:00:00.000Z', '2026-05-26T10:00:00.000Z'),
    ]);
    const t1 = makeTask({
      id: 't1',
      title: 't1',
      priority: 'p0',
      context: { estimated_minutes: 60 },
    });
    const t2 = makeTask({
      id: 't2',
      title: 't2',
      context: { estimated_minutes: 60 },
    });
    const proposals = await proposeSchedule([t1, t2]);
    expect(proposals.map((p) => p.task_id)).toEqual(['t1']);
  });
});
