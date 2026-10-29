/**
 * `/api/delivery` route tests: template listing, instantiation, queue
 * filters and item updates over HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';

let handle: ApiServerHandle;
let baseUrl: string;

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('routes/delivery', () => {
  useMockedDb();

  beforeAll(async () => {
    handle = await startApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }, 30_000);

  afterAll(async () => {
    if (handle) {
      await Promise.race([handle.stop(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
  }, 30_000);

  it('instantiates a template and filters the queue', async () => {
    const list = await json<{ templates: Array<{ id: string; slug: string; sections: string[] }> }>(
      '/api/delivery/templates',
    );
    expect(list.status).toBe(200);
    const stet = list.body.templates.find((t) => t.slug === 'stetwright-practice-programs')!;
    expect(stet.sections).toContain('hipaa');

    const inst = await json<{ instance_id: string; items: Array<{ id: string; owner_type: string; owner_name: string | null }> }>(
      `/api/delivery/templates/${stet.id}/instantiate`,
      {
        method: 'POST',
        body: JSON.stringify({ client: 'Practice A', sections: ['hipaa'], assignees: { offshore: 'Rae' } }),
      },
    );
    expect(inst.status).toBe(201);
    expect(inst.body.items.length).toBeGreaterThan(0);

    const offshore = await json<{ items: Array<{ owner_name: string; sla: { state: string } }> }>(
      '/api/delivery/items?owner_type=offshore&owner_name=Rae',
    );
    expect(offshore.status).toBe(200);
    expect(offshore.body.items.length).toBeGreaterThan(0);
    expect(offshore.body.items.every((i) => i.owner_name === 'Rae')).toBe(true);

    const unassigned = await json<{ items: unknown[] }>('/api/delivery/items?owner_type=contractor&owner_name=__unassigned');
    expect(unassigned.body.items.length).toBeGreaterThan(0);

    const breached = await json<{ items: unknown[]; summary: { total: number } }>('/api/delivery/items?sla_state=breached');
    expect(breached.body.items).toHaveLength(0);
    expect(breached.body.summary.total).toBe(inst.body.items.length);

    const first = inst.body.items[0]!;
    const patched = await json<{ item: { status: string; completed_at: string | null; sla: { state: string } } }>(
      `/api/delivery/items/${first.id}`,
      { method: 'PATCH', body: JSON.stringify({ status: 'done' }) },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.item.completed_at).not.toBeNull();
    expect(patched.body.item.sla.state).toBe('met');
  });

  it('rejects bad filters and bad bodies', async () => {
    expect((await json('/api/delivery/items?sla_state=late')).status).toBe(400);
    expect(
      (await json('/api/delivery/items', { method: 'POST', body: JSON.stringify({ title: 'x', owner_type: 'boss', client: 'c' }) }))
        .status,
    ).toBe(400);
    expect(
      (await json('/api/delivery/templates/nope/instantiate', { method: 'POST', body: JSON.stringify({ client: 'c' }) })).status,
    ).toBe(404);
  });

  it('saves an SOP link on a template', async () => {
    const res = await json<{ template: { sop_url: string | null } }>('/api/delivery/templates/multistate-licensing', {
      method: 'PATCH',
      body: JSON.stringify({ sop_url: 'https://example.com/sop' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.template.sop_url).toBe('https://example.com/sop');
  });
});
