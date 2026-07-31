import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();
useMockedDb();

import {
  applySummary,
  recompressConversation,
} from '@/main/conversations/compactor';
import {
  createConversation,
  getConversation,
} from '@/main/db/repositories/conversations';

function seed() {
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: 's',
    source_path: '/tmp/a.jsonl',
    project_path: null,
    title: 'T',
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: '2026-05-01T01:00:00.000Z',
    model: null,
    message_count: 1,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: null,
    digest: 'pre',
    topics: [],
    key_decisions: [],
    files_touched: [],
    compressed_at: '2026-05-15T00:00:00.000Z',
    archived_at: null,
    content_hash: 'h',
  });
}

describe('recompressConversation', () => {
  it('clears compressed_at so the row is eligible for dispatch again', async () => {
    const c = seed();
    expect(getConversation(c.id)?.compressed_at).not.toBeNull();
    const updated = await recompressConversation(c.id);
    expect(updated?.compressed_at).toBeNull();
  });

  it('removes any sitting request file', async () => {
    const c = seed();
    const reqPath = path.join(PATHS.IO_SUMMARIZE, `${c.id}.json`);
    await fs.mkdir(path.dirname(reqPath), { recursive: true });
    await fs.writeFile(reqPath, '{"stale": true}', 'utf8');
    await recompressConversation(c.id);
    const stillThere = await fs
      .stat(reqPath)
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);
  });

  it('returns null for an unknown id', async () => {
    const r = await recompressConversation('does-not-exist');
    expect(r).toBeNull();
  });
});

describe('applySummary side effects', () => {
  it('archives any sitting request file to IO_DONE_ARCHIVE_SUMMARIZE', async () => {
    const c = seed();
    // Reset compressed_at so applySummary will set it.
    const reqPath = path.join(PATHS.IO_SUMMARIZE, `${c.id}.json`);
    await fs.mkdir(path.dirname(reqPath), { recursive: true });
    await fs.writeFile(reqPath, '{"placeholder": true}', 'utf8');

    applySummary({
      conversation_id: c.id,
      summarized_at: '2026-06-01T00:00:00.000Z',
      summary: 's',
      topics: [],
      key_decisions: [],
    });

    // Let the void async archive complete.
    await new Promise((r) => setTimeout(r, 100));

    const stillThere = await fs
      .stat(reqPath)
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);

    const archiveEntries = await fs.readdir(PATHS.IO_DONE_ARCHIVE_SUMMARIZE);
    expect(archiveEntries.some((e) => e.includes(c.id))).toBe(true);
  });
});
