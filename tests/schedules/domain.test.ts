/**
 * Recurring schedules — domain tests.
 *
 * Coverage:
 *   - extractGoalRepos pulls `- owner/repo` lines, dedupes, ignores noise
 *   - siteNameFromRepo turns slug → Title Case
 *   - interpolate replaces {token} tokens, leaves unknowns literal
 *   - computeNextFireAt for each kind + interval
 *   - fireSchedule materializes N×M tasks, sets context lineage, advances next_fire_at
 *   - fireSchedule throws with structured error when goal missing / empty
 *   - listDueSchedules respects enabled + next_fire_at
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

mockTaskpilotPaths();

import {
  computeNextFireAt,
  createSchedule,
  deleteSchedule,
  extractGoalRepos,
  fireSchedule,
  interpolate,
  listDueSchedules,
  listSchedules,
  ScheduleFireError,
  siteNameFromRepo,
} from '@/main/schedules';
import { createGoal, deleteGoal } from '@/main/db/repositories/goals';
import { listTasks } from '@/main/db/repositories/tasks';

describe('extractGoalRepos', () => {
  it('pulls `- owner/repo` bullets from description', () => {
    const desc = `Some preamble.

Repos:
- Gr0wthHacker/brooklyn-neuro-guides
- Gr0wthHacker/brooklyn-brain-map
- Gr0wthHacker/care-for-us
`;
    expect(extractGoalRepos(desc)).toEqual([
      'Gr0wthHacker/brooklyn-neuro-guides',
      'Gr0wthHacker/brooklyn-brain-map',
      'Gr0wthHacker/care-for-us',
    ]);
  });

  it('also accepts `* owner/repo`', () => {
    const desc = `* foo/bar\n* baz/qux\n`;
    expect(extractGoalRepos(desc)).toEqual(['foo/bar', 'baz/qux']);
  });

  it('dedupes repeats', () => {
    const desc = `- a/b\n- a/b\n- c/d\n`;
    expect(extractGoalRepos(desc)).toEqual(['a/b', 'c/d']);
  });

  it('ignores random text + malformed lines', () => {
    const desc = `
header
- not-a-repo
- has spaces in/it
- foo/bar
- /missing-owner
- missing-repo/
- actual/match
`;
    expect(extractGoalRepos(desc)).toEqual(['foo/bar', 'actual/match']);
  });

  it('returns [] for null / empty', () => {
    expect(extractGoalRepos(null)).toEqual([]);
    expect(extractGoalRepos('')).toEqual([]);
  });
});

describe('siteNameFromRepo', () => {
  it('titlecases a slug', () => {
    expect(siteNameFromRepo('brooklyn-neuro-guides')).toBe(
      'Brooklyn Neuro Guides',
    );
  });

  it('drops owner prefix', () => {
    expect(siteNameFromRepo('Gr0wthHacker/brooklyn-brain-map')).toBe(
      'Brooklyn Brain Map',
    );
  });

  it('handles underscores too', () => {
    expect(siteNameFromRepo('care_for_us')).toBe('Care For Us');
  });
});

describe('interpolate', () => {
  const ctx = {
    repo: 'org/site-one',
    repo_short: 'site-one',
    site_name: 'Site One',
    date: '2026-05-30',
    schedule_name: 'Sparman weekly',
  };

  it('substitutes known tokens', () => {
    expect(interpolate('Audit {site_name} ({repo_short}) on {date}', ctx)).toBe(
      'Audit Site One (site-one) on 2026-05-30',
    );
  });

  it('leaves unknown tokens literal', () => {
    expect(interpolate('Hello {nope}', ctx)).toBe('Hello {nope}');
  });

  it('handles a template with no tokens', () => {
    expect(interpolate('Plain text', ctx)).toBe('Plain text');
  });
});

describe('computeNextFireAt', () => {
  const base = new Date('2026-05-30T09:00:00Z'); // Saturday

  it('daily advances by N days', () => {
    expect(computeNextFireAt('daily', 1, base).toISOString()).toBe(
      '2026-05-31T09:00:00.000Z',
    );
    expect(computeNextFireAt('daily', 7, base).toISOString()).toBe(
      '2026-06-06T09:00:00.000Z',
    );
  });

  it('weekly advances by N*7 days, preserving weekday', () => {
    const next = computeNextFireAt('weekly', 1, base);
    expect(next.toISOString()).toBe('2026-06-06T09:00:00.000Z');
    expect(next.getUTCDay()).toBe(base.getUTCDay());
  });

  it('monthly clamps overflow day', () => {
    const jan31 = new Date('2026-01-31T09:00:00Z');
    expect(computeNextFireAt('monthly', 1, jan31).toISOString()).toBe(
      '2026-02-28T09:00:00.000Z',
    );
  });

  it('weekdays skips weekends', () => {
    // base = Saturday; next weekday = Monday.
    const next = computeNextFireAt('weekdays', 1, base);
    expect(next.getUTCDay()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  DB-backed: fire flow                                                       */
