/**
 * Slack integration tests.
 *
 * Coverage:
 *   - connect persists the token, validates via auth.test, never returns it
 *   - getStatus reports connected:false when no token is stored
 *   - postMessage forwards args to chat.postMessage and returns the ts
 *   - disconnect deletes the token and stops the capture job
 *   - capture creates tasks for new starred messages and dedupes prior imports
 *   - token never appears in any response body (regression check)
 *
 * `@slack/web-api`'s WebClient is mocked module-wide so no network IO
 * happens during tests. The tests touch the real on-disk storage module
 * against a mocked TaskPilot home (via `mockTaskpilotPaths`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

/* -------------------------------------------------------------------------- */
/*  @slack/web-api mock                                                       */
/* -------------------------------------------------------------------------- */

interface WebClientMockInstance {
  token: string;
  auth: { test: ReturnType<typeof vi.fn> };
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
    getPermalink: ReturnType<typeof vi.fn>;
  };
  conversations: {
    list: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  users: {
    info: ReturnType<typeof vi.fn>;
  };
  stars: {
    list: ReturnType<typeof vi.fn>;
  };
}

const slackState = vi.hoisted(() => ({
  lastInstance: null as null | WebClientMockInstance,
  constructorSpy: vi.fn(),
}));

function buildWebClient(token: string): WebClientMockInstance {
  return {
    token,
    auth: {
      test: vi.fn().mockResolvedValue({
        ok: true,
        team: 'IndexThread',
        team_id: 'T12345',
        url: 'https://indexthread.slack.com/',
        user_id: 'U_BOT',
      }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({
        ok: true,
        channel: 'C123',
        ts: '1701000000.000100',
      }),
      getPermalink: vi.fn().mockResolvedValue({
        ok: true,
        permalink: 'https://indexthread.slack.com/archives/C123/p1701000000000100',
      }),
    },
    conversations: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        channels: [
          { id: 'C123', name: 'general', is_private: false, is_member: true },
          { id: 'C456', name: 'random', is_private: false, is_member: false },
        ],
        response_metadata: { next_cursor: '' },
      }),
      info: vi.fn().mockResolvedValue({
        ok: true,
        channel: { id: 'C123', name: 'general' },
      }),
    },
    users: {
      info: vi.fn().mockResolvedValue({
        ok: true,
        user: {
          id: 'U999',
          name: 'jack',
          profile: { display_name: 'Jack', real_name: 'Jack G' },
        },
      }),
    },
    stars: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          {
            type: 'message',
            channel: 'C123',
            message: {
              // Use "now" so the first-run 7-day filter doesn't skip it.
              ts: String(Date.now() / 1_000),
              text: 'Important: ship the Slack integration',
              user: 'U999',
              permalink:
                'https://indexthread.slack.com/archives/C123/p1701000000000100',
            },
          },
        ],
        response_metadata: { next_cursor: '' },
      }),
    },
  };
}

vi.mock('@slack/web-api', () => {
  return {
    WebClient: class {
      constructor(token: string) {
        const inst = buildWebClient(token);
        slackState.lastInstance = inst;
        slackState.constructorSpy(token);
        Object.assign(this, inst);
      }
    },
  };
});

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

useMockedDb();

let slack: typeof import('@/main/slack');
let storage: typeof import('@/main/slack/storage');
let capture: typeof import('@/main/slack/capture');

beforeEach(async () => {
  vi.resetModules();
  slackState.constructorSpy.mockClear();
  slackState.lastInstance = null;
  slack = await import('@/main/slack');
  storage = await import('@/main/slack/storage');
  capture = await import('@/main/slack/capture');
  await storage.deleteToken();
});

afterEach(async () => {
  if (storage) {
    await storage.deleteToken().catch(() => {
      /* file may not exist */
    });
  }
  // Stop any running capture job so it can't bleed into the next test.
  if (capture) {
    try {
      capture.stopCaptureJob();
    } catch {
      /* not running */
    }
  }
});

describe('slack/storage', () => {
  it('saveToken writes and loadToken reads back', async () => {
    await storage.saveToken('xoxb-test-1');
    expect(await storage.hasToken()).toBe(true);
    expect(await storage.loadToken()).toBe('xoxb-test-1');
  });

  it('deleteToken removes the file', async () => {
    await storage.saveToken('xoxb-test-2');
    await storage.deleteToken();
    expect(await storage.hasToken()).toBe(false);
    expect(await storage.loadToken()).toBeNull();
  });

  it('loadToken returns null when nothing is stored', async () => {
    expect(await storage.loadToken()).toBeNull();
  });
});

describe('slack/connect', () => {
  it('validates token via auth.test and persists on success', async () => {
    const result = await slack.connect('xoxb-validtoken');
    expect(result.team.id).toBe('T12345');
    expect(result.team.name).toBe('IndexThread');
    expect(result.team.domain).toBe('indexthread');
    expect(result.bot_user_id).toBe('U_BOT');
    // WebClient was constructed with the token.
    expect(slackState.constructorSpy).toHaveBeenCalledWith('xoxb-validtoken');
    // Token now on disk.
    expect(await storage.hasToken()).toBe(true);
    expect(await storage.loadToken()).toBe('xoxb-validtoken');
  });

  it('rejects empty tokens with SlackAuthError before any network call', async () => {
    await expect(slack.connect('')).rejects.toBeInstanceOf(
      slack.SlackAuthError,
    );
    await expect(slack.connect('   ')).rejects.toBeInstanceOf(
      slack.SlackAuthError,
    );
    expect(await storage.hasToken()).toBe(false);
  });

  it('translates invalid_auth from Slack into SlackAuthError', async () => {
    slackState.constructorSpy.mockImplementationOnce(() => {
      if (slackState.lastInstance) {
        slackState.lastInstance.auth.test = vi.fn().mockRejectedValue(
          Object.assign(new Error('Auth failed'), {
            data: { error: 'invalid_auth' },
            status: 200,
          }),
        );
      }
    });
    await expect(slack.connect('bad-token')).rejects.toBeInstanceOf(
      slack.SlackAuthError,
    );
    // Token must NOT be persisted on auth failure.
    expect(await storage.hasToken()).toBe(false);
  });

  it('never returns the raw token in any response field', async () => {
    const result = await slack.connect('xoxb-sneaky-token');
    const json = JSON.stringify(result);
    expect(json).not.toContain('xoxb-sneaky-token');
  });
});

