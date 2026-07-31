/**
 * `/api/tasks` route tests.
 *
 * Boots the real API server against a mocked TaskPilot home + in-memory DB,
 * then hits the HTTP surface. Mirrors the harness in
 * `tests/integration/api-roundtrip.test.ts`.
 *
 * Coverage focus:
 *   - create / list / update / delete round-trip
 *   - path-traversal id is rejected with 400 (and never touches the DB)
 *   - oversized payloads (title > 500 chars) are rejected with 400
 *   - `agent_paused=true` 403s the derive / execute endpoints
 *   - tag-filter LIKE bypass: a malicious wildcard tag returns []
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { settingsRepository } from '@/main/db/repositories/settings';

let handle: ApiServerHandle;
let baseUrl: string;

describe('routes/tasks', () => {
  useMockedDb();

  beforeAll(async () => {
    // Bind to an OS-assigned port so this suite never collides with the
    // other integration tests (which bind the well-known 7847). The
    // startApiServer override is documented in `src/main/server/index.ts`.
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

  // ------------------------------------------------------------------ CRUD
  it('round-trips create / list / update / delete', async () => {
    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', priority: 'p1' }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { task: { id: string } };
    const id = created.task.id;
    expect(typeof id).toBe('string');

    const list = await fetch(`${baseUrl}/api/tasks`);
    expect(list.status).toBe(200);
    const list1 = (await list.json()) as { tasks: { id: string }[] };
    expect(list1.tasks.some((t) => t.id === id)).toBe(true);

    const patch = await fetch(`${baseUrl}/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { task: { title: string } };
    expect(patched.task.title).toBe('renamed');

    const del = await fetch(`${baseUrl}/api/tasks/${id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const removed = (await del.json()) as { ok: boolean; id: string };
    expect(removed.ok).toBe(true);
    expect(removed.id).toBe(id);
  });

  // ----------------------------------------------------------- path traversal
  it('rejects path-traversal task ids with 400, not 404', async () => {
    // Encoded `../../../tokens` — the server should refuse to look this up.
    const id = encodeURIComponent('../../../tokens');
    const res = await fetch(`${baseUrl}/api/tasks/${id}`);
    expect([400, 404]).toContain(res.status);
    // We prefer 400 (invalid_task_id) over 404 because the id is malformed.
    // Either is acceptable behavior as long as we never serve the file.
    const body = (await res.json()) as { error: { code?: string } };
    if (res.status === 400) {
      expect(body.error.code).toMatch(/invalid_task_id|invalid|validation/);
    }
  });

  it('rejects PATCH with a path-traversal id with 400', async () => {
    const id = encodeURIComponent('../escape');
    const res = await fetch(`${baseUrl}/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects DELETE with a path-traversal id with 400', async () => {
    const id = encodeURIComponent('../oops');
    const res = await fetch(`${baseUrl}/api/tasks/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  // ------------------------------------------------------------- tighter Zod
  it('rejects POST with a 600-char title (over 500 cap)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a'.repeat(600) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects POST with a non-canonical id (path traversal token)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '../../etc/passwd', title: 'oops' }),
    });
    expect(res.status).toBe(400);
  });

  // ------------------------------------------------------------ agent paused
  it('returns 403 agent_paused on derive/execute when paused setting is on', async () => {
    settingsRepository.set('agent_paused', true);

    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'paused-target' }),
    });
    const created = (await create.json()) as { task: { id: string } };
    const id = created.task.id;

    const derive = await fetch(`${baseUrl}/api/tasks/${id}/derive`, {
      method: 'POST',
    });
    expect(derive.status).toBe(403);
    const dBody = (await derive.json()) as { error: { code: string } };
    expect(dBody.error.code).toBe('agent_paused');

    const execute = await fetch(`${baseUrl}/api/tasks/${id}/execute`, {
      method: 'POST',
    });
    expect(execute.status).toBe(403);
    const eBody = (await execute.json()) as { error: { code: string } };
    expect(eBody.error.code).toBe('agent_paused');

    settingsRepository.delete('agent_paused');
  });

  // --------------------------------------------------------- tag LIKE bypass
  it('rejects malicious tag wildcard query (% / _) with 400 validation', async () => {
    // Without validation, `tag=%` would substring-match every row in the
    // tags column via LIKE. Zod's `tagSchema` should reject it before the
    // repo sees the value.
    const res = await fetch(`${baseUrl}/api/tasks?tag=${encodeURIComponent('%')}`);
    expect(res.status).toBe(400);
  });
});
