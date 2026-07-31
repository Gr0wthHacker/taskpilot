/**
 * Tests for the outcome reverse-engineer module — milestone log + trace.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();
useMockedDb();

import {
  invalidateCache,
  PROJECTS_FILE_PATH,
} from '@/main/businesses/loader';
import {
  listMilestones,
  recordMilestone,
  traceMilestone,
} from '@/main/outcomes';
import { createTask, updateTask } from '@/main/db/repositories/tasks';

function writeProjects(): void {
  fs.mkdirSync(path.dirname(PROJECTS_FILE_PATH), { recursive: true });
  fs.writeFileSync(
    PROJECTS_FILE_PATH,
    JSON.stringify(
      { projects: [{ name: 'Leal Health', tag: 'leal-health', repos: [] }] },
      null,
      2,
    ),
    'utf8',
  );
  invalidateCache();
}

function clear(): void {
  try {
    fs.unlinkSync(PROJECTS_FILE_PATH);
  } catch {
    /* ignore */
  }
  fs.rmSync(path.join(PATHS.TASKPILOT_HOME, 'outcomes'), {
    recursive: true,
    force: true,
  });
  invalidateCache();
}

describe('outcomes', () => {
  beforeEach(writeProjects);
  afterEach(clear);

  it('rejects milestones for unknown businesses', async () => {
    await expect(
      recordMilestone({
        id: 'm_test1',
        business: 'unknown',
        at: new Date().toISOString(),
        kind: 'milestone',
        headline: 'Hi',
      }),
    ).rejects.toThrow(/No business/);
  });

  it('records and lists milestones newest-first', async () => {
    await recordMilestone({
      id: 'm_a',
      business: 'leal-health',
      at: '2026-01-01T00:00:00Z',
      kind: 'ship',
      headline: 'First',
    });
    await recordMilestone({
      id: 'm_b',
      business: 'leal-health',
      at: '2026-01-02T00:00:00Z',
      kind: 'deal',
      headline: 'Second',
    });
    const list = await listMilestones('leal-health');
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe('m_b');
    expect(list[1]?.id).toBe('m_a');
  });

  it('traceMilestone surfaces tasks completed in the window', async () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const task = createTask({
      title: 'Built the deck',
      tags: ['leal-health'],
      created_at: past,
      updated_at: past,
    });
    updateTask(task.id, { status: 'done' });
    // Record the milestone AFTER the task transitions, so the task's new
    // updated_at sits inside the trace window.
    const milestoneAt = new Date(Date.now() + 1_000).toISOString();
    await recordMilestone({
      id: 'm_trace',
      business: 'leal-health',
      at: milestoneAt,
      kind: 'ship',
      headline: 'Shipped v2 deck',
      window_days: 14,
    });
    const trace = await traceMilestone({
      business: 'leal-health',
      milestoneId: 'm_trace',
    });
    expect(trace).not.toBeNull();
    expect(trace!.contributing_tasks.length).toBeGreaterThanOrEqual(1);
    expect(trace!.contributing_tasks[0]?.title).toBe('Built the deck');
    expect(trace!.summary).toContain('Shipped v2 deck');
  });

  it('returns null when milestone id is unknown', async () => {
    const trace = await traceMilestone({
      business: 'leal-health',
      milestoneId: 'm_doesnt_exist',
    });
    expect(trace).toBeNull();
  });
});
