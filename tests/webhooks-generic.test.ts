/**
 * Generic webhook receiver + registry tests.
 *
 * Two test suites in one file:
 *
 *   1. Unit-level — exercises the dispatcher (`ruleMatches`,
 *      `renderTemplate`, `dispatch` against the DB) and the registry
 *      (CRUD round-trip, slug sanitization).
 *   2. Integration — boots the real Express server with auth disabled
 *      and exercises `/api/webhooks/incoming/:name` end-to-end:
 *      missing config → 404, bad HMAC → 401, valid signed payload runs
 *      the mapping rules.
 *
 * Wave 13 — Agent M.
 */

import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { createTask, getTask } from '@/main/db/repositories/tasks';
import {
  createConfig,
  deleteConfig,
  getConfig,
  getConfigByName,
  isValidName,
  listConfigs,
  sanitizeName,
  updateConfig,
} from '@/main/webhooks/registry';
import {
  dispatch,
  renderTemplate,
  resolvePath,
  ruleMatches,
  verifyHmac,
} from '@/main/webhooks/dispatcher';

/* -------------------------------------------------------------------------- */
/*  Unit tests                                                                */
/* -------------------------------------------------------------------------- */

describe('webhooks/dispatcher (unit)', () => {
  useMockedDb();

  it('resolves dotted paths into nested payloads', () => {
    const payload = {
      issue: { number: 42, title: 'Hi' },
      tags: ['a', 'b'],
    };
    expect(resolvePath(payload, 'issue.title')).toBe('Hi');
    expect(resolvePath(payload, 'issue.number')).toBe(42);
    expect(resolvePath(payload, 'tags.1')).toBe('b');
    expect(resolvePath(payload, 'missing.field')).toBeUndefined();
    expect(resolvePath(payload, '')).toBeUndefined();
  });

  it('renders {{path}} templates against the payload', () => {
    const payload = { issue: { title: 'Hi', number: 42 }, who: null };
    expect(renderTemplate('PR #{{issue.number}}: {{issue.title}}', payload)).toBe(
      'PR #42: Hi',
    );
    // Missing paths render as empty string — typo-tolerant by design.
    expect(renderTemplate('hello {{nope}}', payload)).toBe('hello ');
    // Null collapses to empty rather than the literal "null".
    expect(renderTemplate('x{{who}}y', payload)).toBe('xy');
  });

  it('matches rules with strict and string-coerced equality', () => {
    const rule = {
      match: { path: 'action', equals: 'opened' },
      action: 'create_task' as const,
      template: { title: 't' },
    };
    expect(ruleMatches(rule, { action: 'opened' })).toBe(true);
    expect(ruleMatches(rule, { action: 'closed' })).toBe(false);
    // Numeric vs string coerce-equal.
    expect(
      ruleMatches(
        { ...rule, match: { path: 'n', equals: '42' } },
        { n: 42 },
      ),
    ).toBe(true);
    // No `match` always fires.
    expect(
      ruleMatches(
        { action: 'create_task' as const, template: { title: 'x' } },
        {},
      ),
    ).toBe(true);
  });

  it('dispatch creates tasks for matching rules', () => {
    const config = createConfig({
      name: 'linear',
      secret: 'abc',
      mapping_rules: [
        {
          match: { path: 'event', equals: 'issue.created' },
          action: 'create_task',
          template: {
            title: 'Linear: {{title}}',
            description: '{{body}}',
            priority: 'p1',
            tags: ['linear'],
          },
        },
        {
          match: { path: 'event', equals: 'issue.deleted' },
          action: 'create_task',
          template: { title: 'should not fire' },
        },
      ],
    });

    const result = dispatch(config, {
      event: 'issue.created',
      title: 'Fix the thing',
      body: 'A description',
    });
    expect(result.triggered_rules).toBe(1);
    expect(result.created_tasks).toHaveLength(1);
    const created = getTask(result.created_tasks[0]);
    expect(created?.title).toBe('Linear: Fix the thing');
    expect(created?.priority).toBe('p1');
    expect(created?.tags).toContain('linear');
  });

  it('dispatch update_task / comment_task respect the task_id template', () => {
    const target = createTask({
      id: 'targetA12345',
      title: 'Existing',
      status: 'inbox',
    });

    const config = createConfig({
      name: 'updater',
      mapping_rules: [
        {
          action: 'update_task',
          template: { task_id: '{{task_id}}', title: 'Renamed' },
        },
        {
          action: 'comment_task',
          template: { task_id: '{{task_id}}', note: 'PR opened: {{pr_url}}' },
        },
      ],
    });

    const result = dispatch(config, {
      task_id: target.id,
      pr_url: 'https://x/1',
    });
    expect(result.triggered_rules).toBe(2);
    expect(result.updated_tasks).toContain(target.id);

    const refreshed = getTask(target.id);
    expect(refreshed?.title).toBe('Renamed');
    const notes = (refreshed?.context as { notes?: Array<{ note: string }> })
      ?.notes;
    expect(notes?.[notes.length - 1]?.note).toContain('PR opened: https://x/1');
  });

  it('dispatch dry-run never touches the DB', () => {
    const config = createConfig({
      name: 'dry',
      mapping_rules: [
        {
          action: 'create_task',
          template: { title: 'would-not-create' },
        },
      ],
    });

    const before = listConfigs().length;
    const result = dispatch(config, {}, { dryRun: true });
    expect(result.triggered_rules).toBe(1);
    expect(result.created_tasks).toHaveLength(0);
    expect(listConfigs().length).toBe(before);
  });
});

