/**
 * Ingestion tests — the consumer side of the two-agent deliberation.
 *
 * Verifies that `ingestDeliberation` routes each decision branch correctly:
 *   - decision='wait'                      → completes row with surfaced_as='none'
 *   - decision='interrupt' + create_task   → spawns a task with origin tag
 *   - decision='interrupt' + notify        → fires a notification, surfaced_as='notification'
 *   - confidence < threshold               → downgraded to 'none' (no surfacing)
 *   - quiet hours + create_task            → downgraded to 'notify'
 *   - missing batch row                    → returns null
 */

import { describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();

// Stub the Electron notifications module BEFORE importing the ingestion
// module — otherwise the lazy import in `fireNotification` will pull in the
// real Electron-bound module in tests that don't have an Electron runtime.
const notifyMock = vi.fn();
vi.mock('@/main/notifications', () => ({
  notify: (opts: { title: string; body: string }) => notifyMock(opts),
}));

import { ingestDeliberation } from '@/main/deliberation/ingestion';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { settingsRepository } from '@/main/db/repositories/settings';
import { tasksRepository } from '@/main/db/repositories/tasks';
import type { DeliberationResult } from '@/shared/io-schemas';

function seedPending(batchId: string): string {
  const row = deliberationsRepository.create({
    batch_id: batchId,
    observation_ids: ['obs1'],
    trigger_reason: 'batch_size',
  });
  return row.id;
}

function buildResult(overrides: Partial<DeliberationResult> = {}): DeliberationResult {
  const base: DeliberationResult = {
    batch_id: 'b_default',
    completed_at: '2026-06-01T12:00:00Z',
    interrupter: {
      score: 0.8,
      reasoning: 'high signal',
      proposed_action: {
        type: 'create_task',
        title: 'follow up on draft',
        body: 'context bundle suggests action',
        priority: 'med',
      },
    },
    waiter: { score: 0.3, reasoning: 'routine' },
    decision: 'interrupt',
    summary: 'urgent context shift detected',
    confidence: 0.8,
  };
  return { ...base, ...overrides };
}

describe('ingestDeliberation — create_task path', () => {
  useMockedDb();

  it('creates a task with origin=ambient_deliberation and back-ref context', async () => {
    const delibId = seedPending('b_task1');
    notifyMock.mockClear();

    const result = buildResult({ batch_id: 'b_task1' });
    const updated = await ingestDeliberation(result);

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('completed');
    expect(updated?.decision).toBe('interrupt');
    expect(updated?.surfaced_as).toBe('task');
    expect(updated?.summary).toBe('urgent context shift detected');

    const surfacedTaskId = updated?.surfaced_id;
    expect(surfacedTaskId).toBeTruthy();
    const task = tasksRepository.findById(surfacedTaskId as string);
    expect(task?.title).toBe('follow up on draft');
    expect(task?.tags).toContain('ambient_deliberation');
    expect(task?.context).toMatchObject({
      origin: 'ambient_deliberation',
      deliberation_id: delibId,
      batch_id: 'b_task1',
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe('ingestDeliberation — notify path', () => {
  useMockedDb();

  it("fires a notification when the proposed action type is 'notify'", async () => {
    seedPending('b_notify1');
    notifyMock.mockClear();

    const result = buildResult({
      batch_id: 'b_notify1',
      interrupter: {
        score: 0.7,
        reasoning: 'medium signal',
        proposed_action: {
          type: 'notify',
          title: 'Heads up',
          body: 'something to watch',
        },
      },
    });

    const updated = await ingestDeliberation(result);
    expect(updated?.surfaced_as).toBe('notification');
    expect(updated?.surfaced_id).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
      title: 'Heads up',
      body: 'something to watch',
    });
  });
});

describe('ingestDeliberation — wait path', () => {
  useMockedDb();

  it("records the row with surfaced_as='none' on a wait decision", async () => {
    seedPending('b_wait1');
    notifyMock.mockClear();

    const result = buildResult({
      batch_id: 'b_wait1',
      decision: 'wait',
      waiter: { score: 0.9, reasoning: 'noise' },
      interrupter: { score: 0.2, reasoning: 'weak' },
      confidence: 0.9,
    });

    const updated = await ingestDeliberation(result);
    expect(updated?.decision).toBe('wait');
    expect(updated?.surfaced_as).toBe('none');
    expect(updated?.surfaced_id).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe('ingestDeliberation — confidence threshold', () => {
  useMockedDb();

  it('downgrades a low-confidence interrupt to no surfacing', async () => {
    seedPending('b_lowconf');
    notifyMock.mockClear();
    // Threshold tighter than the result's confidence.
    settingsRepository.set('ambient_deliberation_confidence_threshold', 0.9);

    const result = buildResult({
      batch_id: 'b_lowconf',
      confidence: 0.55,
    });

    const updated = await ingestDeliberation(result);
    expect(updated?.surfaced_as).toBe('none');
    expect(updated?.surfaced_id).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe('ingestDeliberation — quiet hours', () => {
  useMockedDb();

  it("downgrades 'create_task' to 'notify' when quiet hours are active", async () => {
    seedPending('b_quiet');
    notifyMock.mockClear();

    // Force quiet hours to cover the entire day.
    settingsRepository.set('ambient_deliberation_quiet_hours', '00:00-23:59');

    const result = buildResult({ batch_id: 'b_quiet' });
    const updated = await ingestDeliberation(result);

    expect(updated?.surfaced_as).toBe('notification');
    expect(notifyMock).toHaveBeenCalledTimes(1);
    // No task spawned even though the action type was 'create_task'.
    const allTasks = tasksRepository.list({});
    expect(allTasks).toHaveLength(0);
  });
});

describe('ingestDeliberation — missing batch row', () => {
  useMockedDb();

  it('returns null without throwing when no pending row matches', async () => {
    const result = buildResult({ batch_id: 'unknown_batch' });
    const updated = await ingestDeliberation(result);
    expect(updated).toBeNull();
  });
});
