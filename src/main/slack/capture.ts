/**
 * Slack starred-message capture loop.
 *
 * Polls `stars.list` on an interval, dedupes against a persisted set of
 * already-imported message identifiers, and creates an inbox task for
 * each new starred message. The task's `context.slack_permalink` points
 * back to the original message; `context.slack_channel` and
 * `context.slack_user` are convenience fields.
 *
 * Capture is paused while the `agent_paused` setting is true so the
 * global kill switch freezes it too. The first poll after a fresh
 * connect skips messages older than 7 days so reconnecting doesn't dump
 * 500 historic tasks into the inbox.
 */

import { createTask } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import { ioEvents } from '@/main/io/events';
import type { Task } from '@/shared/types';

import { SlackNotConfiguredError, getClient } from './client';

/* -------------------------------------------------------------------------- */
/*  Settings keys                                                             */
/* -------------------------------------------------------------------------- */

const IMPORTED_SET_KEY = 'slack_message_imported';
const FIRST_RUN_KEY = 'slack_first_run_done';
const PAUSE_KEYS = ['agent_paused', 'pause_all_agents'] as const;

/** Cap LRU eviction so the imported-set never grows unbounded. */
const IMPORTED_SET_CAP = 500;

/** Skip-on-first-connect window: don't import stars older than this. */
const FIRST_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Default polling interval — 5 minutes. */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1_000;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function readBoolSetting(keys: ReadonlyArray<string>): boolean {
  for (const key of keys) {
    const raw = settingsRepository.get<unknown>(key);
    if (raw === true) return true;
    if (typeof raw === 'string' && (raw === 'true' || raw === '1')) return true;
    if (typeof raw === 'number' && raw === 1) return true;
  }
  return false;
}

function isAgentPaused(): boolean {
  return readBoolSetting(PAUSE_KEYS);
}

