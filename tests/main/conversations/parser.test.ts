/**
 * Tests for the Claude Code JSONL parser. Verifies it tolerates the messy
 * real-world line types and extracts the bits we care about.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSessionFile } from '@/main/conversations/parser';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-parser-'));
  file = path.join(dir, `${SESSION_ID}.jsonl`);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLines(lines: unknown[]): Promise<void> {
  const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await fs.writeFile(file, payload, 'utf8');
}

describe('parseSessionFile', () => {
  it('returns null on empty file', async () => {
    await fs.writeFile(file, '', 'utf8');
    expect(await parseSessionFile(file)).toBeNull();
  });

  it('extracts session id, cwd, model, and message bodies', async () => {
    await writeLines([
      {
        type: 'user',
        sessionId: SESSION_ID,
        cwd: 'C:/Users/Jack/taskpilot',
        gitBranch: 'main',
        timestamp: '2026-05-30T01:00:00.000Z',
        message: { role: 'user', content: 'hello\nworld' },
      },
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [
            { type: 'text', text: 'we decided to ship\nhere is code:' },
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: 'src/x.ts' },
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 200,
          },
        },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe(SESSION_ID);
    expect(result!.cwd).toBe('C:/Users/Jack/taskpilot');
    expect(result!.git_branch).toBe('main');
    expect(result!.model).toBe('claude-opus-4-7');
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].text).toContain('hello');
    expect(result!.messages[1].text).toContain('we decided to ship');
    expect(result!.messages[1].tool_calls).toContain('Read');
    expect(result!.messages[1].files_touched).toContain('src/x.ts');
    expect(result!.input_tokens).toBe(100);
    expect(result!.output_tokens).toBe(50);
    expect(result!.cache_read_tokens).toBe(200);
  });

  it('picks up ai-title and summary lines', async () => {
    await writeLines([
      {
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:00.000Z',
        message: { role: 'user', content: 'first prompt' },
      },
      { type: 'ai-title', sessionId: SESSION_ID, title: 'My Session Title' },
      { type: 'summary', sessionId: SESSION_ID, summary: 'A rolling summary' },
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:05.000Z',
        message: { role: 'assistant', content: 'response' },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result!.ai_title).toBe('My Session Title');
    expect(result!.summary).toBe('A rolling summary');
  });

  it('skips malformed lines without throwing', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      }),
      '{not json',
      JSON.stringify({
        type: 'assistant',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:05.000Z',
        message: { role: 'assistant', content: 'ok' },
      }),
    ];
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    const result = await parseSessionFile(file);
    expect(result!.messages).toHaveLength(2);
  });

  it('extracts fenced code blocks from assistant text', async () => {
    await writeLines([
      {
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:00.000Z',
        message: { role: 'user', content: 'q' },
      },
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'here:\n```ts\nconst x = 1;\nconst y = 2;\n```\nthere',
            },
          ],
        },
      },
    ]);

    const result = await parseSessionFile(file);
    expect(result!.messages[1].code_blocks).toHaveLength(1);
    expect(result!.messages[1].code_blocks[0]).toContain('const x = 1');
  });

  it('produces a stable content hash', async () => {
    await writeLines([
      {
        type: 'user',
        sessionId: SESSION_ID,
        timestamp: '2026-05-30T01:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      },
    ]);
    const a = await parseSessionFile(file);
    const b = await parseSessionFile(file);
    expect(a!.content_hash).toEqual(b!.content_hash);
    expect(a!.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
