/**
 * Tests for the business snapshot engine — feeds (tasks/decisions/conversations
 * + updates), counting, headline pick, and next-step derivation.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();
useMockedDb();

import {
  computeOverview,
  computeSnapshot,
  recordUpdate,
} from '@/main/businesses';
import {
  invalidateCache,
  PROJECTS_FILE_PATH,
} from '@/main/businesses/loader';
import { renderStatusMarkdown } from '@/main/businesses/render';
import { createTask } from '@/main/db/repositories/tasks';

function writeProjects(projects: Array<{ tag: string; name: string; goal_id?: string; repos?: string[] }>): void {
  fs.mkdirSync(path.dirname(PROJECTS_FILE_PATH), { recursive: true });
  fs.writeFileSync(
    PROJECTS_FILE_PATH,
    JSON.stringify({ projects: projects.map((p) => ({ repos: [], ...p })) }, null, 2),
    'utf8',
  );
  invalidateCache();
}

function clearProjects(): void {
  try {
    fs.unlinkSync(PROJECTS_FILE_PATH);
  } catch {
    /* ignore */
  }
  invalidateCache();
}

function clearBusinessesDir(): void {
  const dir = path.join(PATHS.TASKPILOT_HOME, 'businesses');
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('businesses/snapshot', () => {
  beforeEach(() => {
    writeProjects([{ tag: 'leal-health', name: 'Leal Health' }]);
    clearBusinessesDir();
  });
  afterEach(() => {
    clearProjects();
    clearBusinessesDir();
  });

  it('returns null when the tag is not configured', async () => {
    const snap = await computeSnapshot('unknown-tag');
    expect(snap).toBeNull();
  });

  it('reflects open task counts and headlines top open task', async () => {
    createTask({
      title: 'Refresh pricing page',
      status: 'in_progress',
      priority: 'p1',
      tags: ['leal-health'],
    });
    createTask({
      title: 'Audit decks',
      status: 'queued',
      priority: 'p2',
      tags: ['leal-health'],
    });
    createTask({
      title: 'Unrelated work',
      status: 'queued',
      priority: 'p2',
      tags: ['somewhere-else'],
    });
    const snap = await computeSnapshot('leal-health');
    expect(snap).not.toBeNull();
    expect(snap!.task_counts.in_progress).toBe(1);
    expect(snap!.task_counts.queued).toBe(1);
    expect(snap!.task_counts.total).toBe(2);
    expect(snap!.open_tasks.map((t) => t.title)).toContain('Refresh pricing page');
    expect(snap!.headline).toContain('Refresh pricing page');
  });

  it('uses the most recent explicit update as the headline', async () => {
    await recordUpdate('leal-health', {
      at: new Date().toISOString(),
      headline: 'Cut over to new compliance auth middleware',
      source: 'test',
    });
    const snap = await computeSnapshot('leal-health');
    expect(snap!.headline).toBe('Cut over to new compliance auth middleware');
    expect(snap!.recent_updates).toHaveLength(1);
  });

  it('surfaces overdue tasks as the first next step', async () => {
    const past = new Date(Date.now() - 86_400_000 * 3).toISOString();
    createTask({
      title: 'Send the deck',
      status: 'queued',
      priority: 'p1',
      due: past,
      tags: ['leal-health'],
    });
    const snap = await computeSnapshot('leal-health');
    expect(snap!.next_steps[0]?.source).toBe('overdue_task');
    expect(snap!.next_steps[0]?.text).toContain('Send the deck');
    expect(snap!.task_counts.overdue).toBe(1);
  });

  it('emits a no_activity next step when nothing is logged', async () => {
    const snap = await computeSnapshot('leal-health');
    expect(snap!.next_steps).toHaveLength(1);
    expect(snap!.next_steps[0]?.source).toBe('no_activity');
  });

  it('renders STATUS.md with the headline and update entries', async () => {
    await recordUpdate('leal-health', {
      at: new Date().toISOString(),
      headline: 'Wave 1 shipped',
      what_changed: 'PR merged, deployed to staging.',
      source: 'test',
    });
    const snap = await computeSnapshot('leal-health');
    const md = renderStatusMarkdown(snap!);
    expect(md).toContain('# Leal Health — Status');
    expect(md).toContain('Wave 1 shipped');
    expect(md).toContain('PR merged, deployed to staging.');
  });

  it('overview lists each business with derived counts and headlines', async () => {
    writeProjects([
      { tag: 'leal-health', name: 'Leal Health' },
      { tag: 'indexthread', name: 'IndexThread' },
    ]);
    createTask({
      title: 'A task',
      status: 'queued',
      priority: 'p2',
      tags: ['leal-health'],
    });
    const overview = await computeOverview();
    expect(overview.map((b) => b.tag).sort()).toEqual(
      ['indexthread', 'leal-health'].sort(),
    );
    const leal = overview.find((b) => b.tag === 'leal-health')!;
    expect(leal.open_task_count).toBe(1);
  });
});
