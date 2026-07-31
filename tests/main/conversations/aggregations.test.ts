import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import {
  aggregateTopics,
  createConversation,
  rollupByDay,
} from '@/main/db/repositories/conversations';

function conv(over: Partial<Parameters<typeof createConversation>[0]> = {}) {
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: `s-${Math.random().toString(36).slice(2)}`,
    source_path: null,
    project_path: null,
    title: 'T',
    started_at: '2026-05-30T00:00:00.000Z',
    ended_at: '2026-05-30T01:00:00.000Z',
    model: null,
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
    ...over,
  });
}

describe('aggregateTopics', () => {
  it('sums conversation_count and total_tokens per topic', () => {
    conv({ topics: ['leal', 'mcp'], input_tokens: 100, output_tokens: 100 });
    conv({ topics: ['leal'], input_tokens: 200, output_tokens: 0 });
    conv({ topics: ['indexthread'], input_tokens: 50, output_tokens: 0 });
    const topics = aggregateTopics();
    const leal = topics.find((t) => t.topic === 'leal');
    expect(leal?.conversation_count).toBe(2);
    expect(leal?.total_tokens).toBe(400);
    const mcp = topics.find((t) => t.topic === 'mcp');
    expect(mcp?.conversation_count).toBe(1);
  });

  it('returns sorted by count descending', () => {
    conv({ topics: ['a'] });
    conv({ topics: ['a'] });
    conv({ topics: ['b'] });
    const topics = aggregateTopics();
    expect(topics[0].topic).toBe('a');
    expect(topics[1].topic).toBe('b');
  });
});

describe('rollupByDay', () => {
  it('groups by date and surfaces top topics', () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const today = new Date().toISOString();
    conv({ ended_at: today, topics: ['x'], files_touched: ['a.ts'] });
    conv({ ended_at: today, topics: ['x', 'y'], files_touched: ['b.ts'] });
    conv({ ended_at: recent, topics: ['z'], files_touched: ['c.ts'] });
    const rollup = rollupByDay(7);
    expect(rollup.length).toBeGreaterThanOrEqual(2);
    const todayBucket = rollup.find((r) => r.date === today.slice(0, 10));
    expect(todayBucket?.sessions).toBe(2);
    expect(todayBucket?.top_topics).toContain('x');
  });

  it('excludes conversations older than the window', () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    conv({ ended_at: old });
    const rollup = rollupByDay(7);
    expect(rollup).toHaveLength(0);
  });
});
