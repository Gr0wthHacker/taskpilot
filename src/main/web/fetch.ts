/**
 * HTTP fetch with readability extraction.
 *
 * Two modes:
 *   - mode: 'raw'  — returns the response body verbatim (HTML, JSON, text)
 *   - mode: 'text' — strips HTML to plain text with optional title + meta
 *                    description preserved (default)
 *
 * The fetch is bounded by a request timeout (default 20s) and a max body size
 * (default 5 MB) so a hostile or pathological response can't hang or OOM the
 * server. Redirect following is on by default; the final URL is reported back
 * so callers can detect cross-origin hops.
 */

import net from 'node:net';

import { parse, type HTMLElement } from 'node-html-parser';

/**
 * Typed error so the route layer can map URL-validation failures to 400
 * without resorting to a brittle error-message regex.
 */
export class UrlValidationError extends Error {
  readonly code = 'web_fetch_invalid_url';
  constructor(message: string) {
    super(message);
    this.name = 'UrlValidationError';
  }
}

export type FetchMode = 'raw' | 'text';

export interface FetchOptions {
  mode?: FetchMode;
  /** Milliseconds. Default 20_000. Capped at 60_000. */
  timeoutMs?: number;
  /** Bytes. Default 5 MB. Capped at 20 MB. */
  maxBytes?: number;
  /** Override the User-Agent. Default mimics Chrome on Windows. */
  userAgent?: string;
}

export interface FetchResponse {
  url: string;
  /** The URL of the final response after any redirects. */
  final_url: string;
  status: number;
  status_text: string;
  content_type: string;
  /** Best-effort title extraction from `<title>` or `og:title`. */
  title: string | null;
  /** Best-effort `<meta name="description">` / `og:description`. */
  description: string | null;
  /** Total bytes consumed (may be truncated to `maxBytes`). */
  byte_length: number;
  truncated: boolean;
  mode: FetchMode;
  /** The extracted body — text in 'text' mode, raw body in 'raw' mode. */
  body: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchUrl(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  let url = validateUrl(rawUrl);
  const mode: FetchMode = options.mode ?? 'text';
  const timeoutMs = Math.min(
    Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const maxBytes = Math.min(
    Math.max(1_024, options.maxBytes ?? DEFAULT_MAX_BYTES),
    MAX_MAX_BYTES,
  );
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    // Manual redirect handling: each hop's `Location` is re-run through
    // `validateUrl`, so an attacker can't smuggle us to 127.0.0.1 via a
    // 302 from a publicly resolvable host. `fetch(redirect: 'follow')`
    // would silently bypass the validator entirely.
    res = await followRedirects(url, { userAgent, controller });
    // followRedirects may have updated the effective URL — refresh for
    // logging / response shape consistency.
    url = new URL(res.url || url.toString());
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      // Don't echo the full URL — query strings may carry API keys.
      throw new Error(
        `fetchUrl: request to ${url.origin}${url.pathname} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  }

  let bytes: Uint8Array;
  let truncated: boolean;
  try {
    ({ bytes, truncated } = await readBounded(res, maxBytes, controller));
  } finally {
    // Always cancel the timer — `readBounded` can throw on network errors
    // and we don't want a stray abort firing on an already-finished response.
    clearTimeout(timer);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const charset = parseCharset(contentType) ?? 'utf-8';

  let raw: string;
  try {
    raw = new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  const isHtml = contentType.toLowerCase().includes('html');
  let title: string | null = null;
  let description: string | null = null;
  let body = raw;

  if (isHtml) {
    const meta = extractMeta(raw);
    title = meta.title;
    description = meta.description;
    if (mode === 'text') {
      body = htmlToText(raw);
    }
  } else if (mode === 'text') {
    // Non-HTML in text mode: collapse runs of whitespace; otherwise leave
    // alone. JSON / plaintext look fine as-is.
    body = raw;
  }

  return {
    url: url.toString(),
    final_url: res.url || url.toString(),
    status: res.status,
    status_text: res.statusText,
    content_type: contentType,
    title,
    description,
    byte_length: bytes.length,
    truncated,
    mode,
    body,
  };
}

/* -------------------------------------------------------------------------- */
/*  URL validation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reject anything that isn't http/https + protect against SSRF to internal
 * addresses. Covers:
 *   - Loopback (127.0.0.0/8, ::1, ::ffff:127.x, plus "localhost" string)
 *   - RFC1918 private (10/8, 172.16/12, 192.168/16)
 *   - Link-local (169.254/16, fe80::/10) — esp. 169.254.169.254 cloud metadata
 *   - ULA IPv6 (fc00::/7)
 *   - Unspecified (0.0.0.0, ::)
 *   - Non-dotted-quad IPv4 encodings (decimal `2130706433`, hex `0x7f.0.0.1`,
 *     shortform `127.1`) that bypass naive regex blocklists by parsing as a
 *     valid URL but still hitting loopback.
 *
 * DNS rebinding (hostname resolves to public IP at validate time, internal
 * IP at fetch time) is still out of scope — defending requires a custom
 * agent that pins the resolved IP across the connection. The bearer-auth
 * gate keeps this surface internal in practice.
 */
export function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlValidationError(`fetchUrl: invalid URL "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlValidationError(
      `fetchUrl: only http/https URLs are allowed (got ${parsed.protocol})`,
    );
  }
  // Reject URLs carrying userinfo. `http://[email protected]@evil.com` is fine
  // for the WHATWG URL parser (host = evil.com), but `http://[email protected]/`
  // is a phishing risk in logs and never legitimately needed by this tool.
  if (parsed.username || parsed.password) {
    throw new UrlValidationError(
      'fetchUrl: URLs with embedded credentials are not allowed',
    );
  }

  const rawHost = parsed.hostname;
  const lowerHost = rawHost.toLowerCase();

  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost')) {
    throw new UrlValidationError(
      `fetchUrl: refusing to fetch from local host "${rawHost}"`,
    );
  }

