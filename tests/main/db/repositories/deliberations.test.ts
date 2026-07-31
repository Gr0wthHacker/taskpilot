/**
 * Deliberations repository tests.
 *
 * Verifies the create / complete / markTerminal / find lifecycle and the
 * JSON-column round-trip behaviour (observation_ids + raw_result).
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../../helpers/mock-paths';
import { useMockedDb } from '../../../helpers/mock-db';

mockTaskpilotPaths();

import {
  completeDeliberation,
  countDeliberations,
  createDeliberation,
  findDeliberationByBatchId,
  getDeliberation,
  listDeliberations,
  markDeliberationTerminal,
} from '@/main/db/repositories/deliberations';

describe('deliberations repository — create + read', () => {
  useMockedDb();

  it('inserts a pending row and returns it via getDeliberation', () => {
    const row = createDeliberation({
      batch_id: 'batch_abc',
      observation_ids: ['obs1', 'obs2'],
      trigger_reason: 'batch_size',
    });
    expect(row.status).toBe('pending');
    expect(row.batch_id).toBe('batch_abc');
    expect(row.observation_ids).toEqual(['obs1', 'obs2']);
    expect(row.decision).toBeNull();
    expect(row.surfaced_as).toBeNull();
    expect(row.raw_result).toBeNull();

    const fetched = getDeliberation(row.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.batch_id).toBe('batch_abc');
    expect(fetched?.observation_ids).toEqual(['obs1', 'obs2']);
  });

  it('round-trips observation_ids as a JSON-encoded string', () => {
    const ids = ['x', 'y', 'z', 'aaa', 'bbb'];
    const row = createDeliberation({
      batch_id: 'b1',
      observation_ids: ids,
      trigger_reason: 'manual',
    });
    const fetched = getDeliberation(row.id);
    expect(fetched?.observation_ids).toEqual(ids);
  });

  it('findDeliberationByBatchId returns the most recent matching row', () => {
    const first = createDeliberation({
      batch_id: 'batch_dup',
      observation_ids: ['obs1'],
      trigger_reason: 'batch_size',
      requested_at: '2026-01-01T00:00:00Z',
    });
    const second = createDeliberation({
      batch_id: 'batch_dup',
      observation_ids: ['obs2'],
      trigger_reason: 'manual',
      requested_at: '2026-02-01T00:00:00Z',
    });
    const found = findDeliberationByBatchId('batch_dup');
    expect(found?.id).toBe(second.id);
    expect(first.id).not.toBe(second.id);
  });
});

describe('deliberations repository — complete + terminal', () => {
  useMockedDb();

  it('completeDeliberation flips status to completed and persists scores', () => {
    const row = createDeliberation({
      batch_id: 'batch_done',
      observation_ids: ['o1'],
      trigger_reason: 'batch_size',
    });
    const updated = completeDeliberation(row.id, {
      interrupter_score: 0.8,
      waiter_score: 0.3,
      decision: 'interrupt',
      surfaced_as: 'task',
      surfaced_id: 'task_xyz',
      summary: 'urgent context shift',
      raw_result: { batch_id: 'batch_done', decision: 'interrupt' },
    });
    expect(updated?.status).toBe('completed');
    expect(updated?.interrupter_score).toBe(0.8);
    expect(updated?.waiter_score).toBe(0.3);
    expect(updated?.decision).toBe('interrupt');
    expect(updated?.surfaced_as).toBe('task');
    expect(updated?.surfaced_id).toBe('task_xyz');
    expect(updated?.summary).toBe('urgent context shift');
    expect(updated?.raw_result).toEqual({ batch_id: 'batch_done', decision: 'interrupt' });
    expect(updated?.result_at).toBeTruthy();
  });

  it('completeDeliberation returns null for an unknown id', () => {
    const result = completeDeliberation('nope', {
      interrupter_score: 0,
      waiter_score: 0,
      decision: 'wait',
      surfaced_as: 'none',
    });
    expect(result).toBeNull();
  });

  it('markDeliberationTerminal flips status to failed or skipped', () => {
    const row = createDeliberation({
      batch_id: 'batch_fail',
      observation_ids: ['o1'],
      trigger_reason: 'manual',
    });
    const failed = markDeliberationTerminal(row.id, 'failed', 'parse error');
    expect(failed?.status).toBe('failed');
    expect(failed?.summary).toBe('parse error');

    const other = createDeliberation({
      batch_id: 'batch_skip',
      observation_ids: ['o1'],
      trigger_reason: 'hotkey',
    });
    const skipped = markDeliberationTerminal(other.id, 'skipped');
    expect(skipped?.status).toBe('skipped');
  });
});

describe('deliberations repository — list + count', () => {
  useMockedDb();

  it('filters by status and counts correctly', () => {
    createDeliberation({
      batch_id: 'b1',
      observation_ids: ['o1'],
      trigger_reason: 'batch_size',
    });
    const second = createDeliberation({
      batch_id: 'b2',
      observation_ids: ['o2'],
      trigger_reason: 'manual',
    });
    completeDeliberation(second.id, {
      interrupter_score: 0.5,
      waiter_score: 0.7,
      decision: 'wait',
      surfaced_as: 'none',
    });

    const pending = listDeliberations({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.batch_id).toBe('b1');

    expect(countDeliberations({ status: 'pending' })).toBe(1);
    expect(countDeliberations({ status: 'completed' })).toBe(1);
    expect(countDeliberations({})).toBe(2);
  });
});
