/**
 * Full-text search tests (Wave 17).
 *
 * Coverage:
 *   - FTS path: index tasks/decisions/executions/attachments, ranked matches,
 *     `<mark>` snippet highlights, type filtering, incremental updates.
 *   - Fallback path: force `ftsAvailable = false` and verify the LIKE scanner
 *     still returns matching, ranked, highlighted results.
 *   - HTTP route: GET /api/search returns `{ results, total, fts_available }`,
 *     honors `types` + `limit`, and returns empty for a too-short query.
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { createTask, updateTask } from '@/main/db/repositories/tasks';
import { createDecision } from '@/main/db/repositories/decisions';
import { createLog } from '@/main/db/repositories/execution-logs';
import { search, isFtsAvailable, resetSearchEngine } from '@/main/search';
import {
  rebuildIndex,
  indexTask,
  indexDecision,
  indexExecutionsForTask,
} from '@/main/search/indexer';
import type { SearchResult } from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  FTS path                                                                  */
/* -------------------------------------------------------------------------- */

describe('search — FTS5 backend', () => {
  const { current } = useMockedDb();

  // Each test gets a fresh in-memory DB; clear the cached FTS flag so the
  // engine re-probes (and re-creates the virtual table) against it.
  beforeEach(() => {
    resetSearchEngine();
  });

  it('reports FTS5 as available on a default better-sqlite3 build', () => {
    void current();
    expect(isFtsAvailable()).toBe(true);
  });

  it('indexes a task and finds it by description content', () => {
    const t = createTask({
      title: 'Reddit campaign',
      description: 'Draft posts for the r/marketing launch about analytics',
    });
    indexTask(t.id);

    const results = search('analytics');
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.task_id === t.id);
    expect(hit).toBeDefined();
    expect(hit?.entity_type).toBe('task');
  });

  it('finds a task by agent_instructions content', () => {
    const t = createTask({
      title: 'Build widget',
      agent_instructions: 'Scaffold a Supabase edge function and wire auth',
    });
    indexTask(t.id);
    const results = search('supabase');
    expect(results.some((r) => r.task_id === t.id)).toBe(true);
  });

  it('returns <mark>-highlighted snippets', () => {
    const t = createTask({
      title: 'Quarterly review',
      description: 'Summarize the pipeline velocity numbers for Q2',
    });
    indexTask(t.id);
    const results = search('velocity');
    const hit = results.find((r) => r.task_id === t.id);
    expect(hit?.snippet).toContain('<mark>');
    expect(hit?.snippet.toLowerCase()).toContain('velocity');
  });

  it('indexes decisions and finds them, navigating to the owning task', () => {
    const t = createTask({ title: 'Stack choice' });
    const d = createDecision({
      task_id: t.id,
      category: 'rationale',
      text: 'Chose Cloudflare over Fastly for the edge tier',
    });
    indexDecision(d.id);
    const results = search('cloudflare');
    const hit = results.find((r) => r.entity_type === 'decision');
    expect(hit).toBeDefined();
    expect(hit?.entity_id).toBe(d.id);
    // Decisions navigate to their owning task.
    expect(hit?.task_id).toBe(t.id);
  });

  it('indexes execution outputs (result summaries)', () => {
    const t = createTask({ title: 'Run report' });
    createLog({
      task_id: t.id,
      method: 'cli',
      status: 'succeeded',
      output: 'Generated the weekly churn report with 12 cohorts',
    });
    indexExecutionsForTask(t.id);
    const results = search('churn');
    const hit = results.find((r) => r.entity_type === 'execution');
    expect(hit).toBeDefined();
    expect(hit?.task_id).toBe(t.id);
  });

  it('indexes attachment filenames', () => {
    const t = createTask({
      title: 'Has files',
      context: {
        attachments: [
          {
            filename: 'q3-forecast-model.xlsx',
            size_bytes: 100,
            content_type: 'application/octet-stream',
            added_at: new Date().toISOString(),
          },
        ],
      },
    });
    indexTask(t.id);
    const results = search('forecast');
    const hit = results.find((r) => r.entity_type === 'attachment');
    expect(hit).toBeDefined();
    expect(hit?.title).toBe('q3-forecast-model.xlsx');
    expect(hit?.task_id).toBe(t.id);
  });

  it('filters by entity type', () => {
    const t = createTask({
      title: 'Polyphonic widget',
      description: 'a polyphonic synth task',
    });
    createDecision({ task_id: t.id, text: 'polyphonic decision note' });
    rebuildIndex();

    const all = search('polyphonic');
    expect(all.some((r) => r.entity_type === 'task')).toBe(true);
    expect(all.some((r) => r.entity_type === 'decision')).toBe(true);

    const tasksOnly = search('polyphonic', { types: ['task'] });
    expect(tasksOnly.length).toBeGreaterThan(0);
    expect(tasksOnly.every((r) => r.entity_type === 'task')).toBe(true);

    const decisionsOnly = search('polyphonic', { types: ['decision'] });
    expect(decisionsOnly.every((r) => r.entity_type === 'decision')).toBe(true);
  });

  it('reflects an incremental update after the task changes', () => {
    const t = createTask({ title: 'Initial title', description: 'zebra content' });
    indexTask(t.id);
    expect(search('zebra').some((r) => r.task_id === t.id)).toBe(true);

    // Update the description; re-index; old term gone, new term found.
    updateTask(t.id, { description: 'giraffe content' });
    indexTask(t.id);
    expect(search('zebra').some((r) => r.task_id === t.id)).toBe(false);
    expect(search('giraffe').some((r) => r.task_id === t.id)).toBe(true);
  });

  it('rebuildIndex reports per-entity counts', () => {
    const t = createTask({ title: 'Rebuild me', description: 'searchable body' });
    createDecision({ task_id: t.id, text: 'a decision' });
    createLog({
      task_id: t.id,
      method: 'cli',
      status: 'succeeded',
      output: 'some output',
    });
    const stats = rebuildIndex();
    expect(stats.fts_available).toBe(true);
    expect(stats.tasks).toBe(1);
    expect(stats.decisions).toBe(1);
    expect(stats.executions).toBe(1);
  });

  it('AND-matches multi-word queries', () => {
    const a = createTask({ title: 'Reddit ads strategy', description: 'paid social' });
    const b = createTask({ title: 'Reddit organic', description: 'unpaid' });
    rebuildIndex();
    const results = search('reddit ads');
    expect(results.some((r) => r.task_id === a.id)).toBe(true);
    expect(results.some((r) => r.task_id === b.id)).toBe(false);
  });

  it('returns [] for an empty or operator-only query without throwing', () => {
    createTask({ title: 'Something' });
    rebuildIndex();
    expect(search('')).toEqual([]);
    expect(search('   ')).toEqual([]);
    // A query of pure FTS operators sanitizes to no tokens → [].
    expect(search('"*()^:')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Fallback (LIKE) path                                                      */
/* -------------------------------------------------------------------------- */

describe('search — LIKE fallback backend', () => {
  useMockedDb();

  beforeEach(() => {
    // Force the engine to believe FTS5 is unavailable so it exercises the
    // LIKE scanner over the source tables.
    resetSearchEngine(false);
  });

  afterEach(() => {
    resetSearchEngine();
  });

  it('reports FTS as unavailable when forced', () => {
    expect(isFtsAvailable()).toBe(false);
  });

  it('finds tasks by content with the LIKE scanner', () => {
    const t = createTask({
      title: 'Fallback task',
      description: 'contains the magic keyword somewhere',
    });
    // No indexTask call needed — the LIKE scanner reads source tables directly.
    void t;
    const results = search('magic');
    expect(results.some((r) => r.entity_type === 'task')).toBe(true);
  });

  it('finds decisions + executions + attachments via the LIKE scanner', () => {
    const t = createTask({
      title: 'Fallback bundle',
      context: {
        attachments: [
          {
            filename: 'pelican-notes.txt',
            size_bytes: 1,
            content_type: 'text/plain',
            added_at: new Date().toISOString(),
          },
        ],
      },
    });
    createDecision({ task_id: t.id, text: 'pelican rationale' });
    createLog({
      task_id: t.id,
      method: 'cli',
      status: 'succeeded',
      output: 'pelican output summary',
    });

    const results = search('pelican');
    const kinds = new Set(results.map((r) => r.entity_type));
    expect(kinds.has('decision')).toBe(true);
    expect(kinds.has('execution')).toBe(true);
    expect(kinds.has('attachment')).toBe(true);
  });

  it('highlights matches with <mark> in the fallback path', () => {
    createTask({ title: 'Highlighted', description: 'find the needle here' });
    const results = search('needle');
    const hit = results[0];
    expect(hit?.snippet).toContain('<mark>');
  });

  it('honors type filtering in the fallback path', () => {
    const t = createTask({ title: 'unicorn task', description: 'unicorn body' });
    createDecision({ task_id: t.id, text: 'unicorn note' });
    const tasksOnly = search('unicorn', { types: ['task'] });
    expect(tasksOnly.length).toBeGreaterThan(0);
    expect(tasksOnly.every((r) => r.entity_type === 'task')).toBe(true);
  });

  it('ranks a title hit above a body-only hit', () => {
    const titleHit = createTask({ title: 'penguin', description: 'nothing' });
    const bodyHit = createTask({ title: 'nothing', description: 'a penguin lives here' });
    const results = search('penguin');
    const titleIdx = results.findIndex((r) => r.task_id === titleHit.id);
    const bodyIdx = results.findIndex((r) => r.task_id === bodyHit.id);
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeLessThan(bodyIdx);
  });
});

/* -------------------------------------------------------------------------- */
/*  HTTP route                                                                */
/* -------------------------------------------------------------------------- */

describe('search — HTTP route', () => {
  const { current } = useMockedDb();

  let handle: ApiServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    resetSearchEngine();
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

  it('returns ranked results with fts_available flag', async () => {
    const db = current();
    void db;
    const t = createTask({
      title: 'HTTP search target',
      description: 'route-level orangutan content',
    });
    rebuildIndex();

    const res = await fetch(
      `${baseUrl}/api/search?q=orangutan`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: SearchResult[];
      total: number;
      fts_available: boolean;
    };
    expect(typeof body.fts_available).toBe('boolean');
    expect(body.total).toBe(body.results.length);
    expect(body.results.some((r) => r.task_id === t.id)).toBe(true);
  });

  it('honors the types query param', async () => {
    const t = createTask({ title: 'kangaroo task', description: 'kangaroo body' });
    createDecision({ task_id: t.id, text: 'kangaroo decision' });
    rebuildIndex();

    const res = await fetch(
      `${baseUrl}/api/search?q=kangaroo&types=decision`,
    );
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r) => r.entity_type === 'decision')).toBe(true);
  });

  it('honors the limit query param', async () => {
    for (let i = 0; i < 5; i += 1) {
      createTask({ title: `limitword task ${i}`, description: 'limitword body' });
    }
    rebuildIndex();
    const res = await fetch(`${baseUrl}/api/search?q=limitword&limit=2`);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for a missing/blank query', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[]; total: number };
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });
});
