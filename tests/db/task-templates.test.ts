/**
 * Task templates repository unit tests.
 *
 * Mirrors `tests/db/tasks.test.ts` — fresh in-memory DB per test via the
 * mock-db helper. Covers CRUD, the {{variable}} substitution path through
 * `materializeTemplate`, and the "deleting a template doesn't cascade to its
 * spawned tasks" invariant.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from '../helpers/mock-db';

import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  materializeTemplate,
  updateTemplate,
  __testing,
} from '@/main/db/repositories/task-templates';
import { getTask, listTasks } from '@/main/db/repositories/tasks';

describe('task templates repository', () => {
  useMockedDb();

  describe('createTemplate', () => {
    it('generates an id when none supplied', () => {
      const tmpl = createTemplate({ name: 'demo', task_title: 'hello' });
      expect(tmpl.id).toBeDefined();
      expect(tmpl.id.length).toBe(12);
    });

    it('respects an explicit id', () => {
      const tmpl = createTemplate({
        id: 'template_xy1',
        name: 'demo',
        task_title: 'hello',
      });
      expect(tmpl.id).toBe('template_xy1');
    });

    it('defaults optional fields to null / empty array', () => {
      const tmpl = createTemplate({ name: 'demo', task_title: 'hello' });
      expect(tmpl.description).toBeNull();
      expect(tmpl.task_description).toBeNull();
      expect(tmpl.priority).toBeNull();
      expect(tmpl.agent_method).toBeNull();
      expect(tmpl.agent_instructions).toBeNull();
      expect(tmpl.tags).toEqual([]);
      expect(tmpl.context).toBeNull();
    });

    it('round-trips tags and context as JSON', () => {
      const tmpl = createTemplate({
        name: 'rich',
        task_title: 't',
        tags: ['a', 'b'],
        context: { foo: 1, bar: 'baz' },
      });
      const fetched = getTemplate(tmpl.id);
      expect(fetched?.tags).toEqual(['a', 'b']);
      expect(fetched?.context).toEqual({ foo: 1, bar: 'baz' });
    });
  });

  describe('listTemplates', () => {
    it('returns [] when empty', () => {
      expect(listTemplates()).toEqual([]);
    });

    it('sorts by name asc', () => {
      createTemplate({ name: 'zebra', task_title: 'z' });
      createTemplate({ name: 'apple', task_title: 'a' });
      createTemplate({ name: 'mango', task_title: 'm' });
      const list = listTemplates();
      expect(list.map((t) => t.name)).toEqual(['apple', 'mango', 'zebra']);
    });
  });

  describe('updateTemplate', () => {
    it('returns null for missing id', () => {
      expect(updateTemplate('does-not-exist', { name: 'x' })).toBeNull();
    });

    it('patches only provided fields', () => {
      const tmpl = createTemplate({
        name: 'orig',
        task_title: 'orig title',
        priority: 'p2',
      });
      const updated = updateTemplate(tmpl.id, { name: 'renamed' });
      expect(updated?.name).toBe('renamed');
      expect(updated?.task_title).toBe('orig title');
      expect(updated?.priority).toBe('p2');
    });

    it('can null out an optional field', () => {
      const tmpl = createTemplate({
        name: 'has-desc',
        task_title: 't',
        task_description: 'orig',
      });
      const updated = updateTemplate(tmpl.id, { task_description: null });
      expect(updated?.task_description).toBeNull();
    });

    it('bumps updated_at', async () => {
      const tmpl = createTemplate({ name: 't', task_title: 't' });
      // 1ms hop so the ISO timestamp can differ.
      await new Promise((r) => setTimeout(r, 5));
      const updated = updateTemplate(tmpl.id, { name: 'renamed' });
      expect(updated?.updated_at).not.toBe(tmpl.updated_at);
    });
  });

  describe('deleteTemplate', () => {
    it('removes the row', () => {
      const tmpl = createTemplate({ name: 't', task_title: 't' });
      expect(deleteTemplate(tmpl.id)).toBe(true);
      expect(getTemplate(tmpl.id)).toBeNull();
    });

    it('returns false for unknown id', () => {
      expect(deleteTemplate('nope_nope_no')).toBe(false);
    });

    it('does NOT cascade to tasks spawned from it', () => {
      const tmpl = createTemplate({
        name: 'reusable',
        task_title: 'spawned title',
      });
      const spawned = materializeTemplate(tmpl.id);
      expect(spawned).not.toBeNull();
      deleteTemplate(tmpl.id);
      // Task still exists, untouched.
      const fetched = getTask(spawned!.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.title).toBe('spawned title');
    });
  });

  describe('materializeTemplate', () => {
    it('returns null for missing id', () => {
      expect(materializeTemplate('does-not-exist')).toBeNull();
    });

    it('creates a fresh task from the template fields', () => {
      const tmpl = createTemplate({
        name: 'weekly review',
        task_title: 'Weekly review',
        task_description: 'Review the week',
        priority: 'p1',
        agent_method: 'human_only',
        tags: ['ops'],
      });
      const task = materializeTemplate(tmpl.id);
      expect(task).not.toBeNull();
      expect(task!.title).toBe('Weekly review');
      expect(task!.description).toBe('Review the week');
      expect(task!.priority).toBe('p1');
      expect(task!.agent_method).toBe('human_only');
      expect(task!.tags).toEqual(['ops']);
      // Lives in the tasks table.
      expect(listTasks()).toHaveLength(1);
    });

    it('applies override fields verbatim', () => {
      const tmpl = createTemplate({
        name: 't',
        task_title: 'orig',
        priority: 'p2',
      });
      const task = materializeTemplate(tmpl.id, {
        title: 'override title',
        priority: 'p0',
        due: '2026-12-31T09:00:00.000Z',
      });
      expect(task!.title).toBe('override title');
      expect(task!.priority).toBe('p0');
      expect(task!.due).toBe('2026-12-31T09:00:00.000Z');
    });

    it('substitutes {{variable}} placeholders in title and description', () => {
      const tmpl = createTemplate({
        name: 'review',
        task_title: 'Review — {{week}}',
        task_description: 'For week {{week}} owned by {{owner}}.',
      });
      const task = materializeTemplate(tmpl.id, {
        variables: { week: '2026-W22', owner: 'Jack' },
      });
      expect(task!.title).toBe('Review — 2026-W22');
      expect(task!.description).toBe('For week 2026-W22 owned by Jack.');
    });

    it('leaves untouched any placeholders without a matching variable', () => {
      const tmpl = createTemplate({
        name: 't',
        task_title: 'Hello {{name}} from {{place}}',
      });
      const task = materializeTemplate(tmpl.id, {
        variables: { name: 'Jack' },
      });
      // {{place}} stays literal — caller forgot to provide it.
      expect(task!.title).toBe('Hello Jack from {{place}}');
    });

    it('falls back to defaults when template fields are null', () => {
      const tmpl = createTemplate({ name: 't', task_title: 'just title' });
      const task = materializeTemplate(tmpl.id);
      expect(task!.priority).toBe('p2');
      expect(task!.agent_method).toBe('human_only');
      expect(task!.agent_executable).toBe(false);
    });

    it('sets agent_executable based on agent_method override', () => {
      const tmpl = createTemplate({ name: 't', task_title: 't' });
      const task = materializeTemplate(tmpl.id, { agent_method: 'cli' });
      expect(task!.agent_method).toBe('cli');
      expect(task!.agent_executable).toBe(true);
    });
  });

  describe('substitute helper', () => {
    it('tolerates spaces around the key', () => {
      expect(__testing.substitute('Hello {{ name }}!', { name: 'world' })).toBe(
        'Hello world!',
      );
    });

    it('returns source unchanged when no variables', () => {
      expect(__testing.substitute('plain text', undefined)).toBe('plain text');
      expect(__testing.substitute('plain text', {})).toBe('plain text');
    });

    it('returns null for null source', () => {
      expect(__testing.substitute(null, { x: 'y' })).toBeNull();
    });
  });
});
