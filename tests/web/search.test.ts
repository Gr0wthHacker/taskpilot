/**
 * Web search adapter tests.
 *
 * Each adapter is exercised by mocking global `fetch`. We assert the right
 * endpoint is hit, the right headers go out, and the returned shape matches
 * the canonical `SearchResult[]`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { search, __testing } from '@/main/web/search';

const originalFetch = global.fetch;

describe('search/pickProvider', () => {
  afterEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.SERPER_API_KEY;
  });

  it('falls back to duckduckgo when no key is set', () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.SERPER_API_KEY;
    expect(__testing.pickProvider()).toBe('duckduckgo');
  });

  it('prefers brave when BRAVE_API_KEY is set', () => {
    process.env.BRAVE_API_KEY = 'x';
    expect(__testing.pickProvider()).toBe('brave');
  });

  it('prefers brave over serper when both keys are set', () => {
    process.env.BRAVE_API_KEY = 'x';
    process.env.SERPER_API_KEY = 'y';
    expect(__testing.pickProvider()).toBe('brave');
  });

  it('uses serper when only SERPER_API_KEY is set', () => {
    process.env.SERPER_API_KEY = 'y';
    expect(__testing.pickProvider()).toBe('serper');
  });
});

describe('search/unwrapDdgRedirect', () => {
  it('unwraps the //duckduckgo.com/l/ outbound redirect', () => {
    const wrapped =
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath&rut=abc';
    expect(__testing.unwrapDdgRedirect(wrapped)).toBe(
      'https://example.com/path',
    );
  });

  it('returns absolute http URLs unchanged', () => {
    expect(__testing.unwrapDdgRedirect('https://example.com/x')).toBe(
      'https://example.com/x',
    );
  });

  it('returns the raw string for unparseable inputs', () => {
    expect(__testing.unwrapDdgRedirect('javascript:void(0)')).toBe(
      'javascript:void(0)',
    );
  });
});

describe('search/duckduckgo (mocked fetch)', () => {
  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.SERPER_API_KEY;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('parses the lite-endpoint HTML into results', async () => {
    const html = `
      <html><body><table>
        <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F1">First</a></td></tr>
        <tr><td class="result-snippet">First snippet</td></tr>
        <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2F2">Second</a></td></tr>
        <tr><td class="result-snippet">Second snippet</td></tr>
      </table></body></html>
    `;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => html,
    }) as unknown as typeof global.fetch;

    const result = await search('hello world');
    expect(result.provider).toBe('duckduckgo');
    expect(result.count).toBe(2);
    expect(result.results).toEqual([
      {
        title: 'First',
        url: 'https://a.example/1',
        snippet: 'First snippet',
      },
      {
        title: 'Second',
        url: 'https://b.example/2',
        snippet: 'Second snippet',
      },
    ]);
  });

  it('respects the limit option', async () => {
    const rows: string[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(
        `<tr><td><a class="result-link" href="https://x.example/${i}">T${i}</a></td></tr>`,
      );
      rows.push(`<tr><td class="result-snippet">S${i}</td></tr>`);
    }
    const html = `<html><body><table>${rows.join('')}</table></body></html>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => html,
    }) as unknown as typeof global.fetch;

    const result = await search('q', { limit: 3 });
    expect(result.results).toHaveLength(3);
  });

  it('throws on non-2xx from the lite endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => '',
    }) as unknown as typeof global.fetch;
    await expect(search('q')).rejects.toThrow(/503/);
  });
});

describe('search/brave (mocked fetch)', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BRAVE_API_KEY;
  });

  it('hits the brave endpoint with the subscription token header', async () => {
    process.env.BRAVE_API_KEY = 'secret-key';
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        web: {
          results: [
            { title: 'A', url: 'https://a.example/', description: 'desc-a' },
            { title: 'B', url: 'https://b.example/', description: 'desc-b' },
          ],
        },
      }),
    });
    global.fetch = spy as unknown as typeof global.fetch;

    const result = await search('hello', { limit: 2 });
    expect(result.provider).toBe('brave');
    expect(result.results).toEqual([
      { title: 'A', url: 'https://a.example/', snippet: 'desc-a' },
      { title: 'B', url: 'https://b.example/', snippet: 'desc-b' },
    ]);

    // First arg is a URL object; second carries the auth header.
    const firstCall = spy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const url = firstCall![0] as URL;
    expect(url.toString()).toMatch(/api\.search\.brave\.com.*q=hello/);
    const init = firstCall![1] as RequestInit;
    expect(
      (init.headers as Record<string, string>)['X-Subscription-Token'],
    ).toBe('secret-key');
  });
});

describe('search/serper (mocked fetch)', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SERPER_API_KEY;
  });

  it('posts to the serper endpoint with X-API-KEY', async () => {
    process.env.SERPER_API_KEY = 'serper-secret';
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        organic: [
          { title: 'A', link: 'https://a.example/', snippet: 'sn-a' },
          { title: 'B', link: 'https://b.example/', snippet: 'sn-b' },
        ],
      }),
    });
    global.fetch = spy as unknown as typeof global.fetch;

    const result = await search('hi');
    expect(result.provider).toBe('serper');
    expect(result.results).toEqual([
      { title: 'A', url: 'https://a.example/', snippet: 'sn-a' },
      { title: 'B', url: 'https://b.example/', snippet: 'sn-b' },
    ]);
    const firstCall = spy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const init = firstCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe(
      'serper-secret',
    );
  });
});

describe('search/validation', () => {
  it('rejects empty queries', async () => {
    await expect(search('')).rejects.toThrow(/non-empty/);
    await expect(search('   ')).rejects.toThrow(/non-empty/);
  });
});
