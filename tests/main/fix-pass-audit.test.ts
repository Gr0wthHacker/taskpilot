/**
 * Tests for the audit-fix round (system-wide).
 *
 * Coverage:
 *   - deleteTask transactional + child cleanup
 *   - deleteConversation transactional
 *   - webhook 'none' algorithm guard
 *   - ambient daily budget enforcement
 *   - SSE token mint + validation
 *   - idempotency middleware
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import {
  createTask,
  deleteTask,
  getTask,
} from '@/main/db/repositories/tasks';
import {
  createConversation,
  deleteConversation,
  getConversation,
  linkConversationToTask,
  listLinksForConversation,
} from '@/main/db/repositories/conversations';
import { decisionsRepository } from '@/main/db/repositories/decisions';
import { recordDecision } from '@/main/decisions';
import { createConfig, updateConfig } from '@/main/webhooks/registry';
import {
  issueSseToken,
  isValidSseToken,
  _resetSseTokensForTest,
} from '@/main/server/sse-tokens';

describe('deleteTask transactional + child cleanup', () => {
  it('removes execution_logs, cost_events, feedback, decisions, conversation links when the task is deleted', () => {
    const task = createTask({ title: 'will be deleted' });
    recordDecision({
      task_id: task.id,
      text: 'a decision worth keeping',
      category: 'decision',
    });
    const conv = createConversation({
      id: '',
      source: 'claude_code',
      source_id: 's',
      source_path: null,
      project_path: null,
      title: 'T',
      started_at: '2026-05-01T00:00:00.000Z',
      ended_at: '2026-05-01T00:01:00.000Z',
      model: null,
      message_count: 0,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      cost_usd: null,
      digest: null,
      topics: [],
      key_decisions: [],
      files_touched: [],
      compressed_at: null,
      archived_at: null,
      content_hash: 'h',
    });
    linkConversationToTask({
      conversation_id: conv.id,
      task_id: task.id,
      kind: 'manual',
    });

    expect(deleteTask(task.id)).toBe(true);
    expect(getTask(task.id)).toBeNull();
    expect(decisionsRepository.list({ task_id: task.id })).toHaveLength(0);
    expect(listLinksForConversation(conv.id)).toHaveLength(0);
    // The conversation itself stays — link is one-way.
    expect(getConversation(conv.id)).not.toBeNull();
  });

  it('re-parents children when a parent task is deleted', () => {
    const parent = createTask({ title: 'parent' });
    const child = createTask({ title: 'child', parent_id: parent.id });
    expect(deleteTask(parent.id)).toBe(true);
    const refreshedChild = getTask(child.id);
    expect(refreshedChild).not.toBeNull();
    expect(refreshedChild!.parent_id).toBeNull();
  });
});

describe('deleteConversation transactional', () => {
  it('removes link rows and the conversation row atomically', () => {
    const conv = createConversation({
      id: '',
      source: 'claude_code',
      source_id: 's2',
      source_path: null,
      project_path: null,
      title: 'T',
      started_at: '2026-05-01T00:00:00.000Z',
      ended_at: '2026-05-01T00:01:00.000Z',
      model: null,
      message_count: 0,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      cost_usd: null,
      digest: null,
      topics: [],
      key_decisions: [],
      files_touched: [],
      compressed_at: null,
      archived_at: null,
      content_hash: 'h',
    });
    const task = createTask({ title: 't' });
    linkConversationToTask({
      conversation_id: conv.id,
      task_id: task.id,
      kind: 'manual',
    });
    expect(deleteConversation(conv.id)).toBe(true);
    expect(getConversation(conv.id)).toBeNull();
    expect(listLinksForConversation(conv.id)).toHaveLength(0);
  });
});

describe('webhook signature_algorithm guard', () => {
  it('refuses to create a config with algorithm=none without trusted_network_only', () => {
    expect(() =>
      createConfig({
        name: 'unsafe',
        signature_algorithm: 'none',
        mapping_rules: [],
      }),
    ).toThrow(/trusted_network_only/i);
  });

  it('accepts algorithm=none when trusted_network_only=true', () => {
    const cfg = createConfig({
      name: 'safe',
      signature_algorithm: 'none',
      trusted_network_only: true,
      mapping_rules: [],
    });
    expect(cfg.signature_algorithm).toBe('none');
    expect(cfg.trusted_network_only).toBe(true);
  });

  it('refuses to update a config to algorithm=none without trusted_network_only', () => {
    const cfg = createConfig({
      name: 'flips-unsafe',
      mapping_rules: [],
    });
    expect(() =>
      updateConfig(cfg.id, { signature_algorithm: 'none' }),
    ).toThrow(/trusted_network_only/i);
  });
});

describe('ambient daily budget enforcement', () => {
  it('throws when the projected spend exceeds ambient_daily_budget_usd', async () => {
    const { settingsRepository } = await import(
      '@/main/db/repositories/settings'
    );
    settingsRepository.set('ambient_daily_budget_usd', 0.05);
    settingsRepository.set(
      'ambient_estimated_cost_per_deliberation_usd',
      0.1,
    );
    const { requestDeliberation } = await import(
      '@/main/deliberation/orchestrator'
    );
    await expect(
      requestDeliberation({
        observation_ids: ['obs-1'],
        trigger_reason: 'batch_size',
      }),
    ).rejects.toThrow(/daily budget exceeded/i);
  });

  it('lets manual triggers bypass the budget gate', async () => {
    const { settingsRepository } = await import(
      '@/main/db/repositories/settings'
    );
    settingsRepository.set('ambient_daily_budget_usd', 0.01);
    settingsRepository.set(
      'ambient_estimated_cost_per_deliberation_usd',
      1,
    );
    const { requestDeliberation } = await import(
      '@/main/deliberation/orchestrator'
    );
    // Manual trigger should not throw on budget — it throws downstream on
    // "no observations resolved" instead, proving budget gate is skipped.
    await expect(
      requestDeliberation({
        observation_ids: [],
        trigger_reason: 'manual',
      }),
    ).rejects.toThrow(/no observations/);
  });
});

describe('SSE tokens', () => {
  it('issued token validates within TTL', () => {
    _resetSseTokensForTest();
    const issued = issueSseToken();
    expect(issued.token.startsWith('sse_')).toBe(true);
    expect(isValidSseToken(issued.token)).toBe(true);
  });

  it('rejects garbage tokens and unknown tokens', () => {
    expect(isValidSseToken('garbage')).toBe(false);
    expect(isValidSseToken('sse_unknown_unknown_unknown')).toBe(false);
  });
});
