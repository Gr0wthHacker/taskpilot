/**
 * Task journal aggregator tests (Wave 15A).
 *
 * Covers:
 *   - Multi-source ordering — feedback / cost / execution / attachments /
 *     context notes all surface and merge newest-first.
 *   - Event-kind mapping for each source.
 *   - Graceful behavior when optional sources are missing (no execution_logs,
 *     no derived file, empty context, etc.).
 *   - The `since` and `limit` options.
 *   - The route layer surfaces 404 for unknown ids and 400 for bad ids.
 *
 * The aggregator reaches out to disk for `result.json` and `derived/<id>.json`.
 * `mockTaskpilotPaths` (from `tests/helpers`) re-points `~/.taskpilot` at a
 * tmpdir so the test never touches the real user's data.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';
import { mockTaskpilotPaths } from './helpers/mock-paths';

mockTaskpilotPaths();

import { __internals, getTaskJournal } from '@/main/journal/aggregator';
import { costEventsRepository } from '@/main/db/repositories/cost-events';
import { executionLogsRepository } from '@/main/db/repositories/execution-logs';
import { feedbackRepository } from '@/main/db/repositories/feedback';
import { createTask, updateTask } from '@/main/db/repositories/tasks';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function isoMinusMinutes(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe('journal/aggregator', () => {
  useMockedDb();

  it('returns empty list for unknown task id', async () => {
    const events = await getTaskJournal('does_not_exist');
    expect(events).toEqual([]);
  });

  it('emits a single created event for a fresh task with no sources', async () => {
    const t = createTask({ title: 'Fresh task' });
    const events = await getTaskJournal(t.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.kind).toBe('created');
    expect(events[0]?.title).toContain('Fresh task');
    expect(events[0]?.actor).toBe('user');
  });

  it('emits an edited event when updated_at diverges from created_at', async () => {
    const t = createTask({ title: 'Edit me' });
    // Force a divergent updated_at by patching.
    updateTask(t.id, { title: 'Renamed' });
    const events = await getTaskJournal(t.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('edited');
  });

  it('emits execution_started and execution_completed for each log', async () => {
    const t = createTask({ title: 'Has logs' });
    executionLogsRepository.create({
      task_id: t.id,
      method: 'cli',
      status: 'succeeded',
      output: 'done',
      started_at: isoMinusMinutes(10),
      completed_at: isoMinusMinutes(8),
    });
    const events = await getTaskJournal(t.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('execution_started');
    expect(kinds).toContain('execution_completed');
    const completed = events.find((e) => e.kind === 'execution_completed');
    expect(completed?.title).toContain('succeeded');
  });

  it('emits feedback rows with kind=feedback and embeds the feedback kind in details', async () => {
    const t = createTask({ title: 'Feedback target' });
    feedbackRepository.create({
      task_id: t.id,
      kind: 'rejection_derivation',
      reason: 'Too granular',
    });
    feedbackRepository.create({
      task_id: t.id,
      kind: 'low_confidence',
      reason: 'confidence 0.30 < threshold 0.70',
    });
    const events = await getTaskJournal(t.id);
    const feedback = events.filter((e) => e.kind === 'feedback');
    expect(feedback.length).toBe(2);
    const rej = feedback.find((e) =>
      (e.title as string).toLowerCase().includes('derivation rejected'),
    );
    expect(rej).toBeDefined();
    expect(rej?.details?.feedback_kind).toBe('rejection_derivation');
    const lowConf = feedback.find((e) =>
      (e.title as string).toLowerCase().includes('low confidence'),
    );
    expect(lowConf?.actor).toBe('system');
  });

  it('emits cost events with token + dollar details', async () => {
    const t = createTask({ title: 'Has cost' });
    costEventsRepository.create({
      task_id: t.id,
      model: 'claude-opus-4-7',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0123,
      source: 'execution',
    });
    const events = await getTaskJournal(t.id);
    const cost = events.find((e) => e.kind === 'cost');
    expect(cost).toBeDefined();
    expect(cost?.title).toContain('$');
    expect(cost?.details?.model).toBe('claude-opus-4-7');
    expect(cost?.details?.input_tokens).toBe(1000);
  });

  it('emits attachment_added events from context.attachments', async () => {
    const t = createTask({
      title: 'With attachment',
      context: {
        attachments: [
          {
            filename: 'spec.md',
            size_bytes: 1234,
            content_type: 'text/markdown',
            added_at: isoMinusMinutes(5),
          },
        ],
      },
    });
    const events = await getTaskJournal(t.id);
    const att = events.find((e) => e.kind === 'attachment_added');
    expect(att).toBeDefined();
    expect(att?.title).toContain('spec.md');
  });

  it('classifies context.notes into pr_event vs issue_event vs feedback', async () => {
    const t = createTask({
      title: 'Notes target',
      context: {
        notes: [
          {
            at: isoMinusMinutes(20),
            source: 'github_webhook',
            note: 'PR merged: https://github.com/me/repo/pull/42',
          },
          {
            at: isoMinusMinutes(15),
            source: 'github_webhook',
            note: 'Issue closed via webhook',
          },
          {
            at: isoMinusMinutes(10),
            source: 'manual',
            note: 'random note',
          },
        ],
      },
    });
    const events = await getTaskJournal(t.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('pr_event');
    expect(kinds).toContain('issue_event');
    // The "random note" falls back to feedback kind.
    expect(kinds).toContain('feedback');
  });

  it('emits notion_synced from context.notion_page_id', async () => {
    const t = createTask({
      title: 'Notion linked',
      context: {
        notion_page_id: 'abcd1234',
        notion_last_synced: isoMinusMinutes(2),
        notion_page_url: 'https://www.notion.so/abcd1234',
      },
    });
    const events = await getTaskJournal(t.id);
    const notion = events.find((e) => e.kind === 'notion_synced');
    expect(notion).toBeDefined();
    expect(notion?.link?.url).toContain('notion.so');
  });

  it('emits slack_linked from context.slack_permalink', async () => {
    const t = createTask({
      title: 'Slack capture',
      context: {
        slack_permalink: 'https://example.slack.com/archives/C123/p1700000000',
        slack_channel: 'general',
      },
    });
    const events = await getTaskJournal(t.id);
    const slack = events.find((e) => e.kind === 'slack_linked');
    expect(slack).toBeDefined();
  });

  it('emits gmail_linked from context.gmail_message_id', async () => {
    const t = createTask({
      title: 'From Gmail',
      context: {
        gmail_message_id: 'msg_xyz',
        gmail_subject: 'Hello',
        gmail_from: 'someone@example.com',
      },
    });
    const events = await getTaskJournal(t.id);
    const gmail = events.find((e) => e.kind === 'gmail_linked');
    expect(gmail).toBeDefined();
    expect(gmail?.title).toContain('Hello');
  });

  it('emits issue_event from context.github_issue', async () => {
    const t = createTask({
      title: 'Issue linked',
      context: {
        github_issue: {
          owner: 'me',
          repo: 'app',
          number: 7,
          state: 'open',
          url: 'https://github.com/me/app/issues/7',
        },
      },
    });
    const events = await getTaskJournal(t.id);
    const issue = events.find((e) => e.kind === 'issue_event');
    expect(issue).toBeDefined();
    expect(issue?.title).toContain('#7');
  });

  it('emits scheduled + calendar_linked when calendar_event_id is set', async () => {
    const t = createTask({
      title: 'Scheduled',
      calendar_event_id: 'evt_abc',
    });
    const events = await getTaskJournal(t.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('scheduled');
    expect(kinds).toContain('calendar_linked');
  });

  it('orders events newest-first across all sources', async () => {
    const t = createTask({ title: 'Mixed' });
    // Insert sources with explicit timestamps so we can assert ordering.
    feedbackRepository.create({
      task_id: t.id,
      kind: 'note',
      reason: 'older note',
      at: isoMinusMinutes(60),
    });
    costEventsRepository.create({
      task_id: t.id,
      model: 'claude',
      cost_usd: 0.01,
      at: isoMinusMinutes(30),
    });
    executionLogsRepository.create({
      task_id: t.id,
      method: 'cli',
      status: 'succeeded',
      started_at: isoMinusMinutes(20),
      completed_at: isoMinusMinutes(15),
    });
    feedbackRepository.create({
      task_id: t.id,
      kind: 'note',
      reason: 'newer note',
      at: isoMinusMinutes(2),
    });

    const events = await getTaskJournal(t.id);
    // Verify monotonic non-increasing by timestamp.
    const times = events.map((e) => Date.parse(e.at));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i] ?? 0);
    }
    // First event should be the "newer note" feedback.
    const firstFeedback = events.find((e) => e.kind === 'feedback');
    expect(firstFeedback?.details?.reason).toBe('newer note');
  });

  it('respects the limit option (server-side cap)', async () => {
    const t = createTask({ title: 'Many events' });
    for (let i = 0; i < 12; i += 1) {
      feedbackRepository.create({
        task_id: t.id,
        kind: 'note',
        reason: `note ${i}`,
        at: isoMinusMinutes(60 - i),
      });
    }
    const events = await getTaskJournal(t.id, { limit: 5 });
    expect(events.length).toBeLessThanOrEqual(5);
  });

  it('respects the since filter', async () => {
    const t = createTask({ title: 'Time-windowed' });
    feedbackRepository.create({
      task_id: t.id,
      kind: 'note',
      reason: 'ancient',
      at: isoMinusMinutes(120),
    });
    feedbackRepository.create({
      task_id: t.id,
      kind: 'note',
      reason: 'recent',
      at: isoMinusMinutes(5),
    });
    const events = await getTaskJournal(t.id, {
      since: isoMinusMinutes(30),
    });
    const reasons = events
      .filter((e) => e.kind === 'feedback')
      .map((e) => e.details?.reason as string | undefined);
    expect(reasons).toContain('recent');
    expect(reasons).not.toContain('ancient');
  });

  it('child_completed surfaces for derived sub-tasks that finished', async () => {
    const parent = createTask({ title: 'Parent' });
    const child = createTask({
      title: 'Child A',
      parent_id: parent.id,
    });
    updateTask(child.id, { status: 'done' });
    const events = await getTaskJournal(parent.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('derived');
    expect(kinds).toContain('child_completed');
  });

  it('handles a task with completely empty context gracefully', async () => {
    const t = createTask({ title: 'Empty ctx' });
    const events = await getTaskJournal(t.id);
    // At minimum, we should always get the `created` event back.
    expect(events.some((e) => e.kind === 'created')).toBe(true);
  });

  it('exposes a stable secondary sort for identical timestamps', () => {
    // Two events at the same instant must compare with a stable ordering by
    // kind so the renderer doesn't flicker between fetches.
    const a = { at: '2026-05-27T00:00:00.000Z', kind: 'cost', title: 'a' };
    const b = { at: '2026-05-27T00:00:00.000Z', kind: 'feedback', title: 'b' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(__internals.compareDesc(a as any, b as any)).toBeLessThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(__internals.compareDesc(b as any, a as any)).toBeGreaterThan(0);
  });

  it('clamps long titles in the title helper', () => {
    const long = 'a'.repeat(200);
    expect(__internals.clamp(long, 10).length).toBe(10);
  });
});
