import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import {
  createConversation,
  deleteConversation,
  findBySourceId,
  getConversation,
  linkConversationToTask,
  listConversations,
  listLinksForConversation,
  listPendingArchive,
  listPendingCompaction,
  unlinkConversationFromTask,
  updateConversation,
} from '@/main/db/repositories/conversations';
import { createTask } from '@/main/db/repositories/tasks';

function seedConv(overrides: Partial<Parameters<typeof createConversation>[0]> = {}) {
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: `sid-${Math.random().toString(36).slice(2, 8)}`,
    source_path: '/tmp/x.jsonl',
    project_path: 'C:/Users/Jack/taskpilot',
    title: 'Test session',
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: '2026-05-01T01:00:00.000Z',
    model: 'claude-opus-4-7',
    message_count: 12,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: null,
    digest: 'a digest',
    topics: ['taskpilot', 'mcp'],
    key_decisions: ['decided to ship'],
    files_touched: ['src/foo.ts'],
    compressed_at: null,
    archived_at: null,
    content_hash: 'h',
    ...overrides,
  });
}

describe('conversations repository', () => {
  it('round-trips topics, key_decisions, files_touched as arrays', () => {
    const c = seedConv();
    const fetched = getConversation(c.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.topics).toEqual(['taskpilot', 'mcp']);
    expect(fetched!.key_decisions).toEqual(['decided to ship']);
    expect(fetched!.files_touched).toEqual(['src/foo.ts']);
  });

  it('findBySourceId is unique per (source, source_id)', () => {
    const c = seedConv({ source_id: 'unique-1' });
    const found = findBySourceId('claude_code', 'unique-1');
    expect(found?.id).toBe(c.id);
  });

  it('listConversations filters by topic', () => {
    seedConv({ source_id: 's1', topics: ['leal'] });
    seedConv({ source_id: 's2', topics: ['indexthread'] });
    const leal = listConversations({ topic: 'leal' });
    expect(leal).toHaveLength(1);
    expect(leal[0].topics).toContain('leal');
  });

  it('listConversations filters by compressed state', () => {
    seedConv({ source_id: 'live', compressed_at: null });
    seedConv({ source_id: 'comp', compressed_at: '2026-06-01T00:00:00.000Z' });
    expect(listConversations({ compressed: true })).toHaveLength(1);
    expect(listConversations({ compressed: false })).toHaveLength(1);
  });

  it('updateConversation replaces digest + topics atomically', () => {
    const c = seedConv();
    const updated = updateConversation(c.id, {
      digest: 'new summary',
      topics: ['new-topic'],
      compressed_at: '2026-06-01T00:00:00.000Z',
    });
    expect(updated!.digest).toBe('new summary');
    expect(updated!.topics).toEqual(['new-topic']);
    expect(updated!.compressed_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('listPendingCompaction returns rows older than cutoff with no compressed_at', () => {
    const old = seedConv({
      source_id: 'old',
      ended_at: '2026-01-01T00:00:00.000Z',
    });
    seedConv({ source_id: 'recent', ended_at: '2026-06-01T00:00:00.000Z' });
    seedConv({
      source_id: 'already',
      ended_at: '2026-01-01T00:00:00.000Z',
      compressed_at: '2026-05-01T00:00:00.000Z',
    });
    const pending = listPendingCompaction('2026-05-01T00:00:00.000Z');
    expect(pending.map((c) => c.id)).toContain(old.id);
    expect(pending).toHaveLength(1);
  });

  it('listPendingArchive ignores rows with already-cleared source_path', () => {
    const a = seedConv({
      source_id: 'a',
      ended_at: '2025-01-01T00:00:00.000Z',
      source_path: '/tmp/a.jsonl',
    });
    seedConv({
      source_id: 'b',
      ended_at: '2025-01-01T00:00:00.000Z',
      source_path: null,
    });
    const list = listPendingArchive('2026-01-01T00:00:00.000Z');
    expect(list.map((c) => c.id)).toEqual([a.id]);
  });

  it('linkConversationToTask upserts on (conversation_id, task_id)', () => {
    const c = seedConv();
    const task = createTask({ title: 'test task' });
    linkConversationToTask({
      conversation_id: c.id,
      task_id: task.id,
      kind: 'cwd_match',
      confidence: 0.5,
    });
    // Stronger kind upgrades.
    linkConversationToTask({
      conversation_id: c.id,
      task_id: task.id,
      kind: 'manual',
      confidence: 1.0,
    });
    const links = listLinksForConversation(c.id);
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe('manual');
    expect(links[0].confidence).toBe(1.0);
  });

  it('deleteConversation also drops link rows', () => {
    const c = seedConv();
    const task = createTask({ title: 'test task' });
    linkConversationToTask({
      conversation_id: c.id,
      task_id: task.id,
      kind: 'manual',
    });
    expect(deleteConversation(c.id)).toBe(true);
    expect(getConversation(c.id)).toBeNull();
    expect(listLinksForConversation(c.id)).toHaveLength(0);
  });

  it('unlinkConversationFromTask removes a single edge', () => {
    const c = seedConv();
    const task = createTask({ title: 'test task' });
    linkConversationToTask({
      conversation_id: c.id,
      task_id: task.id,
      kind: 'manual',
    });
    expect(unlinkConversationFromTask(c.id, task.id)).toBe(true);
    expect(listLinksForConversation(c.id)).toHaveLength(0);
  });
});
