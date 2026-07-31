/**
 * Reddit integration tests.
 *
 * Coverage:
 *   - URL builder appends raw_json=1 + the right path
 *   - Sort variants (`hot`/`new`/`top`/`rising`) map to the expected path
 *   - User-Agent header from the configured setting is forwarded
 *   - Rate-limit bucket: 60th call passes, 61st rejects with the right error
 *   - 404 → RedditNotFoundError; 429 → RedditRateLimitError
 *   - Input validation on subreddit / post id (invalid → throws synchronously)
 *
 * The native `fetch` is mocked module-wide; no real network IO. The settings
 * repo is short-circuited so we don't need a DB.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';

mockTaskpilotPaths();

/* -------------------------------------------------------------------------- */
/*  Settings stub — return whatever we want for the user-agent test           */
/* -------------------------------------------------------------------------- */

const settingsStub = vi.hoisted(() => ({
  userAgent: null as string | null,
}));

vi.mock('@/main/db/repositories/settings', () => ({
  settingsRepository: {
    get: (key: string) => {
      if (key === 'reddit_user_agent') return settingsStub.userAgent;
      return null;
    },
    set: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(),
  },
  get: (key: string) => {
    if (key === 'reddit_user_agent') return settingsStub.userAgent;
    return null;
  },
}));

/* -------------------------------------------------------------------------- */
/*  fetch mock                                                                */
/* -------------------------------------------------------------------------- */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const fetchCalls: FetchCall[] = [];

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const HOT_LISTING = {
  kind: 'Listing',
  data: {
    after: 't3_xyz',
    before: null,
    children: [
      {
        kind: 't3',
        data: {
          id: 'abc123',
          name: 't3_abc123',
          subreddit: 'marketing',
          title: 'Best growth tactics 2026',
          author: 'someuser',
          permalink: '/r/marketing/comments/abc123/best_growth_tactics_2026/',
          url: 'https://reddit.com/r/marketing/comments/abc123',
          score: 42,
          upvote_ratio: 0.95,
          num_comments: 7,
          created_utc: 1_700_000_000,
          is_self: true,
          selftext: 'Some self text.',
          link_flair_text: 'Discussion',
          over_18: false,
          stickied: false,
        },
      },
    ],
  },
};

const POST_DETAIL: [unknown, unknown] = [
  HOT_LISTING,
  {
    kind: 'Listing',
    data: {
      after: null,
      before: null,
      children: [
        {
          kind: 't1',
          data: {
            id: 'cmt1',
            author: 'commenter',
            body: 'Top comment',
            score: 10,
            created_utc: 1_700_000_500,
            replies: '',
          },
        },
      ],
    },
  },
];

const fetchImpl = vi.fn(
  async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof url === 'string'
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
    fetchCalls.push({ url: urlStr, init });

    // Test triggers for non-200 responses via magic subreddit names.
    if (urlStr.includes('/r/__404__/')) {
      return new Response('not found', { status: 404 });
    }
    if (urlStr.includes('/r/__429__/')) {
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '45' },
      });
    }

    if (urlStr.includes('/comments/')) {
      return makeJsonResponse(POST_DETAIL);
    }
    return makeJsonResponse(HOT_LISTING);
  },
);

// Native fetch is global in Node 20; assign before any operations module loads.
beforeEach(() => {
  fetchCalls.length = 0;
  fetchImpl.mockClear();
  globalThis.fetch = fetchImpl as unknown as typeof globalThis.fetch;
  settingsStub.userAgent = null;
});

/* -------------------------------------------------------------------------- */
/*  Lazy import — must run AFTER the mock factory is installed                */
/* -------------------------------------------------------------------------- */

let reddit: typeof import('@/main/reddit/operations');

beforeEach(async () => {
  reddit = await import('@/main/reddit/operations');
  reddit.__testing.resetBucket(reddit.__testing.BUCKET_CAPACITY);
});

/* -------------------------------------------------------------------------- */
/*  buildRedditUrl                                                            */
/* -------------------------------------------------------------------------- */

describe('reddit/buildRedditUrl', () => {
  it('appends raw_json=1 to every request', () => {
    const url = reddit.buildRedditUrl('/r/marketing/hot.json', { limit: 25 });
    expect(url).toContain('https://www.reddit.com/r/marketing/hot.json');
    expect(url).toContain('raw_json=1');
    expect(url).toContain('limit=25');
  });

  it('skips empty query values', () => {
    const url = reddit.buildRedditUrl('/r/x/new.json', {
      limit: 10,
      t: undefined,
      after: '',
    });
    // `t=` is checked as a discrete param — the `raw_json=1` literal would
    // otherwise yield a false positive on a substring search.
    expect(url).not.toMatch(/[?&]t=/);
    expect(url).not.toMatch(/[?&]after=/);
    expect(url).toContain('limit=10');
  });
});

/* -------------------------------------------------------------------------- */
/*  getSubredditPosts                                                         */
/* -------------------------------------------------------------------------- */

