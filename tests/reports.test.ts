/**
 * Reports aggregation tests.
 *
 * Seeds an in-memory DB with tasks across days, priorities, statuses, and
 * tags, then exercises each aggregation function in isolation. Tests
 * deliberately avoid Date.now() mocking — instead they create tasks whose
 * `created_at` / `updated_at` are set explicitly relative to NOW so the
 * windowed queries pick them up regardless of when the test runs.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import { getSqlite } from '@/main/db';
import { createTask } from '@/main/db/repositories/tasks';
import { createLog } from '@/main/db/repositories/execution-logs';
import {
  __internals,
  agentSuccessRate,
  recentFailures,
  reportBundle,
  reviewQueueTrend,
  tagHeatMap,
  throughput,
  timeToDoneByPriority,
  timeToDoneByTag,
} from '@/main/reports/aggregations';
import type { Task, TaskPriority, TaskStatus } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function isoDaysAgo(days: number, extraMs = 0): string {
  return new Date(Date.now() - days * DAY_MS + extraMs).toISOString();
}

/**
 * Insert a task with explicit `created_at` / `updated_at`. `updateTask`
 * bumps `updated_at` to NOW on every call, so we rewrite both timestamps
 * via raw SQL after the repo insert.
 */
function seedTaskExact(opts: {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  agent_status?: 'pending' | 'needs_review' | 'succeeded' | 'failed';
  agent_executable?: boolean;
  createdAt: string;
  updatedAt: string;
}): Task {
  // Use the repo to insert (which fires triggers, etc.), then directly
  // rewrite updated_at via raw SQL. The repo accepts both timestamps as
  // overrides on create, but updates bump updated_at.
  const task = createTask({
    title: opts.title,
    status: opts.status ?? 'inbox',
    priority: opts.priority ?? 'p2',
    tags: opts.tags ?? [],
    agent_executable: opts.agent_executable ?? false,
    agent_status: opts.agent_status ?? 'pending',
    created_at: opts.createdAt,
    updated_at: opts.updatedAt,
  });
  // The create path honors created_at/updated_at on insert, but defensive
  // tests still rewrite both timestamps via raw SQL so any future repo
  // changes can't drift the timeline silently.
  getSqlite()
    .prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?')
    .run(opts.createdAt, opts.updatedAt, task.id);
  return { ...task, created_at: opts.createdAt, updated_at: opts.updatedAt };
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

describe('reports internals — median', () => {
  it('returns null for an empty array', () => {
    expect(__internals.median([])).toBeNull();
  });
  it('returns the middle element for odd-length arrays', () => {
    expect(__internals.median([5, 1, 3])).toBe(3);
  });
  it('returns the average of the two middle elements for even arrays', () => {
    expect(__internals.median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('reports internals — utcDateKey', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    const d = new Date('2026-05-27T03:00:00.000Z');
    expect(__internals.utcDateKey(d)).toBe('2026-05-27');
  });
});

describe('reports internals — windowCutoffIso', () => {
  it('returns null for "all"', () => {
    expect(__internals.windowCutoffIso('all')).toBeNull();
  });
  it('returns an iso roughly N days ago for "7d"', () => {
    const iso = __internals.windowCutoffIso('7d');
    expect(iso).not.toBeNull();
    const diff = Date.now() - new Date(iso!).getTime();
    expect(Math.abs(diff - 7 * DAY_MS)).toBeLessThan(60_000);
  });
});

/* -------------------------------------------------------------------------- */
/*  throughput                                                                */
/* -------------------------------------------------------------------------- */

describe('throughput', () => {
  useMockedDb();

  it('returns exactly `days` contiguous points, oldest first', () => {
    const points = throughput(7);
    expect(points).toHaveLength(7);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.date.localeCompare(points[i - 1]!.date)).toBeGreaterThan(0);
    }
  });

  it('counts closures by updated_at date', () => {
    seedTaskExact({
      title: 'closed-today',
      status: 'done',
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(0, 60_000), // just now-ish
    });
    seedTaskExact({
      title: 'closed-yesterday',
      status: 'done',
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(1),
    });
    seedTaskExact({
      title: 'failed-yesterday',
      status: 'failed',
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(1),
    });
    seedTaskExact({
      title: 'still-open',
      status: 'queued',
      createdAt: isoDaysAgo(2),
      updatedAt: isoDaysAgo(2),
    });

    const points = throughput(7);
    const total = points.reduce((sum, p) => sum + p.closed, 0);
    expect(total).toBe(3); // 1 done today + 1 done yesterday + 1 failed yesterday
  });

  it('excludes closures outside the window', () => {
    seedTaskExact({
      title: 'closed-long-ago',
      status: 'done',
      createdAt: isoDaysAgo(120),
      updatedAt: isoDaysAgo(60),
    });
    const points = throughput(7);
    const total = points.reduce((sum, p) => sum + p.closed, 0);
    expect(total).toBe(0);
  });

  it('still returns a contiguous timeline when nothing closed', () => {
    const points = throughput(5);
    expect(points).toHaveLength(5);
    expect(points.every((p) => p.closed === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  agentSuccessRate                                                          */
/* -------------------------------------------------------------------------- */

describe('agentSuccessRate', () => {
  useMockedDb();

  it('returns zeros when no logs exist', () => {
    const rate = agentSuccessRate('30d');
    expect(rate).toEqual({
      succeeded: 0,
      failed: 0,
      needs_review: 0,
      total: 0,
    });
  });

  it('counts succeeded/failed/needs_review correctly', () => {
    const task = seedTaskExact({
      title: 'agent-task',
      status: 'queued',
      agent_executable: true,
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(5),
    });
    createLog({
      task_id: task.id,
      method: 'cli',
      status: 'succeeded',
      started_at: isoDaysAgo(2),
      completed_at: isoDaysAgo(2),
    });
    createLog({
      task_id: task.id,
      method: 'cli',
      status: 'succeeded',
      started_at: isoDaysAgo(1),
      completed_at: isoDaysAgo(1),
    });
    createLog({
      task_id: task.id,
      method: 'cli',
      status: 'failed',
      started_at: isoDaysAgo(1),
      completed_at: isoDaysAgo(1),
    });
    createLog({
      task_id: task.id,
      method: 'cowork',
      status: 'needs_review',
      started_at: isoDaysAgo(1),
      completed_at: isoDaysAgo(1),
    });

    const rate = agentSuccessRate('30d');
    expect(rate.succeeded).toBe(2);
    expect(rate.failed).toBe(1);
    expect(rate.needs_review).toBe(1);
    expect(rate.total).toBe(4);
  });

  it('excludes logs from non-agent-executable tasks', () => {
    const task = seedTaskExact({
      title: 'human-only',
      status: 'queued',
      agent_executable: false,
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(5),
    });
    createLog({
      task_id: task.id,
      method: 'cli',
      status: 'succeeded',
      started_at: isoDaysAgo(1),
      completed_at: isoDaysAgo(1),
    });
    const rate = agentSuccessRate('30d');
    expect(rate.total).toBe(0);
  });

  it('excludes logs outside the window', () => {
    const task = seedTaskExact({
      title: 'agent-task',
      agent_executable: true,
      createdAt: isoDaysAgo(120),
      updatedAt: isoDaysAgo(120),
    });
    createLog({
      task_id: task.id,
      method: 'cli',
      status: 'succeeded',
      started_at: isoDaysAgo(60),
      completed_at: isoDaysAgo(60),
    });
    const rate = agentSuccessRate('30d');
    expect(rate.total).toBe(0);

    const all = agentSuccessRate('all');
    expect(all.total).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  timeToDoneByPriority                                                       */
/* -------------------------------------------------------------------------- */

describe('timeToDoneByPriority', () => {
  useMockedDb();

  it('returns null medians and zero counts when no tasks are done', () => {
    const result = timeToDoneByPriority('30d');
    for (const p of ['p0', 'p1', 'p2', 'p3'] as const) {
      expect(result[p].median_hours).toBeNull();
      expect(result[p].count).toBe(0);
    }
  });

  it('computes sensible medians per priority bucket', () => {
    // p0: closed in 1h, 5h, 9h → median 5
    seedTaskExact({
      title: 'p0-fast',
      status: 'done',
      priority: 'p0',
      createdAt: new Date(Date.now() - 2 * DAY_MS - 1 * HOUR_MS).toISOString(),
      updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    });
    seedTaskExact({
      title: 'p0-mid',
      status: 'done',
      priority: 'p0',
      createdAt: new Date(Date.now() - 3 * DAY_MS - 5 * HOUR_MS).toISOString(),
      updatedAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    });
    seedTaskExact({
      title: 'p0-slow',
      status: 'done',
      priority: 'p0',
      createdAt: new Date(Date.now() - 4 * DAY_MS - 9 * HOUR_MS).toISOString(),
      updatedAt: new Date(Date.now() - 4 * DAY_MS).toISOString(),
    });
    // p2: closed in 2h
    seedTaskExact({
      title: 'p2-only',
      status: 'done',
      priority: 'p2',
      createdAt: new Date(Date.now() - 1 * DAY_MS - 2 * HOUR_MS).toISOString(),
      updatedAt: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    });

    const result = timeToDoneByPriority('30d');
    expect(result.p0.count).toBe(3);
    expect(result.p0.median_hours).not.toBeNull();
    // ~5 hours, allow some slack for julianday rounding.
    expect(Math.abs((result.p0.median_hours ?? 0) - 5)).toBeLessThan(0.5);
    expect(result.p2.count).toBe(1);
    expect(Math.abs((result.p2.median_hours ?? 0) - 2)).toBeLessThan(0.5);
    expect(result.p1.count).toBe(0);
    expect(result.p3.count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  timeToDoneByTag                                                            */
/* -------------------------------------------------------------------------- */

describe('timeToDoneByTag', () => {
  useMockedDb();

  it('returns an empty array when no closed tagged tasks exist', () => {
    expect(timeToDoneByTag('30d')).toEqual([]);
  });

  it('groups closed tasks by every tag they carry', () => {
    seedTaskExact({
      title: 't1',
      status: 'done',
      tags: ['alpha', 'shared'],
      createdAt: new Date(Date.now() - 1 * DAY_MS - 2 * HOUR_MS).toISOString(),
      updatedAt: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    });
    seedTaskExact({
      title: 't2',
      status: 'done',
      tags: ['alpha'],
      createdAt: new Date(Date.now() - 2 * DAY_MS - 4 * HOUR_MS).toISOString(),
      updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    });
    seedTaskExact({
      title: 't3',
      status: 'done',
      tags: ['shared'],
      createdAt: new Date(Date.now() - 3 * DAY_MS - 1 * HOUR_MS).toISOString(),
      updatedAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    });

    const rows = timeToDoneByTag('30d');
    const alpha = rows.find((r) => r.tag === 'alpha');
    const shared = rows.find((r) => r.tag === 'shared');
    expect(alpha?.count).toBe(2);
    expect(shared?.count).toBe(2);
    // Tag with most tasks should come first.
    expect(rows[0]?.count).toBeGreaterThanOrEqual(rows[1]?.count ?? 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  tagHeatMap                                                                */
/* -------------------------------------------------------------------------- */

describe('tagHeatMap', () => {
  useMockedDb();

  it('returns an empty array when no tagged tasks exist', () => {
    expect(tagHeatMap('30d')).toEqual([]);
  });

  it('orders by total descending and breaks down by status', () => {
    seedTaskExact({
      title: 'a1',
      status: 'done',
      tags: ['big'],
      createdAt: isoDaysAgo(1),
      updatedAt: isoDaysAgo(1),
    });
    seedTaskExact({
      title: 'a2',
      status: 'queued',
      tags: ['big'],
      createdAt: isoDaysAgo(1),
      updatedAt: isoDaysAgo(1),
    });
    seedTaskExact({
      title: 'a3',
      status: 'inbox',
      tags: ['big'],
      createdAt: isoDaysAgo(1),
      updatedAt: isoDaysAgo(1),
    });
    seedTaskExact({
      title: 'b1',
      status: 'done',
      tags: ['small'],
      createdAt: isoDaysAgo(1),
      updatedAt: isoDaysAgo(1),
    });

    const rows = tagHeatMap('30d');
    expect(rows[0]?.tag).toBe('big');
    expect(rows[0]?.total).toBe(3);
    expect(rows[0]?.by_status.done).toBe(1);
    expect(rows[0]?.by_status.queued).toBe(1);
    expect(rows[0]?.by_status.inbox).toBe(1);
    expect(rows[1]?.tag).toBe('small');
    expect(rows[1]?.total).toBe(1);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 25; i++) {
      seedTaskExact({
        title: `tag-${i}`,
        status: 'done',
        tags: [`tag${i}`],
        createdAt: isoDaysAgo(1),
        updatedAt: isoDaysAgo(1),
      });
    }
    const rows = tagHeatMap('30d', 10);
    expect(rows).toHaveLength(10);
  });
});

/* -------------------------------------------------------------------------- */
/*  recentFailures                                                            */
/* -------------------------------------------------------------------------- */

describe('recentFailures', () => {
  useMockedDb();

  it('returns an empty array when no failed tasks exist', () => {
    expect(recentFailures(10)).toEqual([]);
  });

  it('returns failed tasks newest-first with error from latest log', () => {
    const older = seedTaskExact({
      title: 'older-fail',
      status: 'failed',
      priority: 'p1',
      createdAt: isoDaysAgo(10),
      updatedAt: isoDaysAgo(5),
    });
    const newer = seedTaskExact({
      title: 'newer-fail',
      status: 'failed',
      priority: 'p0',
      createdAt: isoDaysAgo(3),
      updatedAt: isoDaysAgo(1),
    });
    createLog({
      task_id: newer.id,
      method: 'cli',
      status: 'failed',
      error: 'boom',
      started_at: isoDaysAgo(1),
      completed_at: isoDaysAgo(1),
    });
    createLog({
      task_id: older.id,
      method: 'cli',
      status: 'failed',
      error: 'old-boom',
      started_at: isoDaysAgo(5),
      completed_at: isoDaysAgo(5),
    });

    const rows = recentFailures(10);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]?.task_id).toBe(newer.id);
    expect(rows[0]?.error).toBe('boom');
    expect(rows[0]?.priority).toBe('p0');
    expect(rows[1]?.task_id).toBe(older.id);
    expect(rows[1]?.error).toBe('old-boom');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      seedTaskExact({
        title: `fail-${i}`,
        status: 'failed',
        createdAt: isoDaysAgo(10),
        updatedAt: new Date(Date.now() - (5 - i) * HOUR_MS).toISOString(),
      });
    }
    expect(recentFailures(3)).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  reviewQueueTrend                                                          */
/* -------------------------------------------------------------------------- */

describe('reviewQueueTrend', () => {
  useMockedDb();

  it('returns `days` contiguous points', () => {
    const points = reviewQueueTrend(7);
    expect(points).toHaveLength(7);
  });

  it('counts tasks currently in needs_review or failed up to each day', () => {
    seedTaskExact({
      title: 'r1',
      status: 'blocked',
      agent_status: 'needs_review',
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(5),
    });
    seedTaskExact({
      title: 'r2',
      status: 'failed',
      createdAt: isoDaysAgo(3),
      updatedAt: isoDaysAgo(3),
    });

    const points = reviewQueueTrend(7);
    // The most recent point should reflect both items entering review.
    const today = points[points.length - 1];
    expect(today?.count).toBe(2);
    // The oldest point predates both entries → 0.
    expect(points[0]?.count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  reportBundle                                                              */
/* -------------------------------------------------------------------------- */

describe('reportBundle', () => {
  useMockedDb();

  it('returns every sub-report in one call', () => {
    const bundle = reportBundle('30d');
    expect(bundle.throughput).toBeInstanceOf(Array);
    expect(bundle.success_rate).toBeDefined();
    expect(bundle.time_to_done_priority).toBeDefined();
    expect(bundle.time_to_done_tags).toBeInstanceOf(Array);
    expect(bundle.tag_heat_map).toBeInstanceOf(Array);
    expect(bundle.recent_failures).toBeInstanceOf(Array);
    expect(bundle.review_queue_trend).toBeInstanceOf(Array);
    expect(bundle.window).toBe('30d');
    expect(bundle.days).toBe(30);
  });

  it('honors a custom days override', () => {
    const bundle = reportBundle('30d', 14);
    expect(bundle.throughput).toHaveLength(14);
    expect(bundle.review_queue_trend).toHaveLength(14);
  });
});
