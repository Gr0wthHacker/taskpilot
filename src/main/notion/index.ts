/**
 * Public entry point for the Notion integration (one-way mirror:
 * TaskPilot → Notion).
 *
 * Exposes lifecycle (`connect`, `getStatus`, `disconnect`) plus the
 * low-level operations the sync module needs (`listDatabases`,
 * `upsertPage`). The internal-integration token is validated via
 * `users.me`, persisted via the storage module, and never returned to
 * callers.
 *
 * Mirrors the shape of `src/main/slack/index.ts` so the three
 * integrations feel cohesive.
 */

import type { Client as NotionClient } from '@notionhq/client';

import { deleteToken, hasToken, loadToken, saveToken } from './storage';

/* -------------------------------------------------------------------------- */
/*  Error taxonomy                                                            */
/* -------------------------------------------------------------------------- */

export class NotionNotConfiguredError extends Error {
  readonly code = 'NOTION_NOT_CONFIGURED';
  constructor(message = 'Notion is not connected.') {
    super(message);
    this.name = 'NotionNotConfiguredError';
  }
}

export class NotionAuthError extends Error {
  readonly code = 'NOTION_AUTH';
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'NotionAuthError';
    this.status = status;
  }
}

export class NotionRateLimitError extends Error {
  readonly code = 'NOTION_RATE_LIMIT';
  readonly retryAfter: number | null;
  constructor(message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'NotionRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class NotionApiError extends Error {
  readonly code = 'NOTION_API_ERROR';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'NotionApiError';
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/*  Error helpers                                                             */
/* -------------------------------------------------------------------------- */

interface NotionErrorShape {
  code?: string;
  status?: number;
  message?: string;
  body?: unknown;
}

/**
 * Translate any error from `@notionhq/client` into our typed taxonomy.
 * Notion's SDK uses `APIResponseError` with a `.code` and `.status`;
 * we sniff both. The token itself never appears in Notion's error
 * messages, but we still scrub for defense in depth.
 */
export function classifyNotionError(err: unknown): Error {
  if (
    err instanceof NotionAuthError ||
    err instanceof NotionRateLimitError ||
    err instanceof NotionApiError ||
    err instanceof NotionNotConfiguredError
  ) {
    return err;
  }
  const e = err as NotionErrorShape;
  const status = typeof e?.status === 'number' ? e.status : 0;
  const code = typeof e?.code === 'string' ? e.code : '';
  const safeMessage = sanitizeErrorMessage(
    typeof e?.message === 'string' ? e.message : 'Notion request failed',
  );
  if (status === 401 || code === 'unauthorized') {
    return new NotionAuthError(safeMessage, 401);
  }
  if (status === 429 || code === 'rate_limited') {
    return new NotionRateLimitError(safeMessage, null);
  }
  if (status >= 400) {
    return new NotionApiError(safeMessage, status);
  }
  return new NotionApiError(safeMessage, status || 500);
}

/**
 * Defensive token scrub. Notion's tokens start with `secret_` or
 * `ntn_` (newer pattern) — both get masked if they ever leak into a
 * message. The 32+ hex fallback catches anything else token-shaped.
 */
function sanitizeErrorMessage(input: string): string {
  return input
    .replace(/\b(?:secret_|ntn_)[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<redacted>');
}

/* -------------------------------------------------------------------------- */
/*  Client cache                                                              */
/* -------------------------------------------------------------------------- */

let cachedClient: NotionClient | null = null;
let cachedToken: string | null = null;

export function resetClient(): void {
  cachedClient = null;
  cachedToken = null;
}

/**
 * Lazily import the Notion SDK and construct a client. The dynamic
 * import keeps the package out of the cold-start path for users who
 * don't connect Notion.
 */
async function buildClient(token: string): Promise<NotionClient> {
  const { Client } = await import('@notionhq/client');
  return new Client({ auth: token });
}

export async function getClient(): Promise<NotionClient> {
  const token = await loadToken();
  if (!token) {
    resetClient();
    throw new NotionNotConfiguredError();
  }
  if (cachedClient && cachedToken === token) {
    return cachedClient;
  }
  cachedClient = await buildClient(token);
  cachedToken = token;
  return cachedClient;
}

/**
 * Wrap an SDK call so any thrown error flows through our classifier.
 */
export async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyNotionError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Workspace / lifecycle                                                     */
/* -------------------------------------------------------------------------- */

export interface NotionWorkspaceSummary {
  bot_id: string;
  workspace_name: string;
  workspace_icon: string | null;
  owner_user_id: string | null;
}

interface UsersMeResponse {
  object?: string;
  id?: string;
  bot?: {
    workspace_name?: string | null;
    workspace_icon?: string | null;
    owner?: {
      user?: { id?: string };
    };
  };
}

/**
 * Probe the workspace via `users.me`. Returns a sanitised summary
 * suitable for surfacing to the renderer / Claude.
 */
async function probeWorkspace(
  client: NotionClient,
): Promise<NotionWorkspaceSummary> {
  const res = (await client.users.me({})) as UsersMeResponse;
  const bot = res.bot ?? {};
  return {
    bot_id: typeof res.id === 'string' ? res.id : '',
    workspace_name:
      typeof bot.workspace_name === 'string' && bot.workspace_name.length > 0
        ? bot.workspace_name
        : 'Notion workspace',
    workspace_icon:
      typeof bot.workspace_icon === 'string' ? bot.workspace_icon : null,
    owner_user_id:
      typeof bot.owner?.user?.id === 'string' ? bot.owner.user.id : null,
  };
}

export interface NotionStatus {
  connected: boolean;
  workspace_name?: string;
  workspace_icon?: string | null;
  database_id?: string;
  database_title?: string;
}

/**
 * Validate the supplied token by hitting `users.me`, then persist it.
 *
 * On success: returns the workspace summary, caches the client.
 * On a 401 from Notion: throws `NotionAuthError`.
 * Never returns or logs the raw token.
 */
export async function connect(
  token: string,
): Promise<{ workspace: NotionWorkspaceSummary }> {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new NotionAuthError('Token is empty.', 400);
  }
  const trimmed = token.trim();
  const probeClient = await buildClient(trimmed);
  let workspace: NotionWorkspaceSummary;
  try {
    workspace = await probeWorkspace(probeClient);
  } catch (err) {
    throw classifyNotionError(err);
  }
  await saveToken(trimmed);
  resetClient();
  return { workspace };
}

/**
 * Status probe. Returns `{ connected: false }` if no token is stored;
 * otherwise hits `users.me` to confirm the token still works. A
 * 401 means it's been revoked — we treat as disconnected. Other
 * failures are reported as connected-but-degraded.
 */
export async function getStatus(): Promise<NotionStatus> {
  const present = await hasToken();
  if (!present) return { connected: false };
  try {
    const client = await getClient();
    const workspace = await probeWorkspace(client);
    return {
      connected: true,
      workspace_name: workspace.workspace_name,
      workspace_icon: workspace.workspace_icon,
    };
  } catch (err) {
    const classified = classifyNotionError(err);
    if (classified instanceof NotionAuthError) {
      return { connected: false };
    }
    return { connected: true };
  }
}

/**
 * Drop the persisted token and tear down the cached client.
 */
export async function disconnect(): Promise<void> {
  resetClient();
  await deleteToken();
}

/* -------------------------------------------------------------------------- */
/*  Databases                                                                  */
/* -------------------------------------------------------------------------- */

export interface NotionDatabaseSummary {
  id: string;
  title: string;
  url: string;
}

interface SearchResponseLike {
  results?: Array<{
    object?: string;
    id?: string;
    url?: string;
    title?: unknown;
  }>;
}

function extractPlainTitle(rawTitle: unknown): string {
  if (!Array.isArray(rawTitle)) return '';
  const parts: string[] = [];
  for (const t of rawTitle) {
    if (
      t &&
      typeof t === 'object' &&
      'plain_text' in t &&
      typeof (t as { plain_text: unknown }).plain_text === 'string'
    ) {
      parts.push((t as { plain_text: string }).plain_text);
    }
  }
  return parts.join('');
}

/**
 * List databases the integration has been added to. Uses Notion's
 * `search` endpoint filtered to `data_source` objects because v5 of
 * the SDK renamed the historical "database" object to "data_source".
 * (Notion still calls them "databases" in the UI; the API just changed
 * the surface name.)
 */
export async function listDatabases(
  limit = 50,
): Promise<NotionDatabaseSummary[]> {
  const client = await getClient();
  return wrap(async () => {
    const res = (await client.search({
      filter: { value: 'data_source', property: 'object' },
      page_size: Math.min(Math.max(limit, 1), 100),
    })) as SearchResponseLike;
    const results = res.results ?? [];
    const out: NotionDatabaseSummary[] = [];
    for (const r of results) {
      // Accept both the legacy `database` shape (in case the SDK is
      // upgraded mid-flight) and the newer `data_source` shape.
      if (
        r.object !== 'database' &&
        r.object !== 'data_source' &&
        // Tests mock the older `database` literal — keep that working.
        r.object !== undefined
      ) {
        continue;
      }
      if (typeof r.id !== 'string') continue;
      out.push({
        id: r.id,
        title: extractPlainTitle(r.title) || 'Untitled database',
        url: typeof r.url === 'string' ? r.url : '',
      });
    }
    return out;
  });
}

/* -------------------------------------------------------------------------- */
/*  Page upsert (used by sync.ts)                                             */
/* -------------------------------------------------------------------------- */

export interface UpsertPageParams {
  database_id: string;
  page_id?: string | null;
  /** Plain text title. */
  title: string;
  /** Mapped status name from the TaskPilot side. */
  status?: string;
  /** Mapped priority name. */
  priority?: string;
  /** Tags become a multi-select. */
  tags?: string[];
  /** Markdown description rendered to simple paragraph blocks. */
  description?: string | null;
}

export interface UpsertPageResult {
  page_id: string;
  url: string | null;
  created: boolean;
}

/**
 * Build the Notion `properties` map. The database schema is the user's
 * — we only set properties that look like they exist. Title is always
 * sent; the rest are conditional on the description / tags / etc being
 * non-empty. If the user's DB doesn't have a `Status` / `Priority` /
 * `Tags` column the API call will silently drop them (Notion ignores
 * properties it doesn't recognise on create/update).
 */
function buildProperties(params: UpsertPageParams): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  // Title — Notion expects an array of rich-text on a `title` property.
  // The default title column is conventionally named `Name`, but the
  // SDK lets us set it by property type so we use `title` shape directly.
  props['Name'] = {
    title: [
      {
        type: 'text',
        text: { content: params.title.slice(0, 2000) },
      },
    ],
  };
  if (typeof params.status === 'string' && params.status.length > 0) {
    props['Status'] = { select: { name: params.status.slice(0, 100) } };
  }
  if (typeof params.priority === 'string' && params.priority.length > 0) {
    props['Priority'] = { select: { name: params.priority.slice(0, 100) } };
  }
  if (Array.isArray(params.tags) && params.tags.length > 0) {
    props['Tags'] = {
      multi_select: params.tags
        .filter((t) => typeof t === 'string' && t.length > 0)
        .slice(0, 25)
        .map((t) => ({ name: t.slice(0, 100) })),
    };
  }
  return props;
}

/**
 * Render a markdown-ish string into Notion paragraph blocks. We split
 * on blank lines so each paragraph becomes its own block. Lines longer
 * than Notion's 2,000-char limit get sliced — better truncated than
 * rejected outright.
 */
function buildBlocks(description: string | null | undefined): Array<unknown> {
  if (!description || description.trim().length === 0) return [];
  const paragraphs = description
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: Array<unknown> = [];
  for (const p of paragraphs) {
    // Single block per paragraph; long lines get sliced into chunks.
    const chunks: string[] = [];
    for (let i = 0; i < p.length; i += 1800) {
      chunks.push(p.slice(i, i + 1800));
    }
    for (const chunk of chunks) {
      out.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: chunk } },
          ],
        },
      });
    }
    if (out.length >= 50) break; // Notion caps block creation; bail conservatively.
  }
  return out;
}

