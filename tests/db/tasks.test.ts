/**
 * Tasks repository unit tests.
 *
 * Each test runs against a fresh in-memory SQLite DB injected via the
 * mock-db helper. We test the public repo API: create/get/list/update/delete,
 * filter combinations, JSON round-trip for context + tags, and the children
 * relationship.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from '../helpers/mock-db';

import {
  createTask,
  deleteTask,
  getChildren,
  getTask,
  listTasks,
  updateTask,
} from '@/main/db/repositories/tasks';

describe('tasks repository', () => {
  useMockedDb();

  describe('createTask', () => {
    it('generates a 12-char nanoid id when none supplied', () => {
      const task = createTask({ title: 'no id' });
      expect(task.id).toBeDefined();
      expect(task.id.length).toBe(12);
    });

    it('respects an explicit id', () => {
      const task = createTask({ id: 'fixed_id_xy', title: 'explicit id' });
      expect(task.id).toBe('fixed_id_xy');
    });

    it('defaults status, priority, agent_method, agent_status', () => {
      const task = createTask({ title: 'defaults' });
      expect(task.status).toBe('inbox');
      expect(task.priority).toBe('p2');
      expect(task.agent_method).toBe('human_only');
      expect(task.agent_status).toBe('pending');
      expect(task.agent_executable).toBe(false);
    });

    it('sets created_at and updated_at to ISO strings', () => {
      const task = createTask({ title: 'timestamps' });
      expect(task.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(task.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // both equal at create time
      expect(task.created_at).toBe(task.updated_at);
    });

    it('persists null description and tags as empty array', () => {
      const task = createTask({ title: 'minimal' });
      expect(task.description).toBeNull();
      expect(task.tags).toEqual([]);
    });
  });

  describe('getTask', () => {
    it('returns null for missing id', () => {
      expect(getTask('does-not-exist')).toBeNull();
    });

    it('returns the created task by id', () => {
      const created = createTask({ title: 'found me' });
      const fetched = getTask(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.title).toBe('found me');
    });
  });

  describe('listTasks', () => {
    it('returns [] when DB is empty', () => {
      expect(listTasks()).toEqual([]);
    });

    it('filters by status', () => {
      createTask({ title: 'a', status: 'inbox' });
      createTask({ title: 'b', status: 'done' });
      createTask({ title: 'c', status: 'done' });

      const done = listTasks({ status: 'done' });
      expect(done).toHaveLength(2);
      expect(done.every((t) => t.status === 'done')).toBe(true);
    });

    it('filters by priority', () => {
      createTask({ title: 'a', priority: 'p0' });
      createTask({ title: 'b', priority: 'p2' });
      createTask({ title: 'c', priority: 'p0' });

      const p0 = listTasks({ priority: 'p0' });
      expect(p0).toHaveLength(2);
      expect(p0.every((t) => t.priority === 'p0')).toBe(true);
    });

    it('filters by agent_only', () => {
      createTask({ title: 'human', agent_executable: false });
      createTask({ title: 'agent', agent_executable: true });

      const agent = listTasks({ agent_only: true });
      expect(agent).toHaveLength(1);
      expect(agent[0]?.title).toBe('agent');
    });

    it('filters by parent_id', () => {
      const parent = createTask({ title: 'parent' });
      createTask({ title: 'kid1', parent_id: parent.id });
      createTask({ title: 'kid2', parent_id: parent.id });
      createTask({ title: 'unrelated' });

      const kids = listTasks({ parent: parent.id });
      expect(kids).toHaveLength(2);
      expect(kids.every((t) => t.parent_id === parent.id)).toBe(true);
    });

    it('combines multiple filters', () => {
      createTask({
        title: 'match',
        status: 'queued',
        priority: 'p1',
        agent_executable: true,
      });
      createTask({
        title: 'wrong status',
        status: 'done',
        priority: 'p1',
        agent_executable: true,
      });
      createTask({
        title: 'wrong priority',
        status: 'queued',
        priority: 'p2',
        agent_executable: true,
      });

      const results = listTasks({
        status: 'queued',
        priority: 'p1',
        agent_only: true,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('match');
    });

    it('filters by status array', () => {
      createTask({ title: 'a', status: 'queued' });
      createTask({ title: 'b', status: 'in_progress' });
      createTask({ title: 'c', status: 'done' });

      const active = listTasks({ status: ['queued', 'in_progress'] });
      expect(active).toHaveLength(2);
    });
  });

  describe('updateTask', () => {
    it('updates fields and refreshes updated_at', async () => {
      const created = createTask({ title: 'original' });
      const originalUpdated = created.updated_at;

      // Sleep so timestamps differ by at least 1ms.
      await new Promise((r) => setTimeout(r, 5));

      const updated = updateTask(created.id, { title: 'edited' });
      expect(updated).not.toBeNull();
      expect(updated?.title).toBe('edited');
      expect(updated?.updated_at).not.toBe(originalUpdated);
    });

    it('leaves created_at intact', async () => {
      const created = createTask({ title: 'unchanging birth' });
      await new Promise((r) => setTimeout(r, 5));
      const updated = updateTask(created.id, { status: 'done' });
      expect(updated?.created_at).toBe(created.created_at);
    });

    it('returns null when target id does not exist', () => {
      expect(updateTask('nope', { title: 'irrelevant' })).toBeNull();
    });

    it('merges patch — untouched fields keep their values', () => {
      const created = createTask({
        title: 'persistent',
        description: 'keep me',
        priority: 'p1',
      });
      const updated = updateTask(created.id, { status: 'in_progress' });
      expect(updated?.description).toBe('keep me');
      expect(updated?.priority).toBe('p1');
      expect(updated?.status).toBe('in_progress');
    });

    it('allows nulling description explicitly', () => {
      const created = createTask({ title: 'nullable', description: 'gone soon' });
      const updated = updateTask(created.id, { description: null });
      expect(updated?.description).toBeNull();
    });
  });

  describe('deleteTask', () => {
    it('removes the row and returns true', () => {
      const created = createTask({ title: 'doomed' });
      expect(deleteTask(created.id)).toBe(true);
      expect(getTask(created.id)).toBeNull();
    });

    it('returns false for missing id', () => {
      expect(deleteTask('not-there')).toBe(false);
    });
  });

  describe('getChildren', () => {
    it('returns only children of the given parent', () => {
      const parent = createTask({ title: 'mom' });
      const otherParent = createTask({ title: 'dad' });
      createTask({ title: 'kid1', parent_id: parent.id });
      createTask({ title: 'kid2', parent_id: parent.id });
      createTask({ title: 'half sib', parent_id: otherParent.id });

      const kids = getChildren(parent.id);
      expect(kids).toHaveLength(2);
      expect(kids.every((t) => t.parent_id === parent.id)).toBe(true);
    });

    it('returns [] when there are no children', () => {
      const parent = createTask({ title: 'lonely' });
      expect(getChildren(parent.id)).toEqual([]);
    });
  });

  describe('JSON serialization', () => {
    it('round-trips a complex context object', () => {
      const context = {
        estimated_minutes: 45,
        review_required: true,
        depends_on: ['abc', 'def'],
        nested: { deep: { value: 'ok', count: 3 } },
        list: [1, 2, 3],
      };
      const created = createTask({ title: 'ctx', context });
      const fetched = getTask(created.id);
      expect(fetched?.context).toEqual(context);
    });

    it('round-trips a tags array', () => {
      const tags = ['work', 'urgent', 'health-care'];
      const created = createTask({ title: 'tagged', tags });
      const fetched = getTask(created.id);
      expect(fetched?.tags).toEqual(tags);
    });

    it('returns empty tags array when not set', () => {
      const created = createTask({ title: 'no tags' });
      expect(createTask({ title: 'x' }).tags).toEqual([]);
      expect(created.tags).toEqual([]);
    });

    it('returns null context when not set', () => {
      const created = createTask({ title: 'no ctx' });
      expect(created.context).toBeNull();
    });
  });
});
