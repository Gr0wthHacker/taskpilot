/**
 * Bearer-token + host-header middleware tests.
 *
 * Exercises the auth path directly via Express's `app.use(...)` rather than
 * booting the full `startApiServer()` stack — that way the test never has
 * to disable the global `TASKPILOT_DISABLE_AUTH` flag set by
 * `tests/helpers/setup.ts` for the other suites.
 *
 * Coverage (per Wave 10 / S8 ownership):
 *   - getOrCreateApiToken / readApiToken / rotateApiToken lifecycle
 *   - authMiddleware: rejects missing / wrong / malformed; accepts correct
 *   - authMiddleware: allowlist (`/api/health`, `/oauth/callback`, webhooks)
 *   - authMiddleware: SSE accepts token via `?token=` query param
 *   - hostCheckMiddleware: accepts canonical hosts, rejects everything else
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';

import express from 'express';
import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

import {
  getOrCreateApiToken,
  readApiToken,
  rotateApiToken,
} from '@/main/api-auth';
import {
  authMiddleware,
  hostCheckMiddleware,
  isAuthAllowlisted,
} from '@/main/server/middleware/auth';

const TOKEN_PATH = path.join(PATHS.TASKPILOT_HOME, 'api-token');

/**
 * Spin up a tiny Express server that mounts the supplied middlewares plus
 * a couple of trivial handlers we can probe with `fetch`. Returns the
 * bound base URL and a stop fn.
 */
