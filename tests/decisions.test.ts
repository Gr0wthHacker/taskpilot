/**
 * Decision log tests (Wave 16).
 *
 * Coverage:
 *   - repository: create / list (newest-first) / get / delete
 *   - domain wrapper: trims text, defaults category/author, rejects empty,
 *     coerces unknown category to `note`
 *   - journal integration: decisions surface as `decision` events with the
 *     right actor + details
 *   - HTTP routes: GET/POST /api/tasks/:id/decisions and
 *     DELETE /api/decisions/:id, including 404 (unknown task / decision) and
 *     400 (bad task id / empty text)
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import {
  decisionsRepository,
  listDecisionsForTask,
  recordDecision,
} from '@/main/decisions';
import { getTaskJournal } from '@/main/journal/aggregator';
import { createTask } from '@/main/db/repositories/tasks';
import type { DecisionEntry } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Repository + domain                                                       */
/* -------------------------------------------------------------------------- */

describe('decisions — repository + domain', () => {
  useMockedDb();

  it('creates and lists newest-first', () => {
    const t = createTask({ title: 'Has decisions' });
    recordDecision({
      task_id: t.id,
      category: 'context',
      text: 'older entry',
    });
    recordDecision({
      task_id: t.id,
      category: 'decision',
      text: 'newer entry',
    });
    const rows = listDecisionsForTask(t.id);
    expect(rows).toHaveLength(2);
    // Newest-first ordering.
    const times = rows.map((r) => Date.parse(r.created_at));
    expect(times[0]).toBeGreaterThanOrEqual(times[1] ?? 0);
  });

  it('defaults category to note and author to user', () => {
    const t = createTask({ title: 'Defaults' });
    const entry = recordDecision({ task_id: t.id, text: 'plain note' });
    expect(entry.category).toBe('note');
    expect(entry.author).toBe('user');
    expect(entry.link).toBeNull();
  });

  it('records claude as the author when supplied', () => {
    const t = createTask({ title: 'Claude wrote this' });
    const entry = recordDecision({
      task_id: t.id,
      category: 'rationale',
      text: 'went with X because Y',
      author: 'claude',
    });
    expect(entry.author).toBe('claude');
    expect(entry.category).toBe('rationale');
  });

  it('coerces an unknown category to note', () => {
    const t = createTask({ title: 'Bad category' });
    const entry = recordDecision({
      task_id: t.id,
      // `category` accepts a freeform string for exactly this coercion path.
      category: 'not-a-real-category',
      text: 'still saved',
    });
    expect(entry.category).toBe('note');
  });

  it('trims text and rejects empty', () => {
    const t = createTask({ title: 'Whitespace' });
    const entry = recordDecision({ task_id: t.id, text: '  spaced  ' });
    expect(entry.text).toBe('spaced');
    expect(() => recordDecision({ task_id: t.id, text: '   ' })).toThrow();
  });

  it('keeps a non-empty link and nulls a blank one', () => {
    const t = createTask({ title: 'Links' });
    const withLink = recordDecision({
      task_id: t.id,
      text: 'see docs',
      link: 'https://example.com',
    });
    expect(withLink.link).toBe('https://example.com');
    const blankLink = recordDecision({
      task_id: t.id,
      text: 'no link',
      link: '   ',
    });
    expect(blankLink.link).toBeNull();
  });

  it('gets by id and deletes', () => {
    const t = createTask({ title: 'Deletable' });
    const entry = recordDecision({ task_id: t.id, text: 'temp' });
    expect(decisionsRepository.get(entry.id)?.id).toBe(entry.id);
    expect(decisionsRepository.delete(entry.id)).toBe(true);
    expect(decisionsRepository.get(entry.id)).toBeNull();
    // Deleting a missing id returns false.
    expect(decisionsRepository.delete('nope_nope_nope')).toBe(false);
  });

  it('only returns decisions for the requested task', () => {
    const a = createTask({ title: 'A' });
    const b = createTask({ title: 'B' });
    recordDecision({ task_id: a.id, text: 'for A' });
    recordDecision({ task_id: b.id, text: 'for B' });
    const rowsA = listDecisionsForTask(a.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.text).toBe('for A');
  });
});