describe('reddit/getSubredditPosts', () => {
  it('builds the right URL for the default (hot) sort', async () => {
    const result = await reddit.getSubredditPosts({ subreddit: 'marketing' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/r/marketing/hot.json');
    expect(fetchCalls[0].url).toContain('limit=25');
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].title).toBe('Best growth tactics 2026');
    expect(result.after).toBe('t3_xyz');
  });

  it('respects sort + limit + time-window', async () => {
    await reddit.getSubredditPosts({
      subreddit: 'marketing',
      sort: 'top',
      limit: 50,
      t: 'week',
    });
    const url = fetchCalls[0].url;
    expect(url).toContain('/r/marketing/top.json');
    expect(url).toContain('limit=50');
    expect(url).toContain('t=week');
  });

  it('sends the configured User-Agent', async () => {
    settingsStub.userAgent = 'custom-agent/1.0';
    await reddit.getSubredditPosts({ subreddit: 'marketing' });
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('custom-agent/1.0');
  });

  it('falls back to the default User-Agent when unset', async () => {
    await reddit.getSubredditPosts({ subreddit: 'marketing' });
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(reddit.DEFAULT_USER_AGENT);
  });

  it('rejects invalid subreddit names without hitting the network', async () => {
    await expect(
      reddit.getSubredditPosts({ subreddit: 'has space' }),
    ).rejects.toBeInstanceOf(reddit.RedditApiError);
    expect(fetchCalls).toHaveLength(0);
  });

  it('throws RedditNotFoundError on 404', async () => {
    await expect(
      reddit.getSubredditPosts({ subreddit: '__404__' }),
    ).rejects.toBeInstanceOf(reddit.RedditNotFoundError);
  });

  it('throws RedditRateLimitError with retry hint on 429', async () => {
    let thrown: unknown;
    try {
      await reddit.getSubredditPosts({ subreddit: '__429__' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(reddit.RedditRateLimitError);
    expect((thrown as InstanceType<typeof reddit.RedditRateLimitError>).retry_after_seconds).toBe(
      45,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  getPost                                                                   */
/* -------------------------------------------------------------------------- */

describe('reddit/getPost', () => {
  it('returns the post + comments', async () => {
    const result = await reddit.getPost({
      subreddit: 'marketing',
      post_id: 'abc123',
    });
    expect(result.post.title).toBe('Best growth tactics 2026');
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body).toBe('Top comment');
  });

  it('rejects malformed post ids before any network call', async () => {
    await expect(
      reddit.getPost({ subreddit: 'marketing', post_id: 'BAD/ID' }),
    ).rejects.toBeInstanceOf(reddit.RedditApiError);
    expect(fetchCalls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  searchSubreddit                                                           */
/* -------------------------------------------------------------------------- */

describe('reddit/searchSubreddit', () => {
  it('hits the search endpoint with restrict_sr by default', async () => {
    await reddit.searchSubreddit({ subreddit: 'marketing', query: 'growth' });
    const url = fetchCalls[0].url;
    expect(url).toContain('/r/marketing/search.json');
    expect(url).toContain('q=growth');
    expect(url).toContain('restrict_sr=on');
    expect(url).toContain('sort=relevance');
  });

  it('disables restrict_sr when asked', async () => {
    await reddit.searchSubreddit({
      subreddit: 'marketing',
      query: 'growth',
      restrict_sr: false,
    });
    const url = fetchCalls[0].url;
    expect(url).not.toContain('restrict_sr');
  });

  it('rejects empty queries before any network call', async () => {
    await expect(
      reddit.searchSubreddit({ subreddit: 'marketing', query: '' }),
    ).rejects.toBeInstanceOf(reddit.RedditApiError);
    expect(fetchCalls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Rate limiter                                                              */
/* -------------------------------------------------------------------------- */

describe('reddit/rate-limit', () => {
  it('60 requests succeed; the 61st throws RedditRateLimitError', async () => {
    reddit.__testing.resetBucket(reddit.__testing.BUCKET_CAPACITY);

    // Burn 60 tokens — should all succeed against the mock.
    for (let i = 0; i < reddit.__testing.BUCKET_CAPACITY; i += 1) {
      await reddit.getSubredditPosts({ subreddit: 'marketing' });
    }

    let thrown: unknown;
    try {
      await reddit.getSubredditPosts({ subreddit: 'marketing' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(reddit.RedditRateLimitError);
    const err = thrown as InstanceType<typeof reddit.RedditRateLimitError>;
    expect(err.retry_after_seconds).toBeGreaterThanOrEqual(1);
    // Make sure we didn't issue the 61st HTTP request.
    expect(fetchCalls).toHaveLength(reddit.__testing.BUCKET_CAPACITY);
  });

  it('allows a fresh batch after the bucket is reset', async () => {
    reddit.__testing.resetBucket(0);
    await expect(
      reddit.getSubredditPosts({ subreddit: 'marketing' }),
    ).rejects.toBeInstanceOf(reddit.RedditRateLimitError);

    reddit.__testing.resetBucket(reddit.__testing.BUCKET_CAPACITY);
    await expect(
      reddit.getSubredditPosts({ subreddit: 'marketing' }),
    ).resolves.toBeDefined();
  });
});