describe('slack/getStatus', () => {
  it('returns connected:false when no token is stored', async () => {
    const status = await slack.getStatus();
    expect(status.connected).toBe(false);
    expect(status.team).toBeUndefined();
  });

  it('returns connected:true with team shape but no token', async () => {
    await storage.saveToken('xoxb-real');
    const status = await slack.getStatus();
    expect(status.connected).toBe(true);
    expect(status.team?.name).toBe('IndexThread');
    const json = JSON.stringify(status);
    expect(json).not.toContain('xoxb-real');
  });
});

describe('slack/postMessage', () => {
  it('forwards channel/text to chat.postMessage and returns ts + permalink', async () => {
    await storage.saveToken('xoxb-real');
    const result = await slack.postMessage({
      channel: 'C123',
      text: 'Done — PR opened',
    });
    expect(result.ts).toBe('1701000000.000100');
    expect(result.permalink).toContain('p1701000000000100');
    expect(slackState.lastInstance?.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', text: 'Done — PR opened' }),
    );
  });

  it('forwards thread_ts when set', async () => {
    await storage.saveToken('xoxb-real');
    await slack.postMessage({
      channel: 'C123',
      text: 'reply',
      thread_ts: '1700000000.000200',
    });
    expect(slackState.lastInstance?.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1700000000.000200' }),
    );
  });

  it('throws SlackNotConfiguredError when no token is stored', async () => {
    await expect(
      slack.postMessage({ channel: 'C123', text: 'hi' }),
    ).rejects.toBeInstanceOf(slack.SlackNotConfiguredError);
  });
});

describe('slack/disconnect', () => {
  it('removes the token file and resets cached client', async () => {
    await storage.saveToken('to-remove');
    expect(await storage.hasToken()).toBe(true);
    await slack.disconnect();
    expect(await storage.hasToken()).toBe(false);
    await expect(slack.getClient()).rejects.toBeInstanceOf(
      slack.SlackNotConfiguredError,
    );
  });

  it('stopping the capture job is safe before it ever started', () => {
    // capture.stopCaptureJob is a no-op when nothing is running.
    expect(() => capture.stopCaptureJob()).not.toThrow();
  });
});

describe('slack/capture', () => {
  it('creates a task for a new starred message', async () => {
    await storage.saveToken('xoxb-real');
    const tasksRepo = await import('@/main/db/repositories/tasks');
    expect(tasksRepo.listTasks().length).toBe(0);

    const result = await capture.captureOnce();
    expect(result.created).toBe(1);

    const tasks = tasksRepo.listTasks();
    expect(tasks.length).toBe(1);
    const task = tasks[0]!;
    expect(task.title).toContain('Important: ship the Slack integration');
    expect(task.tags).toContain('slack');
    expect(task.agent_method).toBe('human_only');
    const ctx = task.context as Record<string, unknown>;
    expect(ctx.slack_permalink).toContain('p1701000000000100');
    expect(ctx.slack_channel).toBe('general');
    expect(ctx.slack_user).toBe('Jack');
  });

  it('skips already-imported messages on the second pass', async () => {
    await storage.saveToken('xoxb-real');
    const first = await capture.captureOnce();
    expect(first.created).toBe(1);
    const second = await capture.captureOnce();
    expect(second.created).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it('short-circuits when no token is configured', async () => {
    const result = await capture.captureOnce();
    expect(result.created).toBe(0);
    expect(result.notConfigured).toBe(true);
  });

  it('short-circuits when agent_paused is set', async () => {
    await storage.saveToken('xoxb-real');
    const settings = await import('@/main/db/repositories/settings');
    settings.set('agent_paused', true);
    const result = await capture.captureOnce();
    expect(result.created).toBe(0);
    expect(result.paused).toBe(true);
  });

  it('skips messages older than 7 days on first run', async () => {
    await storage.saveToken('xoxb-real');
    // Override the stars list to return one ancient and one fresh item.
    const ancient = String(
      (Date.now() - 30 * 24 * 60 * 60 * 1_000) / 1_000,
    );
    const fresh = String(Date.now() / 1_000);
    slackState.constructorSpy.mockImplementationOnce(() => {
      if (slackState.lastInstance) {
        slackState.lastInstance.stars.list = vi.fn().mockResolvedValue({
          ok: true,
          items: [
            {
              type: 'message',
              channel: 'C123',
              message: { ts: ancient, text: 'old', user: 'U999' },
            },
            {
              type: 'message',
              channel: 'C123',
              message: { ts: fresh, text: 'new', user: 'U999' },
            },
          ],
          response_metadata: { next_cursor: '' },
        });
      }
    });
    const result = await capture.captureOnce();
    // Only the fresh message becomes a task on the first pass.
    expect(result.created).toBe(1);
    const tasksRepo = await import('@/main/db/repositories/tasks');
    const tasks = tasksRepo.listTasks();
    expect(tasks.some((t) => t.title === 'new')).toBe(true);
    expect(tasks.some((t) => t.title === 'old')).toBe(false);
  });
});