/* -------------------------------------------------------------------------- */
/*  Journal integration                                                       */
/* -------------------------------------------------------------------------- */

describe('decisions — journal integration', () => {
  useMockedDb();

  it('surfaces decisions as decision events in the journal', async () => {
    const t = createTask({ title: 'Journaled decisions' });
    recordDecision({
      task_id: t.id,
      category: 'decision',
      text: 'chose Supabase over Firebase',
      author: 'claude',
    });
    const events = await getTaskJournal(t.id);
    const decision = events.find((e) => e.kind === 'decision');
    expect(decision).toBeDefined();
    expect(decision?.title).toContain('Decision');
    expect(decision?.title).toContain('Supabase');
    expect(decision?.actor).toBe('claude');
    expect(decision?.details?.category).toBe('decision');
  });

  it('maps a user-authored decision to the user actor', async () => {
    const t = createTask({ title: 'User decision' });
    recordDecision({ task_id: t.id, category: 'risk', text: 'watch the rate limit' });
    const events = await getTaskJournal(t.id);
    const decision = events.find((e) => e.kind === 'decision');
    expect(decision?.actor).toBe('user');
    expect(decision?.title).toContain('Risk');
  });
});

/* -------------------------------------------------------------------------- */
/*  HTTP routes                                                               */
/* -------------------------------------------------------------------------- */

describe('decisions — HTTP routes', () => {
  useMockedDb();

  let handle: ApiServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = await startApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }, 30_000);

  afterAll(async () => {
    if (handle) {
      await Promise.race([
        handle.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }, 30_000);

  async function makeTask(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'route-decision-task' }),
    });
    const body = (await res.json()) as { task: { id: string } };
    return body.task.id;
  }

  it('POST then GET round-trips a decision', async () => {
    const taskId = await makeTask();
    const post = await fetch(`${baseUrl}/api/tasks/${taskId}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'decision', text: 'pinned the version' }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { decision: DecisionEntry };
    expect(created.decision.category).toBe('decision');
    expect(created.decision.text).toBe('pinned the version');
    expect(created.decision.author).toBe('user');

    const get = await fetch(`${baseUrl}/api/tasks/${taskId}/decisions`);
    expect(get.status).toBe(200);
    const listed = (await get.json()) as { decisions: DecisionEntry[] };
    expect(listed.decisions.some((d) => d.id === created.decision.id)).toBe(true);
  });

  it('defaults category to note when omitted', async () => {
    const taskId = await makeTask();
    const post = await fetch(`${baseUrl}/api/tasks/${taskId}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'just a note' }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { decision: DecisionEntry };
    expect(created.decision.category).toBe('note');
  });

  it('DELETE removes a decision and 404s when missing', async () => {
    const taskId = await makeTask();
    const post = await fetch(`${baseUrl}/api/tasks/${taskId}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'delete me' }),
    });
    const created = (await post.json()) as { decision: DecisionEntry };

    const del = await fetch(`${baseUrl}/api/decisions/${created.decision.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    const delAgain = await fetch(
      `${baseUrl}/api/decisions/${created.decision.id}`,
      { method: 'DELETE' },
    );
    expect(delAgain.status).toBe(404);
  });

  it('404s POST/GET for an unknown task id', async () => {
    const get = await fetch(`${baseUrl}/api/tasks/unknowntask123/decisions`);
    expect(get.status).toBe(404);
    const post = await fetch(`${baseUrl}/api/tasks/unknowntask123/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'orphan' }),
    });
    expect(post.status).toBe(404);
  });

  it('400s on a path-traversal task id and on empty text', async () => {
    const badId = await fetch(`${baseUrl}/api/tasks/..%2F..%2Fetc/decisions`);
    expect(badId.status).toBe(400);

    const taskId = await makeTask();
    const emptyText = await fetch(
      `${baseUrl}/api/tasks/${taskId}/decisions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      },
    );
    expect(emptyText.status).toBe(400);
  });
});
