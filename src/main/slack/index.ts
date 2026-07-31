/**
 * Public entry point for the Slack integration.
 *
 * Exposes lifecycle (`connect`, `getStatus`, `disconnect`) plus the high-
 * level operations (`postMessage`, `listChannels`). The bot token is never
 * returned to callers — `connect()` validates it via `auth.test` and
 * persists it via the storage module; `getStatus()` exposes the public
 * `team` block and bot user id only.
 *
 * Mirrors the shape of `src/main/github/index.ts` so the two integrations
 * feel cohesive.
 */

import {
  SlackApiError,
  SlackAuthError,
  SlackNotConfiguredError,
  SlackRateLimitError,
  classifySlackError,
  getClient,
  resetClient,
  wrap,
} from './client';
import { deleteToken, hasToken, saveToken } from './storage';

export {
  SlackApiError,
  SlackAuthError,
  SlackNotConfiguredError,
  SlackRateLimitError,
  classifySlackError,
  getClient,
};

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export interface SlackTeamSummary {
  id: string;
  name: string;
  domain: string;
}

export interface SlackStatus {
  connected: boolean;
  team?: SlackTeamSummary;
  bot_user_id?: string;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  is_archived: boolean;
}

export interface SlackPostMessageResult {
  channel: string;
  ts: string;
  permalink: string | null;
}

interface AuthTestResponse {
  ok?: boolean;
  team?: string;
  team_id?: string;
  url?: string;
  user_id?: string;
  bot_id?: string;
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

function extractDomainFromUrl(url: string | undefined): string {
  if (!url) return '';
  // `auth.test` returns the workspace URL as `https://my-workspace.slack.com/`.
  // The subdomain is the workspace domain.
  try {
    const u = new URL(url);
    const host = u.hostname;
    const dot = host.indexOf('.');
    return dot === -1 ? host : host.slice(0, dot);
  } catch {
    return '';
  }
}

async function probe(
  client: import('@slack/web-api').WebClient,
): Promise<{ team: SlackTeamSummary; bot_user_id: string }> {
  const res = (await client.auth.test()) as AuthTestResponse;
  if (res.ok === false) {
    throw new SlackAuthError('auth.test returned ok: false', 401);
  }
  const team_id = res.team_id ?? '';
  const name = res.team ?? '';
  const domain = extractDomainFromUrl(res.url);
  const bot_user_id = res.user_id ?? res.bot_id ?? '';
  return {
    team: { id: team_id, name, domain },
    bot_user_id,
  };
}

/**
 * Validate the supplied bot token by hitting `auth.test`, then persist it.
 *
 * On success: returns the team info + bot user id, caches the client.
 * On a Slack auth error: throws `SlackAuthError`.
 * Never returns or logs the raw token.
 */
export async function connect(
  token: string,
): Promise<{ team: SlackTeamSummary; bot_user_id: string }> {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new SlackAuthError('Token is empty.', 400);
  }
  const trimmed = token.trim();
  // Probe with a one-shot WebClient so we don't clobber the cache until
  // we know the token works.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebClient } = await import('@slack/web-api');
  const probeClient = new WebClient(trimmed);
  let result: { team: SlackTeamSummary; bot_user_id: string };
  try {
    result = await probe(probeClient);
  } catch (err) {
    throw classifySlackError(err);
  }

  await saveToken(trimmed);
  // Invalidate any previously-cached client so the next getClient() picks
  // up the new token.
  resetClient();
  return result;
}

/**
 * Status probe.
 *
 * Returns `{ connected: false }` if no token is stored. If one exists, we
 * hit `auth.test` to confirm it still works — a Slack auth error means
 * it's been revoked. On any other failure we treat it as connected-but-
 * degraded to avoid surfacing transient network errors as a disconnect.
 */
