/**
 * Notion integration tests.
 *
 * Coverage:
 *   - storage roundtrip (save / load / delete)
 *   - connect persists the token, validates via users.me, never returns it
 *   - sync creates a page for a fresh task (no notion_page_id yet)
 *   - sync updates an existing page when notion_page_id is set
 *   - workspace filter excludes tasks that don't match
 *   - token never appears in any response body (regression check)
 *   - disabled / not configured short-circuit cleanly
 *
 * @notionhq/client is mocked module-wide so no network IO happens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

/* -------------------------------------------------------------------------- */
/*  @notionhq/client mock                                                     */
/* -------------------------------------------------------------------------- */

interface NotionClientMock {
  token: string;
  users: { me: ReturnType<typeof vi.fn> };
  pages: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  blocks: {
    delete: ReturnType<typeof vi.fn>;
    children: {
      list: ReturnType<typeof vi.fn>;
      append: ReturnType<typeof vi.fn>;
    };
  };
  search: ReturnType<typeof vi.fn>;
}

const notionState = vi.hoisted(() => ({
  lastInstance: null as null | NotionClientMock,
  constructorSpy: vi.fn(),
}));

function buildClient(token: string): NotionClientMock {
  return {
    token,
    users: {
      me: vi.fn().mockResolvedValue({
        object: 'user',
        id: 'bot-id',
        bot: {
          workspace_name: 'IndexThread',
          workspace_icon: 'https://example.com/icon.png',
          owner: { user: { id: 'user-id' } },
        },
      }),
    },
    pages: {
      create: vi.fn().mockResolvedValue({
        id: 'page-created-1',
        url: 'https://notion.so/page-created-1',
      }),
      update: vi.fn().mockResolvedValue({
        id: 'page-updated-1',
        url: 'https://notion.so/page-updated-1',
      }),
    },
    blocks: {
      delete: vi.fn().mockResolvedValue({}),
      children: {
        list: vi.fn().mockResolvedValue({ results: [], has_more: false }),
        append: vi.fn().mockResolvedValue({}),
      },
    },
    search: vi.fn().mockResolvedValue({
      results: [
        {
          object: 'database',
          id: 'db-1',
          title: [{ plain_text: 'My Tasks' }],
          url: 'https://notion.so/db-1',
        },
      ],
    }),
  };
}

vi.mock('@notionhq/client', () => {
  return {
    Client: class {
      constructor(opts: { auth: string }) {
        const inst = buildClient(opts.auth);
        notionState.lastInstance = inst;
        notionState.constructorSpy(opts.auth);
        Object.assign(this, inst);
      }
    },
  };
});

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

useMockedDb();

let notion: typeof import('@/main/notion');
let storage: typeof import('@/main/notion/storage');
let sync: typeof import('@/main/notion/sync');
let tasks: typeof import('@/main/db/repositories/tasks');
let settings: typeof import('@/main/db/repositories/settings');

beforeEach(async () => {
  vi.resetModules();
  notionState.constructorSpy.mockClear();
  notionState.lastInstance = null;
  notion = await import('@/main/notion');
  storage = await import('@/main/notion/storage');
  sync = await import('@/main/notion/sync');
  tasks = await import('@/main/db/repositories/tasks');
  settings = await import('@/main/db/repositories/settings');
  await storage.deleteToken();
});

afterEach(async () => {
  if (storage) {
    await storage.deleteToken().catch(() => {
      /* file may not exist */
    });
  }
  if (sync) {
    try {
      sync.stopSyncJob();
    } catch {
      /* not running */
    }
  }
});

/* -------------------------------------------------------------------------- */

