/**
 * Auto completion summary tests (Wave 16).
 *
 * Coverage:
 *   - Pure heuristic {@link summarizeTaskCompletion} across every variant:
 *       failure, artifacts (PR), files-only, default (time/cost), bare.
 *   - The ~140 char clamp.
 *   - The store-side {@link generateAndStoreCompletionSummary} writes onto
 *     `context.completion_summary` for a done task, leaves a blocked task
 *     untouched, and produces a "Failed: …" line for a failed task.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import {
  __internals,
  generateAndStoreCompletionSummary,
  MAX_SUMMARY_CHARS,
  summarizeTaskCompletion,
} from '@/main/auto-summary';
import { createTask, getTask } from '@/main/db/repositories/tasks';
import { executionLogsRepository } from '@/main/db/repositories/execution-logs';
import type { JournalEvent } from '@/shared/api-contract';
import type { OutputBundle, Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function fakeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: 'task_abc12345',
    title: 'Test task',
    description: null,
    status: 'done',
    priority: 'p2',
    due: null,
    calendar_event_id: null,
    parent_id: null,
    agent_executable: true,
    agent_method: 'cli',
    agent_instructions: null,
    agent_status: 'succeeded',
    context: null,
    tags: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function emptyBundle(overrides: Partial<OutputBundle> = {}): OutputBundle {
  return {
    task_id: 'task_abc12345',
    generated_at: new Date().toISOString(),
    summary: null,
    files: [],
    artifacts: [],
    attachments: [],
    metrics: {
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      time_to_done_hours: null,
      last_confidence: null,
      execution_count: 0,
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Pure heuristic                                                            */
/* -------------------------------------------------------------------------- */

