/**
 * Tests for the three audit-fix paths:
 *   - deleteConversation drops FTS5 rows (best-effort lazy import)
 *   - manual link via repo + propagate path
 *   - per-project rollup
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import {
  createConversation,
  deleteConversation,
  linkConversationToTask,
  rollupByProject,
} from '@/main/db/repositories/conversations';
import { createTask } from '@/main/db/repositories/tasks';
import { propagateToTask } from '@/main/conversations/side-effects';
import { listDecisionsForTask } from '@/main/decisions';

function seed(overrides: Partial<Parameters<typeof createConversation>[0]> = {}) {
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: `s-${Math.random().toString(36).slice(2)}`,
    source_path: '/tmp/a.jsonl',
    project_path: 'C:/repo/a',
    title: 'T',
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: '2026-05-01T01:00:00.000Z',
    model: 'claude-opus-4-7',
    message_count: 1,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0.01,
    digest: '',
    topics: [],
    key_decisions: [],
    files_touched: [],
    compressed_at: null,
    archived_at: null,
    content_hash: 'h',
    ...overrides,
  });
}

describe('deleteConversation', () => {
  it('removes the row and link rows; does not throw if FTS5 cleanup unavailable', () => {
    const c = seed();
    const task = createTask({ title: 't' });
    linkConversationToTask({
      conversation_id: c.id,
      task_id: task.id,
      kind: 'manual',
    });
    expect(deleteConversation(c.id)).toBe(true);
    expect(deleteConversation(c.id)).toBe(false); // already gone
  });
});

describe('side-effects on manual link', () => {
  it('files-touched is consolidated into a single decision row', () => {
    const task = createTask({ title: 't' });
    const c = seed({
      files_touched: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    propagateToTask(c, task.id, []);
    const refs = listDecisionsForTask(task.id).filter(
      (d) =>
        d.category === 'reference' && d.text.startsWith('Touched 3 files'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].text).toContain('src/a.ts');
    expect(refs[0].text).toContain('src/b.ts');
    expect(refs[0].text).toContain('src/c.ts');
  });
});

describe('rollupByProject', () => {
  it('groups by project_path and sums tokens + cost', () => {
    seed({ project_path: 'C:/repo/a', input_tokens: 100, output_tokens: 0, cost_usd: 0.05 });
    seed({ project_path: 'C:/repo/a', input_tokens: 200, output_tokens: 0, cost_usd: 0.10 });
    seed({ project_path: 'C:/repo/b', input_tokens: 50, output_tokens: 0, cost_usd: 0.01 });
    seed({ project_path: null, input_tokens: 10, output_tokens: 0, cost_usd: 0 });
    const rollup = rollupByProject();
    const a = rollup.find((r) => r.project_path === 'C:/repo/a');
    expect(a?.sessions).toBe(2);
    expect(a?.total_tokens).toBe(300);
    expect(a?.total_cost_usd).toBeCloseTo(0.15);
    const unknown = rollup.find((r) => r.project_path === '(unknown)');
    expect(unknown?.sessions).toBe(1);
  });

  it('sorts by total_cost_usd desc', () => {
    seed({ project_path: 'cheap', cost_usd: 0.01 });
    seed({ project_path: 'expensive', cost_usd: 5 });
    const rollup = rollupByProject();
    expect(rollup[0].project_path).toBe('expensive');
  });
});
