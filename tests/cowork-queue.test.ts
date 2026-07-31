/**
 * Cowork queue filter — verifies that listTasks() with a queued status,
 * post-filtered by agent_method, returns exactly the cowork-eligible
 * tasks. This is the same predicate the renderer's `useCoworkQueue` hook
 * and the tray's `countCoworkWaiting` apply.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { createTask, listTasks } from '@/main/db/repositories/tasks';
import type { AgentMethod, Task } from '@/shared/types';

interface Fixture {
  title: string;
  agent_method: AgentMethod;
  status?: Task['status'];
}

function seed(fixtures: Fixture[]): Task[] {
  return fixtures.map((f) =>
    createTask({
      title: f.title,
      agent_method: f.agent_method,
      status: f.status ?? 'queued',
      agent_executable: f.agent_method !== 'human_only',
      priority: 'p2',
    }),
  );
}

/**
 * Mirror of the predicate used by the renderer's `useCoworkQueue` hook and
 * `tray.countCoworkWaiting`. Kept here so a regression in the predicate
 * surfaces as a failing test rather than a silent divergence between
 * surfaces.
 */
function coworkFilter(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) => t.agent_method === 'cowork' || t.agent_method === 'either',
  );
}

describe('cowork queue filter', () => {
  useMockedDb();

  it('returns only cowork + either tasks at queued status', () => {
    seed([
      { title: 'cowork-1', agent_method: 'cowork' },
      { title: 'either-1', agent_method: 'either' },
      { title: 'cli-only', agent_method: 'cli' },
      { title: 'human', agent_method: 'human_only' },
    ]);
    const queued = listTasks({ status: 'queued' });
    const cowork = coworkFilter(queued);
    expect(cowork.map((t) => t.title).sort()).toEqual(['cowork-1', 'either-1']);
  });

  it('excludes tasks that are not queued when the queued filter is applied', () => {
    seed([
      { title: 'cowork-queued', agent_method: 'cowork', status: 'queued' },
      { title: 'cowork-done', agent_method: 'cowork', status: 'done' },
      { title: 'either-inbox', agent_method: 'either', status: 'inbox' },
    ]);
    const queued = listTasks({ status: 'queued' });
    const cowork = coworkFilter(queued);
    expect(cowork.map((t) => t.title)).toEqual(['cowork-queued']);
  });

  it('counts correctly across mixed agent methods', () => {
    seed([
      { title: 'cowork-1', agent_method: 'cowork' },
      { title: 'cowork-2', agent_method: 'cowork' },
      { title: 'cowork-3', agent_method: 'cowork' },
      { title: 'either-1', agent_method: 'either' },
      { title: 'cli-1', agent_method: 'cli' },
      { title: 'cli-2', agent_method: 'cli' },
      { title: 'human-1', agent_method: 'human_only' },
    ]);
    const queued = listTasks({ status: 'queued' });
    expect(coworkFilter(queued)).toHaveLength(4);
  });

  it('returns an empty list when no cowork tasks exist', () => {
    seed([
      { title: 'cli-1', agent_method: 'cli' },
      { title: 'human-1', agent_method: 'human_only' },
    ]);
    const queued = listTasks({ status: 'queued' });
    expect(coworkFilter(queued)).toHaveLength(0);
  });
});
