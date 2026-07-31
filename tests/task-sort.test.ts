/**
 * Tests for the shared priority-sort helper (`src/renderer/lib/task-sort.ts`).
 *
 * Pins the ordering contract that was previously duplicated across four views,
 * including the one behavioural difference: Board uses `recent:false`
 * (oldest-first) as the final tiebreak, everyone else newest-first.
 */

import { describe, expect, it } from 'vitest';

import {
  PRIORITY_ORDER,
  PRIORITY_RANK,
  sortByPriority,
} from '@/renderer/lib/task-sort';
import type { Task } from '@/shared/types';

function t(partial: Partial<Task>): Task {
  return {
    id: 'x',
    title: 'x',
    description: null,
    status: 'inbox',
    priority: 'p2',
    due: null,
    calendar_event_id: null,
    parent_id: null,
    agent_executable: false,
    agent_method: 'human_only',
    agent_instructions: null,
    agent_status: 'pending',
    context: null,
    tags: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Task;
}

describe('sortByPriority', () => {
  it('orders by priority first (p0 → p3)', () => {
    const out = sortByPriority([
      t({ id: 'b', priority: 'p3' }),
      t({ id: 'a', priority: 'p0' }),
      t({ id: 'c', priority: 'p2' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('breaks priority ties by earliest due, nulls last', () => {
    const out = sortByPriority([
      t({ id: 'none', priority: 'p1', due: null }),
      t({ id: 'late', priority: 'p1', due: '2026-03-01T00:00:00Z' }),
      t({ id: 'soon', priority: 'p1', due: '2026-02-01T00:00:00Z' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['soon', 'late', 'none']);
  });

  it('defaults to newest-created first on a full tie', () => {
    const out = sortByPriority([
      t({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      t({ id: 'new', created_at: '2026-06-01T00:00:00Z' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['new', 'old']);
  });

  it('recent:false flips the tiebreak to oldest-first (Board)', () => {
    const out = sortByPriority(
      [
        t({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
        t({ id: 'new', created_at: '2026-06-01T00:00:00Z' }),
      ],
      { recent: false },
    );
    expect(out.map((x) => x.id)).toEqual(['old', 'new']);
  });

  it('does not mutate the input array', () => {
    const input = [t({ id: 'b', priority: 'p3' }), t({ id: 'a', priority: 'p0' })];
    const snapshot = input.map((x) => x.id);
    sortByPriority(input);
    expect(input.map((x) => x.id)).toEqual(snapshot);
  });

  it('exposes consistent rank + order constants', () => {
    expect(PRIORITY_ORDER).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(PRIORITY_ORDER.map((p) => PRIORITY_RANK[p])).toEqual([0, 1, 2, 3]);
  });
});
