/**
 * Server-side URL fetcher for `kind='url'` memory captures.
 *
 * What it does:
 *   1. Fetch the URL with a strict timeout + size cap.
 *   2. Parse the HTML with `node-html-parser` (already in the tree).
 *   3. Strip noisy nodes (script/style/nav/footer/aside).
 *   4. Return the `<title>` plus a plain-text rendering of the main body.
 *
 * Why not turndown / html-to-markdown? The memory subsystem stores raw
 * content as a Claude summarization input — perfect HTML→md fidelity
 * doesn't matter. Cheap-and-good-enough plain text beats a new dep.
 *
 * SECURITY:
 *   - Only `http:` and `https:` are allowed (no `file:`, `data:`, etc).
 *   - Response size hard-capped at 5 MB; truncated past that with a note.
 *   - 10-second timeout. The renderer should not pin the UI on this call.
 */

import { parse } from 'node-html-parser';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;

export interface FetchedPage {
  title: string | null;
  markdown: string;
  /** True when the fetched body exceeded `MAX_BYTES` and was truncated. */
  truncated: boolean;
}

function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${u.protocol}`);
  }
  return u;
}

/**
 * Read a fetch Response body but stop once we've buffered `MAX_BYTES`.
 * Returns `{ text, truncated }` so the caller can flag long pages.
 */
async function readBounded(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return { text: text.slice(0, MAX_BYTES), truncated: text.length > MAX_BYTES };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        const overflow = total - MAX_BYTES;
        chunks.push(value.subarray(0, value.byteLength - overflow));
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
    }
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buffer.toString('utf8'), truncated };
}

/**
 * Strip the inline-noise nodes from a parsed document. Modifies the tree
 * in place; callers re-walk the root afterward.
 */
function stripNoise(root: ReturnType<typeof parse>): void {
  const noisy = [
    'script',
    'style',
    'noscript',
    'iframe',
    'svg',
    'header',
    'footer',
    'nav',
    'aside',
    'form',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
  ];
  for (const sel of noisy) {
    for (const el of root.querySelectorAll(sel)) {
      el.remove();
    }
  }
}

/**
 * Collapse whitespace runs in extracted text. Strip leading/trailing space
 * on each line, drop consecutive blank lines beyond 1.
 */
function tidyText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1]!.length > 0))
    .join('\n')
    .trim();
}

export async function fetchUrlAsMarkdown(rawUrl: string): Promise<FetchedPage> {
  const url = assertSafeUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        // Identify ourselves so site operators see something honest.
        'User-Agent': 'TaskPilot/0.1 (+memory-capture)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`fetch timed out after ${FETCH_TIMEOUT_MS} ms`);
    }
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`fetch returned ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('text')) {
    throw new Error(`unsupported content-type: ${contentType}`);
  }

  const { text, truncated } = await readBounded(res);

  let title: string | null = null;
  let markdown: string;
  try {
    const root = parse(text);
    const titleEl = root.querySelector('title');
    title = titleEl ? titleEl.text.trim().slice(0, 500) : null;

    // Prefer the document's main content region when one is marked up.
    const main = root.querySelector('main') ?? root.querySelector('article') ?? root;
    stripNoise(main);
    const body = main.text;
    markdown = tidyText(body);
  } catch {
    // Parse failed — return the raw text as a fallback so the user still
    // captures something. Memory is forgiving by design.
    markdown = tidyText(text);
  }

  if (truncated) {
    markdown += '\n\n_(truncated — page exceeded 5MB)_';
  }

  if (markdown.length === 0) {
    markdown = `(no extractable text from ${url.toString()})`;
  }

  return { title, markdown, truncated };
}
