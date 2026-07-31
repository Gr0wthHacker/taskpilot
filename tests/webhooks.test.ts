/**
 * `/api/webhooks/github` route tests.
 *
 * Boots the real API server against a mocked TaskPilot home + in-memory DB,
 * then exercises the webhook receiver end-to-end:
 *
 *   - missing `github_webhook_secret` setting → 503
 *   - bad signature → 401
 *   - valid signature + PR merge → linked task flipped to done
 *   - valid signature + PR closed without merge → linked task failed
 *   - delivery_id idempotency: second delivery is a no-op
 *   - PR branch that doesn't match `agent/<id>` → 200, no task change
 *
 * HMAC signatures are computed with Node's `crypto` against the canonical
 * `JSON.stringify(payload)` body. The handler uses the raw body bytes for
 * verification — we send the exact same bytes via fetch so the signatures
 * line up.
 */

import crypto from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { settingsRepository } from '@/main/db/repositories/settings';
import { createTask, getTask } from '@/main/db/repositories/tasks';
import { __resetWebhookDeliveryCache } from '@/main/server/routes/webhooks';

const SECRET = 'super-secret-shared-webhook-key';

function sign(body: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

function deliveryId(): string {
  return crypto.randomUUID();
}

interface PRBody {
  action: string;
  pull_request: {
    number: number;
    state: string;
    merged: boolean;
    title?: string;
    html_url?: string;
    head: { ref: string };
    base: { ref: string };
  };
  repository?: { full_name: string };
}

function prMergedBody(taskId: string, merged = true): PRBody {
  return {
    action: 'closed',
    pull_request: {
      number: 42,
      state: 'closed',
      merged,
      title: 'Test PR',
      html_url: 'https://github.com/example/repo/pull/42',
      head: { ref: `agent/${taskId}` },
      base: { ref: 'main' },
    },
    repository: { full_name: 'example/repo' },
  };
}

let handle: ApiServerHandle;
let baseUrl: string;

describe('routes/webhooks', () => {
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

  beforeEach(() => {
    __resetWebhookDeliveryCache();
  });

  // ----------------------------------------------------------------- missing
  it('returns 503 when github_webhook_secret is not set', async () => {
    // Ensure no secret exists.
    settingsRepository.delete('github_webhook_secret');

    const body = JSON.stringify(prMergedBody('abc12345'));
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId(),
        'x-hub-signature-256': sign(body, SECRET),
      },
      body,
    });
    expect(res.status).toBe(503);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('webhook_secret_unset');
  });

  // ------------------------------------------------------------- bad signature
  it('returns 401 when the signature does not match', async () => {
    settingsRepository.set('github_webhook_secret', SECRET);

    const body = JSON.stringify(prMergedBody('xyz98765'));
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId(),
        'x-hub-signature-256': sign(body, 'wrong-secret'),
      },
      body,
    });
    expect(res.status).toBe(401);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('invalid_signature');
  });

  // -------------------------------------------------------- PR merge → done
  it('marks the linked task done on PR merge', async () => {
    settingsRepository.set('github_webhook_secret', SECRET);

    const task = createTask({
      id: 'mergedone001',
      title: 'PR target',
      status: 'in_progress',
      agent_status: 'needs_review',
    });

    const body = JSON.stringify(prMergedBody(task.id, true));
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId(),
        'x-hub-signature-256': sign(body, SECRET),
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as {
      ok: boolean;
      task_id?: string;
      action: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.task_id).toBe(task.id);
    expect(parsed.action).toBe('closed');

    const refreshed = getTask(task.id);
    expect(refreshed?.status).toBe('done');
    expect(refreshed?.agent_status).toBe('succeeded');
  });

  // -------------------------------------------------------- PR closed → failed
  it('marks the linked task failed on PR closed-without-merge', async () => {
    settingsRepository.set('github_webhook_secret', SECRET);

    const task = createTask({
      id: 'closednom001',
      title: 'PR target — abandoned',
      status: 'in_progress',
      agent_status: 'needs_review',
    });

    const body = JSON.stringify(prMergedBody(task.id, false));
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId(),
        'x-hub-signature-256': sign(body, SECRET),
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { ok: boolean; task_id?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.task_id).toBe(task.id);

    const refreshed = getTask(task.id);
    expect(refreshed?.status).toBe('failed');
    expect(refreshed?.agent_status).toBe('failed');

    // Note should be appended to context.notes.
    const ctx = refreshed?.context as Record<string, unknown> | null;
    const notes = (ctx?.notes as Array<{ note?: string }> | undefined) ?? [];
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[notes.length - 1]?.note ?? '').toMatch(/closed without merge/i);
  });

  // ----------------------------------------------------------- idempotency
  it('treats the same delivery_id as a no-op on replay', async () => {
    settingsRepository.set('github_webhook_secret', SECRET);

    const task = createTask({
      id: 'replaytarget',
      title: 'Replay target',
      status: 'in_progress',
      agent_status: 'needs_review',
    });

    const body = JSON.stringify(prMergedBody(task.id, true));
    const delivery = deliveryId();

    const headers = {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': delivery,
      'x-hub-signature-256': sign(body, SECRET),
    };

    const first = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers,
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { task_id?: string };
    expect(firstBody.task_id).toBe(task.id);

    // Reset task to a different state so we can detect re-processing.
    const afterFirst = getTask(task.id);
    expect(afterFirst?.status).toBe('done');

    // Replay — same delivery id should short-circuit.
    const second = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers,
      body,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { action: string };
    expect(secondBody.action).toBe('duplicate');
  });

  // ----------------------------------------------------- non-matching branch
  it('returns 200 with no task change when the branch is not agent/<id>', async () => {
    settingsRepository.set('github_webhook_secret', SECRET);

    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 7,
        state: 'closed',
        merged: true,
        title: 'random branch',
        html_url: 'https://github.com/example/repo/pull/7',
        head: { ref: 'feature/something-else' },
        base: { ref: 'main' },
      },
      repository: { full_name: 'example/repo' },
    });

    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId(),
        'x-hub-signature-256': sign(body, SECRET),
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as {
      ok: boolean;
      task_id?: string;
      note?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.task_id).toBeUndefined();
    expect(parsed.note ?? '').toMatch(/agent\/<task_id>/);
  });

  // ----------------------------------------------------------------- ping
  it('ack 200 on ping events', async () => {
    settingsRepository.set('github_webhook_secret', SECRET);

    const body = JSON.stringify({ zen: 'Speak like a human.' });
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': deliveryId(),
        'x-hub-signature-256': sign(body, SECRET),
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { ok: boolean; action: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe('ping');
  });
});
