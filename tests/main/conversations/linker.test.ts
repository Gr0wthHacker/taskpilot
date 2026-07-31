/**
 * Tests for the auto-linker.
 *
 * Verifies that all four signals (session_pin, cwd_match, file overlap as
 * cwd_match-equivalent, tag_match) fire correctly and that the upsert
 * priority lets a stronger signal upgrade a previous match.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import { autoLinkConversation } from '@/main/conversations/linker';
import type { ParsedSession } from '@/main/conversations/parser';
import {
  createConversation,
  listLinksForConversation,
} from '@/main/db/repositories/conversations';
import { createTask, updateTask } from '@/main/db/repositories/tasks';

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  const now = new Date().toISOString();
  return {
    session_id: 'sess-abc',
    cwd: 'C:/Users/Jack/taskpilot',
    git_branch: 'main',
    model: 'claude-opus-4-7',
    started_at: now,
    ended_at: now,
    messages: [
      {
        role: 'user',
        timestamp: now,
        text: 'hi',
        code_blocks: [],
        files_touched: [],
        tool_calls: [],
      },
    ],
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    ai_title: null,
    summary: null,
    content_hash: 'h',
    bytes: 0,
    ...overrides,
  };
}

function makeConv() {
  const now = new Date().toISOString();
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: 'sess-abc',
    source_path: '/tmp/x.jsonl',
    project_path: 'C:/Users/Jack/taskpilot',
    title: 't',
    started_at: now,
    ended_at: now,
    model: 'claude-opus-4-7',
    message_count: 1,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: null,
    digest: '',
    topics: [],
    key_decisions: [],
    files_touched: [],
    compressed_at: null,
    archived_at: null,
    content_hash: 'h',
  });
}

describe('autoLinkConversation', () => {
  it('links via session_pin when task.context.claude_session_id matches', () => {
    const conv = makeConv();
    const task = createTask({
      title: 'pinned',
      context: { claude_session_id: 'sess-abc' },
    });
    const session = makeSession();
    const result = autoLinkConversation(conv.id, session, []);
    expect(result.linkedTaskIds).toContain(task.id);
    const links = listLinksForConversation(conv.id);
    expect(links[0].kind).toBe('session_pin');
    expect(links[0].confidence).toBe(1);
  });

  it('links via cwd_match when task.context.cwd matches the session cwd', () => {
    const conv = makeConv();
    const task = createTask({
      title: 'cwd matched',
      context: { cwd: 'C:/Users/Jack/taskpilot' },
    });
    const session = makeSession();
    autoLinkConversation(conv.id, session, []);
    const links = listLinksForConversation(conv.id);
    const link = links.find((l) => l.task_id === task.id);
    expect(link?.kind).toBe('cwd_match');
  });

  it('links via file overlap when task.context.attachments overlaps session.files_touched', () => {
    const conv = makeConv();
    const task = createTask({
      title: 'file overlap',
      context: { attachments: ['src/foo.ts'] },
    });
    const session = makeSession({
      cwd: 'C:/Users/Jack/elsewhere',
      messages: [
        {
          role: 'user',
          timestamp: '2026-06-01T01:00:00.000Z',
          text: 'q',
          code_blocks: [],
          files_touched: ['src/foo.ts'],
          tool_calls: [],
        },
      ],
    });
    autoLinkConversation(conv.id, session, []);
    const links = listLinksForConversation(conv.id);
    const link = links.find((l) => l.task_id === task.id);
    expect(link?.kind).toBe('cwd_match');
  });

  it('links via tag_match when session topics overlap task tags', () => {
    const conv = makeConv();
    const task = createTask({
      title: 'tagged',
      tags: ['leal'],
    });
    const session = makeSession({ cwd: 'C:/elsewhere' });
    autoLinkConversation(conv.id, session, ['leal']);
    const links = listLinksForConversation(conv.id);
    const link = links.find((l) => l.task_id === task.id);
    expect(link?.kind).toBe('tag_match');
    expect(link?.confidence).toBeCloseTo(0.4);
  });

  it('upgrades tag_match → session_pin on a second pass', () => {
    const conv = makeConv();
    const task = createTask({
      title: 'upgrade',
      tags: ['leal'],
    });
    autoLinkConversation(conv.id, makeSession({ cwd: 'C:/elsewhere' }), ['leal']);
    expect(listLinksForConversation(conv.id)[0].kind).toBe('tag_match');
    updateTask(task.id, {
      context: { claude_session_id: 'sess-abc' },
    });
    autoLinkConversation(conv.id, makeSession({ cwd: 'C:/elsewhere' }), ['leal']);
    expect(listLinksForConversation(conv.id)[0].kind).toBe('session_pin');
  });
});
