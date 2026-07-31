/**
 * Compactor smoke test — dispatch a request, write a fake response, ingest.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();
useMockedDb();

import {
  dispatchPendingCompactions,
  ingestPendingSummaries,
  archiveOldSources,
} from '@/main/conversations/compactor';
import {
  createConversation,
  getConversation,
} from '@/main/db/repositories/conversations';
import { settingsRepository } from '@/main/db/repositories/settings';

const OLD_TS = '2024-01-01T00:00:00.000Z';

beforeEach(() => {
  settingsRepository.set('conversations_enabled', true);
  settingsRepository.set('conversation_compression_days', 30);
});

function seedOldConv(suffix = '1') {
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: `old-${suffix}`,
    source_path: '/tmp/a.jsonl',
    project_path: 'C:/Users/Jack/taskpilot',
    title: 'Old session',
    started_at: OLD_TS,
    ended_at: OLD_TS,
    model: 'claude-opus-4-7',
    message_count: 5,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: null,
    digest: 'pre-compression digest',
    topics: ['taskpilot'],
    key_decisions: [],
    files_touched: [],
    compressed_at: null,
    archived_at: null,
    content_hash: 'h',
  });
}

describe('conversations compactor', () => {
  it('dispatches summarize requests for old non-compressed rows', async () => {
    const conv = seedOldConv();
    const result = await dispatchPendingCompactions();
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    const expected = path.join(PATHS.IO_SUMMARIZE, `${conv.id}.json`);
    const exists = await fs
      .stat(expected)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('does not re-dispatch if a request file is already present', async () => {
    seedOldConv();
    await dispatchPendingCompactions();
    const second = await dispatchPendingCompactions();
    expect(second.dispatched).toBe(0);
  });

  it('ingests a valid summarize response and updates the row', async () => {
    const conv = seedOldConv();
    await dispatchPendingCompactions();

    const responsePath = path.join(PATHS.IO_SUMMARIZED, `${conv.id}.json`);
    const response = {
      conversation_id: conv.id,
      summarized_at: '2026-06-01T00:00:00.000Z',
      summary: 'A compressed summary of what happened.',
      topics: ['taskpilot', 'mcp'],
      key_decisions: ['decided to ship'],
      title: 'Compressed title',
    };
    await fs.writeFile(responsePath, JSON.stringify(response), 'utf8');

    const result = await ingestPendingSummaries();
    expect(result.ingested).toBe(1);

    const updated = getConversation(conv.id);
    expect(updated!.digest).toBe(response.summary);
    expect(updated!.topics).toEqual(['taskpilot', 'mcp']);
    expect(updated!.key_decisions).toEqual(['decided to ship']);
    expect(updated!.compressed_at).toBe(response.summarized_at);
    expect(updated!.title).toBe('Compressed title');
  });

  it('archiveOldSources clears source_path past retention', () => {
    const conv = seedOldConv('arch');
    settingsRepository.set('conversation_retention_days', 1);
    const result = archiveOldSources();
    expect(result.archived).toBeGreaterThanOrEqual(1);
    const updated = getConversation(conv.id);
    expect(updated!.source_path).toBeNull();
    expect(updated!.archived_at).not.toBeNull();
  });

  it('skips when conversations_enabled is false', async () => {
    seedOldConv();
    settingsRepository.set('conversations_enabled', false);
    const result = await dispatchPendingCompactions();
    expect(result.dispatched).toBe(0);
  });
});
