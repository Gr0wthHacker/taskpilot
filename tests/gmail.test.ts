/**
 * Gmail integration tests.
 *
 * Coverage:
 *   - getStatus reports `connected: false` when no tokens are stored.
 *   - getStatus reports `connected: true` once Gmail scopes are granted, and
 *     `send_enabled: true` only when both the scope AND the user setting opt-in.
 *   - captureOnce imports new messages, dedupes against already-imported ids,
 *     and applies the configured import label.
 *   - createDraft hits the drafts.create endpoint with a base64url RFC822 blob.
 *   - sendMessage refuses when `gmail_send_enabled` is false.
 *   - sendMessage succeeds (and hits drafts.send) when both gates are open.
 *   - The Gmail status JSON never contains a token value.
 *
 * `googleapis` is mocked module-wide so no real network IO happens. The test
 * harness uses `mockTaskpilotPaths` to redirect `~/.taskpilot` into a temp
 * directory and bootstraps a fake credentials.json + tokens.json for each
 * scenario.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

/* -------------------------------------------------------------------------- */
/*  googleapis mock                                                           */
/* -------------------------------------------------------------------------- */

interface OAuth2InstanceMock {
  setCredentials: ReturnType<typeof vi.fn>;
  generateAuthUrl: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getToken: ReturnType<typeof vi.fn>;
  credentials: Record<string, unknown>;
}

const googleapisState = vi.hoisted(() => {
  return {
    /** Last OAuth2 instance the module constructed. */
    lastOauth: null as OAuth2InstanceMock | null,
    /** Captured gmail() instance — overridable per test via `setGmailMock`. */
    gmail: {
      users: {
        getProfile: vi.fn().mockResolvedValue({
          data: { emailAddress: 'jack@example.com' },
        }),
        messages: {
          list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
          get: vi.fn(),
          modify: vi.fn().mockResolvedValue({ data: {} }),
          send: vi.fn().mockResolvedValue({
            data: { id: 'sent-msg-1', threadId: 'thread-1' },
          }),
        },
        drafts: {
          create: vi.fn().mockResolvedValue({
            data: { id: 'draft-1', message: { id: 'msg-1' } },
          }),
          send: vi.fn().mockResolvedValue({
            data: { id: 'sent-msg-1', threadId: 'thread-1' },
          }),
        },
        labels: {
          list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
          create: vi.fn().mockResolvedValue({
            data: { id: 'Label_imported', name: 'TaskPilot/imported' },
          }),
        },
      },
    },
  };
});

vi.mock('googleapis', () => {
  return {
    google: {
      auth: {
        OAuth2: class {
          credentials: Record<string, unknown> = {};
          setCredentials = vi.fn((c: Record<string, unknown>): void => {
            this.credentials = c;
          });
          generateAuthUrl = vi.fn(
            (opts: { state?: string; scope?: string[] }) => {
              const state = opts.state ?? '';
              const scopes = (opts.scope ?? []).join(' ');
              return `https://example.com/oauth?state=${state}&scope=${encodeURIComponent(scopes)}`;
            },
          );
          on = vi.fn();
          getToken = vi.fn();
          constructor(..._args: unknown[]) {
            googleapisState.lastOauth = this as unknown as OAuth2InstanceMock;
          }
        },
      },
      gmail: vi.fn(() => googleapisState.gmail),
    },
  };
});

/* -------------------------------------------------------------------------- */
/*  Test helpers                                                              */
/* -------------------------------------------------------------------------- */

async function writeCredentials(): Promise<void> {
  await fs.mkdir(PATHS.TASKPILOT_HOME, { recursive: true });
  await fs.writeFile(
    PATHS.CREDS_PATH,
    JSON.stringify({
      installed: {
        client_id: 'fake-id',
        client_secret: 'fake-secret',
        redirect_uris: ['http://localhost:7847/oauth/callback'],
      },
    }),
    'utf8',
  );
}