describe('notion/storage', () => {
  it('saveToken writes and loadToken reads back', async () => {
    await storage.saveToken('secret_test');
    expect(await storage.hasToken()).toBe(true);
    expect(await storage.loadToken()).toBe('secret_test');
  });

  it('deleteToken removes the file', async () => {
    await storage.saveToken('secret_x');
    await storage.deleteToken();
    expect(await storage.hasToken()).toBe(false);
    expect(await storage.loadToken()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('notion/connect', () => {
  it('validates token via users.me and persists on success', async () => {
    const result = await notion.connect('secret_validtoken');
    expect(result.workspace.workspace_name).toBe('IndexThread');
    expect(result.workspace.bot_id).toBe('bot-id');
    expect(notionState.constructorSpy).toHaveBeenCalledWith('secret_validtoken');
    expect(await storage.hasToken()).toBe(true);
    expect(await storage.loadToken()).toBe('secret_validtoken');
  });

  it('rejects empty tokens', async () => {
    await expect(notion.connect('')).rejects.toBeInstanceOf(notion.NotionAuthError);
    await expect(notion.connect('   ')).rejects.toBeInstanceOf(
      notion.NotionAuthError,
    );
    expect(await storage.hasToken()).toBe(false);
  });

  it('never echoes the token in the response', async () => {
    const result = await notion.connect('secret_sneaky');
    const json = JSON.stringify(result);
    expect(json).not.toContain('secret_sneaky');
  });
});

/* -------------------------------------------------------------------------- */

describe('notion/getStatus', () => {
  it('returns connected:false when no token is stored', async () => {
    const status = await notion.getStatus();
    expect(status.connected).toBe(false);
  });

  it('returns connected:true with workspace name and no token', async () => {
    await storage.saveToken('secret_real');
    const status = await notion.getStatus();
    expect(status.connected).toBe(true);
    expect(status.workspace_name).toBe('IndexThread');
    const json = JSON.stringify(status);
    expect(json).not.toContain('secret_real');
  });
});

/* -------------------------------------------------------------------------- */

describe('notion/listDatabases', () => {
  it('returns mapped database summaries', async () => {
    await storage.saveToken('secret_real');
    const dbs = await notion.listDatabases();
    expect(dbs).toHaveLength(1);
    expect(dbs[0]).toMatchObject({
      id: 'db-1',
      title: 'My Tasks',
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('notion/sync', () => {
  beforeEach(async () => {
    await storage.saveToken('secret_real');
    settings.settingsRepository.set('notion_sync_enabled', true);
    settings.settingsRepository.set('notion_database_id', 'db-1');
  });

  it('no-op when sync is disabled', async () => {
    settings.settingsRepository.set('notion_sync_enabled', false);
    const result = await sync.syncOnce();
    expect(result.pushed).toBe(0);
    expect(result.reason).toBe('notion_sync_disabled');
  });

  it('no-op when no database is selected', async () => {
    settings.settingsRepository.delete('notion_database_id');
    const result = await sync.syncOnce();
    expect(result.reason).toBe('database_not_selected');
  });

  it('no-op when not configured', async () => {
    await storage.deleteToken();
    const result = await sync.syncOnce();
    expect(result.notConfigured).toBe(true);
  });

  it('creates a page for a task with no notion_page_id', async () => {
    tasks.createTask({
      title: 'Mirror me',
      description: 'Body',
      priority: 'p1',
      tags: ['marketing'],
    });
    const result = await sync.syncOnce();
    expect(result.pushed).toBe(1);
    expect(notionState.lastInstance?.pages.create).toHaveBeenCalledTimes(1);
    const createArg = notionState.lastInstance!.pages.create.mock.calls[0]?.[0];
    expect(createArg?.parent?.database_id).toBe('db-1');
  });

  it('updates a page when notion_page_id is already set', async () => {
    tasks.createTask({
      title: 'Existing page',
      context: { notion_page_id: 'page-existing' },
    });
    const result = await sync.syncOnce();
    expect(result.pushed).toBe(1);
    expect(notionState.lastInstance?.pages.update).toHaveBeenCalledTimes(1);
    expect(notionState.lastInstance?.pages.create).not.toHaveBeenCalled();
  });

  it('persists notion_page_id back onto the task after a create', async () => {
    const created = tasks.createTask({ title: 'Fresh' });
    await sync.syncOnce();
    const refreshed = tasks.getTask(created.id);
    const ctx = refreshed?.context as Record<string, unknown> | null;
    expect(ctx?.notion_page_id).toBe('page-created-1');
    expect(ctx?.notion_page_url).toBe('https://notion.so/page-created-1');
  });

  it('respects the workspace filter when set', async () => {
    settings.settingsRepository.set('notion_sync_workspace', 'IndexThread');
    tasks.createTask({
      title: 'belongs',
      context: { workspace: 'IndexThread' },
    });
    tasks.createTask({
      title: 'other',
      context: { workspace: 'Other' },
    });
    tasks.createTask({
      title: 'no workspace',
    });
    const result = await sync.syncOnce();
    expect(result.pushed).toBe(1);
  });

  it('maps status / priority into select properties', async () => {
    tasks.createTask({
      title: 'check mapping',
      status: 'queued',
      priority: 'p1',
    });
    await sync.syncOnce();
    const createArg = notionState.lastInstance!.pages.create.mock.calls[0]?.[0];
    expect(createArg?.properties?.Status?.select?.name).toBe('Queued');
    expect(createArg?.properties?.Priority?.select?.name).toBe('P1');
  });

  it('skips archived tasks', async () => {
    tasks.createTask({ title: 'live' });
    tasks.createTask({ title: 'archived', status: 'archived' });
    const result = await sync.syncOnce();
    expect(result.pushed).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('notion/disconnect', () => {
  it('removes the token and resets the cached client', async () => {
    await storage.saveToken('to-remove');
    expect(await storage.hasToken()).toBe(true);
    await notion.disconnect();
    expect(await storage.hasToken()).toBe(false);
    await expect(notion.getClient()).rejects.toBeInstanceOf(
      notion.NotionNotConfiguredError,
    );
  });
});