/* -------------------------------------------------------------------------- */

describe('fireSchedule', () => {
  useMockedDb();

  function makeGoalWithRepos(repos: string[]): string {
    const desc = `Repos:\n${repos.map((r) => `- ${r}`).join('\n')}\n`;
    const goal = createGoal({
      name: 'Test fan-out goal',
      description: desc,
      tags: [],
    });
    return goal.id;
  }

  beforeEach(() => {
    for (const s of listSchedules()) deleteSchedule(s.id);
  });

  it('creates N×M tasks (repos × child templates) with lineage on context', () => {
    const goalId = makeGoalWithRepos([
      'org/site-a',
      'org/site-b',
      'org/site-c',
    ]);
    const schedule = createSchedule({
      name: 'Three-site weekly',
      recurrence_kind: 'weekly',
      recurrence_interval: 1,
      next_fire_at: new Date('2026-05-30T09:00:00Z').toISOString(),
      fan_out_goal_id: goalId,
      child_templates: [
        { title_template: 'Audit {site_name}' },
        { title_template: 'Ideate {site_name}' },
      ],
    });

    const tasksBefore = listTasks({}).length;
    const result = fireSchedule(
      schedule.id,
      new Date('2026-05-30T09:00:00Z'),
    );
    const tasksAfter = listTasks({});

    expect(result.expected_count).toBe(6);
    expect(result.created_task_ids).toHaveLength(6);
    expect(tasksAfter.length - tasksBefore).toBe(6);

    // Spot-check one task: title interpolated, lineage stored on context.
    const created = tasksAfter.filter((t) =>
      result.created_task_ids.includes(t.id),
    );
    const auditA = created.find((t) => t.title === 'Audit Site A');
    expect(auditA).toBeDefined();
    const ctx = (auditA?.context ?? {}) as Record<string, unknown>;
    expect(ctx.schedule_id).toBe(schedule.id);
    expect(ctx.schedule_name).toBe('Three-site weekly');
    expect(ctx.github_repo).toBe('org/site-a');
    expect(ctx.goal_id).toBe(goalId);
    expect(typeof ctx.schedule_fire_at).toBe('string');

    deleteGoal(goalId);
  });

  it('advances next_fire_at past now per the kind/interval', () => {
    const goalId = makeGoalWithRepos(['org/only']);
    const schedule = createSchedule({
      name: 'Daily',
      recurrence_kind: 'daily',
      next_fire_at: new Date('2026-05-30T09:00:00Z').toISOString(),
      fan_out_goal_id: goalId,
      child_templates: [{ title_template: 'Daily for {site_name}' }],
    });
    const result = fireSchedule(
      schedule.id,
      new Date('2026-05-30T09:00:00Z'),
    );
    expect(result.next_fire_at).toBe('2026-05-31T09:00:00.000Z');
    deleteGoal(goalId);
  });

  it('preserves cadence when manually fired off-schedule', () => {
    // Schedule fires Mondays 09:00 UTC. Manual fire on Saturday 20:59 must
    // NOT drift the next fire to Saturday 20:59 — it must stay Monday 09:00
    // (the next Monday after the manual-fire moment).
    const goalId = makeGoalWithRepos(['org/only']);
    const mondayMorning = new Date('2026-06-01T09:00:00Z'); // Monday
    const schedule = createSchedule({
      name: 'Weekly Mondays 9am',
      recurrence_kind: 'weekly',
      next_fire_at: mondayMorning.toISOString(),
      fan_out_goal_id: goalId,
      child_templates: [{ title_template: 'work for {site_name}' }],
    });
    // Fire manually on Saturday 20:59 — well after the scheduled Monday
    // (which hasn't arrived yet in this contrived test, but the principle
    // is the same: anchor on schedule, not on `now`).
    const saturdayLate = new Date('2026-06-06T20:59:00Z');
    const result = fireSchedule(schedule.id, saturdayLate);
    // Next fire should land on Monday 09:00 UTC, one or more weeks out —
    // never on Saturday 20:59.
    const next = new Date(result.next_fire_at);
    expect(next.getUTCDay()).toBe(1); // Monday
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(saturdayLate.getTime());
    deleteGoal(goalId);
  });

  it('converges when next_fire_at is way behind (cumulative misses)', () => {
    const goalId = makeGoalWithRepos(['org/x']);
    // next_fire_at = 100 days ago. After fire, next should be > now.
    const ancient = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const schedule = createSchedule({
      name: 'Catch-up',
      recurrence_kind: 'daily',
      next_fire_at: ancient.toISOString(),
      fan_out_goal_id: goalId,
      child_templates: [{ title_template: 'work {site_name}' }],
    });
    const now = new Date();
    const result = fireSchedule(schedule.id, now);
    expect(new Date(result.next_fire_at).getTime()).toBeGreaterThan(now.getTime());
    // Only ONE batch of children was created (we don't replay every missed day).
    expect(result.created_task_ids).toHaveLength(1);
    deleteGoal(goalId);
  });

  it('with no fan_out_goal_id, creates one task per child template', () => {
    const schedule = createSchedule({
      name: 'No-fanout',
      recurrence_kind: 'weekly',
      next_fire_at: new Date('2026-05-30T09:00:00Z').toISOString(),
      child_templates: [
        { title_template: 'Plain task A' },
        { title_template: 'Plain task B' },
      ],
    });
    const result = fireSchedule(
      schedule.id,
      new Date('2026-05-30T09:00:00Z'),
    );
    expect(result.expected_count).toBe(2);
    expect(result.created_task_ids).toHaveLength(2);
  });

  it('throws ScheduleFireError when fan_out_goal_id points at nothing', () => {
    const schedule = createSchedule({
      name: 'Broken',
      recurrence_kind: 'weekly',
      next_fire_at: new Date('2026-05-30T09:00:00Z').toISOString(),
      fan_out_goal_id: 'ghost000',
      child_templates: [{ title_template: 'x' }],
    });
    expect(() => fireSchedule(schedule.id)).toThrow(ScheduleFireError);
  });

  it('throws ScheduleFireError when goal description has zero repos', () => {
    const goal = createGoal({
      name: 'Empty goal',
      description: 'No repos listed here, sorry.',
      tags: [],
    });
    const schedule = createSchedule({
      name: 'Empty fanout',
      recurrence_kind: 'weekly',
      next_fire_at: new Date('2026-05-30T09:00:00Z').toISOString(),
      fan_out_goal_id: goal.id,
      child_templates: [{ title_template: 'x' }],
    });
    expect(() => fireSchedule(schedule.id)).toThrow(/no parseable/i);
    deleteGoal(goal.id);
  });
});

describe('listDueSchedules', () => {
  useMockedDb();

  beforeEach(() => {
    for (const s of listSchedules()) deleteSchedule(s.id);
  });

  it('returns schedules whose next_fire_at is in the past, and only enabled', () => {
    const past = createSchedule({
      name: 'Past',
      recurrence_kind: 'daily',
      next_fire_at: new Date(Date.now() - 60_000).toISOString(),
      child_templates: [{ title_template: 't' }],
    });
    createSchedule({
      name: 'Future',
      recurrence_kind: 'daily',
      next_fire_at: new Date(Date.now() + 60_000).toISOString(),
      child_templates: [{ title_template: 't' }],
    });
    const disabled = createSchedule({
      name: 'Past-but-disabled',
      enabled: false,
      recurrence_kind: 'daily',
      next_fire_at: new Date(Date.now() - 120_000).toISOString(),
      child_templates: [{ title_template: 't' }],
    });

    const due = listDueSchedules(new Date());
    const ids = due.map((s) => s.id);
    expect(ids).toContain(past.id);
    expect(ids).not.toContain(disabled.id);
    // Future schedule shouldn't be due.
    expect(due.every((s) => new Date(s.next_fire_at) <= new Date())).toBe(true);
  });
});
