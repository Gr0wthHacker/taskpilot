/**
 * Telemetry collector tests.
 *
 * Coverage:
 *   - record() ALWAYS logs to ~/.taskpilot/logs/telemetry.jsonl (regardless
 *     of the opt-in setting)
 *   - Sanitization replaces home directory paths with `~`
 *   - Sensitive keys (title, description, secret, token, password, email)
 *     are stripped from payloads
 *   - flush() returns 0 uploads when opt-in is off
 *   - flush() POSTs to the endpoint when both flag + URL are set
 */

import fs from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import {
  _internal,
  flush,
  logPath,
  readAll,
  record,
  recordError,
  resetCursor,
  sanitizeValue,
} from '@/main/telemetry';
import { settingsRepository } from '@/main/db/repositories/settings';

describe('telemetry', () => {
  useMockedDb();

  beforeEach(() => {
    // Clear the log between tests so assertions are deterministic.
    if (fs.existsSync(PATHS.TELEMETRY_LOG_PATH)) {
      try {
        fs.rmSync(PATHS.TELEMETRY_LOG_PATH);
      } catch {
        // ignore
      }
    }
    const rotated = `${PATHS.TELEMETRY_LOG_PATH}.1`;
    if (fs.existsSync(rotated)) {
      try {
        fs.rmSync(rotated);
      } catch {
        // ignore
      }
    }
  });

  it('record() writes to the local jsonl regardless of opt-in', () => {
    expect(settingsRepository.get<boolean>('telemetry_enabled')).toBeNull();

    record({ kind: 'launch' });
    record({ kind: 'task_created', payload: { count: 1 } });

    const entries = readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe('launch');
    expect(entries[1]?.kind).toBe('task_created');
    expect((entries[1]?.payload as Record<string, unknown>)?.count).toBe(1);
  });

  it('logPath() points at the per-worker tmp dir', () => {
    expect(logPath()).toBe(PATHS.TELEMETRY_LOG_PATH);
  });

  it('sanitization rewrites home paths to ~', () => {
    const home = _internal.sanitizePath;
    // Use a synthetic home so the test works regardless of the worker dir.
    // Real test: feed a string containing the configured os.homedir() and
    // expect it to come back with `~` substituted.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    const real = os.homedir();
    const sample = `error at ${real}/foo/bar/baz.ts:10`;
    expect(home(sample)).toBe('error at ~/foo/bar/baz.ts:10');
  });

  it('sanitizeValue strips sensitive keys', () => {
    const input = {
      title: 'super secret task',
      description: 'private notes',
      token: 'abc123',
      password: 'hunter2',
      email: 'jack@example.com',
      counts: { a: 1, b: 2 },
      nested: {
        secret: 'shh',
        safe: 'ok',
      },
    };
    const out = sanitizeValue(input) as Record<string, unknown>;
    expect(out.title).toMatch(/^\[redacted/);
    expect(out.description).toMatch(/^\[redacted/);
    expect(out.token).toMatch(/^\[redacted/);
    expect(out.password).toMatch(/^\[redacted/);
    expect(out.email).toMatch(/^\[redacted/);
    expect(out.counts).toEqual({ a: 1, b: 2 });
    const nested = out.nested as Record<string, unknown>;
    expect(nested.secret).toMatch(/^\[redacted/);
    expect(nested.safe).toBe('ok');
  });

  it('recordError sanitizes the stack trace', () => {
    const err = new Error('boom at sensitive path');
    // Force the stack to mention the home dir so we can verify the rewrite.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    err.stack = `Error: boom\n    at thing (${os.homedir()}/code/file.ts:1:1)`;

    recordError(err, { source: 'test' });

    const entries = readAll();
    expect(entries).toHaveLength(1);
    const payload = entries[0]?.payload as Record<string, unknown>;
    expect(String(payload.stack)).toContain('~/code/file.ts');
    expect(String(payload.stack)).not.toContain(os.homedir());
  });

  it('flush returns 0 uploads when opt-in is off', async () => {
    record({ kind: 'launch' });
    record({ kind: 'task_done' });

    // Opt-in is null by default.
    const result = await flush();
    expect(result.uploaded).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('flush returns 0 uploads when endpoint is empty even if opt-in is on', async () => {
    settingsRepository.set('telemetry_enabled', true);
    record({ kind: 'launch' });

    const result = await flush();
    expect(result.uploaded).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('flush POSTs to the endpoint when both flag + URL are set', async () => {
    settingsRepository.set('telemetry_enabled', true);
    settingsRepository.set('telemetry_endpoint', 'https://ingest.example/x');
    await resetCursor();

    record({ kind: 'launch' });
    record({ kind: 'task_created', payload: { count: 1 } });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const result = await flush();
      expect(result.uploaded).toBe(2);
      expect(result.errors).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://ingest.example/x');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('"kind":"launch"');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('flush surfaces a network failure as an error count', async () => {
    settingsRepository.set('telemetry_enabled', true);
    settingsRepository.set('telemetry_endpoint', 'https://ingest.example/x');
    await resetCursor();

    record({ kind: 'launch' });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof globalThis.fetch;

    try {
      const result = await flush();
      expect(result.uploaded).toBe(0);
      expect(result.errors).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('flush advances the cursor so the same line is not re-shipped', async () => {
    settingsRepository.set('telemetry_enabled', true);
    settingsRepository.set('telemetry_endpoint', 'https://ingest.example/x');
    await resetCursor();

    record({ kind: 'launch' });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof globalThis.fetch;

    try {
      const first = await flush();
      expect(first.uploaded).toBe(1);
      // No new records since the previous flush → second pass uploads 0.
      const second = await flush();
      expect(second.uploaded).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