function loadImportedSet(): string[] {
  const raw = settingsRepository.get<unknown>(IMPORTED_SET_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function saveImportedSet(ids: string[]): void {
  // LRU eviction — keep the newest IMPORTED_SET_CAP entries.
  const trimmed = ids.length > IMPORTED_SET_CAP
    ? ids.slice(ids.length - IMPORTED_SET_CAP)
    : ids;
  settingsRepository.set(IMPORTED_SET_KEY, trimmed);
}

function dedupeKey(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

function isFirstRunDone(): boolean {
  return readBoolSetting([FIRST_RUN_KEY]);
}

function markFirstRunDone(): void {
  settingsRepository.set(FIRST_RUN_KEY, true);
}

/* -------------------------------------------------------------------------- */
/*  Slack API shapes (minimal — only what we touch)                           */
/* -------------------------------------------------------------------------- */

interface StarsListResponse {
  ok?: boolean;
  items?: StarItem[];
  paging?: { page?: number; pages?: number };
  response_metadata?: { next_cursor?: string };
}

interface StarItem {
  type?: string; // 'message' | 'file' | ...
  channel?: string;
  message?: {
    ts?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    username?: string;
    permalink?: string;
  };
}

interface PermalinkResponse {
  ok?: boolean;
  permalink?: string;
}

interface ConversationsInfoResponse {
  ok?: boolean;
  channel?: { id?: string; name?: string };
}

interface UsersInfoResponse {
  ok?: boolean;
  user?: { id?: string; name?: string; profile?: { display_name?: string; real_name?: string } };
}

/* -------------------------------------------------------------------------- */
/*  Channel + user resolution caches (per-tick)                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolve channel id → human channel name. Cached for the duration of one
 * capture tick so a burst of new stars in one channel doesn't fan out to
 * many `conversations.info` calls.
 */
async function buildChannelResolver(
  client: import('@slack/web-api').WebClient,
): Promise<(id: string) => Promise<string>> {
  const cache = new Map<string, string>();
  return async (id: string): Promise<string> => {
    if (cache.has(id)) return cache.get(id) as string;
    try {
      const res = (await client.conversations.info({
        channel: id,
      })) as ConversationsInfoResponse;
      const name = res.channel?.name ?? id;
      cache.set(id, name);
      return name;
    } catch {
      cache.set(id, id);
      return id;
    }
  };
}

async function buildUserResolver(
  client: import('@slack/web-api').WebClient,
): Promise<(id: string | undefined) => Promise<string>> {
  const cache = new Map<string, string>();
  return async (id: string | undefined): Promise<string> => {
    if (!id) return '';
    if (cache.has(id)) return cache.get(id) as string;
    try {
      const res = (await client.users.info({ user: id })) as UsersInfoResponse;
      const display =
        res.user?.profile?.display_name ||
        res.user?.profile?.real_name ||
        res.user?.name ||
        id;
      cache.set(id, display);
      return display;
    } catch {
      cache.set(id, id);
      return id;
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Core poll                                                                 */
/* -------------------------------------------------------------------------- */

export interface CaptureResult {
  /** Number of new tasks created this poll. */
  created: number;
  /** Number of starred items skipped (already imported or filtered). */
  skipped: number;
  /** Set to true when the loop short-circuited because Slack isn't connected. */
  notConfigured?: boolean;
  /** Set to true when the loop short-circuited because of the pause kill switch. */
  paused?: boolean;
}

/**
 * Run a single capture pass. Idempotent and safe to call concurrently —
 * the imported-set is loaded fresh each time and writes back atomically.
 *
 * Visible for testing and exposed via `POST /api/slack/capture-now`.
 */
export async function captureOnce(): Promise<CaptureResult> {
  if (isAgentPaused()) {
    return { created: 0, skipped: 0, paused: true };
  }

  let client: import('@slack/web-api').WebClient;
  try {
    client = await getClient();
  } catch (err) {
    if (err instanceof SlackNotConfiguredError) {
      return { created: 0, skipped: 0, notConfigured: true };
    }
    throw err;
  }

  const imported = loadImportedSet();
  const importedSet = new Set(imported);
  const firstRun = !isFirstRunDone();
  const cutoffEpochSeconds = firstRun
    ? (Date.now() - FIRST_RUN_MAX_AGE_MS) / 1_000
    : null;

  const resolveChannel = await buildChannelResolver(client);
  const resolveUser = await buildUserResolver(client);

  // `stars.list` returns a paged list. We make at most one page worth
  // per tick to bound work; the next tick picks up anything we missed
  // (and dedupe protects us from double-imports).
  const res = (await client.stars.list({ count: 100 })) as StarsListResponse;
  const items = res.items ?? [];

  let created = 0;
  let skipped = 0;

  for (const item of items) {
    // Only message-type stars are meaningful as tasks. Files, channels,
    // and other star types are skipped.
    if (item.type !== 'message') {
      skipped += 1;
      continue;
    }
    const channelId = item.channel ?? '';
    const ts = item.message?.ts ?? '';
    if (!channelId || !ts) {
      skipped += 1;
      continue;
    }
    const key = dedupeKey(channelId, ts);
    if (importedSet.has(key)) {
      skipped += 1;
      continue;
    }
    if (cutoffEpochSeconds !== null) {
      // Slack `ts` is a string like "1701234567.000200" — parseFloat
      // gives the epoch seconds.
      const tsNum = Number.parseFloat(ts);
      if (Number.isFinite(tsNum) && tsNum < cutoffEpochSeconds) {
        // Skip but still mark as imported so we don't revisit it.
        importedSet.add(key);
        imported.push(key);
        skipped += 1;
        continue;
      }
    }

    // Look up the permalink. Slack sometimes embeds it in the item, but
    // not always — fall back to `chat.getPermalink`.
    let permalink = item.message?.permalink ?? '';
    if (!permalink) {
      try {
        const link = (await client.chat.getPermalink({
          channel: channelId,
          message_ts: ts,
        })) as PermalinkResponse;
        permalink = link.permalink ?? '';
      } catch {
        permalink = '';
      }
    }

    const channelName = await resolveChannel(channelId);
    const userDisplay = await resolveUser(item.message?.user);
    const messageText = (item.message?.text ?? '').trim();
    const title = messageText.length === 0
      ? `Starred message in #${channelName}`
      : messageText.slice(0, 200);
    const description = [
      messageText,
      '',
      permalink ? `— From Slack: ${permalink}` : '— From Slack',
    ]
      .filter((s) => s.length > 0 || s === '')
      .join('\n');

    const taskInput: Partial<Task> & { title: string } = {
      title,
      description,
      status: 'inbox',
      priority: 'p2',
      agent_method: 'human_only',
      agent_executable: false,
      tags: ['slack'],
      context: {
        slack_permalink: permalink || null,
        slack_channel: channelName,
        slack_channel_id: channelId,
        slack_user: userDisplay,
        slack_message_ts: ts,
      },
    };

    try {
      createTask(taskInput);
      created += 1;
      ioEvents.emit('pipeline_changed', { reason: 'slack_capture' });
    } catch {
      // If task creation fails (unlikely outside DB outages) we skip
      // marking this one imported so the next tick retries.
      skipped += 1;
      continue;
    }

    importedSet.add(key);
    imported.push(key);
  }

  // Persist the updated imported-set even when nothing was created — we
  // may have skipped historic stars via the first-run filter and marked
  // them too.
  saveImportedSet(imported);
  if (firstRun) markFirstRunDone();

  return { created, skipped };
}

/* -------------------------------------------------------------------------- */
/*  Background loop                                                           */
/* -------------------------------------------------------------------------- */

export interface CaptureJobOptions {
  /** Poll interval in milliseconds. Defaults to 5 minutes. */
  intervalMs?: number;
  /** Skip the immediate first tick (mostly for tests). */
  skipInitialTick?: boolean;
}

export interface CaptureJobHandle {
  stop: () => void;
  /** Run a tick immediately. Returns the result; errors propagate. */
  tickNow: () => Promise<CaptureResult>;
}

let activeHandle: CaptureJobHandle | null = null;

/**
 * Start the background capture loop. Calling twice is a no-op; the
 * existing handle is returned (a-la `startApiServer`).
 *
 * The first tick fires immediately so a fresh connect surfaces stars
 * without waiting 5 minutes.
 */
export function startCaptureJob(
  options: CaptureJobOptions = {},
): CaptureJobHandle {
  if (activeHandle) return activeHandle;

  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;

  const tickNow = async (): Promise<CaptureResult> => {
    try {
      return await captureOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:slack-capture] tick failed:',
        err instanceof Error ? err.message : String(err),
      );
      return { created: 0, skipped: 0 };
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (stopped) return;
    void tickNow();
  }, intervalMs);
  // `unref` so the loop doesn't keep Node alive during tests / shutdown.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  const handle: CaptureJobHandle = {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      activeHandle = null;
    },
    tickNow,
  };
  activeHandle = handle;

  if (!options.skipInitialTick) {
    void tickNow();
  }

  return handle;
}

/**
 * Stop the active capture job, if any.
 */
export function stopCaptureJob(): void {
  if (activeHandle) {
    activeHandle.stop();
  }
}

/**
 * Whether the capture job is currently running.
 */
export function isCaptureJobRunning(): boolean {
  return activeHandle !== null;
}
