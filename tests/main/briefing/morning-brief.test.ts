/**
 * Tests for the morning brief generator — render content, on-disk write,
 * due detection, and idempotence.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();
useMockedDb();

import {
  generateMorningBrief,
  isMorningBriefDue,
  morningBriefPath,
  readMorningBrief,
} from '@/main/briefing/morning-brief';
import { invalidateCache, PROJECTS_FILE_PATH } from '@/main/businesses/loader';
import { createTask } from '@/main/db/repositories/tasks';

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

function clearAll(): void {
  try {
    fs.unlinkSync(PROJECTS_FILE_PATH);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(morningBriefPath());
  } catch {
    /* ignore */
  }
  invalidateCache();
}

describe('briefing/morning-brief', () => {
  beforeEach(writeProjects);
  afterEach(clearAll);

  it('isMorningBriefDue starts true on a fresh DB', () => {
    expect(isMorningBriefDue()).toBe(true);
  });

  it('generates a brief, writes markdown to disk, marks today done', async () => {
    const result = await generateMorningBrief();
    expect(result.markdown).toContain('# Morning brief');
    expect(result.markdown).toContain('Leal Health');
    expect(result.bytes).toBeGreaterThan(100);
    expect(result.path.startsWith(PATHS.TASKPILOT_HOME)).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(isMorningBriefDue()).toBe(false);
  });

  it('surfaces overdue tasks in the "needs you today" section', async () => {
    const past = new Date(Date.now() - 86_400_000 * 3).toISOString();
    createTask({
      title: 'Ship the leal deck',
      priority: 'p1',
      status: 'queued',
      due: past,
      tags: ['leal-health'],
    });
    const result = await generateMorningBrief();
    expect(result.markdown).toContain('Overdue');
    expect(result.markdown).toContain('Ship the leal deck');
  });

  it('recommends action based on what is in the queue', async () => {
    const past = new Date(Date.now() - 86_400_000 * 10).toISOString();
    createTask({
      title: 'Overdue thing',
      priority: 'p0',
      status: 'queued',
      due: past,
      tags: [],
    });
    const result = await generateMorningBrief();
    expect(result.markdown).toMatch(/Recommended first move/);
    expect(result.markdown).toMatch(/overdue|Overdue thing/i);
  });

  it('readMorningBrief returns null before any generation', async () => {
    expect(await readMorningBrief()).toBeNull();
  });

  it('regenerate is idempotent within the day', async () => {
    const a = await generateMorningBrief();
    const b = await generateMorningBrief();
    // Both succeed; content shape is stable (same template).
    expect(a.date).toBe(b.date);
    expect(b.markdown.length).toBeGreaterThan(100);
  });
});
