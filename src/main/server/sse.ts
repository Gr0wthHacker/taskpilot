/**
 * Server-Sent Events stream at `GET /api/events`.
 *
 * The renderer subscribes once and receives one `event:` per `ioEvents`
 * emission. Used for live pipeline updates (derived → execute → result) so
 * the UI doesn't have to poll.
 *
 * Each open connection holds a `res` reference; the registry below lets
 * `server/index.ts` broadcast to all subscribers without each route module
 * importing the same set.
 */

import { Router, type Request, type Response } from 'express';

import { ioEvents } from '@/main/io/events';

/* -------------------------------------------------------------------------- */
/*  Connection registry                                                       */
/* -------------------------------------------------------------------------- */

interface SseClient {
  id: number;
  res: Response;
}

const clients = new Set<SseClient>();
let nextClientId = 1;

function addClient(res: Response): SseClient {
  const client: SseClient = { id: nextClientId++, res };
  clients.add(client);
  return client;
}

function removeClient(client: SseClient): void {
  clients.delete(client);
}

/**
 * Format an SSE frame. Each emitted line is prefixed and the message is
 * terminated by a blank line per the EventSource spec.
 */
function formatEvent(event: string, data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}

/**
 * Push an event to every connected client. Safe to call any time; failed
 * writes are swallowed (the disconnect handler will GC the client).
 */
export function broadcastSse(event: string, data: unknown): void {
  const frame = formatEvent(event, data);
  for (const client of clients) {
    try {
      client.res.write(frame);
    } catch {
      // The connection is probably dead — let the close handler clean up.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Wire ioEvents → broadcastSse                                              */
/* -------------------------------------------------------------------------- */

let bridgeAttached = false;

/**
 * Bridge the `ioEvents` emitter onto the SSE registry. Called once from
 * `startApiServer()`. Subsequent calls are no-ops.
 */
export function attachIoEventBridge(): void {
  if (bridgeAttached) return;
  bridgeAttached = true;

  ioEvents.on('derived_ingested', (payload) => {
    broadcastSse('derived_ingested', payload);
  });
  ioEvents.on('result_ingested', (payload) => {
    broadcastSse('result_ingested', payload);
  });
  ioEvents.on('inbox_ingested', (payload) => {
    broadcastSse('inbox_ingested', payload);
  });
  ioEvents.on('pipeline_changed', (payload) => {
    broadcastSse('pipeline_changed', payload);
  });
  ioEvents.on('review_added', (payload) => {
    broadcastSse('review_added', payload);
  });
  ioEvents.on('io_error', (payload) => {
    broadcastSse('io_error', payload);
  });
  ioEvents.on('conversation_ingested', (payload) => {
    broadcastSse('conversation_ingested', payload);
  });
  ioEvents.on('memory_enriched', (payload) => {
    broadcastSse('memory_enriched', payload);
  });
  ioEvents.on('integration_status', (payload) => {
    broadcastSse('integration_status', payload);
  });
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

const HEARTBEAT_MS = 15_000;

export function sseRouter(): Router {
  const router = Router();

  // Mint a short-lived SSE token that the renderer uses in `?token=...`
  // when opening EventSource. Keeps the long-lived bearer token out of
  // URL logs/history. Requires the bearer token to call (the global auth
  // middleware enforces this) and returns a 5-minute token.
  router.post('/events/token', async (_req: Request, res: Response) => {
    const mod = await import('./sse-tokens');
    res.json(mod.issueSseToken());
  });

  router.get('/events', (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Welcome frame so the client can confirm the stream is live before any
    // real events fire.
    res.write(formatEvent('ready', { ok: true, at: new Date().toISOString() }));

    const client = addClient(res);

    const heartbeat = setInterval(() => {
      try {
        // Comment frame — invisible to listeners but keeps proxies from
        // closing idle connections.
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        // close handler will GC
      }
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      removeClient(client);
      try {
        res.end();
      } catch {
        // already ended
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  return router;
}

/**
 * Test/diagnostic helper — current number of attached clients. Exported so
 * other modules (or future telemetry) can inspect liveness.
 */
export function sseClientCount(): number {
  return clients.size;
}