  // WHATWG URL strips the surrounding brackets from IPv6 hostnames.
  const isV6 = lowerHost.includes(':');
  if (isV6) {
    if (isInternalIPv6(lowerHost)) {
      throw new UrlValidationError(
        `fetchUrl: refusing to fetch from internal IPv6 "${rawHost}"`,
      );
    }
    return parsed;
  }

  // IPv4 — normalize numeric encodings before checking blocklist.
  const normalized = normalizeIPv4(lowerHost);
  if (normalized !== null) {
    if (isInternalIPv4(normalized)) {
      throw new UrlValidationError(
        `fetchUrl: refusing to fetch from internal IPv4 "${rawHost}"`,
      );
    }
    return parsed;
  }

  return parsed;
}

/**
 * Convert an IPv4 literal in any of the encodings `node`'s URL parser accepts
 * (`127.0.0.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`) into the
 * canonical dotted-quad form. Returns null if the host isn't an IPv4 literal.
 */
function normalizeIPv4(host: string): string | null {
  // Already canonical? Trust net.isIPv4.
  if (net.isIPv4(host)) return host;

  // Single integer (decimal, hex, or octal) representing the full 32-bit
  // address: `2130706433`, `0x7f000001`, `017700000001`.
  const singleInt = parseIntStrict(host);
  if (singleInt !== null && singleInt >= 0 && singleInt <= 0xffffffff) {
    return [
      (singleInt >>> 24) & 0xff,
      (singleInt >>> 16) & 0xff,
      (singleInt >>> 8) & 0xff,
      singleInt & 0xff,
    ].join('.');
  }

  // Dotted form with 2-4 parts; last part absorbs the remaining bits.
  // Examples: `127.1` → 127.0.0.1; `127.0.65535` → 127.0.255.255.
  const parts = host.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIntStrict(part);
    if (n === null || n < 0) return null;
    nums.push(n);
  }
  // Each leading part must fit in 8 bits; the final part absorbs the rest.
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i]! > 0xff) return null;
  }
  const last = nums[nums.length - 1]!;
  const remainingBits = (4 - nums.length + 1) * 8;
  if (last >= 2 ** remainingBits) return null;
  const out = [...nums.slice(0, -1)];
  for (let shift = remainingBits - 8; shift >= 0; shift -= 8) {
    out.push((last >>> shift) & 0xff);
  }
  return out.join('.');
}

/**
 * Parse a string strictly as decimal, octal (leading 0), or hex (leading 0x).
 * Returns null on anything else — including stray `+`/`-`/whitespace.
 */
function parseIntStrict(s: string): number | null {
  if (s.length === 0) return null;
  let base = 10;
  let body = s;
  if (/^0x/i.test(s)) {
    base = 16;
    body = s.slice(2);
    if (!/^[0-9a-f]+$/i.test(body)) return null;
  } else if (/^0[0-7]+$/.test(s)) {
    base = 8;
    body = s.slice(1);
  } else if (!/^\d+$/.test(s)) {
    return null;
  }
  const n = parseInt(body, base);
  return Number.isFinite(n) ? n : null;
}

function isInternalIPv4(canonical: string): boolean {
  if (canonical === '0.0.0.0') return true;
  return (
    /^127\./.test(canonical) ||
    /^10\./.test(canonical) ||
    /^192\.168\./.test(canonical) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(canonical) ||
    /^169\.254\./.test(canonical)
  );
}

/**
 * IPv6 internal-range check. We expand the address to its full 8-group form
 * via Node's built-in parser, then inspect the leading bits.
 *
 * Covers:
 *   - ::1 (loopback) — including longform `0:0:0:0:0:0:0:1`
 *   - :: (unspecified)
 *   - fc00::/7 (ULA)
 *   - fe80::/10 (link-local)
 *   - ::ffff:0:0/96 (IPv4-mapped) — must check the embedded IPv4
 *   - ::/96 (IPv4-compatible, deprecated)
 */