describe('webhooks/dispatcher — HMAC', () => {
  useMockedDb();

  it('verifyHmac accepts a correctly-signed body', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    const secret = 'shhh';
    const sig =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyHmac(body, sig, secret, 'sha256')).toBe(true);
    // Without the algorithm prefix also works (caller normalizes).
    const bareHex = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    expect(verifyHmac(body, bareHex, secret, 'sha256')).toBe(true);
  });

  it('verifyHmac rejects a wrong signature', () => {
    const body = Buffer.from('{}', 'utf8');
    expect(verifyHmac(body, 'sha256=deadbeef', 'shhh', 'sha256')).toBe(false);
    expect(verifyHmac(body, undefined, 'shhh', 'sha256')).toBe(false);
  });
});

describe('webhooks/registry', () => {
  useMockedDb();

  it('sanitizes and validates names', () => {
    expect(sanitizeName('Linear Issues!')).toBe('linear-issues');
    expect(sanitizeName('-foo--bar-')).toBe('foo-bar');
    expect(isValidName('linear-issues')).toBe(true);
    expect(isValidName('-bad')).toBe(false);
    expect(isValidName('UPPER')).toBe(false);
  });

  it('round-trips create / update / delete', () => {
    const a = createConfig({ name: 'a', secret: 'one' });
    const b = createConfig({ name: 'b', secret: 'two' });
    expect(listConfigs().map((c) => c.name).sort()).toEqual(['a', 'b']);
    expect(getConfigByName('a')?.id).toBe(a.id);

    const updated = updateConfig(a.id, { enabled: false, secret: null });
    expect(updated?.enabled).toBe(false);
    expect(updated?.secret).toBeUndefined();

    expect(deleteConfig(b.id)).toBe(true);
    expect(getConfig(b.id)).toBeNull();
    expect(listConfigs().length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Integration tests                                                         */
/* -------------------------------------------------------------------------- */

function sign(body: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

describe('routes/generic-webhooks', () => {
  useMockedDb();

  let handle: ApiServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = await startApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }, 30_000);

  afterAll(async () => {
    if (handle) {
      await Promise.race([
        handle.stop(),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
    }
  }, 30_000);

  it('404s on an unknown webhook name', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/incoming/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('webhook_not_found');
  });

  it('rejects a wrongly-signed request with 401', async () => {
    createConfig({
      name: 'signed',
      secret: 'real-secret',
      mapping_rules: [
        {
          match: { path: 'event', equals: 'fire' },
          action: 'create_task',
          template: { title: 'fired' },
        },
      ],
    });

    const body = JSON.stringify({ event: 'fire' });
    const res = await fetch(`${baseUrl}/api/webhooks/incoming/signed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-256': sign(body, 'wrong-secret'),
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('runs matching rules on a properly-signed request', async () => {
    createConfig({
      name: 'live',
      secret: 'live-secret',
      mapping_rules: [
        {
          match: { path: 'event', equals: 'issue.created' },
          action: 'create_task',
          template: {
            title: 'Live: {{title}}',
            priority: 'p1',
            tags: ['webhook'],
          },
        },
      ],
    });

    const body = JSON.stringify({
      event: 'issue.created',
      title: 'a new bug',
    });
    const res = await fetch(`${baseUrl}/api/webhooks/incoming/live`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-256': sign(body, 'live-secret'),
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as {
      ok: boolean;
      triggered_rules: number;
      created_tasks: string[];
    };
    expect(parsed.triggered_rules).toBe(1);
    expect(parsed.created_tasks).toHaveLength(1);

    const created = getTask(parsed.created_tasks[0]);
    expect(created?.title).toBe('Live: a new bug');
    expect(created?.tags).toContain('webhook');
  });

  it('honors `signature_algorithm: none` for trusted-network mode', async () => {
    createConfig({
      name: 'trusted',
      signature_algorithm: 'none',
      trusted_network_only: true,
      mapping_rules: [
        {
          action: 'create_task',
          template: { title: 'unsigned worked' },
        },
      ],
    });

    const res = await fetch(`${baseUrl}/api/webhooks/incoming/trusted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('refuses sha256 webhooks that have no secret configured', async () => {
    createConfig({
      name: 'missing-secret',
      // No secret, but algorithm defaults to sha256 — explicit
      // misconfiguration should fail loudly.
      mapping_rules: [
        { action: 'create_task', template: { title: 'x' } },
      ],
    });

    const res = await fetch(
      `${baseUrl}/api/webhooks/incoming/missing-secret`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('secret_required');
  });

  it('refuses requests to a disabled config with 404', async () => {
    const c = createConfig({
      name: 'disabled',
      signature_algorithm: 'none',
      trusted_network_only: true,
      enabled: false,
      mapping_rules: [],
    });

    const res = await fetch(`${baseUrl}/api/webhooks/incoming/disabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    deleteConfig(c.id);
  });
});
