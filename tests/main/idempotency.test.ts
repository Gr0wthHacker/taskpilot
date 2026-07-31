/**
 * Tests for the idempotency middleware.
 * Replays the first 2xx response when the same Idempotency-Key is presented
 * twice; passes through when the header is absent.
 */

import express from 'express';
import { describe, expect, it } from 'vitest';

import { idempotency } from '@/main/server/middleware';

interface AgentResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

async function call(
  app: express.Express,
  method: 'POST',
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<AgentResponse> {
  const http = await import('node:http');
  return new Promise<AgentResponse>((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const port = address.port;
      const payload = opts.body ? JSON.stringify(opts.body) : '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload).toString(),
            ...(opts.headers ?? {}),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => {
            raw += c.toString();
          });
          res.on('end', () => {
            server.close();
            let parsed: unknown = undefined;
            if (raw) {
              try {
                parsed = JSON.parse(raw);
              } catch {
                parsed = raw;
              }
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: parsed,
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function makeApp(): { app: express.Express; counter: { count: number } } {
  const app = express();
  app.use(express.json());
  app.use(idempotency());
  const counter = { count: 0 };
  app.post('/echo', (_req, res) => {
    counter.count += 1;
    res.json({ count: counter.count });
  });
  app.post('/fail', (_req, res) => {
    res.status(500).json({ error: { code: 'boom' } });
  });
  // Express's default error handler returns HTML; force JSON so test parsing
  // is stable when the idempotency middleware emits a ValidationError.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ): void => {
      const status =
        err && typeof err === 'object' && 'status' in err
          ? (err as { status: number }).status
          : 500;
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code: string }).code
          : 'internal_error';
      res.status(status).json({ error: { code, message: (err as Error).message } });
    },
  );
  return { app, counter };
}

describe('idempotency middleware', () => {
  it('replays the first 2xx response for the same Idempotency-Key', async () => {
    const { app, counter } = makeApp();
    const key = 'abc-test-12345';
    const first = await call(app, 'POST', '/echo', { headers: { 'Idempotency-Key': key } });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ count: 1 });
    const second = await call(app, 'POST', '/echo', { headers: { 'Idempotency-Key': key } });
    expect(second.status).toBe(200);
    // Same body returned — handler not re-executed.
    expect(second.body).toEqual({ count: 1 });
    expect(counter.count).toBe(1);
    expect(second.headers['idempotency-replay']).toBe('true');
  });

  it('passes through when no key is supplied', async () => {
    const { app, counter } = makeApp();
    await call(app, 'POST', '/echo');
    await call(app, 'POST', '/echo');
    expect(counter.count).toBe(2);
  });

  it('does not cache non-2xx responses', async () => {
    const { app } = makeApp();
    const key = 'def-test-54321';
    const first = await call(app, 'POST', '/fail', { headers: { 'Idempotency-Key': key } });
    expect(first.status).toBe(500);
    const second = await call(app, 'POST', '/fail', { headers: { 'Idempotency-Key': key } });
    // Second call hits the handler again because errors weren't cached.
    expect(second.status).toBe(500);
    expect(second.headers['idempotency-replay']).toBeUndefined();
  });

  it('rejects malformed keys', async () => {
    const { app } = makeApp();
    const result = await call(app, 'POST', '/echo', {
      headers: { 'Idempotency-Key': 'short' },
    });
    expect(result.status).toBe(400);
  });
});
