/**
 * Recurrence engine tests.
 *
 * The engine itself (`nextOccurrence`, `describeRecurrence`) is pure date
 * math, so most cases run without a DB. `materializeNextOccurrence` reaches
 * into the tasks repository — those tests use the same in-memory DB mock as
 * the other repo tests.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import {
  describeRecurrence,
  materializeNextOccurrence,
  nextOccurrence,
} from '@/main/recurrence';
import { createTask, getChildren, getTask, listTasks } from '@/main/db/repositories/tasks';
import type { RecurrenceRule } from '@/shared/types';

function utc(iso: string): Date {
  return new Date(iso);
}

describe('nextOccurrence', () => {
  describe('daily', () => {
    it('advances by one day with interval 1', () => {
      const next = nextOccurrence(
        { kind: 'daily' },
        utc('2026-05-01T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-05-02T09:00:00.000Z');
    });

    it('advances by N days with interval N', () => {
      const next = nextOccurrence(
        { kind: 'daily', interval: 3 },
        utc('2026-05-01T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-05-04T09:00:00.000Z');
    });

    it('treats interval 0 or negative as 1', () => {
      const next = nextOccurrence(
        { kind: 'daily', interval: 0 },
        utc('2026-05-01T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-05-02T09:00:00.000Z');
    });
  });

  describe('weekdays', () => {
    it('Friday → Monday (skipping the weekend)', () => {
      // 2026-05-01 is a Friday in UTC.
      const next = nextOccurrence(
        { kind: 'weekdays' },
        utc('2026-05-01T09:00:00.000Z'),
      );
      // Next weekday is Monday 2026-05-04.
      expect(next?.toISOString()).toBe('2026-05-04T09:00:00.000Z');
    });

    it('Monday → Tuesday', () => {
      // 2026-05-04 = Monday.
      const next = nextOccurrence(
        { kind: 'weekdays' },
        utc('2026-05-04T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-05-05T09:00:00.000Z');
    });

    it('interval 2 counts only weekdays', () => {
      // From Monday: +2 weekdays = Wednesday.
      const next = nextOccurrence(
        { kind: 'weekdays', interval: 2 },
        utc('2026-05-04T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-05-06T09:00:00.000Z');
    });
  });

  describe('weekly', () => {
    it('advances exactly 7 days', () => {
      const next = nextOccurrence(
        { kind: 'weekly' },
        utc('2026-05-01T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-05-08T09:00:00.000Z');
    });

    it('interval 2 = every other week', () => {
      const next = nextOccurrence(
        { kind: 'weekly', interval: 2 },
        utc('2026-05-01T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-05-15T09:00:00.000Z');
    });
  });

  describe('monthly', () => {
    it('advances by one calendar month', () => {
      const next = nextOccurrence(
        { kind: 'monthly' },
        utc('2026-05-15T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-06-15T09:00:00.000Z');
    });

    it('interval 2', () => {
      const next = nextOccurrence(
        { kind: 'monthly', interval: 2 },
        utc('2026-01-15T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2026-03-15T09:00:00.000Z');
    });

    it('clamps day-of-month at month end (Jan 31 → Feb 28)', () => {
      const next = nextOccurrence(
        { kind: 'monthly' },
        utc('2026-01-31T09:00:00.000Z'),
      );
      // 2026 is not a leap year — Feb has 28 days.
      expect(next?.toISOString()).toBe('2026-02-28T09:00:00.000Z');
    });

    it('clamps at leap-year Feb 29', () => {
      const next = nextOccurrence(
        { kind: 'monthly' },
        utc('2028-01-31T09:00:00.000Z'),
      );
      expect(next?.toISOString()).toBe('2028-02-29T09:00:00.000Z');
    });
  });

  describe('termination', () => {
    it('returns null when end_after_count has been reached', () => {
      const rule: RecurrenceRule = {
        kind: 'daily',
        end_after_count: 3,
        occurrences_completed: 3,
      };
      expect(nextOccurrence(rule, utc('2026-05-01T09:00:00.000Z'))).toBeNull();
    });

    it('still fires while count < limit', () => {
      const rule: RecurrenceRule = {
        kind: 'daily',
        end_after_count: 3,
        occurrences_completed: 2,
      };
      expect(
        nextOccurrence(rule, utc('2026-05-01T09:00:00.000Z')),
      ).not.toBeNull();
    });

    it('returns null when next would exceed end_on', () => {
      const rule: RecurrenceRule = {
        kind: 'daily',
        end_on: '2026-05-02T08:59:00.000Z',
      };
      // From 09:00 on May 1, next is 09:00 May 2 — past 08:59 May 2.
      expect(nextOccurrence(rule, utc('2026-05-01T09:00:00.000Z'))).toBeNull();
    });

    it('fires when end_on is in the future', () => {
      const rule: RecurrenceRule = {
        kind: 'daily',
        end_on: '2026-12-31T00:00:00.000Z',
      };
      expect(
        nextOccurrence(rule, utc('2026-05-01T09:00:00.000Z')),
      ).not.toBeNull();
    });
  });

  describe('invalid input', () => {
    it('returns null for unknown kind', () => {
      const rule = { kind: 'yearly' } as unknown as RecurrenceRule;
      expect(nextOccurrence(rule, utc('2026-05-01T09:00:00.000Z'))).toBeNull();
    });

    it('returns null for invalid from date', () => {
      expect(
        nextOccurrence({ kind: 'daily' }, new Date('not a date')),
      ).toBeNull();
    });
  });
});

describe('describeRecurrence', () => {
  it('summarizes basic kinds', () => {
    expect(describeRecurrence({ kind: 'daily' })).toBe('daily');
    expect(describeRecurrence({ kind: 'weekly' })).toBe('weekly');
    expect(describeRecurrence({ kind: 'monthly' })).toBe('monthly');
    expect(describeRecurrence({ kind: 'weekdays' })).toBe('every weekday');
  });

  it('summarizes intervals', () => {
    expect(describeRecurrence({ kind: 'daily', interval: 2 })).toBe(
      'every 2 days',
    );
    expect(describeRecurrence({ kind: 'weekly', interval: 3 })).toBe(
      'every 3 weeks',
    );
  });

  it('appends end_after_count', () => {
    expect(
      describeRecurrence({ kind: 'daily', end_after_count: 5 }),
    ).toContain('5 occurrences');
  });

  it('handles null', () => {
    expect(describeRecurrence(null)).toBe('');
  });
});

describe('materializeNextOccurrence', () => {
  useMockedDb();

  it('returns null when the task has no recurrence', () => {
    const task = createTask({ title: 'one-off' });
    expect(materializeNextOccurrence(task.id)).toBeNull();
  });

  it('returns null when the task does not exist', () => {
    expect(materializeNextOccurrence('does-not-exist')).toBeNull();
  });

  it('creates a child task with the next due date and incremented count', () => {
    const task = createTask({
      title: 'Daily standup',
      due: '2026-05-01T09:00:00.000Z',
      priority: 'p1',
      tags: ['ops'],
      context: {
        recurrence: { kind: 'daily', occurrences_completed: 0 },
      },
    });

    const next = materializeNextOccurrence(task.id);
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(task.id);
    expect(next!.title).toBe('Daily standup');
    expect(next!.priority).toBe('p1');
    expect(next!.tags).toEqual(['ops']);
    expect(next!.due).toBe('2026-05-02T09:00:00.000Z');
    expect(next!.status).toBe('inbox');

    // The rule's occurrences_completed should have ticked up.
    const ctx = next!.context as Record<string, unknown> | null;
    const rule = ctx?.['recurrence'] as RecurrenceRule | undefined;
    expect(rule?.occurrences_completed).toBe(1);
    // And it back-links to the source.
    expect(ctx?.['recurrence_parent_id']).toBe(task.id);

    // Both tasks now exist (source is still untouched here — caller decides
    // whether to mark it done; we only create the next).
    expect(listTasks()).toHaveLength(2);
  });

  it('preserves null due on the child when the source had no due', () => {
    const task = createTask({
      title: 'Untimed recurring',
      context: { recurrence: { kind: 'daily' } },
    });
    const next = materializeNextOccurrence(task.id);
    expect(next).not.toBeNull();
    expect(next!.due).toBeNull();
  });

  it('returns null when the rule has reached its count limit', () => {
    const task = createTask({
      title: 'Done after 2',
      due: '2026-05-01T09:00:00.000Z',
      context: {
        recurrence: {
          kind: 'daily',
          end_after_count: 2,
          occurrences_completed: 2,
        },
      },
    });
    expect(materializeNextOccurrence(task.id)).toBeNull();
  });

  it('auto-fires when a recurring task is marked done via updateTask', async () => {
    const { updateTask } = await import('@/main/db/repositories/tasks');
    const task = createTask({
      title: 'auto-chain',
      due: '2026-05-01T09:00:00.000Z',
      context: { recurrence: { kind: 'daily' } },
    });
    expect(listTasks()).toHaveLength(1);
    updateTask(task.id, { status: 'done' });
    // Original is now done; a child exists with the next due.
    const all = listTasks();
    expect(all.length).toBe(2);
    const child = all.find((t) => t.id !== task.id);
    expect(child?.due).toBe('2026-05-02T09:00:00.000Z');
    expect(child?.status).toBe('inbox');
    // Source task untouched aside from the status flip.
    const refreshed = getTask(task.id);
    expect(refreshed?.status).toBe('done');
    // Children relationship is NOT set — recurrence children are independent
    // (linked via context.recurrence_parent_id, not parent_id).
    expect(getChildren(task.id)).toHaveLength(0);
  });
});