async function spawnTestServer(
  middlewares: express.RequestHandler[],
  ports: number[] = [],
): Promise<{ baseUrl: string; port: number; stop: () => Promise<void> }> {
  const app = express();
  for (const mw of middlewares) app.use(mw);
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: [] });
  });
  app.get('/api/events', (_req, res) => {
    res.json({ events: 'stream' });
  });
  app.get('/oauth/callback', (_req, res) => {
    res.send('ok');
  });
  app.post('/api/webhooks/github', (_req, res) => {
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const p = addr && typeof addr === 'object' ? addr.port : 0;
      ports.push(p);
      resolve(p);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('api-auth — token lifecycle', () => {
  it('getOrCreateApiToken creates on first call, returns same on second', async () => {
    // Guarantee no stale token from a prior test in this file.
    await fs.rm(TOKEN_PATH, { force: true });

    const first = await getOrCreateApiToken();
    expect(typeof first).toBe('string');
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const second = await getOrCreateApiToken();
    expect(second).toBe(first);

    const onDisk = await readApiToken();
    expect(onDisk).toBe(first);
  });

  it('rotateApiToken produces a different token', async () => {
    const before = await getOrCreateApiToken();
    const after = await rotateApiToken();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(await readApiToken()).toBe(after);
  });

  it('readApiToken returns null when the file is missing', async () => {
    await fs.rm(TOKEN_PATH, { force: true });
    expect(await readApiToken()).toBeNull();
  });
});

describe('api-auth — authMiddleware', () => {
  // One shared token across this describe so individual tests don't have to
  // mint their own. The token sits in the mocked TASKPILOT_HOME.
  const TOKEN = 'a'.repeat(64);

  it('rejects requests with no Authorization header', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/api/tasks`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('unauthorized');
    } finally {
      await srv.stop();
    }
  });

  it('rejects requests with a malformed Authorization header', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/api/tasks`, {
        headers: { Authorization: 'NotBearer something' },
      });
      expect(res.status).toBe(401);
    } finally {
      await srv.stop();
    }
  });

  it('rejects requests with the wrong bearer value', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/api/tasks`, {
        headers: { Authorization: 'Bearer ' + 'b'.repeat(64) },
      });
      expect(res.status).toBe(401);
    } finally {
      await srv.stop();
    }
  });

  it('accepts requests with the correct bearer value', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/api/tasks`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      expect(Array.isArray(body.tasks)).toBe(true);
    } finally {
      await srv.stop();
    }
  });

  it('passes /api/health without a token', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('passes /oauth/callback without a token', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/oauth/callback?code=abc`);
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('passes /api/webhooks/* without a token', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/api/webhooks/github`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('SSE accepts the token via ?token= query param', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(
        `${srv.baseUrl}/api/events?token=${encodeURIComponent(TOKEN)}`,
      );
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('SSE rejects the wrong token via ?token=', async () => {
    const srv = await spawnTestServer([authMiddleware(TOKEN)]);
    try {
      const res = await fetch(`${srv.baseUrl}/api/events?token=wrong`);
      expect(res.status).toBe(401);
    } finally {
      await srv.stop();
    }
  });
});

describe('api-auth — isAuthAllowlisted', () => {
  it('exempts /api/health and /api/config', () => {
    expect(isAuthAllowlisted('/api/health')).toBe(true);
    expect(isAuthAllowlisted('/api/config')).toBe(true);
  });

  it('exempts /oauth/callback', () => {
    expect(isAuthAllowlisted('/oauth/callback')).toBe(true);
  });

  it('exempts the inbound webhook routes only', () => {
    // Both inbound webhook surfaces verify via HMAC and must skip bearer auth.
    expect(isAuthAllowlisted('/api/webhooks/github')).toBe(true);
    expect(isAuthAllowlisted('/api/webhooks/incoming/anything')).toBe(true);
    // Wave 13 / Agent M: the registry CRUD endpoints mutate config state
    // and MUST require the bearer token — they are not allowlisted.
    expect(isAuthAllowlisted('/api/webhooks/configs')).toBe(false);
    expect(isAuthAllowlisted('/api/webhooks/configs/abc')).toBe(false);
  });

  it('does not exempt /api/tasks or /api/calendar', () => {
    expect(isAuthAllowlisted('/api/tasks')).toBe(false);
    expect(isAuthAllowlisted('/api/calendar/events')).toBe(false);
  });

  it('does not exempt prefix-look-alikes like /api/healthz', () => {
    expect(isAuthAllowlisted('/api/healthz')).toBe(false);
  });
});

describe('api-auth — hostCheckMiddleware', () => {
  // Node's fetch (undici) forces `Host: <url-host>:<url-port>` and silently
  // ignores any caller-supplied override. To drive arbitrary Host headers
  // we drop down to `http.request`, which keeps whatever the caller sets.

  function rawRequest(
    port: number,
    hostHeader: string,
    pathStr = '/api/health',
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: pathStr,
          headers: { Host: hostHeader },
        },
        (res) => {
          let chunks = '';
          res.on('data', (d: Buffer) => {
            chunks += d.toString('utf8');
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: chunks }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('accepts canonical 127.0.0.1:<accepted-port>', async () => {
    const srv = await spawnTestServer([
      hostCheckMiddleware({ acceptedPorts: [7847] }),
    ]);
    try {
      const res = await rawRequest(srv.port, '127.0.0.1:7847');
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('accepts canonical localhost:<accepted-port>', async () => {
    const srv = await spawnTestServer([
      hostCheckMiddleware({ acceptedPorts: [7847] }),
    ]);
    try {
      const res = await rawRequest(srv.port, 'localhost:7847');
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('accepts canonical [::1]:<accepted-port>', async () => {
    const srv = await spawnTestServer([
      hostCheckMiddleware({ acceptedPorts: [7847] }),
    ]);
    try {
      const res = await rawRequest(srv.port, '[::1]:7847');
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('rejects a foreign hostname (DNS-rebinding guard)', async () => {
    const srv = await spawnTestServer([
      hostCheckMiddleware({ acceptedPorts: [7847] }),
    ]);
    try {
      const res = await rawRequest(srv.port, 'evil.example.com:7847');
      expect(res.status).toBe(403);
      const body = JSON.parse(res.body) as { error?: { code?: string } };
      expect(body.error?.code).toBe('invalid_host');
    } finally {
      await srv.stop();
    }
  });

  it('rejects a missing-port Host header', async () => {
    const srv = await spawnTestServer([
      hostCheckMiddleware({ acceptedPorts: [7847] }),
    ]);
    try {
      const res = await rawRequest(srv.port, 'localhost');
      expect(res.status).toBe(403);
    } finally {
      await srv.stop();
    }
  });

  it('rejects a wrong-port Host header', async () => {
    const srv = await spawnTestServer([
      hostCheckMiddleware({ acceptedPorts: [7847] }),
    ]);
    try {
      const res = await rawRequest(srv.port, 'localhost:1234');
      expect(res.status).toBe(403);
    } finally {
      await srv.stop();
    }
  });
});