describe('summarizeTaskCompletion — variants', () => {
  it('failure variant from journal error', () => {
    const journal: JournalEvent[] = [
      {
        at: new Date().toISOString(),
        kind: 'result_ingested',
        title: 'Result ingested — failed',
        details: { status: 'failed', error: 'npm install exploded' },
      },
    ];
    const out = summarizeTaskCompletion(
      fakeTask({ status: 'failed' }),
      emptyBundle(),
      journal,
    );
    expect(out.startsWith('Failed:')).toBe(true);
    expect(out).toContain('npm install exploded');
  });

  it('failure variant from task status with no journal', () => {
    const out = summarizeTaskCompletion(
      fakeTask({ status: 'failed' }),
      emptyBundle({ summary: 'could not reach API' }),
      [],
    );
    expect(out).toBe('Failed: could not reach API');
  });

  it('artifacts variant — opened PR', () => {
    const bundle = emptyBundle({
      artifacts: [
        { kind: 'github_pr', url: 'https://github.com/x/y/pull/42', number: 42, state: 'open' },
      ],
    });
    const out = summarizeTaskCompletion(fakeTask(), bundle, []);
    expect(out).toContain('opened PR #42');
    expect(out.startsWith('Done:')).toBe(true);
  });

  it('artifacts variant — PR wins over a file and counts extras', () => {
    const bundle = emptyBundle({
      files: [
        { path: '/out/report.md', size_bytes: 10, content_type: 'text/markdown', added_at: new Date().toISOString() },
      ],
      artifacts: [
        { kind: 'github_pr', url: 'https://github.com/x/y/pull/7', number: 7, state: 'open' },
        { kind: 'calendar_event', event_id: 'evt1' },
      ],
    });
    const out = summarizeTaskCompletion(fakeTask(), bundle, []);
    expect(out).toContain('opened PR #7');
    expect(out).toContain('+1 more');
  });

  it('files-only variant names the files', () => {
    const bundle = emptyBundle({
      files: [
        { path: '/io/out/brief.md', size_bytes: 1, content_type: 'text/markdown', added_at: new Date().toISOString() },
        { path: '/io/out/data.csv', size_bytes: 1, content_type: 'text/csv', added_at: new Date().toISOString() },
      ],
    });
    const out = summarizeTaskCompletion(fakeTask(), bundle, []);
    expect(out).toContain('produced 2 files');
    expect(out).toContain('brief.md');
    expect(out).toContain('data.csv');
  });

  it('default variant uses time + cost', () => {
    const bundle = emptyBundle({
      metrics: {
        total_cost_usd: 0.1234,
        total_input_tokens: 0,
        total_output_tokens: 0,
        time_to_done_hours: 12.7,
        last_confidence: null,
        execution_count: 1,
      },
    });
    const out = summarizeTaskCompletion(fakeTask(), bundle, []);
    expect(out).toContain('Done in 12.7h');
    expect(out).toContain('$0.12');
  });

  it('falls back to a bare "Done." when nothing measurable', () => {
    const out = summarizeTaskCompletion(fakeTask(), emptyBundle(), []);
    expect(out).toBe('Done.');
  });

  it('uses the result summary when no metrics, files, or artifacts', () => {
    const out = summarizeTaskCompletion(
      fakeTask(),
      emptyBundle({ summary: 'tidied the inbox' }),
      [],
    );
    expect(out).toBe('Done: tidied the inbox');
  });

  it('clamps to MAX_SUMMARY_CHARS', () => {
    const long = 'x'.repeat(500);
    const out = summarizeTaskCompletion(
      fakeTask({ status: 'failed' }),
      emptyBundle({ summary: long }),
      [],
    );
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Internal formatters                                                       */
/* -------------------------------------------------------------------------- */

describe('auto-summary — formatters', () => {
  it('formatDuration renders minutes, hours, days', () => {
    expect(__internals.formatDuration(0.5)).toBe('30m');
    expect(__internals.formatDuration(12.7)).toBe('12.7h');
    expect(__internals.formatDuration(2)).toBe('2h');
    expect(__internals.formatDuration(72)).toBe('3d');
    expect(__internals.formatDuration(0)).toBeNull();
    expect(__internals.formatDuration(null)).toBeNull();
  });

  it('formatCost rounds and floors sub-cent', () => {
    expect(__internals.formatCost(0.005)).toBe('<$0.01');
    expect(__internals.formatCost(1.239)).toBe('$1.24');
    expect(__internals.formatCost(0)).toBeNull();
  });

  it('fileBasename strips directories on both slash styles', () => {
    expect(__internals.fileBasename('/a/b/c.md')).toBe('c.md');
    expect(__internals.fileBasename('C:\\x\\y\\z.csv')).toBe('z.csv');
  });
});

/* -------------------------------------------------------------------------- */
/*  Store-side helper                                                         */
/* -------------------------------------------------------------------------- */

describe('generateAndStoreCompletionSummary', () => {
  useMockedDb();

  it('stores a summary onto context for a done task', async () => {
    const t = createTask({ title: 'Done task', status: 'done' });
    // Give it a measurable execution log so time-to-done is computable.
    executionLogsRepository.create({
      task_id: t.id,
      method: 'cli',
      status: 'succeeded',
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      completed_at: new Date().toISOString(),
    });
    const summary = await generateAndStoreCompletionSummary(t.id);
    expect(summary).toBeTruthy();
    const reloaded = getTask(t.id);
    const ctx = reloaded?.context as Record<string, unknown> | null;
    expect(ctx?.completion_summary).toBe(summary);
    expect(ctx?.completion_summary_at).toBeTruthy();
  });

  it('leaves a blocked task untouched', async () => {
    const t = createTask({ title: 'Blocked task', status: 'blocked' });
    const summary = await generateAndStoreCompletionSummary(t.id);
    expect(summary).toBeNull();
    const reloaded = getTask(t.id);
    const ctx = reloaded?.context as Record<string, unknown> | null;
    expect(ctx?.completion_summary).toBeUndefined();
  });

  it('writes a Failed: summary for a failed task', async () => {
    const t = createTask({ title: 'Failed task', status: 'failed' });
    executionLogsRepository.create({
      task_id: t.id,
      method: 'cli',
      status: 'failed',
      error: 'boom',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      completed_at: new Date().toISOString(),
    });
    const summary = await generateAndStoreCompletionSummary(t.id);
    expect(summary?.startsWith('Failed')).toBe(true);
  });

  it('returns null for an unknown task id', async () => {
    const summary = await generateAndStoreCompletionSummary('nope_nope_123');
    expect(summary).toBeNull();
  });

  it('preserves existing context keys', async () => {
    const t = createTask({
      title: 'Has context',
      status: 'done',
      context: { phase: 'ship', custom: 1 },
    });
    await generateAndStoreCompletionSummary(t.id);
    const reloaded = getTask(t.id);
    const ctx = reloaded?.context as Record<string, unknown> | null;
    expect(ctx?.phase).toBe('ship');
    expect(ctx?.custom).toBe(1);
    expect(ctx?.completion_summary).toBeTruthy();
  });

  it('keeps the stored summary within the char cap', async () => {
    const t = createTask({ title: 'Cap check', status: 'done' });
    const summary = await generateAndStoreCompletionSummary(t.id);
    expect((summary ?? '').length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it('avoids using updateTask when there is nothing to summarize is not a concern — confirm idempotence', async () => {
    const t = createTask({ title: 'Twice', status: 'done' });
    const first = await generateAndStoreCompletionSummary(t.id);
    const second = await generateAndStoreCompletionSummary(t.id);
    expect(second).toBe(first);
  });
});
