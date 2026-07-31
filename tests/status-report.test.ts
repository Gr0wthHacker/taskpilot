/**
 * Status report tests (Wave 16E).
 *
 * Covers four layers:
 *   1. Cron parsing + matching (pure, no DB).
 *   2. Window resolution + markdown rendering + rollups (pure helpers).
 *   3. `generateStatusReport` against a seeded in-memory DB.
 *   4. `publishReport` — disk write + the soft-import skip path for an
 *      unconnected integration.
 *   5. The HTTP surface (preview / generate / schedule / history) over a real
 *      Express stack.
 *
 * The path mock must run at module scope (before any `@/main/*` import that
 * pulls in constants) so disk writes land in a tmp home, not the user's
 * real `~/.taskpilot`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { getSqlite } from '@/main/db';
import { createTask } from '@/main/db/repositories/tasks';
import { createCostEvent } from '@/main/db/repositories/cost-events';
import { settingsRepository } from '@/main/db/repositories/settings';
import {
  __internals as schedInternals,
  cronMatches,
  isValidCron,
  parseCron,
  readSchedule,
  startScheduler,
  writeSchedule,
  DEFAULT_CRON,
} from '@/main/reports/report-scheduler';
import {
  __internals as genInternals,
  generateStatusReport,
  renderMarkdown,
  resolveWindow,
} from '@/main/reports/status-report';
import {
  listReportHistory,
  publishReport,
  reportBasename,
} from '@/main/reports/report-publish';
import type { TaskPriority, TaskStatus } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number, extraMs = 0): string {
  return new Date(Date.now() - days * DAY_MS + extraMs).toISOString();
}

function seedTask(opts: {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  due?: string | null;
  createdAt: string;
  updatedAt: string;
}): string {
  const t = createTask({
    title: opts.title,
    status: opts.status ?? 'inbox',
    priority: opts.priority ?? 'p2',
    tags: opts.tags ?? [],
    due: opts.due ?? null,
    created_at: opts.createdAt,
    updated_at: opts.updatedAt,
  });
  getSqlite()
    .prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?')
    .run(opts.createdAt, opts.updatedAt, t.id);
  return t.id;
}

/* -------------------------------------------------------------------------- */
/*  1. Cron parsing + matching                                                */
/* -------------------------------------------------------------------------- */

