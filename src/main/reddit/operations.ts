/**
 * Reddit JSON API client.
 *
 * Reddit's public JSON API works unauthenticated for read-only subreddit
 * traffic — append `.json` to any subreddit / post URL and it returns the
 * same JSON the website renders against. No OAuth, no PAT, no PRAW.
 *
 * The only contract Reddit cares about is a sane User-Agent so they can
 * back off a misbehaving client; we expose it as a setting
 * (`reddit_user_agent`, default `taskpilot/0.1.0 (by /u/Gr0wthHacker)`).
 *
 * Rate limiting:
 *   60 req/min via a token bucket. Reddit's unauthenticated quota is around
 *   60/minute per IP; over-shooting that gets you 429s. The bucket throws
 *   `RedditRateLimitError` when empty so callers can surface a 503/429 to
 *   the user rather than hammering Reddit's edge.
 *
 * NOTE: This is read-only. We do NOT support posting, voting, commenting,
 * or anything that needs an OAuth token — that path requires a full app
 * registration and Jack hasn't signalled interest. Content creation runs
 * through the `reddit-content-crafter` skill which drives the browser via
 * Chrome-MCP or Cowork.
 */

import { settingsRepository } from '@/main/db/repositories/settings';

/* -------------------------------------------------------------------------- */
/*  Error taxonomy                                                            */
/* -------------------------------------------------------------------------- */

export class RedditNotFoundError extends Error {
  readonly code = 'REDDIT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'RedditNotFoundError';
  }
}

export class RedditRateLimitError extends Error {
  readonly code = 'REDDIT_RATE_LIMIT';
  /** Approx wall-clock seconds until the bucket refills enough for one call. */
  readonly retry_after_seconds: number;
  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = 'RedditRateLimitError';
    this.retry_after_seconds = retryAfter;
  }
}

export class RedditApiError extends Error {
  readonly code = 'REDDIT_API_ERROR';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RedditApiError';
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/*  Token bucket — 60 req/min                                                 */
/* -------------------------------------------------------------------------- */

const BUCKET_CAPACITY = 60;
/** Token refill rate: full bucket per 60s → 1 token/sec. */
const REFILL_PER_MS = BUCKET_CAPACITY / 60_000;

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

const bucket: TokenBucket = {
  tokens: BUCKET_CAPACITY,
  lastRefillMs: Date.now(),
};

function refill(now: number): void {
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed <= 0) return;
  bucket.tokens = Math.min(
    BUCKET_CAPACITY,
    bucket.tokens + elapsed * REFILL_PER_MS,
  );
  bucket.lastRefillMs = now;
}

function takeToken(): void {
  const now = Date.now();
  refill(now);
  if (bucket.tokens < 1) {
    // Seconds until at least 1 token is available.
    const seconds = Math.max(
      1,
      Math.ceil((1 - bucket.tokens) / (REFILL_PER_MS * 1000)),
    );
    throw new RedditRateLimitError(
      'Reddit rate limit (60 req/min) exhausted. Try again shortly.',
      seconds,
    );
  }
  bucket.tokens -= 1;
}

/**
 * Test-only: reset the bucket to a known state between assertions.
 */
export const __testing = {
  resetBucket(tokens: number = BUCKET_CAPACITY): void {
    bucket.tokens = tokens;
    bucket.lastRefillMs = Date.now();
  },
  getBucket(): { tokens: number } {
    refill(Date.now());
    return { tokens: bucket.tokens };
  },
  BUCKET_CAPACITY,
};

/* -------------------------------------------------------------------------- */
/*  User-agent                                                                 */
/* -------------------------------------------------------------------------- */

export const DEFAULT_USER_AGENT = 'taskpilot/0.1.0 (by /u/Gr0wthHacker)';

/**
 * Resolve the configured User-Agent string. Falls back to the default
 * whenever the setting is empty or unreadable (e.g. tests where the DB
 * isn't initialized).
 */
export function getUserAgent(): string {
  try {
    const raw = settingsRepository.get<string>('reddit_user_agent');
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    // Settings repo not available — that's fine, use the default.
  }
  return DEFAULT_USER_AGENT;
}

/* -------------------------------------------------------------------------- */
/*  Input validation                                                          */
/* -------------------------------------------------------------------------- */

/** Reddit subreddit names: 3–21 chars, alnum + underscore. */
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
/** Post / comment ids: base36, typically 5–10 chars, but allow up to 14. */
const POST_ID_RE = /^[a-z0-9]{1,14}$/;

function assertSubreddit(name: string): void {
  if (!SUBREDDIT_RE.test(name)) {
    throw new RedditApiError(`Invalid subreddit name: ${name}`, 400);
  }
}

function assertPostId(id: string): void {
  if (!POST_ID_RE.test(id)) {
    throw new RedditApiError(`Invalid post id: ${id}`, 400);
  }
}

