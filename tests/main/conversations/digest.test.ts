import { describe, expect, it } from 'vitest';

import { buildDigest } from '@/main/conversations/digest';
import type { ParsedSession } from '@/main/conversations/parser';

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    session_id: 's1',
    cwd: 'C:/Users/Jack/taskpilot',
    git_branch: 'main',
    model: 'claude-opus-4-7',
    started_at: '2026-05-30T01:00:00.000Z',
    ended_at: '2026-05-30T02:00:00.000Z',
    messages: [],
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

describe('buildDigest', () => {
  it('prefers ai_title when present', () => {
    const session = makeSession({
      ai_title: 'My Title',
      messages: [
        {
          role: 'user',
          timestamp: '2026-05-30T01:00:00.000Z',
          text: 'A different first prompt',
          code_blocks: [],
          files_touched: [],
          tool_calls: [],
        },
      ],
    });
    const d = buildDigest(session);
    expect(d.title).toBe('My Title');
  });

  it('falls back to first-line of first user message', () => {
    const session = makeSession({
      messages: [
        {
          role: 'user',
          timestamp: '2026-05-30T01:00:00.000Z',
          text: 'Write the launch email\nmore detail here',
          code_blocks: [],
          files_touched: [],
          tool_calls: [],
        },
      ],
    });
    expect(buildDigest(session).title).toBe('Write the launch email');
  });

  it('picks up known business topics regardless of casing', () => {
    const session = makeSession({
      messages: [
        {
          role: 'user',
          timestamp: '2026-05-30T01:00:00.000Z',
          text: 'help with Leal Health pricing and IndexThread strategy',
          code_blocks: [],
          files_touched: [],
          tool_calls: [],
        },
      ],
    });
    const topics = buildDigest(session).topics;
    expect(topics).toContain('leal health');
    expect(topics).toContain('indexthread');
  });

  it('extracts file extensions from tool calls', () => {
    const session = makeSession({
      messages: [
        {
          role: 'assistant',
          timestamp: '2026-05-30T01:00:00.000Z',
          text: '[tool: Read]',
          code_blocks: [],
          files_touched: ['src/foo.tsx', 'README.md'],
          tool_calls: ['Read'],
        },
      ],
    });
    const topics = buildDigest(session).topics;
    expect(topics).toContain('.tsx');
    expect(topics).toContain('.md');
  });

  it('detects decision-shaped statements', () => {
    const session = makeSession({
      messages: [
        {
          role: 'assistant',
          timestamp: '2026-05-30T01:00:00.000Z',
          text: 'OK, we decided to use Supabase for auth. The plan is to ship by Friday.',
          code_blocks: [],
          files_touched: [],
          tool_calls: [],
        },
      ],
    });
    const decisions = buildDigest(session).key_decisions;
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    expect(decisions.some((d) => d.toLowerCase().includes('decided to'))).toBe(
      true,
    );
    expect(decisions.some((d) => d.toLowerCase().includes('the plan is'))).toBe(
      true,
    );
  });

  it('caps digest text under the budget', () => {
    const big = 'x'.repeat(50_000);
    const session = makeSession({
      messages: [
        {
          role: 'user',
          timestamp: '2026-05-30T01:00:00.000Z',
          text: big,
          code_blocks: [],
          files_touched: [],
          tool_calls: [],
        },
        {
          role: 'assistant',
          timestamp: '2026-05-30T01:00:01.000Z',
          text: big,
          code_blocks: [big],
          files_touched: [],
          tool_calls: [],
        },
      ],
    });
    const d = buildDigest(session);
    expect(d.digest.length).toBeLessThanOrEqual(8_000);
  });
});