async function writeTokens(scope: string): Promise<void> {
  const tokensPath = path.join(PATHS.TASKPILOT_HOME, 'tokens.json');
  await fs.writeFile(
    tokensPath,
    JSON.stringify({
      access_token: 'access-fake',
      refresh_token: 'refresh-fake',
      scope,
      token_type: 'Bearer',
      expiry_date: Date.now() + 3_600_000,
    }),
    'utf8',
  );
}

async function clearTokens(): Promise<void> {
  const tokensPath = path.join(PATHS.TASKPILOT_HOME, 'tokens.json');
  try {
    await fs.unlink(tokensPath);
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/*  Module loaders                                                            */
/* -------------------------------------------------------------------------- */

let gmail: typeof import('@/main/gmail');
let settings: typeof import('@/main/db/repositories/settings');
let tasksRepo: typeof import('@/main/db/repositories/tasks');

beforeEach(async () => {
  vi.resetModules();
  await writeCredentials();
  await clearTokens();
  // Reset the in-memory gmail() mock so each test sees a fresh handler set.
  for (const fn of Object.values(googleapisState.gmail.users.messages))
    if (typeof fn === 'function') fn.mockClear();
  for (const fn of Object.values(googleapisState.gmail.users.drafts))
    if (typeof fn === 'function') fn.mockClear();
  for (const fn of Object.values(googleapisState.gmail.users.labels))
    if (typeof fn === 'function') fn.mockClear();
  googleapisState.gmail.users.getProfile.mockClear();
  googleapisState.gmail.users.messages.list.mockResolvedValue({
    data: { messages: [] },
  });
  googleapisState.gmail.users.labels.list.mockResolvedValue({
    data: { labels: [] },
  });

  gmail = await import('@/main/gmail');
  settings = await import('@/main/db/repositories/settings');
  tasksRepo = await import('@/main/db/repositories/tasks');

  // Clear gmail_send_enabled between tests so the default (off) holds.
  try {
    settings.del('gmail_send_enabled');
    settings.del('gmail_messages_imported');
    settings.del('gmail_capture_query');
    settings.del('gmail_import_label');
    settings.del('agent_paused');
  } catch {
    /* DB may not be initialized in some tests */
  }
});

afterEach(async () => {
  await clearTokens();
});

/* -------------------------------------------------------------------------- */
/*  Status                                                                    */
/* -------------------------------------------------------------------------- */

describe('gmail/getStatus', () => {
  it('returns connected: false when no tokens are stored', async () => {
    const status = await gmail.getStatus();
    expect(status.connected).toBe(false);
    expect(status.scopes_granted).toEqual([]);
    expect(status.send_enabled).toBe(false);
  });

  it('returns connected: true once gmail scopes are granted', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    );
    const status = await gmail.getStatus();
    expect(status.connected).toBe(true);
    expect(status.scopes_granted.length).toBeGreaterThan(0);
    expect(
      status.scopes_granted.every((s) => s.includes('gmail')),
    ).toBe(true);
    // send is not yet granted as a scope AND not yet enabled in settings.
    expect(status.send_enabled).toBe(false);
  });

  it('send_enabled requires BOTH the scope AND the user setting', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    );
    // Scope present but setting off.
    expect((await gmail.getStatus()).send_enabled).toBe(false);

    settings.set('gmail_send_enabled', true);
    expect((await gmail.getStatus()).send_enabled).toBe(true);

    // Drop the scope but keep the setting — should still be false.
    await writeTokens('https://www.googleapis.com/auth/gmail.readonly');
    expect((await gmail.getStatus()).send_enabled).toBe(false);
  });

  it('never echoes the access token in the response shape', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    const status = await gmail.getStatus();
    const json = JSON.stringify(status);
    expect(json).not.toContain('access-fake');
    expect(json).not.toContain('refresh-fake');
  });
});

