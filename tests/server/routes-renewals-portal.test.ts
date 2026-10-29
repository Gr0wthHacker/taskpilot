/**
 * `/api/renewals`, `/api/portal` and public `/portal/:token` over HTTP.
 */

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { hostCheckMiddleware } from '@/main/server/middleware/auth';

let handle: ApiServerHandle;
let baseUrl: string;

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('routes/renewals + routes/portal', () => {
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

  it('creates, lists, imports and runs renewals', async () => {
    const soon = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const created = await json<{ renewal: { id: string; schedule: { state: string } } }>('/api/renewals', {
      method: 'POST',
      body: JSON.stringify({ client: 'Practice A', item_type: 'baa', label: 'Main BAA', due_date: soon, lead_times: [30] }),
    });
    expect(created.status).toBe(201);
    expect(created.body.renewal.schedule.state).toBe('due_soon');

    expect(
      (await json('/api/renewals', { method: 'POST', body: JSON.stringify({ client: 'x', item_type: 'baa', label: 'y', due_date: 'nope' }) }))
        .status,
    ).toBe(400);

    const imp = await json<{ imported: number; errors: number }>('/api/renewals/import', {
      method: 'POST',
      body: JSON.stringify({ csv: 'client,item_type,label,due_date\nPractice B,dea,Dr. Kim,2030-01-01' }),
    });
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ imported: 1, errors: 0 });

    const ran = await json<{ created_items: unknown[]; reminders: unknown[] }>('/api/renewals/run', { method: 'POST' });
    expect(ran.body.created_items).toHaveLength(1);

    const reminders = await json<{ reminders: Array<{ id: string; label: string }> }>('/api/renewals/reminders');
    expect(reminders.body.reminders.map((r) => r.label)).toEqual(['Main BAA']);
    expect((await json(`/api/renewals/reminders/${reminders.body.reminders[0]!.id}/ack`, { method: 'POST' })).status).toBe(200);
    expect((await json<{ reminders: unknown[] }>('/api/renewals/reminders')).body.reminders).toHaveLength(0);

    const due = await json<{ renewals: Array<{ label: string }> }>('/api/renewals?state=due_soon');
    expect(due.body.renewals.map((r) => r.label)).toEqual(['Main BAA']);
    expect((await json('/api/renewals?state=late')).status).toBe(400);

    const renewed = await json<{ renewal: { active: boolean } }>(`/api/renewals/${created.body.renewal.id}/renew`, {
      method: 'POST',
    });
    expect(renewed.body.renewal.active).toBe(true);
  });

  it('publishes a portal behind a signed link and revokes it', async () => {
    const item = await json<{ item: { id: string } }>('/api/delivery/items', {
      method: 'POST',
      body: JSON.stringify({ title: 'Quarterly scan', owner_type: 'offshore', owner_name: 'Rae', client: 'Practice C', status: 'in_progress' }),
    });
    expect(
      (
        await json(`/api/delivery/items/${item.body.item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ deliverable_url: 'javascript:alert(1)' }),
        })
      ).status,
    ).toBe(400);
    await json(`/api/delivery/items/${item.body.item.id}`, { method: 'PATCH', body: JSON.stringify({ client_visible: true }) });
    await json('/api/delivery/items', {
      method: 'POST',
      body: JSON.stringify({ title: 'Private task', owner_type: 'jack', client: 'Practice C' }),
    });
    const note = await json<{ entry: { id: string; month: string } }>('/api/portal/entries', {
      method: 'POST',
      body: JSON.stringify({ client: 'Practice C', kind: 'monthly_note', title: 'This month', body: 'Scan is underway.', client_visible: true }),
    });
    expect(note.status).toBe(201);
    expect(note.body.entry.month).toMatch(/^\d{4}-\d{2}$/);

    const preview = await json<{ view: { work: { in_progress: Array<{ title: string }> } } }>(
      '/api/portal/preview?client=Practice%20C',
    );
    expect(preview.body.view.work.in_progress.map((i) => i.title)).toEqual(['Quarterly scan']);

    const created = await json<{ link: { id: string; url: string; status: string } }>('/api/portal/links', {
      method: 'POST',
      body: JSON.stringify({ client: 'Practice C', expires_in_days: 14 }),
    });
    expect(created.status).toBe(201);
    expect(created.body.link.status).toBe('active');
    const path = new URL(created.body.link.url).pathname;

    const page = await fetch(`${baseUrl}${path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('Quarterly scan');
    expect(html).toContain('Scan is underway.');
    expect(html).not.toContain('Private task');
    expect(html).not.toContain('Rae');

    const data = await json<{ view: { client: string } }>(`${path}/view.json`);
    expect(data.body.view.client).toBe('Practice C');

    const links = await json<{ links: Array<{ view_count: number }> }>('/api/portal/links?client=Practice%20C');
    expect(links.body.links[0]!.view_count).toBe(2);

    expect((await json(`/api/portal/links/${created.body.link.id}/revoke`, { method: 'POST' })).status).toBe(200);
    const gone = await fetch(`${baseUrl}${path}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('no longer available');
    expect((await fetch(`${baseUrl}/portal/garbage`)).status).toBe(404);
  });
});

describe('host check for portal hosts', () => {
  async function probe(host: string, path: string): Promise<number> {
    const app = express();
    app.use(hostCheckMiddleware({ acceptedPorts: [7847], portalHosts: ['portal.example.com'] }));
    app.get('*', (_req, res) => {
      res.status(200).send('ok');
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      // fetch() forbids overriding Host, so use node:http directly.
      const http = await import('node:http');
      return await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    } finally {
      server.close();
    }
  }

  it('accepts a configured public host only on /portal/', async () => {
    expect(await probe('portal.example.com', '/portal/abc')).toBe(200);
    expect(await probe('portal.example.com', '/api/tasks')).toBe(403);
    expect(await probe('evil.example.com', '/portal/abc')).toBe(403);
    expect(await probe('localhost:7847', '/api/tasks')).toBe(200);
  });
});
