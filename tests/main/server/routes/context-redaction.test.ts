/**
 * Tests for the redaction pass on `POST /api/context/capture` and
 * `POST /api/context/capture/batch` — the browser-extension intake path.
 *
 * The contract mirrors the window-tick redaction (see
 * `tests/main/monitor/sensitive-title-redaction.test.ts`):
 *
 *   - ANY of `window_title`, `page_title`, `h1`, `meta_description`,
 *     `selection`, or `url` tripping the regex causes ALL of those text
 *     fields to be replaced with `[redacted-sensitive]` and the URL to
 *     be stripped of its query + fragment.
 *   - `app_name` is left intact (low PII).
 *   - `metadata.sensitive_pattern_match` is set to `true` so the Watch
 *     view can render a "redacted" badge.
 *   - The row is STILL PERSISTED — redacted rows don't drop, because the
 *     deliberator + Watch view want to know "something sensitive happened
 *     at 14:03:21".
 *
 * Real API server, in-memory DB, mocked TaskPilot home directory. Auth is
 * disabled via the global `TASKPILOT_DISABLE_AUTH=1` env var that
 * `tests/helpers/setup.ts` sets.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../../helpers/mock-paths';
import { useMockedDb } from '../../../helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { REDACTION_PLACEHOLDER } from '@/main/monitor/sensitive-pattern';

let handle: ApiServerHandle;
let baseUrl: string;

describe('routes/context — redaction', () => {
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

  /* ------------------------------------------------------------------ /capture */
  describe('POST /api/context/capture (single)', () => {
    it('redacts page_title, h1, meta_description, selection on a sensitive page', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          url: 'https://my.1password.com/vault/items/abc?session=secret-xyz',
          page_title: '1Password — Vault',
          h1: 'Your Logins',
          meta_description: 'Manage your 1Password vault',
          selection: 'master-password=hunter2',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };

      const stored = contextObservationsRepository.get(body.id);
      expect(stored).not.toBeNull();
      expect(stored!.page_title).toBe(REDACTION_PLACEHOLDER);
      expect(stored!.h1).toBe(REDACTION_PLACEHOLDER);
      expect(stored!.meta_description).toBe(REDACTION_PLACEHOLDER);
      expect(stored!.selection).toBe(REDACTION_PLACEHOLDER);
      // URL: query string stripped, origin + path preserved.
      expect(stored!.url).toBe('https://my.1password.com/vault/items/abc');
      // Metadata flag for the Watch view's "redacted" badge.
      const meta = stored!.metadata as Record<string, unknown> | null;
      expect(meta?.sensitive_pattern_match).toBe(true);
    });

    it('redacts when only the URL trips the matcher (banking host)', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          url: 'https://login.bankofamerica.com/myaccounts?ref=abc123',
          page_title: 'Account Overview',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const stored = contextObservationsRepository.get(body.id);
      expect(stored!.page_title).toBe(REDACTION_PLACEHOLDER);
      // The full origin + path is kept; query is stripped.
      expect(stored!.url).toBe(
        'https://login.bankofamerica.com/myaccounts',
      );
      expect(
        (stored!.metadata as Record<string, unknown> | null)
          ?.sensitive_pattern_match,
      ).toBe(true);
    });

    it('persists the row even when redacted (does NOT drop it)', async () => {
      const beforeCount = contextObservationsRepository.count({});
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          url: 'https://example.com/oauth/authorize?state=abc',
          page_title: 'OAuth Authorize',
        }),
      });
      expect(res.status).toBe(201);
      expect(contextObservationsRepository.count({})).toBe(beforeCount + 1);
    });

    it('leaves a neutral capture untouched', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          url: 'https://news.ycombinator.com/item?id=12345',
          page_title: 'Show HN: TaskPilot',
          h1: 'Show HN: TaskPilot',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const stored = contextObservationsRepository.get(body.id);
      expect(stored!.page_title).toBe('Show HN: TaskPilot');
      expect(stored!.h1).toBe('Show HN: TaskPilot');
      // URL is preserved INCLUDING query — only sensitive captures get stripped.
      expect(stored!.url).toBe('https://news.ycombinator.com/item?id=12345');
      const meta = stored!.metadata as Record<string, unknown> | null;
      expect(meta?.sensitive_pattern_match).toBeUndefined();
    });

    it('preserves caller-supplied metadata alongside the redaction flag', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          url: 'https://app.example.com/login',
          page_title: 'Sign In',
          metadata: { tab_id: 42, referrer: 'https://example.com/' },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const stored = contextObservationsRepository.get(body.id);
      const meta = stored!.metadata as Record<string, unknown> | null;
      expect(meta?.sensitive_pattern_match).toBe(true);
      expect(meta?.tab_id).toBe(42);
      expect(meta?.referrer).toBe('https://example.com/');
    });

    it('leaves app_name intact even when redacting (low PII process name)', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'manual',
          app_name: '1Password',
          window_title: '1Password — Vault',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const stored = contextObservationsRepository.get(body.id);
      expect(stored!.app_name).toBe('1Password');
      expect(stored!.window_title).toBe(REDACTION_PLACEHOLDER);
    });
  });

  /* ------------------------------------------------------------ /capture/batch */
  describe('POST /api/context/capture/batch', () => {
    it('redacts each observation independently in a batch', async () => {
      const res = await fetch(`${baseUrl}/api/context/capture/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'browser',
          observations: [
            // Sensitive — banking
            {
              source: 'browser',
              url: 'https://bank.example.com/banking/transfer?amount=500',
              page_title: 'Banking — Transfer',
            },
            // Neutral
            {
              source: 'browser',
              url: 'https://example.com/blog',
              page_title: 'Our Blog',
            },
            // Sensitive — OAuth
            {
              source: 'browser',
              url: 'https://example.com/oauth/authorize?code=xyz',
              page_title: 'Authorize Acme',
            },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ids: string[] };
      expect(body.ids).toHaveLength(3);

      const [a, b, c] = body.ids.map((id) =>
        contextObservationsRepository.get(id),
      );
      // First — sensitive (banking)
      expect(a!.page_title).toBe(REDACTION_PLACEHOLDER);
      expect(a!.url).toBe('https://bank.example.com/banking/transfer');
      expect(
        (a!.metadata as Record<string, unknown> | null)
          ?.sensitive_pattern_match,
      ).toBe(true);
      // Second — neutral, query preserved
      expect(b!.page_title).toBe('Our Blog');
      expect(b!.url).toBe('https://example.com/blog');
      expect(
        (b!.metadata as Record<string, unknown> | null)
          ?.sensitive_pattern_match,
      ).toBeUndefined();
      // Third — sensitive (OAuth)
      expect(c!.page_title).toBe(REDACTION_PLACEHOLDER);
      expect(c!.url).toBe('https://example.com/oauth/authorize');
      expect(
        (c!.metadata as Record<string, unknown> | null)
          ?.sensitive_pattern_match,
      ).toBe(true);
    });
  });
});
