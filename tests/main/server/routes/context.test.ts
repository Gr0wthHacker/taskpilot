/**
 * `/api/context/*` route tests.
 *
 * Boots the real API server against the mocked TaskPilot home + in-memory DB
 * (auth disabled via the global `TASKPILOT_DISABLE_AUTH=1` env var), then hits
 * every endpoint declared by the context router:
 *
 *   - POST /capture and /capture/batch — persist + emit + 201
 *   - GET /observations and DELETE /observations/:id
 *   - GET /deliberations + GET /deliberations/:id
 *   - POST /deliberate (manual force) — writes the file + 202
 *   - GET /screenshots/:filename — happy path + path-traversal rejection
 *   - GET /status — composed numbers
 *
 * The orchestrator calls write to `IO_DELIBERATE/<batch_id>.json` on disk;
 * the mock-paths helper provisions that directory.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { mockTaskpilotPaths } from '../../../helpers/mock-paths';
import { useMockedDb } from '../../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { ioEvents } from '@/main/io/events';

let handle: ApiServerHandle;
let baseUrl: string;

describe('routes/context', () => {
  useMockedDb();

  beforeAll(async () => {
    // Port 0 = ephemeral, so this suite never collides with the well-known
    // 7847 the other integration tests bind.
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

  // --------------------------------------------------------------- capture
  describe('POST /api/context/capture', () => {
    it('persists a single observation and returns 201 with id + captured_at', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          url: 'https://example.com/x',
          page_title: 'X',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        captured_at: string;
      };
      expect(typeof body.id).toBe('string');
      expect(body.id.length).toBeGreaterThan(0);
      expect(typeof body.captured_at).toBe('string');

      // DB confirms persistence.
      const stored = contextObservationsRepository.get(body.id);
      expect(stored?.url).toBe('https://example.com/x');
      expect(stored?.source).toBe('browser');
    });

    it('emits observation_captured exactly once per capture', async () => {
      let emitted = 0;
      const onCap = (): void => {
        emitted += 1;
      };
      ioEvents.on('observation_captured', onCap);
      try {
        const res = await fetch(`${baseUrl}/api/context/capture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'manual', selection: 'hello' }),
        });
        expect(res.status).toBe(201);
      } finally {
        ioEvents.off('observation_captured', onCap);
      }
      expect(emitted).toBe(1);
    });

    it('rejects an unknown source with 400 (zod validation)', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'bogus', url: 'https://x.com' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('validation_error');
    });

    it('rejects a payload missing source with 400', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.com' }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------- capture/batch
  describe('POST /api/context/capture/batch', () => {
    it('inserts every observation atomically and returns the ids', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          observations: [
            { source: 'browser', url: 'https://a.com', page_title: 'A' },
            { source: 'browser', url: 'https://b.com', page_title: 'B' },
            { source: 'browser', url: 'https://c.com', page_title: 'C' },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        ids: string[];
        captured_at: string;
      };
      expect(body.ids).toHaveLength(3);
      for (const id of body.ids) {
        expect(contextObservationsRepository.get(id)).not.toBeNull();
      }
    });

    it('rejects an empty observations array with 400', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'browser', observations: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------- observations
  describe('GET /api/context/observations', () => {
    it('returns recent observations with total count', async () => {
      contextObservationsRepository.create({
        source: 'manual',
        selection: 'one',
      });
      contextObservationsRepository.create({
        source: 'manual',
        selection: 'two',
      });
      const res = await fetch(
        `${baseUrl}/api/context/observations?limit=10`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ id: string }>;
        total: number;
      };
      expect(Array.isArray(body.observations)).toBe(true);
      expect(body.observations.length).toBeGreaterThanOrEqual(2);
      expect(body.total).toBeGreaterThanOrEqual(2);
    });

    it('rejects an out-of-range limit with 400', async () => {
      const res = await fetch(
        `${baseUrl}/api/context/observations?limit=99999`,
      );
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------- observations DELETE
  describe('DELETE /api/context/observations/:id', () => {
    it('removes the row and returns ok=true', async () => {
      const created = contextObservationsRepository.create({
        source: 'manual',
        selection: 'to-delete',
      });
      const res = await fetch(
        `${baseUrl}/api/context/observations/${encodeURIComponent(created.id)}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string };
      expect(body.ok).toBe(true);
      expect(body.id).toBe(created.id);
      expect(contextObservationsRepository.get(created.id)).toBeNull();
    });

    it('rejects a path-traversal id with 400 and never inspects the row', async () => {
      const id = encodeURIComponent('../../../etc/passwd');
      const res = await fetch(
        `${baseUrl}/api/context/observations/${id}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for a syntactically valid but unknown id', async () => {
      const res = await fetch(
        `${baseUrl}/api/context/observations/aaaaaaaaaaaa`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------- screenshots
  describe('GET /api/context/screenshots/:filename', () => {
    // The filename schema accepts two formats:
    //   cap_<16-hex>.png         (opaque masked names, new default)
    //   <id>__display-<n>.png    (legacy timestamp-bearing names)
    // Tests below use one of each.
    const SAMPLE_NAME = 'cap_0123456789abcdef.png';
    const MISSING_NAME = 'cap_ffffffffffffffff.png';

    beforeEach(() => {
      fs.mkdirSync(PATHS.CAPTURES_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(PATHS.CAPTURES_DIR, SAMPLE_NAME),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    });
    afterEach(() => {
      try {
        fs.unlinkSync(path.join(PATHS.CAPTURES_DIR, SAMPLE_NAME));
      } catch {
        /* ignore */
      }
    });

    it('serves an existing PNG with the right Content-Type', async () => {
      const res = await fetch(`${baseUrl}/api/context/screenshots/${SAMPLE_NAME}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/image\/png/);
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
    });

    it('rejects a path-traversal filename with 400', async () => {
      const res = await fetch(
        `${baseUrl}/api/context/screenshots/${encodeURIComponent('../../etc/passwd.png')}`,
      );
      expect(res.status).toBe(400);
    });

    it('rejects a non-.png filename with 400', async () => {
      const res = await fetch(`${baseUrl}/api/context/screenshots/x.exe`);
      expect(res.status).toBe(400);
    });

    it('404s a missing file with the canonical envelope', async () => {
      const res = await fetch(
        `${baseUrl}/api/context/screenshots/${MISSING_NAME}`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });
  });

  // ---------------------------------------------------------------- status
  describe('GET /api/context/status', () => {
    it('returns the composed status with captures_dir + counters', async () => {
      contextObservationsRepository.create({
        source: 'manual',
        selection: 'for-status',
      });
      const res = await fetch(`${baseUrl}/api/context/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        monitor_enabled: boolean;
        screenshot_enabled: boolean;
        extension_enabled: boolean;
        last_observation_at: string | null;
        pending_deliberations: number;
        observations_today: number;
        captures_dir: string;
      };
      expect(typeof body.monitor_enabled).toBe('boolean');
      expect(typeof body.captures_dir).toBe('string');
      expect(body.captures_dir).toBe(PATHS.CAPTURES_DIR);
      expect(body.observations_today).toBeGreaterThanOrEqual(1);
      expect(body.last_observation_at).not.toBeNull();
    });
  });

  // --------------------------------------------------------- deliberations
  describe('POST /api/context/deliberate', () => {
    it('returns 400 no_observations when there are no rows to bundle', async () => {
      const res = await fetch(`${baseUrl}/api/context/deliberate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'manual' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('no_observations');
    });

    it('returns 202 with batch_id + deliberation_id when observations exist', async () => {
      const obs = contextObservationsRepository.create({
        source: 'browser',
        url: 'https://e.com',
      });
      const res = await fetch(`${baseUrl}/api/context/deliberate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'manual',
          observation_ids: [obs.id],
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        batch_id: string;
        deliberation_id: string;
      };
      expect(typeof body.batch_id).toBe('string');
      expect(typeof body.deliberation_id).toBe('string');
      // Request file was written to disk.
      const filePath = path.join(PATHS.IO_DELIBERATE, `${body.batch_id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('rejects an invalid reason with 400', async () => {
      const res = await fetch(`${baseUrl}/api/context/deliberate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'not-a-reason' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/context/deliberations', () => {
    it('lists pending deliberations after a manual deliberate', async () => {
      const obs = contextObservationsRepository.create({
        source: 'browser',
        url: 'https://list-test.com',
      });
      await fetch(`${baseUrl}/api/context/deliberate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'manual',
          observation_ids: [obs.id],
        }),
      });
      const res = await fetch(`${baseUrl}/api/context/deliberations`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deliberations: Array<{ id: string; status: string }>;
        total: number;
      };
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.deliberations[0]?.status).toBeDefined();
    });
  });

  describe('GET /api/context/deliberations/:id', () => {
    it('returns the deliberation + the joined observations', async () => {
      const obs = contextObservationsRepository.create({
        source: 'browser',
        url: 'https://detail.com',
      });
      const deliberate = await fetch(`${baseUrl}/api/context/deliberate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'manual',
          observation_ids: [obs.id],
        }),
      });
      const created = (await deliberate.json()) as {
        deliberation_id: string;
      };

      const res = await fetch(
        `${baseUrl}/api/context/deliberations/${created.deliberation_id}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deliberation: { id: string; observation_ids: string[] };
        observations: Array<{ id: string }>;
      };
      expect(body.deliberation.id).toBe(created.deliberation_id);
      expect(body.observations.map((o) => o.id)).toContain(obs.id);
    });

    it('404s an unknown deliberation id', async () => {
      const res = await fetch(
        `${baseUrl}/api/context/deliberations/zzzzzzzzzzzz`,
      );
      expect(res.status).toBe(404);
    });
  });
});
