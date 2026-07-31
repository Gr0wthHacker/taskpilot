/**
 * Pluggable web search.
 *
 * Three adapters, picked in priority order:
 *   1. Brave Search API — activated when `BRAVE_API_KEY` env var is set.
 *      Highest quality, paid (free tier 2k queries/mo).
 *   2. Serper — activated when `SERPER_API_KEY` is set. Google results via
 *      a paid wrapper (free tier 2.5k queries).
 *   3. DuckDuckGo HTML scrape — default fallback, no key required. Fragile
 *      (DDG can change markup at any time) but works out of the box.
 *
 * Adapter selection happens per call, not at module load, so dropping a key
 * into the environment takes effect on the next search without restart.
 */

import { parse, type HTMLElement } from 'node-html-parser';

export type SearchProvider = 'brave' | 'serper' | 'duckduckgo';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  provider: SearchProvider;
  query: string;
  count: number;
  results: SearchResult[];
}

export interface SearchOptions {
  /** Max results to return. Capped at 20. */
  limit?: number;
  /** Force a specific provider. Otherwise auto-selects by available keys. */
  provider?: SearchProvider;
}

/* -------------------------------------------------------------------------- */
/*  Public entry                                                              */
/* -------------------------------------------------------------------------- */

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('search: query must be a non-empty string');
  }
  const limit = Math.min(Math.max(1, options.limit ?? 10), 20);

  const provider = options.provider ?? pickProvider();

  let results: SearchResult[];
  switch (provider) {
    case 'brave':
      results = await searchBrave(query, limit);
      break;
    case 'serper':
      results = await searchSerper(query, limit);
      break;
    case 'duckduckgo':
      results = await searchDuckDuckGo(query, limit);
      break;
  }

  return {
    provider,
    query,
    count: results.length,
    results,
  };
}

function pickProvider(): SearchProvider {
  if (process.env.BRAVE_API_KEY) return 'brave';
  if (process.env.SERPER_API_KEY) return 'serper';
  return 'duckduckgo';
}

/* -------------------------------------------------------------------------- */
/*  Brave Search                                                              */
/* -------------------------------------------------------------------------- */

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('searchBrave: BRAVE_API_KEY is not set');

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': key,
    },
  });
  if (!res.ok) {
    throw new Error(`searchBrave: HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as BraveResponse;
  const items = json.web?.results ?? [];
  return items
    .filter((r): r is Required<Pick<BraveWebResult, 'title' | 'url'>> & BraveWebResult =>
      Boolean(r.title && r.url),
    )
    .slice(0, limit)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
}

/* -------------------------------------------------------------------------- */
/*  Serper                                                                    */
/* -------------------------------------------------------------------------- */

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperOrganic[];
}

async function searchSerper(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('searchSerper: SERPER_API_KEY is not set');

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!res.ok) {
    throw new Error(`searchSerper: HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as SerperResponse;
  const items = json.organic ?? [];
  return items
    .filter((r): r is SerperOrganic & { title: string; link: string } =>
      Boolean(r.title && r.link),
    )
    .slice(0, limit)
    .map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet ?? '',
    }));
}

/* -------------------------------------------------------------------------- */
/*  DuckDuckGo HTML scrape                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Scrape the lite endpoint (no JS, plain HTML). The result table is a flat
 * sequence of rows: link row, snippet row, source row, blank row, repeat.
 * We pair them up by walking each `td.result-link` and looking ahead for the
 * snippet sibling.
 *
 * The unwrap-redirect step handles DDG's outbound link wrapper
 * (`//duckduckgo.com/l/?uddg=<encoded>&...`) so callers see the real URL.
 */
async function searchDuckDuckGo(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      // Lite endpoint serves a clean HTML doc only when it thinks the request
      // is a real browser. The minimum required: a UA + Accept hint.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html',
    },
  });
  if (!res.ok) {
    throw new Error(`searchDuckDuckGo: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const root = parse(html);

  // Lite endpoint uses a single results table; rows alternate link / snippet /
  // source / blank. We walk every <a class="result-link"> and pair it with the
  // next <td class="result-snippet">.
  const links = root.querySelectorAll('a.result-link');
  const snippets = root.querySelectorAll('td.result-snippet');

  const out: SearchResult[] = [];
  for (let i = 0; i < links.length && out.length < limit; i++) {
    const link = links[i];
    if (!link) continue;
    const href = link.getAttribute('href') ?? '';
    const title = link.text.trim();
    const url = unwrapDdgRedirect(href);
    if (!url || !title) continue;
    const snippet = snippets[i]?.text.trim() ?? '';
    out.push({ title, url, snippet });
  }

  // Fallback for the non-lite endpoint shape — if the lite parse came up empty,
  // try the standard "html.duckduckgo.com" results page.
  if (out.length === 0) {
    return await searchDuckDuckGoFallback(query, limit);
  }
  return out;
}

async function searchDuckDuckGoFallback(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html',
    },
  });
  if (!res.ok) {
    throw new Error(`searchDuckDuckGo: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const root = parse(html);

  const out: SearchResult[] = [];
  const nodes = root.querySelectorAll('.result');
  for (const node of nodes) {
    if (out.length >= limit) break;
    const titleEl = node.querySelector('a.result__a');
    const snippetEl = node.querySelector('.result__snippet');
    if (!titleEl) continue;
    const href = titleEl.getAttribute('href') ?? '';
    const url = unwrapDdgRedirect(href);
    if (!url) continue;
    out.push({
      title: titleEl.text.trim(),
      url,
      snippet: snippetEl?.text.trim() ?? '',
    });
  }
  return out;
}

/**
 * Strip DuckDuckGo's outbound redirect wrapper. Returns the decoded target URL
 * or the input unchanged when there's no wrapper.
 */
function unwrapDdgRedirect(href: string): string {
  if (!href) return href;
  // Handle both `//duckduckgo.com/l/?uddg=...` and full-URL variants.
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(normalized, 'https://duckduckgo.com');
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) {
        try {
          return decodeURIComponent(uddg);
        } catch {
          // Malformed percent-escape — fall through to the parsed URL so we
          // don't surface a literal `duckduckgo.com/l/?uddg=...` redirect
          // wrapper as the result link.
          return uddg;
        }
      }
    }
    return parsed.toString();
  } catch {
    return href;
  }
}

/* -------------------------------------------------------------------------- */
/*  Test-only exports                                                         */
/* -------------------------------------------------------------------------- */

export const __testing = {
  pickProvider,
  unwrapDdgRedirect,
  parseDdgLite(html: string, limit: number): SearchResult[] {
    const root = parse(html);
    return collectFromLite(root, limit);
  },
};

function collectFromLite(root: HTMLElement, limit: number): SearchResult[] {
  const links = root.querySelectorAll('a.result-link');
  const snippets = root.querySelectorAll('td.result-snippet');
  const out: SearchResult[] = [];
  for (let i = 0; i < links.length && out.length < limit; i++) {
    const link = links[i];
    if (!link) continue;
    const href = link.getAttribute('href') ?? '';
    const title = link.text.trim();
    const url = unwrapDdgRedirect(href);
    if (!url || !title) continue;
    const snippet = snippets[i]?.text.trim() ?? '';
    out.push({ title, url, snippet });
  }
  return out;
}
