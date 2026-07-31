/**
 * MCP tools for the web module — search + fetch.
 *
 * These give any MCP client (Claude Code, Cowork, Claude Desktop) a uniform
 * way to pull external information without each operator wiring up its own
 * search/fetch stack.
 */

import { z } from 'zod';

import { fetchUrl, search } from '@/main/web';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const searchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(20).optional(),
  provider: z.enum(['brave', 'serper', 'duckduckgo']).optional(),
});

const fetchInput = z.object({
  url: z.string().min(1).max(2_048),
  mode: z.enum(['raw', 'text']).optional(),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
  max_bytes: z.number().int().positive().max(20 * 1024 * 1024).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const searchTool: McpTool<typeof searchInput> = {
  name: 'taskpilot_web_search',
  description:
    'Search the public web. Returns up to `limit` (default 10, max 20) results with title, URL, and snippet. Auto-selects the best available provider: Brave if BRAVE_API_KEY is set, Serper if SERPER_API_KEY is set, otherwise DuckDuckGo (no key required). Pass `provider` to force a specific one. Use this whenever the user wants up-to-date facts, news, references, documentation, or any external lookup.',
  inputSchema: searchInput,
  async handler(input) {
    return await search(input.query, {
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
    });
  },
};

const fetchTool: McpTool<typeof fetchInput> = {
  name: 'taskpilot_web_fetch',
  description:
    "Fetch a URL and return its content. `mode: 'text'` (default) strips HTML to readable plain text and surfaces title + meta description separately. `mode: 'raw'` returns the body verbatim — use for JSON APIs or when the HTML structure matters. Bounded by `timeout_ms` (default 20s, max 60s) and `max_bytes` (default 5 MB, max 20 MB). Refuses localhost and private-IP targets.",
  inputSchema: fetchInput,
  async handler(input) {
    return await fetchUrl(input.url, {
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
      ...(input.max_bytes !== undefined ? { maxBytes: input.max_bytes } : {}),
    });
  },
};

export const webTools: McpTool[] = [
  searchTool as unknown as McpTool,
  fetchTool as unknown as McpTool,
];
