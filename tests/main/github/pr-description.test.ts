/**
 * Tests for auto-PR description generator.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import { createTask } from '@/main/db/repositories/tasks';
import { decisionsRepository } from '@/main/db/repositories/decisions';
import { generatePrDescription } from '@/main/github/pr-description';

describe('github/pr-description', () => {
  it('returns null when the task is unknown', () => {
    expect(
      generatePrDescription({ task_id: 'doesntExist1234' }),
    ).toBeNull();
  });

  it('builds a body using description + tags', () => {
    const task = createTask({
      title: 'Add per-business cost rollup',
      description: 'Aggregate Claude cost per business by repo CWD matching.',
      tags: ['leal-health', 'cost'],
    });
    const generated = generatePrDescription({ task_id: task.id });
    expect(generated).not.toBeNull();
    expect(generated!.title).toBe('Add per-business cost rollup');
    expect(generated!.body).toContain('## Summary');
    expect(generated!.body).toContain('Aggregate Claude cost');
    expect(generated!.body).toContain('## Tags');
    expect(generated!.body).toMatch(/`leal-health`/);
  });

  it('includes commit subjects when passed', () => {
    const task = createTask({ title: 'Ship X', description: 'do the thing' });
    const generated = generatePrDescription({
      task_id: task.id,
      commit_subjects: ['add module', 'wire route', 'fix test'],
    });
    expect(generated!.body).toContain('## What changed');
    expect(generated!.body).toContain('- add module');
    expect(generated!.body).toContain('- wire route');
    expect(generated!.sources.commit_count).toBe(3);
  });

  it('pulls decisions onto the body', () => {
    const task = createTask({ title: 'Refactor auth', description: 'rework' });
    decisionsRepository.create({
      task_id: task.id,
      category: 'rationale',
      text: 'Chose JWT over sessions for stateless scale.',
      author: 'jack',
      link: null,
    });
    const generated = generatePrDescription({ task_id: task.id });
    expect(generated!.body).toContain('## Decisions / trade-offs');
    expect(generated!.body).toContain('Chose JWT over sessions');
    expect(generated!.sources.decision_count).toBe(1);
  });

  it('falls back to agent_instructions when description is empty', () => {
    const task = createTask({
      title: 'Boot task: refresh snapshots',
      agent_instructions: 'For each business, refresh STATUS.md…',
    });
    const generated = generatePrDescription({ task_id: task.id });
    expect(generated!.body).toContain('For each business');
  });

  it('falls back to title when both description and instructions are empty', () => {
    const task = createTask({ title: 'just a title' });
    const generated = generatePrDescription({ task_id: task.id });
    expect(generated!.body).toContain('Implements: just a title');
  });
});