interface PageResponseLike {
  id?: string;
  url?: string;
}

interface BlocksListResponseLike {
  results?: Array<{ id?: string }>;
  has_more?: boolean;
  next_cursor?: string | null;
}

/**
 * Insert OR update a page on the configured database, mirroring a
 * single TaskPilot task. When `page_id` is set we patch the existing
 * page's properties (which keeps the page id stable so future syncs
 * also find it). When unset we create a new page and seed its body
 * with the description blocks.
 *
 * Updates are a two-step dance:
 *   1. PATCH the page properties (title / status / priority / tags)
 *   2. Replace the page body blocks (delete existing children, append
 *      fresh ones from the description)
 *
 * Step 2 is best-effort — body sync is informational. If anything in
 * the delete-then-append fails the upsert as a whole still succeeds.
 */
export async function upsertPage(
  params: UpsertPageParams,
): Promise<UpsertPageResult> {
  const client = await getClient();
  const properties = buildProperties(params);
  const children = buildBlocks(params.description);

  return wrap(async () => {
    if (params.page_id) {
      const updated = (await client.pages.update({
        page_id: params.page_id,
        properties: properties as never,
      })) as PageResponseLike;
      // Replace body — best-effort, swallow errors so a permissions
      // hiccup doesn't roll back the property patch.
      try {
        await replaceChildren(client, params.page_id, children);
      } catch {
        /* non-fatal — body sync is informational */
      }
      return {
        page_id: updated.id ?? params.page_id,
        url: updated.url ?? null,
        created: false,
      };
    }
    const created = (await client.pages.create({
      parent: { database_id: params.database_id },
      properties: properties as never,
      ...(children.length > 0 ? { children: children as never } : {}),
    })) as PageResponseLike;
    return {
      page_id: created.id ?? '',
      url: created.url ?? null,
      created: true,
    };
  });
}