/* -------------------------------------------------------------------------- */
/*  startAuthFlow                                                             */
/* -------------------------------------------------------------------------- */

describe('gmail/startAuthFlow', () => {
  it('builds a URL with the gmail base scopes', async () => {
    const { url, state } = await gmail.startAuthFlow();
    expect(state.length).toBeGreaterThan(0);
    expect(url).toContain('state=');
    expect(decodeURIComponent(url)).toContain('gmail.readonly');
    expect(decodeURIComponent(url)).toContain('gmail.compose');
    // Calendar scopes are always included so we never strip them when
    // re-running the consent flow from the Gmail card.
    expect(decodeURIComponent(url)).toContain('calendar.events');
  });

  it('includes gmail.send when explicitly requested', async () => {
    const { url } = await gmail.startAuthFlow({ includeSend: true });
    expect(decodeURIComponent(url)).toContain('gmail.send');
  });
});

/* -------------------------------------------------------------------------- */
/*  Capture                                                                   */
/* -------------------------------------------------------------------------- */

describe('gmail/captureOnce', () => {
  beforeEach(async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    );
  });

  function stubMessage(id: string, subject: string): void {
    googleapisState.gmail.users.messages.get.mockImplementation(
      async (args: { id: string }) => {
        return {
          data: {
            id: args.id,
            threadId: `thread-${args.id}`,
            labelIds: ['STARRED', 'INBOX'],
            snippet: `snippet for ${subject}`,
            payload: {
              headers: [
                { name: 'Subject', value: subject },
                { name: 'From', value: 'sender@example.com' },
                { name: 'To', value: 'jack@example.com' },
                { name: 'Date', value: 'Mon, 1 Jan 2026 09:00:00 +0000' },
              ],
              body: {
                data: Buffer.from(`body for ${subject}`, 'utf8')
                  .toString('base64')
                  .replace(/\+/g, '-')
                  .replace(/\//g, '_'),
              },
              mimeType: 'text/plain',
            },
          },
        };
      },
    );
    void id;
  }

  it('imports a new message and creates an inbox task', async () => {
    googleapisState.gmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'msg-1', threadId: 'thread-msg-1' }] },
    });
    stubMessage('msg-1', 'Sales follow-up');

    const result = await gmail.captureOnce();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const tasks = tasksRepo.listTasks({ status: 'inbox' });
    const fromGmail = tasks.filter((t) => t.tags?.includes('gmail'));
    expect(fromGmail.length).toBe(1);
    const task = fromGmail[0]!;
    expect(task.title).toBe('Re: Sales follow-up');
    expect(task.context?.gmail_message_id).toBe('msg-1');
    expect(task.context?.gmail_from).toBe('sender@example.com');
    expect(task.agent_method).toBe('human_only');
  });

  it('dedupes ids — running twice does not import twice', async () => {
    googleapisState.gmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'msg-1', threadId: 'thread-msg-1' }] },
    });
    stubMessage('msg-1', 'A subject');

    const first = await gmail.captureOnce();
    expect(first.imported).toBe(1);

    const second = await gmail.captureOnce();
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('applies the import label to each captured message', async () => {
    googleapisState.gmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'msg-2', threadId: 'thread-msg-2' }] },
    });
    stubMessage('msg-2', 'Label me');
    googleapisState.gmail.users.labels.list.mockResolvedValue({
      data: {
        labels: [
          { id: 'Label_imported', name: 'TaskPilot/imported' },
        ],
      },
    });

    await gmail.captureOnce();

    expect(googleapisState.gmail.users.messages.modify).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-2',
        requestBody: expect.objectContaining({
          addLabelIds: expect.arrayContaining(['Label_imported']),
        }),
      }),
    );
  });

  it('respects agent_paused — no work when paused', async () => {
    settings.set('agent_paused', true);
    googleapisState.gmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'msg-x', threadId: 'thread-x' }] },
    });
    const result = await gmail.captureOnce();
    expect(result.imported).toBe(0);
    // The list endpoint should NOT have been called when paused.
    expect(googleapisState.gmail.users.messages.list).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  Drafts                                                                    */
