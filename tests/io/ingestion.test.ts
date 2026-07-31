/**
 * Ingestion unit tests.
 *
 * Verifies that `ingestDerived` correctly creates child tasks with the right
 * agent_status / parent_id / depends_on translation, and that `ingestResult`
 * advances the task state and writes an execution log.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

mockTaskpilotPaths();

import { ingestDerived, ingestResult } from '@/main/io/ingestion';
import { createTask, getChildren, getTask } from '@/main/db/repositories/tasks';
import { getLogsForTask } from '@/main/db/repositories/execution-logs';
import type {
  DerivationResponse,
  ExecutionResult,
} from '@/shared/types';

describe('ingestion — ingestDerived', () => {
  useMockedDb();

  it('creates child tasks linked to parent and sets parent agent_status', async () => {
    const parent = createTask({
      title: 'big plan',
      priority: 'p1',
      tags: ['work'],
    });

    const response: DerivationResponse = {
      task_id: parent.id,
      derived_at: '2026-05-26T12:00:00Z',
      derivatives: [
        {
          title: 'step A',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: 'do a',
          estimated_minutes: 15,
          depends_on: [],
          review_required: false,
        },
        {
          title: 'step B',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: 'do b',
          estimated_minutes: 30,
          depends_on: ['step A'],
          review_required: true,
        },
      ],
    };

    const childIds = await ingestDerived(parent.id, response);
    expect(childIds).toHaveLength(2);

    const children = getChildren(parent.id);
    expect(children).toHaveLength(2);

    const aChild = children.find((c) => c.title === 'step A');
    const bChild = children.find((c) => c.title === 'step B');
    expect(aChild).toBeDefined();
    expect(bChild).toBeDefined();

    // Children inherit priority and tags from parent.
    expect(aChild?.priority).toBe('p1');
    expect(bChild?.tags).toEqual(['work']);

    // Children land in 'queued' with agent_status='pending'.
    expect(aChild?.status).toBe('queued');
    expect(aChild?.agent_status).toBe('pending');

    // Child B's depends_on resolves to child A's id (title-based lookup).
    const depCtx = bChild?.context as Record<string, unknown> | null;
    expect(depCtx?.depends_on).toEqual([aChild?.id]);

    // Parent's agent_status flipped to needs_review.
    const parentAfter = getTask(parent.id);
    expect(parentAfter?.agent_status).toBe('needs_review');
  });

  it('drops the response when the parent task does not exist', async () => {
    const result = await ingestDerived('does_not_exist', {
      task_id: 'does_not_exist',
      derived_at: '2026-05-26T12:00:00Z',
      derivatives: [
        {
          title: 'x',
          agent_executable: false,
          agent_method: 'human_only',
          agent_instructions: null,
          estimated_minutes: 5,
          depends_on: [],
          review_required: false,
        },
      ],
    });
    expect(result).toEqual([]);
  });

  it('resolves depends_on by numeric index', async () => {
    const parent = createTask({ title: 'indexed deps' });
    const response: DerivationResponse = {
      task_id: parent.id,
      derived_at: '2026-05-26T12:00:00Z',
      derivatives: [
        {
          title: 'first',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 5,
          depends_on: [],
          review_required: false,
        },
        {
          title: 'second',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 10,
          depends_on: ['0'],
          review_required: false,
        },
        {
          title: 'third',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 10,
          depends_on: ['#1'],
          review_required: false,
        },
      ],
    };

    await ingestDerived(parent.id, response);
    const kids = getChildren(parent.id);
    const first = kids.find((c) => c.title === 'first');
    const second = kids.find((c) => c.title === 'second');
    const third = kids.find((c) => c.title === 'third');

    const secondCtx = second?.context as Record<string, unknown> | null;
    const thirdCtx = third?.context as Record<string, unknown> | null;
    expect(secondCtx?.depends_on).toEqual([first?.id]);
    expect(thirdCtx?.depends_on).toEqual([second?.id]);
  });

  it('resolves depends_on case-insensitively by title', async () => {
    const parent = createTask({ title: 'case insensitive' });
    const response: DerivationResponse = {
      task_id: parent.id,
      derived_at: '2026-05-26T12:00:00Z',
      derivatives: [
        {
          title: 'Title With CASE',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 5,
          depends_on: [],
          review_required: false,
        },
        {
          title: 'follower',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 5,
          depends_on: ['title with case'],
          review_required: false,
        },
      ],
    };
    await ingestDerived(parent.id, response);
    const kids = getChildren(parent.id);
    const first = kids.find((c) => c.title === 'Title With CASE');
    const follower = kids.find((c) => c.title === 'follower');
    const followerCtx = follower?.context as Record<string, unknown> | null;
    expect(followerCtx?.depends_on).toEqual([first?.id]);
  });

  it('drops unresolvable depends_on entries (short, non-id-looking refs)', async () => {
    const parent = createTask({ title: 'unresolvable' });
    const response: DerivationResponse = {
      task_id: parent.id,
      derived_at: '2026-05-26T12:00:00Z',
      derivatives: [
        {
          title: 'lonely',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 5,
          // Short strings (<10 chars) that aren't valid title matches.
          // (Strings >=10 chars matching [A-Za-z0-9_-] pass the looksLikeId
          // check and get persisted as-is — see the `looksLikeId` regex in
          // src/main/io/ingestion.ts.)
          depends_on: ['nomatch', '#9999'],
          review_required: false,
        },
      ],
    };
    await ingestDerived(parent.id, response);
    const kids = getChildren(parent.id);
    const lonely = kids[0];
    const ctx = lonely?.context as Record<string, unknown> | null;
    expect(ctx?.depends_on).toEqual([]);
  });
});

describe('ingestion — ingestResult', () => {
  useMockedDb();

  function makeTaskForResult(reviewRequired: boolean) {
    return createTask({
      title: 't',
      status: 'in_progress',
      agent_method: 'cli',
      context: { review_required: reviewRequired },
    });
  }

  it('moves task to done when success and no review required', async () => {
    const task = makeTaskForResult(false);
    const result: ExecutionResult = {
      task_id: task.id,
      status: 'succeeded',
      completed_at: '2026-05-26T13:00:00Z',
      summary: 'shipped',
      output_files: [],
    };
    await ingestResult(task.id, result, []);
    const updated = getTask(task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.agent_status).toBe('succeeded');
  });

  it('moves task to blocked when success but review_required=true', async () => {
    const task = makeTaskForResult(true);
    const result: ExecutionResult = {
      task_id: task.id,
      status: 'succeeded',
      completed_at: '2026-05-26T13:00:00Z',
      summary: 'pending review',
      output_files: [],
    };
    await ingestResult(task.id, result, []);
    const updated = getTask(task.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.agent_status).toBe('succeeded');
  });

  it('moves task to failed when result.status=failed', async () => {
    const task = makeTaskForResult(false);
    await ingestResult(
      task.id,
      {
        task_id: task.id,
        status: 'failed',
        completed_at: '2026-05-26T13:00:00Z',
        summary: 'oops',
        output_files: [],
        error: 'kaboom',
      },
      [],
    );
    const updated = getTask(task.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.agent_status).toBe('failed');
  });

  it('moves task to blocked when result.status=needs_review', async () => {
    const task = makeTaskForResult(false);
    await ingestResult(
      task.id,
      {
        task_id: task.id,
        status: 'needs_review',
        completed_at: '2026-05-26T13:00:00Z',
        summary: 'check me',
        output_files: [],
      },
      [],
    );
    const updated = getTask(task.id);
    expect(updated?.status).toBe('blocked');
    expect(updated?.agent_status).toBe('needs_review');
  });

  it('writes an execution log row', async () => {
    const task = makeTaskForResult(false);
    await ingestResult(
      task.id,
      {
        task_id: task.id,
        status: 'succeeded',
        completed_at: '2026-05-26T13:00:00Z',
        summary: 'logged',
        output_files: [],
      },
      [],
    );
    const logs = getLogsForTask(task.id);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]?.status).toBe('succeeded');
    expect(logs[0]?.method).toBe('cli');
  });

  it('drops the result silently when the task does not exist', async () => {
    await expect(
      ingestResult(
        'ghost',
        {
          task_id: 'ghost',
          status: 'succeeded',
          completed_at: '2026-05-26T13:00:00Z',
          summary: '',
          output_files: [],
        },
        [],
      ),
    ).resolves.toBeUndefined();
  });
});
