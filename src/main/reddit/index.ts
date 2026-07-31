/**
 * Public entry point for the Reddit integration.
 *
 * Reddit's public JSON API works without authentication for read traffic, so
 * there's no `connect()` / `disconnect()` lifecycle — every call hits the
 * unauthenticated `www.reddit.com/.json` surface gated by a 60-req/min token
 * bucket and a user-configurable User-Agent.
 *
 * Posting / commenting / voting are out of scope: that path requires a full
 * OAuth flow and Reddit's app-registration dance. Content creation is handled
 * by the `reddit-content-crafter` skill (Cowork / browser-driven).
 *
 * Companion read-only analysis lives in the `subreddit-analyzing` skill,
 * which also hits this JSON surface but from Python via PRAW-less requests.
 * When a task is tagged with `r/<subreddit>`, Claude can call our endpoints
 * directly OR hand off to that skill for deeper aggregation.
 */

export {
  getSubredditPosts,
  getPost,
  getComments,
  searchSubreddit,
  getUserAgent,
  buildRedditUrl,
  RedditNotFoundError,
  RedditRateLimitError,
  RedditApiError,
  DEFAULT_USER_AGENT,
  __testing,
} from './operations';

export type {
  RedditPostSummary,
  RedditCommentNode,
  RedditPostDetail,
  RedditSort,
  RedditTimeWindow,
  GetSubredditPostsParams,
  GetSubredditPostsResult,
  GetPostParams,
  GetCommentsParams,
  SearchSubredditParams,
} from './operations';

import { listTasks } from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

/**
 * Pull the subreddit name (sans `r/`) that a task targets, if any.
 *
 * Looks at `task.context.reddit.subreddit`. Returns the cleaned name or null.
 * Accepts both raw names (`marketing`) and prefixed forms (`r/marketing`,
 * `/r/marketing`) — Reddit treats them interchangeably and so do we.
 */
export function getSubredditFromContext(task: Task): string | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const ctx = task.context as Record<string, unknown>;
  const reddit = ctx.reddit;
  if (!reddit || typeof reddit !== 'object') return null;
  const sub = (reddit as Record<string, unknown>).subreddit;
  if (typeof sub !== 'string') return null;
  return normalizeSubreddit(sub);
}

/**
 * Pull the post id (if any) the task targets.
 */
export function getPostIdFromContext(task: Task): string | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const ctx = task.context as Record<string, unknown>;
  const reddit = ctx.reddit;
  if (!reddit || typeof reddit !== 'object') return null;
  const id = (reddit as Record<string, unknown>).post_id;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  return id.trim();
}

/**
 * Strip `r/` / `/r/` prefixes and lowercase the result. Reddit subreddit
 * names are case-insensitive but the JSON API responses use the canonical
 * lowercased form, so we normalize on input.
 */
export function normalizeSubreddit(input: string): string {
  let s = input.trim();
  if (s.startsWith('/')) s = s.slice(1);
  if (s.toLowerCase().startsWith('r/')) s = s.slice(2);
  return s;
}

/**
 * List every distinct subreddit a current task targets. Used by the Settings
 * card to surface recent subreddits without forcing the user to remember
 * them by hand.
 *
 * Sorted alphabetically, archived tasks excluded.
 */
export function listRecentSubreddits(): string[] {
  const seen = new Set<string>();
  for (const task of listTasks({ include_archived: false })) {
    const sub = getSubredditFromContext(task);
    if (sub) seen.add(sub);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
