/**
 * Tests for the programmatic submit_summary path (MCP tool + HTTP endpoint
 * call this). Verifies applySummary updates the row, re-indexes, propagates
 * decisions to linked tasks, and emits the conversation_ingested event.
 */

import { describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import { applySummary } from '@/main/conversations/compactor';
import {
  createConversation,
  getConversation,
  linkConversationToTask,
} from '@/main/db/repositories/conversations';
import { listDecisionsForTask } from '@/main/decisions';
import { createTask } from '@/main/db/repositories/tasks';
import { ioEvents } from '@/main/io/events';

function conv() {
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: 'sess-1',
    source_path: '/tmp/x.jsonl',
    project_path: null,
    title: 'before',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T01:00:00.000Z',
    model: null,
    message_count: 1,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: null,
    digest: 'old digest',
    topics: ['old'],
    key_decisions: [],
    files_touched: [],
    compressed_at: null,
    archived_at: null,
    content_hash: 'h',
  });
}

describe('applySummary', () => {
  it('updates digest, topics, decisions, title, compressed_at', () => {
    const c = conv();
    const r = applySummary({
      conversation_id: c.id,
      summarized_at: '2026-06-01T00:00:00.000Z',
      summary: 'NEW SUMMARY',
      topics: ['fresh'],
      key_decisions: ['we decided to ship'],
      title: 'after',
    });
    expect(r.ok).toBe(true);
    const updated = getConversation(c.id);
    expect(updated?.digest).toBe('NEW SUMMARY');
    expect(updated?.topics).toEqual(['fresh']);
    expect(updated?.key_decisions).toEqual(['we decided to ship']);
    expect(updated?.title).toBe('after');
    expect(updated?.compressed_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns ok=false when the conversation id is unknown', () => {
    const r = applySummary({
      conversation_id: 'does-not-exist',
      summarized_at: '2026-06-01T00:00:00.000Z',
      summary: 'x',
      topics: [],
      key_decisions: [],
    });
    expect(r.ok).toBe(false);
  });

  it('propagates new decisions to linked tasks', () => {
    const c = conv();
    const task = createTask({ title: 'linked' });
    linkConversationToTask({
      conversation_id: c.id,
      task_id: task.id,
      kind: 'manual',
    });
    applySummary({
      conversation_id: c.id,
      summarized_at: '2026-06-01T00:00:00.000Z',
      summary: 'x',
      topics: [],
      key_decisions: ['we decided to ship the new flow'],
    });
    const decisions = listDecisionsForTask(task.id);
    expect(
      decisions.some(
        (d) =>
          d.category === 'decision' &&
          d.text === 'we decided to ship the new flow',
      ),
    ).toBe(true);
  });

  it('emits conversation_ingested with kind=compressed', () => {
    const c = conv();
    const spy = vi.fn();
    ioEvents.on('conversation_ingested', spy);
    try {
      applySummary({
        conversation_id: c.id,
        summarized_at: '2026-06-01T00:00:00.000Z',
        summary: 's',
        topics: [],
        key_decisions: [],
      });
      expect(spy).toHaveBeenCalled();
      const payload = spy.mock.calls[0][0];
      expect(payload.kind).toBe('compressed');
      expect(payload.conversationId).toBe(c.id);
    } finally {
      ioEvents.removeAllListeners('conversation_ingested');
    }
  });
});
