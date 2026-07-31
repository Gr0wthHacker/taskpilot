/**
 * Auto-derive — watch-observation routing test.
 *
 * When a task is created with `context.deliberation_target === true`, the
 * auto-derive hook should NOT write a regular derive request. Instead, it
 * should call the deliberation orchestrator (which writes to
 * `IO_DELIBERATE/<batch_id>.json` and inserts a pending `deliberations` row)
 * and stamp `context.deliberation_batch_id` back onto the task.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { tasksRepository } from '@/main/db/repositories/tasks';

let handle: ApiServerHandle;
let baseUrl: string;

describe('auto-derive — watch_observation routing', () => {
  useMockedDb();

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

  it('routes a watch-observation task to deliberation and stamps batch_id back', async () => {
    // Seed an observation so the orchestrator has something to bundle.
    const obs = contextObservationsRepository.create({
      source: 'browser',
      url: 'https://watch.example',
      page_title: 'Watch',
    });

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'watch what I am doing',
        context: {
          deliberation_target: true,
          observation_ids: [obs.id],
        },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      task: { id: string; context: Record<string, unknown> | null };
    };

    // The route is async; let the post-create maybeAutoDerive settle.
    await waitFor(() => {
      const persisted = tasksRepository.findById(created.task.id);
      const ctx = (persisted?.context ?? null) as Record<
        string,
        unknown
      > | null;
      return typeof ctx?.['deliberation_batch_id'] === 'string';
    });

    const persisted = tasksRepository.findById(created.task.id);
    const ctx = persisted?.context as Record<string, unknown>;
    expect(typeof ctx['deliberation_batch_id']).toBe('string');
    const batchId = ctx['deliberation_batch_id'] as string;

    // The orchestrator should have written the request file + inserted a row.
    const filePath = path.join(PATHS.IO_DELIBERATE, `${batchId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const found = deliberationsRepository.findByBatchId(batchId);
    expect(found?.status).toBe('pending');

    // Regular derive request must NOT have been written for a watch-task.
    const derivePath = path.join(
      PATHS.IO_DERIVE,
      `${created.task.id}.json`,
    );
    expect(fs.existsSync(derivePath)).toBe(false);
  });

  it('still writes a regular derive request when deliberation_target is absent', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'normal task',
        agent_method: 'cli',
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { task: { id: string } };

    await waitFor(() => {
      return fs.existsSync(
        path.join(PATHS.IO_DERIVE, `${created.task.id}.json`),
      );
    });

    const derivePath = path.join(
      PATHS.IO_DERIVE,
      `${created.task.id}.json`,
    );
    expect(fs.existsSync(derivePath)).toBe(true);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