describe('cron parsing', () => {
  it('parses the default "Mondays 8am" expression', () => {
    const parsed = parseCron(DEFAULT_CRON);
    expect(parsed).not.toBeNull();
    expect(parsed!.minute.has(0)).toBe(true);
    expect(parsed!.hour.has(8)).toBe(true);
    expect(parsed!.dayOfWeek.has(1)).toBe(true); // Monday
  });

  it('rejects malformed expressions', () => {
    expect(parseCron('')).toBeNull();
    expect(parseCron('* * *')).toBeNull(); // too few fields
    expect(parseCron('60 * * * *')).toBeNull(); // minute out of range
    expect(parseCron('* 25 * * *')).toBeNull(); // hour out of range
    expect(parseCron('a b c d e')).toBeNull();
    expect(isValidCron('0 8 * * 1')).toBe(true);
  });

  it('expands lists, ranges, and steps', () => {
    const parsed = parseCron('0,30 9-17 * * 1-5');
    expect(parsed).not.toBeNull();
    expect([...parsed!.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(parsed!.hour.has(9)).toBe(true);
    expect(parsed!.hour.has(17)).toBe(true);
    expect(parsed!.hour.has(8)).toBe(false);
    expect(parsed!.dayOfWeek.has(0)).toBe(false); // Sunday excluded

    const step = parseCron('*/15 * * * *');
    expect([...step!.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });
});

describe('cron matching', () => {
  it('fires Mondays at 8:00 only', () => {
    const parsed = parseCron(DEFAULT_CRON)!;
    // 2026-05-25 is a Monday.
    const monday8 = new Date(2026, 4, 25, 8, 0, 0);
    const monday9 = new Date(2026, 4, 25, 9, 0, 0);
    const tuesday8 = new Date(2026, 4, 26, 8, 0, 0);
    expect(cronMatches(parsed, monday8)).toBe(true);
    expect(cronMatches(parsed, monday9)).toBe(false);
    expect(cronMatches(parsed, tuesday8)).toBe(false);
  });

  it('uses OR semantics when both dom and dow are restricted', () => {
    // "08:00 on the 1st OR on Fridays"
    const parsed = parseCron('0 8 1 * 5')!;
    const firstOfMonth = new Date(2026, 5, 1, 8, 0, 0); // June 1 (a Monday)
    const friday = new Date(2026, 5, 5, 8, 0, 0); // June 5 (a Friday)
    const randomTuesday = new Date(2026, 5, 9, 8, 0, 0);
    expect(cronMatches(parsed, firstOfMonth)).toBe(true);
    expect(cronMatches(parsed, friday)).toBe(true);
    expect(cronMatches(parsed, randomTuesday)).toBe(false);
  });

  it('de-dupes by minute bucket key', () => {
    const a = schedInternals.minuteKey(new Date(2026, 4, 25, 8, 0, 12));
    const b = schedInternals.minuteKey(new Date(2026, 4, 25, 8, 0, 59));
    const c = schedInternals.minuteKey(new Date(2026, 4, 25, 8, 1, 0));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Window resolution + rendering                                          */
/* -------------------------------------------------------------------------- */

describe('window resolution', () => {
  it('defaults to 7 days', () => {
    const win = resolveWindow();
    const span = Date.parse(win.to) - Date.parse(win.from);
    expect(Math.abs(span - 7 * DAY_MS)).toBeLessThan(2_000);
  });

  it('honors explicit bounds', () => {
    const from = '2026-05-01T00:00:00.000Z';
    const to = '2026-05-08T00:00:00.000Z';
    const win = resolveWindow({ from, to });
    expect(win.from).toBe(from);
    expect(win.to).toBe(to);
  });

  it('falls back to default on inverted bounds', () => {
    const win = resolveWindow({ from: '2026-05-08T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' });
    const span = Date.parse(win.to) - Date.parse(win.from);
    expect(Math.abs(span - 7 * DAY_MS)).toBeLessThan(2_000);
  });
});

describe('markdown rendering', () => {
  it('renders all required sections with explicit empty states', () => {
    const md = renderMarkdown({
      win: { from: '2026-05-20T00:00:00.000Z', to: '2026-05-27T00:00:00.000Z' },
      metrics: { done: 0, in_progress: 0, blocked: 0, failed: 0, overdue: 0, cost_usd: 0 },
      tasks: [],
      byTag: [],
      byWorkspace: [],
      highlights: [],
    });
    expect(md).toContain('# TaskPilot Status Report');
    expect(md).toContain('## Headline');
    expect(md).toContain('## Completed');
    expect(md).toContain('## In progress');
    expect(md).toContain('## Blocked / Failed');
    expect(md).toContain('## By project');
    expect(md).toContain('## Notable outputs');
    expect(md).toContain('0 tasks closed');
    // Empty sections still print so nothing looks dropped.
    expect(md).toContain('_None._');
  });

  it('renders output links for highlighted tasks', () => {
    const md = renderMarkdown({
      win: { from: '2026-05-20T00:00:00.000Z', to: '2026-05-27T00:00:00.000Z' },
      metrics: { done: 1, in_progress: 0, blocked: 0, failed: 0, overdue: 0, cost_usd: 1.23 },
      tasks: [
        {
          id: 't1',
          title: 'Ship the thing',
          status: 'done',
          priority: 'p1',
          due: null,
          tags: null,
          updated_at: '2026-05-26T00:00:00.000Z',
        },
      ],
      byTag: [],
      byWorkspace: [],
      highlights: [{ task_id: 't1', title: 'Ship the thing', url: 'https://example.com/pr/1' }],
    });
    expect(md).toContain('1 task closed');
    expect(md).toContain('$1.23');
    expect(md).toContain('[output](https://example.com/pr/1)');
    expect(md).toContain('[Ship the thing](https://example.com/pr/1)');
  });

  it('formats usd defensively', () => {
    expect(genInternals.fmtUsd(0)).toBe('$0.00');
    expect(genInternals.fmtUsd(0.004)).toBe('<$0.01');
    expect(genInternals.fmtUsd(12.5)).toBe('$12.50');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. generateStatusReport against a seeded DB                               */
/* -------------------------------------------------------------------------- */

describe('generateStatusReport', () => {
  useMockedDb();

  it('rolls up status counts within the window', async () => {
    seedTask({ title: 'closed-1', status: 'done', tags: ['indexthread'], createdAt: isoDaysAgo(5), updatedAt: isoDaysAgo(1) });
    seedTask({ title: 'closed-2', status: 'done', tags: ['leal'], createdAt: isoDaysAgo(6), updatedAt: isoDaysAgo(2) });
    seedTask({ title: 'wip', status: 'in_progress', createdAt: isoDaysAgo(3), updatedAt: isoDaysAgo(1) });
    seedTask({ title: 'stuck', status: 'blocked', createdAt: isoDaysAgo(4), updatedAt: isoDaysAgo(1) });
    seedTask({ title: 'broke', status: 'failed', createdAt: isoDaysAgo(4), updatedAt: isoDaysAgo(1) });
    // Outside the window — should NOT be counted.
    seedTask({ title: 'old-done', status: 'done', createdAt: isoDaysAgo(40), updatedAt: isoDaysAgo(40) });

    const report = await generateStatusReport({ window: '7d' });
    expect(report.metrics.done).toBe(2);
    expect(report.metrics.in_progress).toBe(1);
    expect(report.metrics.blocked).toBe(1);
    expect(report.metrics.failed).toBe(1);
    expect(report.markdown).toContain('2 tasks closed');
    expect(report.window.from).toBeTruthy();
    expect(report.window.to).toBeTruthy();
  });

  it('counts overdue tasks regardless of window', async () => {
    seedTask({
      title: 'overdue-old',
      status: 'queued',
      due: isoDaysAgo(2),
      createdAt: isoDaysAgo(90),
      updatedAt: isoDaysAgo(90),
    });
    const report = await generateStatusReport({ window: '7d' });
    expect(report.metrics.overdue).toBe(1);
  });

  it('includes window cost from cost events', async () => {
    const id = seedTask({ title: 'pricey', status: 'done', createdAt: isoDaysAgo(3), updatedAt: isoDaysAgo(1) });
    createCostEvent({ task_id: id, cost_usd: 2.5, at: isoDaysAgo(1) });
    const report = await generateStatusReport({ window: '7d' });
    expect(report.metrics.cost_usd).toBeGreaterThanOrEqual(2.5);
  });

  it('rolls up by workspace when workspaces are configured', async () => {
    settingsRepository.set('workspaces', [
      { id: 'indexthread', name: 'IndexThread', tags: ['indexthread'] },
      { id: 'leal', name: 'Leal Health', tags: ['leal', 'leal-health'] },
    ]);
    seedTask({ title: 'it-done', status: 'done', tags: ['indexthread'], createdAt: isoDaysAgo(3), updatedAt: isoDaysAgo(1) });
    seedTask({ title: 'leal-wip', status: 'in_progress', tags: ['leal'], createdAt: isoDaysAgo(3), updatedAt: isoDaysAgo(1) });

    const report = await generateStatusReport({ window: '7d' });
    const it = report.by_workspace.find((w) => w.workspace === 'IndexThread');
    const leal = report.by_workspace.find((w) => w.workspace === 'Leal Health');
    expect(it?.done).toBe(1);
    expect(leal?.total).toBe(1);
    expect(leal?.done).toBe(0);
    expect(report.markdown).toContain('## By project');
    expect(report.markdown).toContain('IndexThread');
  });
});

/* -------------------------------------------------------------------------- */
/*  4. publishReport                                                          */
/* -------------------------------------------------------------------------- */

describe('publishReport', () => {
  useMockedDb();

  const sampleReport = {
    window: { from: '2026-05-20T00:00:00.000Z', to: '2026-05-27T00:00:00.000Z' },
    generated_at: '2026-05-27T08:00:00.000Z',
    markdown: '# Status\n\nbody',
    metrics: { done: 3, in_progress: 1, blocked: 0, failed: 0, overdue: 2, cost_usd: 1.5 },
    by_tag: [],
    by_workspace: [],
    highlights: [],
  };

  it('writes a md file + json sidecar to the reports dir', async () => {
    const results = await publishReport(sampleReport, ['disk']);
    const disk = results.find((r) => r.destination === 'disk');
    expect(disk?.ok).toBe(true);
    expect(disk?.skipped).toBe(false);
    const reportsDir = path.join(PATHS.TASKPILOT_HOME, 'reports');
    const files = fs.readdirSync(reportsDir);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    const stem = reportBasename(sampleReport.generated_at);
    const md = fs.readFileSync(path.join(reportsDir, `${stem}.md`), 'utf8');
    expect(md).toBe(sampleReport.markdown);
  });

  it('skips Slack when not connected (soft import path)', async () => {
    const results = await publishReport(sampleReport, ['slack']);
    const slack = results.find((r) => r.destination === 'slack');
    expect(slack?.ok).toBe(false);
    expect(slack?.skipped).toBe(true);
    expect(slack?.detail.toLowerCase()).toContain('not connected');
  });

  it('de-dupes a destination listed twice', async () => {
    const results = await publishReport(sampleReport, ['disk', 'disk']);
    expect(results.filter((r) => r.destination === 'disk')).toHaveLength(1);
  });

  it('lists history newest-first with metrics from the sidecar', async () => {
    await publishReport(
      { ...sampleReport, generated_at: '2026-05-20T08:00:00.000Z' },
      ['disk'],
    );
    await publishReport(
      { ...sampleReport, generated_at: '2026-05-27T08:00:00.000Z' },
      ['disk'],
    );
    const history = await listReportHistory(10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    expect(history[0]!.generated_at >= history[1]!.generated_at).toBe(true);
    expect(history[0]!.metrics?.done).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Schedule read/write                                                    */
/* -------------------------------------------------------------------------- */

describe('schedule settings', () => {
  useMockedDb();

  it('defaults to disabled + the Mondays-8am cron', () => {
    const s = readSchedule();
    expect(s.enabled).toBe(false);
    expect(s.cron).toBe(DEFAULT_CRON);
    expect(s.destinations).toEqual([]);
  });

  it('persists a valid update and sanitizes destinations', () => {
    const s = writeSchedule({
      enabled: true,
      cron: '*/30 * * * *',
      destinations: ['slack', 'disk', 'bogus' as never, 'slack'],
    });
    expect(s.enabled).toBe(true);
    expect(s.cron).toBe('*/30 * * * *');
    // Bogus dropped, duplicate collapsed.
    expect(s.destinations).toEqual(['slack', 'disk']);
  });

  it('rejects an invalid cron on write', () => {
    expect(() => writeSchedule({ cron: 'not a cron' })).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Scheduler tick                                                         */
/* -------------------------------------------------------------------------- */

describe('scheduler tick', () => {
  useMockedDb();

  it('does not fire when disabled', async () => {
    let fired = 0;
    const handle = startScheduler({
      fire: async () => {
        fired += 1;
      },
      skipInitialTick: true,
    });
    // Monday 8am, but schedule disabled by default.
    await handle.tick(new Date(2026, 4, 25, 8, 0, 0));
    expect(fired).toBe(0);
    handle.stop();
  });

  it('fires once per matching minute when enabled', async () => {
    writeSchedule({ enabled: true, cron: DEFAULT_CRON, destinations: ['disk'] });
    let fired = 0;
    const handle = startScheduler({
      fire: async () => {
        fired += 1;
      },
      skipInitialTick: true,
    });
    const monday8 = new Date(2026, 4, 25, 8, 0, 5);
    const firstFired = await handle.tick(monday8);
    const secondFired = await handle.tick(new Date(2026, 4, 25, 8, 0, 45));
    expect(firstFired).toBe(true);
    expect(secondFired).toBe(false); // de-duped within the same minute
    expect(fired).toBe(1);
    // Records last_run_at.
    expect(readSchedule().last_run_at).toBeTruthy();
    handle.stop();
  });
});

/* -------------------------------------------------------------------------- */
/*  7. HTTP surface                                                           */
/* -------------------------------------------------------------------------- */

describe('routes/status-report', () => {
  useMockedDb();

  let handle: ApiServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = await startApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }, 30_000);

  afterAll(async () => {
    if (handle) {
      await Promise.race([
        handle.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }, 30_000);

  it('GET /api/reports/status/preview returns a report without publishing', async () => {
    const res = await fetch(`${baseUrl}/api/reports/status/preview?window=7d`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string; metrics: { done: number } };
    expect(body.markdown).toContain('# TaskPilot Status Report');
    expect(typeof body.metrics.done).toBe('number');
  });

  it('POST /api/reports/status generates + persists to disk', async () => {
    const res = await fetch(`${baseUrl}/api/reports/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ window: '7d', destinations: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { markdown: string };
      published: Array<{ destination: string; ok: boolean }>;
    };
    expect(body.report.markdown).toContain('# TaskPilot Status Report');
    // disk is always folded in so history has the report.
    const disk = body.published.find((p) => p.destination === 'disk');
    expect(disk?.ok).toBe(true);
  });

  it('GET /api/reports/status/history lists the persisted report', async () => {
    const res = await fetch(`${baseUrl}/api/reports/status/history?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reports: unknown[] };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(body.reports.length).toBeGreaterThanOrEqual(1);
  });

  it('GET + PATCH /api/reports/status/schedule round-trips', async () => {
    const patch = await fetch(`${baseUrl}/api/reports/status/schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, cron: '0 9 * * 1', destinations: ['disk'] }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { enabled: boolean; cron: string };
    expect(patched.enabled).toBe(true);
    expect(patched.cron).toBe('0 9 * * 1');

    const get = await fetch(`${baseUrl}/api/reports/status/schedule`);
    const got = (await get.json()) as { cron: string };
    expect(got.cron).toBe('0 9 * * 1');
  });

  it('PATCH /api/reports/status/schedule rejects a bad cron with 400', async () => {
    const res = await fetch(`${baseUrl}/api/reports/status/schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: 'totally bogus cron' }),
    });
    expect(res.status).toBe(400);
  });

  it('does not collide with the analytics /api/reports/all route', async () => {
    const res = await fetch(`${baseUrl}/api/reports/all?window=7d`);
    expect(res.status).toBe(200);
  });
});
