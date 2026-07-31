/**
 * fetchUrl tests.
 *
 * Validation, charset handling, redirect tracking, and readability extraction.
 * Network is mocked via global `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchUrl, __testing } from '@/main/web/fetch';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('fetchUrl/validateUrl', () => {
  const { validateUrl } = __testing;

  it('accepts http and https', () => {
    expect(validateUrl('http://example.com/').toString()).toBe(
      'http://example.com/',
    );
    expect(validateUrl('https://example.com/path').toString()).toBe(
      'https://example.com/path',
    );
  });

  it('rejects invalid URLs', () => {
    expect(() => validateUrl('not a url')).toThrow(/invalid URL/);
  });

  it('rejects non-http schemes', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/only http\/https/);
    expect(() => validateUrl('javascript:alert(1)')).toThrow(/only http\/https/);
  });

  it('rejects localhost + loopback IPv4', () => {
    expect(() => validateUrl('http://localhost:7847/api')).toThrow(
      /local host/,
    );
    // 127.x and 0.0.0.0 go through the IPv4 path so the message reads
    // "internal IPv4". Both forms are blocked.
    expect(() => validateUrl('http://127.0.0.1/')).toThrow(/internal IPv4/);
    expect(() => validateUrl('http://0.0.0.0/')).toThrow(/internal IPv4/);
  });

  it('rejects private IPv4 ranges', () => {
    expect(() => validateUrl('http://10.0.0.1/')).toThrow(/internal IPv4/);
    expect(() => validateUrl('http://192.168.1.1/')).toThrow(/internal IPv4/);
    expect(() => validateUrl('http://172.16.0.1/')).toThrow(/internal IPv4/);
    expect(() => validateUrl('http://169.254.169.254/')).toThrow(/internal IPv4/);
  });

  it('does not block 172 IPs outside the 16-31 second octet', () => {
    // 172.15.x and 172.32.x are public.
    expect(() => validateUrl('http://172.15.0.1/')).not.toThrow();
    expect(() => validateUrl('http://172.32.0.1/')).not.toThrow();
  });

  it('rejects IPv4 numeric encodings (decimal/hex/octal/shortform)', () => {
    // 2130706433 = 127.0.0.1 decimal
    expect(() => validateUrl('http://2130706433/')).toThrow(/internal IPv4/);
    // 0x7f000001 = 127.0.0.1 hex
    expect(() => validateUrl('http://0x7f000001/')).toThrow(/internal IPv4/);
    // 0177.0.0.1 = 127.0.0.1 (leading 0 → octal)
    expect(() => validateUrl('http://0177.0.0.1/')).toThrow(/internal IPv4/);
    // 127.1 shortform = 127.0.0.1
    expect(() => validateUrl('http://127.1/')).toThrow(/internal IPv4/);
  });

  it('rejects IPv6 loopback in every spelling', () => {
    expect(() => validateUrl('http://[::1]/')).toThrow(/internal IPv6/);
    expect(() => validateUrl('http://[0:0:0:0:0:0:0:1]/')).toThrow(
      /internal IPv6/,
    );
  });

  it('rejects IPv4-mapped IPv6 loopback', () => {
    expect(() => validateUrl('http://[::ffff:127.0.0.1]/')).toThrow(
      /internal IPv6/,
    );
  });

  it('rejects IPv6 link-local + ULA + unspecified', () => {
    expect(() => validateUrl('http://[fe80::1]/')).toThrow(/internal IPv6/);
    expect(() => validateUrl('http://[fc00::1]/')).toThrow(/internal IPv6/);
    expect(() => validateUrl('http://[fd12:3456::1]/')).toThrow(
      /internal IPv6/,
    );
    expect(() => validateUrl('http://[::]/')).toThrow(/internal IPv6/);
  });

  it('rejects URLs with embedded credentials', () => {
    // Node's URL parser rejects userinfo when the host has a dot (per
    // WHATWG strictness), so we exercise the credential check with hosts
    // it accepts. The point is that `parsed.username`/`password` getting
    // populated trips our guard.
    expect(() => validateUrl('http://user:pass@example/')).toThrow(
      /embedded credentials/,
    );
    expect(() => validateUrl('http://user@host/')).toThrow(
      /embedded credentials/,
    );
  });
});

describe('fetchUrl/normalizeIPv4', () => {
  const { normalizeIPv4 } = __testing;

  it('keeps dotted-quad unchanged', () => {
    expect(normalizeIPv4('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIPv4('8.8.8.8')).toBe('8.8.8.8');
  });

  it('expands single decimal integers', () => {
    expect(normalizeIPv4('2130706433')).toBe('127.0.0.1');
    expect(normalizeIPv4('16909060')).toBe('1.2.3.4');
  });

  it('expands single hex integers', () => {
    expect(normalizeIPv4('0x7f000001')).toBe('127.0.0.1');
  });

  it('expands 2-part shortform', () => {
    expect(normalizeIPv4('127.1')).toBe('127.0.0.1');
    expect(normalizeIPv4('10.65535')).toBe('10.0.255.255');
  });

  it('returns null for non-IPv4 hosts', () => {
    expect(normalizeIPv4('example.com')).toBeNull();
    expect(normalizeIPv4('not-an-ip')).toBeNull();
    expect(normalizeIPv4('1.2.3.4.5')).toBeNull();
  });
});

describe('fetchUrl/extractMeta', () => {
  const { extractMeta } = __testing;

  it('pulls title and description from standard tags', () => {
    const html = `
      <html><head>
        <title>My Page</title>
        <meta name="description" content="A description">
      </head><body>x</body></html>
    `;
    expect(extractMeta(html)).toEqual({
      title: 'My Page',
      description: 'A description',
    });
  });

  it('falls back to og:title / og:description', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG desc">
      </head><body>x</body></html>
    `;
    expect(extractMeta(html)).toEqual({
      title: 'OG Title',
      description: 'OG desc',
    });
  });

  it('prefers <title> over og:title', () => {
    const html = `
      <html><head>
        <title>Real</title>
        <meta property="og:title" content="OG">
      </head></html>
    `;
    expect(extractMeta(html).title).toBe('Real');
  });
});

describe('fetchUrl/htmlToText', () => {
  const { htmlToText } = __testing;

  it('strips script and style tags', () => {
    const html = `
      <html><body>
        <script>var x = 1;</script>
        <style>.x { color: red }</style>
        <article><p>Hello world.</p></article>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toContain('Hello world.');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('color: red');
  });

  it('prefers <article> as the content container', () => {
    const html = `
      <html><body>
        <nav>nav stuff</nav>
        <article><p>Main content here.</p></article>
        <footer>footer stuff</footer>
      </body></html>
    `;
    const text = htmlToText(html);
    expect(text).toBe('Main content here.');
  });

  it('collapses runs of blank lines', () => {
    const html = '<body><p>A</p><p>B</p><p>C</p></body>';
    const text = htmlToText(html);
    expect(text.split(/\n{2,}/).length).toBeLessThanOrEqual(3);
  });
});

describe('fetchUrl (integration)', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://example.com/final',
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: new ReadableStream({
        start(controller) {
          const html = `
            <html><head>
              <title>Example</title>
              <meta name="description" content="Just an example">
            </head><body><article><p>Hello.</p></article></body></html>
          `;
          controller.enqueue(new TextEncoder().encode(html));
          controller.close();
        },
      }),
    }) as unknown as typeof global.fetch;
  });

  it('returns the parsed body in text mode by default', async () => {
    const res = await fetchUrl('https://example.com/');
    expect(res.status).toBe(200);
    expect(res.title).toBe('Example');
    expect(res.description).toBe('Just an example');
    expect(res.body).toContain('Hello.');
    expect(res.body).not.toContain('<title>');
    expect(res.final_url).toBe('https://example.com/final');
    expect(res.mode).toBe('text');
  });

  it('returns the raw HTML in raw mode', async () => {
    const res = await fetchUrl('https://example.com/', { mode: 'raw' });
    expect(res.body).toContain('<title>Example</title>');
    expect(res.mode).toBe('raw');
  });

  it('rejects redirects that point at internal targets', async () => {
    // First fetch returns a 302 pointing at 127.0.0.1. Second fetch never
    // happens — the validator throws on the redirect target first.
    const spy = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: 'Found',
      url: 'https://attacker.example/',
      headers: new Headers({ location: 'http://127.0.0.1:7847/api/health' }),
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });
    global.fetch = spy as unknown as typeof global.fetch;

    await expect(fetchUrl('https://attacker.example/')).rejects.toThrow(
      /internal IPv4|invalid URL/i,
    );
    // Only the first request should have fired; the redirect was blocked.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects requests over maxBytes', async () => {
    const huge = 'x'.repeat(10_000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://example.com/',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(huge));
          controller.close();
        },
      }),
    }) as unknown as typeof global.fetch;

    const res = await fetchUrl('https://example.com/', { maxBytes: 1_024 });
    expect(res.truncated).toBe(true);
    expect(res.byte_length).toBe(1_024);
  });
});