/* -------------------------------------------------------------------------- */
/*  Fetch wrapper                                                              */
/* -------------------------------------------------------------------------- */

interface FetchOptions {
  signal?: AbortSignal;
}

/**
 * Issue a request against Reddit's JSON API. Handles:
 *   - rate-bucket consumption
 *   - User-Agent header injection
 *   - status-code → typed error translation
 *
 * Always uses `oauth.reddit.com`'s unauthenticated mirror? No — we use the
 * public `www.reddit.com/.json` surface which doesn't require OAuth. The
 * `?raw_json=1` flag prevents HTML entity escaping on textual fields.
 */
async function redditFetch<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  options: FetchOptions = {},
): Promise<T> {
  takeToken();

  const url = buildRedditUrl(path, query);
  const headers: Record<string, string> = {
    'User-Agent': getUserAgent(),
    Accept: 'application/json',
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new RedditApiError(
      err instanceof Error ? err.message : 'Network error talking to Reddit',
      0,
    );
  }

  if (response.status === 404) {
    throw new RedditNotFoundError(`Reddit returned 404 for ${path}`);
  }
  if (response.status === 429) {
    const retryHeader = response.headers.get('Retry-After');
    const retry = retryHeader ? Number.parseInt(retryHeader, 10) : 60;
    throw new RedditRateLimitError(
      'Reddit returned 429 — slow down.',
      Number.isFinite(retry) ? retry : 60,
    );
  }
  if (!response.ok) {
    throw new RedditApiError(
      `Reddit returned ${response.status}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

/**
 * Exported for tests so the URL-builder can be asserted independently from
 * the full network round-trip.
 */
export function buildRedditUrl(
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const base = `https://www.reddit.com${path}`;
  const params = new URLSearchParams();
  params.set('raw_json', '1');
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  return `${base}?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export interface RedditPostSummary {
  id: string;
  /** Full name like `t3_abc123` — Reddit's id-with-kind. */
  name: string;
  subreddit: string;
  title: string;
  author: string | null;
  permalink: string;
  url: string;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  created_utc: number;
  is_self: boolean;
  selftext: string;
  link_flair_text: string | null;
  over_18: boolean;
  stickied: boolean;
}

export interface RedditCommentNode {
  id: string;
  author: string | null;
  body: string;
  score: number;
  created_utc: number;
  depth: number;
  replies: RedditCommentNode[];
}

export interface RedditPostDetail {
  post: RedditPostSummary;
  comments: RedditCommentNode[];
}

/* -------------------------------------------------------------------------- */
/*  Shaping helpers                                                            */
/* -------------------------------------------------------------------------- */

interface RawListingChild {
  kind: string;
  data: Record<string, unknown>;
}

interface RawListing {
  kind: 'Listing';
  data: {
    children: RawListingChild[];
    after?: string | null;
    before?: string | null;
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function shapePost(data: Record<string, unknown>): RedditPostSummary {
  return {
    id: asString(data.id),
    name: asString(data.name),
    subreddit: asString(data.subreddit),
    title: asString(data.title),
    author: typeof data.author === 'string' ? data.author : null,
    permalink: asString(data.permalink),
    url: asString(data.url),
    score: asNumber(data.score),
    upvote_ratio: asNumber(data.upvote_ratio, 0),
    num_comments: asNumber(data.num_comments),
    created_utc: asNumber(data.created_utc),
    is_self: asBool(data.is_self),
    selftext: asString(data.selftext),
    link_flair_text:
      typeof data.link_flair_text === 'string' ? data.link_flair_text : null,
    over_18: asBool(data.over_18),
    stickied: asBool(data.stickied),
  };
}

function shapeComment(
  data: Record<string, unknown>,
  depth: number,
): RedditCommentNode {
  const replies: RedditCommentNode[] = [];
  const rawReplies = data.replies;
  if (
    rawReplies &&
    typeof rawReplies === 'object' &&
    'data' in (rawReplies as Record<string, unknown>)
  ) {
    const listing = rawReplies as RawListing;
    for (const child of listing.data.children ?? []) {
      if (child.kind !== 't1') continue;
      replies.push(shapeComment(child.data, depth + 1));
    }
  }
  return {
    id: asString(data.id),
    author: typeof data.author === 'string' ? data.author : null,
    body: asString(data.body),
    score: asNumber(data.score),
    created_utc: asNumber(data.created_utc),
    depth,
    replies,
  };
}

function extractPostsFromListing(listing: RawListing): RedditPostSummary[] {
  if (listing.kind !== 'Listing' || !listing.data?.children) return [];
  const out: RedditPostSummary[] = [];
  for (const child of listing.data.children) {
    if (child.kind !== 't3') continue;
    out.push(shapePost(child.data));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Operations                                                                 */
/* -------------------------------------------------------------------------- */

export type RedditSort = 'hot' | 'new' | 'top' | 'rising';
export type RedditTimeWindow = 'all' | 'year' | 'month' | 'week' | 'day' | 'hour';

export interface GetSubredditPostsParams {
  subreddit: string;
  sort?: RedditSort;
  limit?: number;
  /** Only meaningful when `sort === 'top'`. */
  t?: RedditTimeWindow;
  /** Pagination cursor — Reddit's `after` parameter. */
  after?: string;
  signal?: AbortSignal;
}

export interface GetSubredditPostsResult {
  posts: RedditPostSummary[];
  after: string | null;
}

/**
 * Fetch posts from a subreddit's listing endpoint.
 *
 *   GET /r/<sub>/<sort>.json?limit=<n>&t=<window>&after=<cursor>
 */
export async function getSubredditPosts(
  params: GetSubredditPostsParams,
): Promise<GetSubredditPostsResult> {
  assertSubreddit(params.subreddit);
  const sort = params.sort ?? 'hot';
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);

  const query: Record<string, string | number | undefined> = { limit };
  if (sort === 'top' && params.t) {
    query.t = params.t;
  }
  if (params.after) {
    query.after = params.after;
  }

  const path = `/r/${params.subreddit}/${sort}.json`;
  const fetchOptions: FetchOptions = {};
  if (params.signal) fetchOptions.signal = params.signal;
  const listing = await redditFetch<RawListing>(path, query, fetchOptions);
  return {
    posts: extractPostsFromListing(listing),
    after: listing.data?.after ?? null,
  };
}

export interface GetPostParams {
  subreddit: string;
  post_id: string;
  /** Comment depth / limit hints — Reddit caps these silently. */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Fetch a single post and its top-level comment tree.
 *
 * Reddit's `/r/<sub>/comments/<id>.json` returns a 2-element array:
 *   [0] = listing of t3 (the post itself)
 *   [1] = listing of t1 (the comment tree)
 */
export async function getPost(
  params: GetPostParams,
): Promise<RedditPostDetail> {
  assertSubreddit(params.subreddit);
  assertPostId(params.post_id);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);

  const path = `/r/${params.subreddit}/comments/${params.post_id}.json`;
  const fetchOptions: FetchOptions = {};
  if (params.signal) fetchOptions.signal = params.signal;
  const result = await redditFetch<[RawListing, RawListing]>(
    path,
    { limit },
    fetchOptions,
  );

  if (!Array.isArray(result) || result.length < 2) {
    throw new RedditApiError(
      `Unexpected Reddit response shape for post ${params.post_id}`,
      502,
    );
  }

  const postListing = result[0];
  const commentListing = result[1];

  const posts = extractPostsFromListing(postListing);
  if (posts.length === 0) {
    throw new RedditNotFoundError(
      `Post ${params.post_id} not found in r/${params.subreddit}`,
    );
  }

  const comments: RedditCommentNode[] = [];
  for (const child of commentListing.data?.children ?? []) {
    if (child.kind !== 't1') continue;
    comments.push(shapeComment(child.data, 0));
  }

  return { post: posts[0], comments };
}

export interface GetCommentsParams {
  subreddit: string;
  post_id: string;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Fetch ONLY the comment tree for a post. Thin wrapper over `getPost` that
 * strips the post body — keeps the caller from having to ignore it.
 */
export async function getComments(
  params: GetCommentsParams,
): Promise<RedditCommentNode[]> {
  const detail = await getPost(params);
  return detail.comments;
}

export interface SearchSubredditParams {
  subreddit: string;
  query: string;
  /** `relevance` (default), `top`, `new`, `comments`. */
  sort?: 'relevance' | 'top' | 'new' | 'comments';
  limit?: number;
  /** Restrict the search to this subreddit. Defaults to true. */
  restrict_sr?: boolean;
  signal?: AbortSignal;
}

/**
 * Search posts in a subreddit.
 *
 *   GET /r/<sub>/search.json?q=<query>&restrict_sr=on&sort=<sort>&limit=<n>
 */
export async function searchSubreddit(
  params: SearchSubredditParams,
): Promise<GetSubredditPostsResult> {
  assertSubreddit(params.subreddit);
  if (
    typeof params.query !== 'string' ||
    params.query.trim().length === 0 ||
    params.query.length > 512
  ) {
    throw new RedditApiError('Invalid search query', 400);
  }
  const sort = params.sort ?? 'relevance';
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const restrict = params.restrict_sr === false ? undefined : 'on';

  const path = `/r/${params.subreddit}/search.json`;
  const fetchOptions: FetchOptions = {};
  if (params.signal) fetchOptions.signal = params.signal;
  const listing = await redditFetch<RawListing>(
    path,
    {
      q: params.query,
      sort,
      limit,
      ...(restrict ? { restrict_sr: restrict } : {}),
    },
    fetchOptions,
  );

  return {
    posts: extractPostsFromListing(listing),
    after: listing.data?.after ?? null,
  };
}