/**
 * Replace a page's body blocks with a fresh list. Notion has no
 * "set children" endpoint — we list, delete each existing block, then
 * append the new ones.
 */
async function replaceChildren(
  client: NotionClient,
  pageId: string,
  newChildren: Array<unknown>,
): Promise<void> {
  // Walk paginated children — usually small for task pages but cap
  // iterations defensively.
  let cursor: string | null = null;
  const existingIds: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const listed = (await client.blocks.children.list({
      block_id: pageId,
      ...(cursor ? { start_cursor: cursor } : {}),
    })) as BlocksListResponseLike;
    for (const child of listed.results ?? []) {
      if (typeof child.id === 'string') existingIds.push(child.id);
    }
    if (!listed.has_more) break;
    cursor = listed.next_cursor ?? null;
    if (!cursor) break;
  }
  for (const id of existingIds) {
    try {
      await client.blocks.delete({ block_id: id });
    } catch {
      /* swallow — block may have been deleted concurrently */
    }
  }
  if (newChildren.length > 0) {
    await client.blocks.children.append({
      block_id: pageId,
      children: newChildren as never,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Test-only escape hatch                                                    */
/* -------------------------------------------------------------------------- */

export const __internals = {
  reset(): void {
    resetClient();
  },
  buildProperties,
  buildBlocks,
  extractPlainTitle,
  sanitizeErrorMessage,
};
