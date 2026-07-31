/**
 * Tests for the SessionEnd TODO/Next/Tomorrow extractor — the pure half of
 * the auto-derive flow. Filesystem reads live in the script; the regex +
 * dedup logic lives in `src/main/businesses/todo-extractor` and is the
 * subject of these tests.
 */

import { describe, expect, it } from 'vitest';

import {
  extractMessageText,
  extractTodos,
  TODO_LINE_RX,
} from '@/main/businesses/todo-extractor';

function jsonl(messages: Array<{ role: string; text: string }>): string {
  return (
    messages
      .map((m) =>
        JSON.stringify({
          type: m.role === 'user' ? 'user' : 'assistant',
          message: { role: m.role, content: m.text },
        }),
      )
      .join('\n') + '\n'
  );
}

describe('businesses/todo-extractor', () => {
  it('regex catches the canonical labels', () => {
    const cases = [
      'TODO: rewrite the pricing page',
      '- TODO: rewrite the pricing page',
      'Next: ship the new auth middleware',
      'Next step: ship the new auth middleware',
      'Tomorrow: send the deck to legal',
      "Don't forget: file the patent",
      'Follow up: ping Chris about the QBR',
      'Action item: write the briefing doc',
      '**TODO**: bold-wrapped label',
    ];
    for (const c of cases) {
      const m = TODO_LINE_RX.exec(c);
      expect(m, `expected match for ${JSON.stringify(c)}`).not.toBeNull();
      expect(m?.[1]?.length).toBeGreaterThan(3);
    }
  });

  it('regex does NOT catch incidental mentions', () => {
    const misses = [
      'the TODO list said something earlier',
      'we put it on a TODO somewhere',
      'looking at the next iteration',
      'tomorrow morning standup is at 9',
    ];
    for (const c of misses) {
      expect(TODO_LINE_RX.exec(c), `should not match: ${c}`).toBeNull();
    }
  });

  it('extracts text content from both string and array message shapes', () => {
    expect(extractMessageText({ message: { content: 'hello' } })).toBe('hello');
    expect(
      extractMessageText({
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', input: {} },
            { type: 'text', text: 'second' },
          ],
        },
      }),
    ).toBe('first\nsecond');
    expect(extractMessageText(null)).toBe('');
    expect(extractMessageText({})).toBe('');
  });

  it('returns inbox candidates from a JSONL with forward-looking lines', () => {
    const text = jsonl([
      { role: 'user', text: 'lets do stuff' },
      {
        role: 'assistant',
        text: 'Plan:\n- Step one done\n- TODO: rewrite the pricing page\n- Next: ship the auth migration',
      },
      { role: 'assistant', text: "Don't forget: file the patent" },
    ]);
    const matches = extractTodos(text);
    expect(matches.map((m) => m.title)).toEqual([
      'rewrite the pricing page',
      'ship the auth migration',
      'file the patent',
    ]);
  });

  it('dedupes by lowercased title across multiple message frames', () => {
    const text = jsonl([
      { role: 'assistant', text: 'TODO: rewrite the pricing page' },
      { role: 'assistant', text: 'TODO: Rewrite The Pricing Page' },
      { role: 'assistant', text: 'TODO: rewrite the pricing page' },
    ]);
    const matches = extractTodos(text);
    expect(matches).toHaveLength(1);
  });

  it('honors the maxDrops cap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `TODO: thing number ${i}`);
    const text = jsonl([{ role: 'assistant', text: lines.join('\n') }]);
    const matches = extractTodos(text, { maxDrops: 3 });
    expect(matches).toHaveLength(3);
  });

  it('ignores malformed JSONL lines without throwing', () => {
    const text =
      'not-json\n' +
      JSON.stringify({
        message: { content: 'TODO: real one' },
      }) +
      '\nalso-not-json\n';
    const matches = extractTodos(text);
    expect(matches.map((m) => m.title)).toEqual(['real one']);
  });

  it('skips trivial / too-short titles', () => {
    const text = jsonl([{ role: 'assistant', text: 'TODO: x' }]);
    expect(extractTodos(text)).toHaveLength(0);
  });

  it('only scans the tail when the transcript is huge', () => {
    const oldStuff = Array.from({ length: 100 }, () => ({
      role: 'assistant',
      text: 'TODO: ancient ignored task',
    }));
    const recent = [{ role: 'assistant', text: 'TODO: recent visible task' }];
    const text = jsonl([...oldStuff, ...recent]);
    const matches = extractTodos(text, { tailMessages: 5 });
    // Only the last 5 messages were scanned; the recent line should appear
    // and the dedup means the ancient lines (if any leaked in via the tail)
    // would still be one entry. With tailMessages=5 only the very last few
    // frames are visible, so the recent title wins.
    expect(matches.map((m) => m.title)).toContain('recent visible task');
  });
});