/* -------------------------------------------------------------------------- */

describe('gmail/createDraft', () => {
  beforeEach(async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    );
  });

  it('creates a draft and returns the draft id', async () => {
    const result = await gmail.createDraft({
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there.',
    });
    expect(result.draft_id).toBe('draft-1');
    expect(result.message_id).toBe('msg-1');
    expect(googleapisState.gmail.users.drafts.create).toHaveBeenCalled();
    const callArgs =
      googleapisState.gmail.users.drafts.create.mock.calls[0]![0];
    expect(callArgs.requestBody.message.raw).toBeTruthy();
    // The raw blob is base64url — decode and sanity check the headers.
    const raw = callArgs.requestBody.message.raw as string;
    const decoded = Buffer.from(
      raw.replace(/-/g, '+').replace(/_/g, '/') +
        '==='.slice((raw.length + 3) % 4),
      'base64',
    ).toString('utf8');
    expect(decoded).toContain('To: recipient@example.com');
    expect(decoded).toContain('Subject: Hello');
    expect(decoded).toContain('Hi there.');
  });
});

/* -------------------------------------------------------------------------- */
/*  Send                                                                      */
/* -------------------------------------------------------------------------- */

describe('gmail/sendMessage', () => {
  it('refuses when gmail_send_enabled is false', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    );
    // setting NOT set → send not enabled.
    await expect(
      gmail.sendMessage({
        to: 'r@example.com',
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toBeInstanceOf(gmail.GmailAuthError);
    expect(googleapisState.gmail.users.drafts.send).not.toHaveBeenCalled();
    expect(googleapisState.gmail.users.messages.send).not.toHaveBeenCalled();
  });

  it('refuses when the scope is missing even if the setting is on', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    settings.set('gmail_send_enabled', true);
    await expect(
      gmail.sendMessage({
        to: 'r@example.com',
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toBeInstanceOf(gmail.GmailAuthError);
  });

  it('sends a draft when both gates are open', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send',
    );
    settings.set('gmail_send_enabled', true);

    const result = await gmail.sendMessage({ draftId: 'draft-1' });
    expect(result.message_id).toBe('sent-msg-1');
    expect(googleapisState.gmail.users.drafts.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { id: 'draft-1' },
      }),
    );
  });

  it('sends an inline compose when both gates are open', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send',
    );
    settings.set('gmail_send_enabled', true);

    const result = await gmail.sendMessage({
      to: 'r@example.com',
      subject: 'inline',
      body: 'inline body',
    });
    expect(result.message_id).toBe('sent-msg-1');
    expect(googleapisState.gmail.users.messages.send).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  Disconnect                                                                */
/* -------------------------------------------------------------------------- */

describe('gmail/disconnect', () => {
  it('strips gmail scopes but keeps calendar tokens when calendar is granted', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events',
    );
    settings.set('gmail_send_enabled', true);

    await gmail.disconnect();

    const tokensPath = path.join(PATHS.TASKPILOT_HOME, 'tokens.json');
    const raw = await fs.readFile(tokensPath, 'utf8');
    expect(raw).not.toContain('gmail.readonly');
    expect(raw).toContain('calendar.events');
    expect((await gmail.getStatus()).connected).toBe(false);
    // setting flipped off as a side effect.
    expect(gmail.isSendEnabledInSettings()).toBe(false);
  });

  it('deletes the tokens file when only gmail scopes were granted', async () => {
    await writeTokens(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    await gmail.disconnect();
    const tokensPath = path.join(PATHS.TASKPILOT_HOME, 'tokens.json');
    await expect(fs.stat(tokensPath)).rejects.toThrow();
  });
});
