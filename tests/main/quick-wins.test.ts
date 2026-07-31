/**
 * Tests for the "Found a moment" pure filter — gating, sort, auto-energy.
 */

import { describe, expect, it } from 'vitest';

import {
  deriveAutoEnergy,
  pickQuickWins,
  readEstimatedMinutes,
  readTaskEnergy,
} from '@/shared/quick-wins';
import type { Task, TaskPriority, TaskStatus } from '@/shared/types';

function makeTask(overrides: Partial<Task> & {
  estimated_minutes?: number;
  energy?: 'low' | 'medium' | 'high';
}): Task {
  const ctx: Record<string, unknown> = {};
  if (overrides.estimated_minutes !== undefined) {
    ctx.estimated_minutes = overrides.estimated_minutes;
  }
  if (overrides.energy !== undefined) ctx.energy = overrides.energy;
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Some task',
    description: null,
    status: (overrides.status ?? 'queued') as TaskStatus,
    priority: (overrides.priority ?? 'p2') as TaskPriority,
    due: null,
    calendar_event_id: null,
    parent_id: null,
    agent_executable: true,
    agent_method: 'cli',
    agent_instructions: null,
    agent_status: 'pending',
    context: Object.keys(ctx).length > 0 ? ctx : null,
    tags: overrides.tags ?? [],
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z',
  };
}

describe('shared/quick-wins', () => {
  it('reads estimated_minutes off context, null when missing', () => {
    expect(readEstimatedMinutes(makeTask({ estimated_minutes: 12 }))).toBe(12);
    expect(readEstimatedMinutes(makeTask({}))).toBeNull();
  });

  it('reads energy off context, null when invalid', () => {
    expect(readTaskEnergy(makeTask({ energy: 'low' }))).toBe('low');
    expect(
      readTaskEnergy(
        makeTask({}) // no context
      ),
    ).toBeNull();
  });

  it('filters to inbox/queued tasks with an estimate within the budget', () => {
    const tasks = [
      makeTask({ id: 't1', estimated_minutes: 10, status: 'queued' }),
      makeTask({ id: 't2', estimated_minutes: 60, status: 'queued' }), // too long
      makeTask({ id: 't3', estimated_minutes: 5, status: 'done' }), // wrong status
      makeTask({ id: 't4', status: 'inbox' }), // no estimate
      makeTask({ id: 't5', estimated_minutes: 12, status: 'inbox' }),
    ];
    const picked = pickQuickWins(tasks, { minutes: 15 }).map((t) => t.id);
    expect(picked).toEqual(['t1', 't5']);
  });

  it('respects the energy ceiling — low cap excludes medium/high', () => {
    const tasks = [
      makeTask({ id: 'low', estimated_minutes: 5, energy: 'low' }),
      makeTask({ id: 'med', estimated_minutes: 5, energy: 'medium' }),
      makeTask({ id: 'high', estimated_minutes: 5, energy: 'high' }),
      makeTask({ id: 'noenergy', estimated_minutes: 5 }),
    ];
    expect(
      pickQuickWins(tasks, { minutes: 10, energy: 'low' }).map((t) => t.id),
    ).toEqual(['low']);
    // Default energy cap is medium — high excluded, unset treated as medium.
    expect(
      pickQuickWins(tasks, { minutes: 10 }).map((t) => t.id).sort(),
    ).toEqual(['low', 'med', 'noenergy'].sort());
  });

  it('sorts by priority, then estimate, then recency', () => {
    const tasks = [
      makeTask({
        id: 'p2-late',
        estimated_minutes: 5,
        priority: 'p2',
        updated_at: '2026-01-02T00:00:00Z',
      }),
      makeTask({
        id: 'p0-bigger',
        estimated_minutes: 10,
        priority: 'p0',
      }),
      makeTask({
        id: 'p2-early',
        estimated_minutes: 5,
        priority: 'p2',
        updated_at: '2026-01-01T00:00:00Z',
      }),
      makeTask({
        id: 'p1-small',
        estimated_minutes: 3,
        priority: 'p1',
      }),
    ];
    expect(
      pickQuickWins(tasks, { minutes: 15 }).map((t) => t.id),
    ).toEqual(['p0-bigger', 'p1-small', 'p2-late', 'p2-early']);
  });

  it('deriveAutoEnergy maps minutes to a default energy bucket', () => {
    expect(deriveAutoEnergy(5)).toBe('low');
    expect(deriveAutoEnergy(15)).toBe('low');
    expect(deriveAutoEnergy(30)).toBe('medium');
    expect(deriveAutoEnergy(120)).toBe('high');
    expect(deriveAutoEnergy(undefined)).toBeNull();
  });
});