export async function getStatus(): Promise<SlackStatus> {
  const present = await hasToken();
  if (!present) {
    return { connected: false };
  }
  try {
    const client = await getClient();
    const result = await probe(client);
    return {
      connected: true,
      team: result.team,
      bot_user_id: result.bot_user_id,
    };
  } catch (err) {
    const classified = classifySlackError(err);
    if (classified instanceof SlackAuthError) {
      return { connected: false };
    }
    // Network blip / 5xx — say we're still connected but skip the team
    // block. Mirrors github/getStatus.
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
/*  Channel listing                                                            */
/* -------------------------------------------------------------------------- */

interface ConversationsListResponse {
  ok?: boolean;
  channels?: Array<{
    id?: string;
    name?: string;
    is_private?: boolean;
    is_archived?: boolean;
    is_member?: boolean;
    is_channel?: boolean;
    is_group?: boolean;
    is_im?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
}

/**
 * List channels (public + private) the bot can post to. Excludes archived
 * channels and DMs. Returns up to `limit` results across paginated calls.
 */
export async function listChannels(
  limit = 500,
): Promise<SlackChannelSummary[]> {
  const client = await getClient();
  return wrap(async () => {
    const out: SlackChannelSummary[] = [];
    let cursor: string | undefined = undefined;
    const pageSize = Math.min(limit, 200);
    // Cap the loop so a runaway cursor can't spin forever.
    for (let i = 0; i < 20 && out.length < limit; i += 1) {
      const args: Record<string, unknown> = {
        limit: pageSize,
        exclude_archived: true,
        types: 'public_channel,private_channel',
      };
      if (cursor) args.cursor = cursor;
      const res = (await client.conversations.list(
        args,
      )) as ConversationsListResponse;
      const channels = res.channels ?? [];
      for (const c of channels) {
        if (!c.id || !c.name) continue;
        out.push({
          id: c.id,
          name: c.name,
          is_private: Boolean(c.is_private),
          is_member: Boolean(c.is_member),
          is_archived: Boolean(c.is_archived),
        });
        if (out.length >= limit) break;
      }
      const next = res.response_metadata?.next_cursor;
      if (!next || next.length === 0) break;
      cursor = next;
    }
    return out;
  });
}

/* -------------------------------------------------------------------------- */
/*  Posting messages                                                          */
/* -------------------------------------------------------------------------- */

export interface PostMessageInput {
  channel: string;
  text: string;
  /** Reply in a thread when set. Pass the parent `ts`. */
  thread_ts?: string;
}

interface ChatPostMessageResponse {
  ok?: boolean;
  channel?: string;
  ts?: string;
}

interface PermalinkResponse {
  ok?: boolean;
  permalink?: string;
}

/**
 * Post a message to a channel (or DM). When `thread_ts` is provided the
 * message lands in that thread. Returns the channel, ts, and a permalink
 * to the posted message (best-effort — if `chat.getPermalink` fails the
 * permalink is `null`).
 */
export async function postMessage(
  input: PostMessageInput,
): Promise<SlackPostMessageResult> {
  if (typeof input.channel !== 'string' || input.channel.trim().length === 0) {
    throw new SlackApiError('channel is required', 400, null);
  }
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw new SlackApiError('text is required', 400, null);
  }
  const client = await getClient();
  return wrap(async () => {
    const args: {
      channel: string;
      text: string;
      thread_ts?: string;
    } = {
      channel: input.channel,
      text: input.text,
    };
    if (input.thread_ts) args.thread_ts = input.thread_ts;
    const res = (await client.chat.postMessage(
      args,
    )) as ChatPostMessageResponse;
    const channel = res.channel ?? input.channel;
    const ts = res.ts ?? '';
    let permalink: string | null = null;
    if (channel && ts) {
      try {
        const link = (await client.chat.getPermalink({
          channel,
          message_ts: ts,
        })) as PermalinkResponse;
        permalink = link.permalink ?? null;
      } catch {
        // Permalink is informational — don't fail the post over a 404 here.
        permalink = null;
      }
    }
    return { channel, ts, permalink };
  });
}

/* -------------------------------------------------------------------------- */
/*  Test-only escape hatch                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Test-only: reset the cached client. Not part of the public API but
 * useful to mocks that swap the on-disk token between assertions.
 */
export const __internals = {
  reset(): void {
    resetClient();
  },
};
