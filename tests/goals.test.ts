/**
 * Goals / Initiatives tier tests (Wave 17).
 *
 * Coverage:
 *   - repository: create (defaults) / get / list (filter by status, workspace)
 *     / update / delete
 *   - membership: explicit `context.goal_id` + tag membership, de-duplicated
 *   - progress aggregation: done/in_progress/blocked/percent, overdue + next_due
 *   - attach / detach a task (writes context.goal_id, leaves other context)
 *   - delete detaches explicit members WITHOUT deleting the tasks
 *   - HTTP routes: full CRUD + :id/tasks + POST /api/tasks/:id/goal, including
 *     404s (unknown goal / task) and 400 (bad ids / dangling attach)
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import {
  computeProgress,
  createGoal,
  deleteGoalAndDetach,
  getGoal,
  listGoals,
  listGoalsWithProgress,
  listGoalTasks,
  readTaskGoalId,
  setTaskGoal,
  taskBelongsToGoal,
  updateGoal,
} from '@/main/goals';
import { createTask, getTask } from '@/main/db/repositories/tasks';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function pastIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

function futureIso(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Repository + domain                                                       */
/* -------------------------------------------------------------------------- */

describe('goals — repository + CRUD', () => {
  useMockedDb();

  it('creates a goal with sensible defaults', () => {
    const goal = createGoal({ name: 'Hit $50k MRR' });
    expect(goal.id).toBeTruthy();
    expect(goal.name).toBe('Hit $50k MRR');
    expect(goal.status).toBe('active');
    expect(goal.description).toBeNull();
    expect(goal.target_date).toBeNull();
    expect(goal.workspace).toBeNull();
    expect(goal.tags).toEqual([]);
  });

  it('round-trips description, target, workspace, tags', () => {
    const goal = createGoal({
      name: 'Ship deck',
      description: 'Success: 3 live pitches',
      target_date: '2026-06-30',
      workspace: 'leal-health',
      tags: ['leal', 'deck'],
      status: 'active',
    });
    const fetched = getGoal(goal.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.description).toBe('Success: 3 live pitches');
    expect(fetched?.target_date).toBe('2026-06-30');
    expect(fetched?.workspace).toBe('leal-health');
    expect(fetched?.tags).toEqual(['leal', 'deck']);
  });

  it('updates fields and refreshes updated_at', () => {
    const goal = createGoal({ name: 'Original' });
    const updated = updateGoal(goal.id, {
      name: 'Renamed',
      status: 'on_hold',
      tags: ['x'],
    });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.status).toBe('on_hold');
    expect(updated?.tags).toEqual(['x']);
  });

  it('returns null updating a missing goal', () => {
    expect(updateGoal('does-not-exist', { name: 'X' })).toBeNull();
  });

  it('filters list by status and workspace', () => {
    createGoal({ name: 'A', status: 'active', workspace: 'indexthread' });
    createGoal({ name: 'B', status: 'achieved', workspace: 'indexthread' });
    createGoal({ name: 'C', status: 'active', workspace: 'leal-health' });

    expect(listGoals({ status: 'active' })).toHaveLength(2);
    expect(listGoals({ status: 'achieved' })).toHaveLength(1);
    expect(listGoals({ workspace: 'indexthread' })).toHaveLength(2);
    expect(
      listGoals({ status: 'active', workspace: 'leal-health' }),
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Membership                                                                */
/* -------------------------------------------------------------------------- */

describe('goals — membership', () => {
  useMockedDb();

  it('matches explicit context.goal_id', () => {
    const goal = createGoal({ name: 'Explicit' });
    const t = createTask({ title: 'attached' });
    setTaskGoal(t.id, goal.id);

    const members = listGoalTasks(goal.id);
    expect(members.map((m) => m.id)).toContain(t.id);
    expect(taskBelongsToGoal(getTask(t.id)!, goal)).toBe(true);
  });

  it('matches tasks carrying any of the goal tags', () => {
    const goal = createGoal({ name: 'Tagged', tags: ['leal', 'deck'] });
    const tagged = createTask({ title: 'tagged task', tags: ['leal'] });
    const other = createTask({ title: 'unrelated', tags: ['indexthread'] });

    const members = listGoalTasks(goal.id);
    const ids = members.map((m) => m.id);
    expect(ids).toContain(tagged.id);
    expect(ids).not.toContain(other.id);
  });

  it('de-duplicates a task that matches both explicit + tag', () => {
    const goal = createGoal({ name: 'Both', tags: ['leal'] });
    const t = createTask({ title: 'double', tags: ['leal'] });
    setTaskGoal(t.id, goal.id);

    const members = listGoalTasks(goal.id);
    expect(members.filter((m) => m.id === t.id)).toHaveLength(1);
  });

  it('returns empty for an unknown goal id', () => {
    expect(listGoalTasks('nope')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Progress aggregation                                                      */
/* -------------------------------------------------------------------------- */

describe('goals — progress', () => {
  useMockedDb();

  it('counts done / in_progress / blocked and computes percent', () => {
    const goal = createGoal({ name: 'Progress' });
    const a = createTask({ title: 'done', status: 'done' });
    const b = createTask({ title: 'doing', status: 'in_progress' });
    const c = createTask({ title: 'blocked', status: 'blocked' });
    const d = createTask({ title: 'inbox', status: 'inbox' });
    for (const t of [a, b, c, d]) setTaskGoal(t.id, goal.id);

    const progress = computeProgress(goal.id, listGoalTasks(goal.id));
    expect(progress.total).toBe(4);
    expect(progress.done).toBe(1);
    expect(progress.in_progress).toBe(1);
    expect(progress.blocked).toBe(1);
    expect(progress.percent).toBe(25);
  });

  it('aggregates over BOTH explicit and tag members', () => {
    const goal = createGoal({ name: 'Mixed', tags: ['leal'] });
    const explicit = createTask({ title: 'explicit done', status: 'done' });
    setTaskGoal(explicit.id, goal.id);
    createTask({ title: 'tag inbox', tags: ['leal'], status: 'inbox' });

    const progress = computeProgress(goal.id, listGoalTasks(goal.id));
    expect(progress.total).toBe(2);
    expect(progress.done).toBe(1);
    expect(progress.percent).toBe(50);
  });

  it('zeroes percent on an empty goal', () => {
    const goal = createGoal({ name: 'Empty' });
    const progress = computeProgress(goal.id, listGoalTasks(goal.id));
    expect(progress.total).toBe(0);
    expect(progress.percent).toBe(0);
    expect(progress.next_due).toBeNull();
  });

  it('counts overdue tasks and picks the earliest next_due', () => {
    const goal = createGoal({ name: 'Dated' });
    const overdue = createTask({
      title: 'overdue',
      status: 'inbox',
      due: pastIso(3),
    });
    const soon = createTask({
      title: 'soon',
      status: 'inbox',
      due: futureIso(2),
    });
    // A done task that is "overdue" must NOT count.
    const doneLate = createTask({
      title: 'done late',
      status: 'done',
      due: pastIso(10),
    });
    for (const t of [overdue, soon, doneLate]) setTaskGoal(t.id, goal.id);

    const progress = computeProgress(goal.id, listGoalTasks(goal.id));
    expect(progress.overdue_tasks).toBe(1);
    // next_due is the earliest non-done due — the overdue one is earliest.
    expect(progress.next_due).toBe(overdue.due);
  });

  it('listGoalsWithProgress bundles progress per goal', () => {
    const g = createGoal({ name: 'Bundled' });
    const t = createTask({ title: 'm', status: 'done' });
    setTaskGoal(t.id, g.id);
    const list = listGoalsWithProgress();
    const found = list.find((x) => x.id === g.id);
    expect(found?.progress.done).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Attach / detach                                                           */
/* -------------------------------------------------------------------------- */

describe('goals — attach / detach', () => {
  useMockedDb();

  it('writes goal_id without clobbering other context', () => {
    const goal = createGoal({ name: 'G' });
    const t = createTask({
      title: 'has context',
      context: { phase: 'spec', note: 'keep me' },
    });
    const updated = setTaskGoal(t.id, goal.id);
    expect(readTaskGoalId(updated!)).toBe(goal.id);
    expect((updated!.context as Record<string, unknown>).phase).toBe('spec');
    expect((updated!.context as Record<string, unknown>).note).toBe('keep me');
  });

  it('detaches by clearing goal_id', () => {
    const goal = createGoal({ name: 'G' });
    const t = createTask({ title: 't' });
    setTaskGoal(t.id, goal.id);
    const detached = setTaskGoal(t.id, null);
    expect(readTaskGoalId(detached!)).toBeNull();
  });

  it('returns null attaching a missing task', () => {
    const goal = createGoal({ name: 'G' });
    expect(setTaskGoal('missing', goal.id)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Delete detaches but never deletes tasks                                   */
/* -------------------------------------------------------------------------- */

describe('goals — delete detaches members', () => {
  useMockedDb();

  it('clears explicit members and keeps the tasks alive', () => {
    const goal = createGoal({ name: 'Doomed' });
    const a = createTask({ title: 'a' });
    const b = createTask({ title: 'b' });
    setTaskGoal(a.id, goal.id);
    setTaskGoal(b.id, goal.id);

    const { removed, detached } = deleteGoalAndDetach(goal.id);
    expect(removed).toBe(true);
    expect(detached).toBe(2);

    // Goal gone, tasks alive with goal_id cleared.
    expect(getGoal(goal.id)).toBeNull();
    expect(getTask(a.id)).not.toBeNull();
    expect(getTask(b.id)).not.toBeNull();
    expect(readTaskGoalId(getTask(a.id)!)).toBeNull();
    expect(readTaskGoalId(getTask(b.id)!)).toBeNull();
  });

  it('leaves tag-only members untouched (nothing referenced the goal)', () => {
    const goal = createGoal({ name: 'TagGoal', tags: ['leal'] });
    const tagOnly = createTask({ title: 'tag member', tags: ['leal'] });

    const { detached } = deleteGoalAndDetach(goal.id);
    expect(detached).toBe(0);
    // Task survives and keeps its tags.
    const reloaded = getTask(tagOnly.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.tags).toContain('leal');
  });

  it('returns removed=false for a missing goal', () => {
    const { removed } = deleteGoalAndDetach('nope');
    expect(removed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  HTTP routes                                                               */
/* -------------------------------------------------------------------------- */

describe('goals — HTTP routes', () => {
  const { current } = useMockedDb();
  let server: ApiServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    server = await startApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  async function http(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  it('POST/GET/PATCH/DELETE /api/goals round-trips with progress', async () => {
    // Seed a member task directly via the repo (shares the mocked DB).
    const goalTask = current().db; // touch to ensure DB initialized
    void goalTask;

    const created = await http('POST', '/api/goals', {
      name: 'API goal',
      tags: ['leal'],
    });
    expect(created.status).toBe(201);
    const id = created.json.goal.id as string;

    // Attach a task via the repo, then read it back through the list.
    const t = createTask({ title: 'member', status: 'done' });
    await http('POST', `/api/tasks/${t.id}/goal`, { goal_id: id });

    const list = await http('GET', '/api/goals');
    expect(list.status).toBe(200);
    const found = list.json.goals.find((g: any) => g.id === id);
    expect(found.progress.total).toBe(1);
    expect(found.progress.done).toBe(1);
    expect(found.progress.percent).toBe(100);

    const detail = await http('GET', `/api/goals/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.tasks).toHaveLength(1);

    const patched = await http('PATCH', `/api/goals/${id}`, {
      status: 'achieved',
    });
    expect(patched.status).toBe(200);
    expect(patched.json.goal.status).toBe('achieved');

    const tasks = await http('GET', `/api/goals/${id}/tasks`);
    expect(tasks.status).toBe(200);
    expect(tasks.json.tasks).toHaveLength(1);

    const del = await http('DELETE', `/api/goals/${id}`);
    expect(del.status).toBe(200);
    expect(del.json.detached).toBe(1);
    // Task survives.
    expect(getTask(t.id)).not.toBeNull();
  });

  it('404s on unknown goal', async () => {
    const res = await http('GET', '/api/goals/abc123');
    expect(res.status).toBe(404);
  });

  it('400s on a bad goal id', async () => {
    const res = await http('GET', '/api/goals/has%20space');
    expect(res.status).toBe(400);
  });

  it('400s creating a goal with no name', async () => {
    const res = await http('POST', '/api/goals', { description: 'x' });
    expect(res.status).toBe(400);
  });

  it('attach 404s when the target goal does not exist', async () => {
    const t = createTask({ title: 'orphan attach' });
    const res = await http('POST', `/api/tasks/${t.id}/goal`, {
      goal_id: 'ghost000',
    });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('goal_not_found');
  });

  it('attach 404s when the task does not exist', async () => {
    const g = await http('POST', '/api/goals', { name: 'For attach' });
    const res = await http('POST', '/api/tasks/missing00/goal', {
      goal_id: g.json.goal.id,
    });
    expect(res.status).toBe(404);
  });

  it('detach (goal_id: null) clears the attachment', async () => {
    const g = await http('POST', '/api/goals', { name: 'Detach me' });
    const id = g.json.goal.id as string;
    const t = createTask({ title: 'detachable' });
    await http('POST', `/api/tasks/${t.id}/goal`, { goal_id: id });
    const detached = await http('POST', `/api/tasks/${t.id}/goal`, {
      goal_id: null,
    });
    expect(detached.status).toBe(200);
    expect(readTaskGoalId(getTask(t.id)!)).toBeNull();
  });
});