function isInternalIPv6(host: string): boolean {
  // Strip embedded zone id (`fe80::1%eth0`).
  const bare = host.split('%')[0] ?? host;
  if (!net.isIPv6(bare)) {
    // Hostname looked v6-shaped but isn't a valid literal. Reject conservatively.
    return true;
  }
  // Loopback / unspecified — cover all spellings.
  const collapsed = bare.replace(/^0+/, '0');
  if (bare === '::1' || collapsed === '::1' || /^0+(:0+){7}:?1$/.test(bare)) {
    return true;
  }
  if (bare === '::' || /^0+(:0+){7}$/.test(bare)) return true;

  // IPv4-mapped or compat: `::ffff:127.0.0.1` or `::127.0.0.1`.
  const mapped = /^::(ffff:)?([\d.]+)$/i.exec(bare);
  if (mapped && mapped[2]) {
    return isInternalIPv4(mapped[2]);
  }

  const lower = bare.toLowerCase();
  // Link-local fe80::/10.
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // ULA fc00::/7.
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  return false;
}

/**
 * Manually follow redirects. Each `Location` is re-validated through
 * `validateUrl` so an attacker can't pivot from a public host to an internal
 * one via 30x. Caps at MAX_REDIRECTS hops to defeat redirect loops.
 */
async function followRedirects(
  start: URL,
  ctx: { userAgent: string; controller: AbortController },
): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': ctx.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: ctx.controller.signal,
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    let next: URL;
    try {
      // Relative redirects resolve against the current URL.
      next = new URL(location, current);
    } catch {
      throw new UrlValidationError(
        `fetchUrl: redirect produced invalid URL "${location}"`,
      );
    }
    // Validate the hop. Throws UrlValidationError on internal targets.
    validateUrl(next.toString());
    // Drain the redirect body so the underlying connection can be reused.
    try {
      await res.body?.cancel();
    } catch {
      /* best-effort */
    }
    current = next;
  }
  throw new Error(`fetchUrl: too many redirects (>${MAX_REDIRECTS})`);
}

/* -------------------------------------------------------------------------- */
/*  Bounded body read                                                          */
/* -------------------------------------------------------------------------- */

async function readBounded(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
      }
      truncated = true;
      controller.abort();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return { bytes: out, truncated };
}

/* -------------------------------------------------------------------------- */
/*  Charset parsing                                                            */
/* -------------------------------------------------------------------------- */

function parseCharset(contentType: string): string | null {
  const m = /charset=([^;]+)/i.exec(contentType);
  if (!m || !m[1]) return null;
  return m[1].trim().replace(/^"|"$/g, '').toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  HTML → text                                                               */
/* -------------------------------------------------------------------------- */

/** Tags whose content never belongs in a readability extraction. */
const STRIP_TAGS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'nav',
  'footer',
  'aside',
  'template',
  'object',
  'embed',
] as const;

interface ExtractedMeta {
  title: string | null;
  description: string | null;
}

function extractMeta(html: string): ExtractedMeta {
  let root: HTMLElement;
  try {
    root = parse(html);
  } catch {
    return { title: null, description: null };
  }
  const titleEl = root.querySelector('title');
  const ogTitle = root.querySelector('meta[property="og:title"]');
  const title =
    titleEl?.text.trim() ||
    ogTitle?.getAttribute('content')?.trim() ||
    null;

  const descMeta = root.querySelector('meta[name="description"]');
  const ogDesc = root.querySelector('meta[property="og:description"]');
  const description =
    descMeta?.getAttribute('content')?.trim() ||
    ogDesc?.getAttribute('content')?.trim() ||
    null;
  return { title, description };
}

/**
 * Lightweight readability — strip scripts/styles, then take the textContent of
 * the most-content-heavy candidate (main/article/body) and collapse whitespace.
 * Not as smart as @mozilla/readability but no jsdom dep and good enough to
 * turn a typical article into something usable.
 */
function htmlToText(html: string): string {
  let root: HTMLElement;
  try {
    root = parse(html);
  } catch {
    return html;
  }
  // Drop noisy elements that never carry the article body.
  for (const sel of STRIP_TAGS) {
    root.querySelectorAll(sel).forEach((n) => n.remove());
  }
  // Prefer an obvious main/article container if present.
  const candidate =
    root.querySelector('article') ||
    root.querySelector('main') ||
    root.querySelector('[role="main"]') ||
    root.querySelector('body') ||
    root;
  const text = candidate.text;
  return text
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* -------------------------------------------------------------------------- */
/*  Test-only                                                                 */
/* -------------------------------------------------------------------------- */

export const __testing = {
  validateUrl,
  parseCharset,
  extractMeta,
  htmlToText,
  normalizeIPv4,
  isInternalIPv4,
  isInternalIPv6,
};
