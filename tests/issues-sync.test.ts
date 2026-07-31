/**
 * GitHub Issues two-way sync tests.
 *
 * Coverage:
 *   - opened     → task created with github_issue context + github/issue tags
 *   - opened     → existing task refreshed (dedupe on owner/repo/number)
 *   - closed     → task marked done; backfilled if missing
 *   - reopened   → task requeued; backfilled if missing
 *   - edited     → title / body synced on existing task
 *   - sync-back disabled → no GitHub API call
 *   - sync-back enabled  → updateIssue called on task.status flip
 *
 * Octokit is mocked module-wide so no network IO happens. The DB
 * repository is mocked via `useMockedDb`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

/* -------------------------------------------------------------------------- */
/*  Octokit / github mock                                                     */
/* -------------------------------------------------------------------------- */

const ghState = vi.hoisted(() => ({
  updateIssueSpy: vi.fn(),
}));

vi.mock('@/main/github', () => {
  class GitHubNotConfiguredError extends Error {
    code = 'GITHUB_NOT_CONFIGURED';
    constructor(message = 'GitHub not configured.') {
      super(message);
    }
  }
  class GitHubAuthError extends Error {
    code = 'GITHUB_AUTH';
    status = 401;
    constructor(message = 'Auth failed') {
      super(message);
    }
  }
  class GitHubApiError extends Error {
    code = 'GITHUB_API_ERROR';
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    GitHubNotConfiguredError,
    GitHubAuthError,
    GitHubApiError,
    GitHubRateLimitError: class extends Error {},
    classifyOctokitError: (err: unknown) => err,
    getClient: vi.fn(),
  };
});

vi.mock('@/main/github/operations', () => ({
  updateIssue: ghState.updateIssueSpy,
}));

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

useMockedDb();

let sync: typeof import('@/main/github/issues-sync');
let tasks: typeof import('@/main/db/repositories/tasks');
let settings: typeof import('@/main/db/repositories/settings');

beforeEach(async () => {
  vi.resetModules();
  ghState.updateIssueSpy.mockReset();
  ghState.updateIssueSpy.mockResolvedValue({
    number: 7,
    title: 'Test',
    state: 'closed',
    html_url: 'https://github.com/owner/repo/issues/7',
    user_login: 'jack',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    labels: [],
  });
  sync = await import('@/main/github/issues-sync');
  tasks = await import('@/main/db/repositories/tasks');
  settings = await import('@/main/db/repositories/settings');
});

afterEach(() => {
  tasks?.__clearCompletionListeners();
});

function makeIssuePayload(
  action: string,
  overrides: Partial<{
    number: number;
    state: string;
    title: string;
    body: string | null;
    html_url: string;
    labels: string[];
    owner: string;
    repo: string;
  }> = {},
) {
  const labels = overrides.labels ?? [];
  return {
    action,
    issue: {
      number: overrides.number ?? 7,
      state: overrides.state ?? 'open',
      title: overrides.title ?? 'Test issue',
      body: overrides.body !== undefined ? overrides.body : 'Body content',
      html_url:
        overrides.html_url ??
        `https://github.com/${overrides.owner ?? 'owner'}/${overrides.repo ?? 'repo'}/issues/${
          overrides.number ?? 7
        }`,
      labels: labels.map((name) => ({ name })),
    },
    repository: {
      owner: { login: overrides.owner ?? 'owner' },
      name: overrides.repo ?? 'repo',
      full_name: `${overrides.owner ?? 'owner'}/${overrides.repo ?? 'repo'}`,
    },
  };
}

describe('issues-sync inbound', () => {
  it('opened: creates task with github_issue context and tags', async () => {
    const result = await sync.handleIssueWebhook(
      makeIssuePayload('opened', {
        number: 11,
        title: 'Hello',
        body: 'Some body',
        labels: ['bug', 'p1'],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.task_id).toBeTruthy();
    const created = tasks.getTask(result.task_id!);
    expect(created).not.toBeNull();
    expect(created!.title).toBe('Hello');
    expect(created!.description).toBe('Some body');
    expect(created!.tags).toEqual(expect.arrayContaining(['github', 'issue']));
    const link = sync.readIssueLink(created!);
    expect(link).not.toBeNull();
    expect(link!.owner).toBe('owner');
    expect(link!.repo).toBe('repo');
    expect(link!.number).toBe(11);
  });

  it('opened: dedupes on (owner, repo, number) — second opened reuses the row', async () => {
    const first = await sync.handleIssueWebhook(
      makeIssuePayload('opened', { number: 22 }),
    );
    const second = await sync.handleIssueWebhook(
      makeIssuePayload('opened', { number: 22 }),
    );
    expect(second.task_id).toBe(first.task_id);
  });

  it('closed: existing task → status done', async () => {
    const created = await sync.handleIssueWebhook(
      makeIssuePayload('opened', { number: 33 }),
    );
    const closed = await sync.handleIssueWebhook(
      makeIssuePayload('closed', { number: 33, state: 'closed' }),
    );
    expect(closed.task_id).toBe(created.task_id);
    const t = tasks.getTask(created.task_id!);
    expect(t!.status).toBe('done');
    expect(t!.agent_status).toBe('succeeded');
  });

  it('closed: missing task → backfills as done', async () => {
    const closed = await sync.handleIssueWebhook(
      makeIssuePayload('closed', { number: 44, state: 'closed' }),
    );
    expect(closed.task_id).toBeTruthy();
    const t = tasks.getTask(closed.task_id!);
    expect(t!.status).toBe('done');
  });

  it('reopened: closed task → status queued', async () => {
    const created = await sync.handleIssueWebhook(
      makeIssuePayload('opened', { number: 55 }),
    );
    await sync.handleIssueWebhook(
      makeIssuePayload('closed', { number: 55, state: 'closed' }),
    );
    const reopened = await sync.handleIssueWebhook(
      makeIssuePayload('reopened', { number: 55, state: 'open' }),
    );
    expect(reopened.task_id).toBe(created.task_id);
    const t = tasks.getTask(created.task_id!);
    expect(t!.status).toBe('queued');
  });

  it('edited: syncs title and body onto linked task', async () => {
    const created = await sync.handleIssueWebhook(
      makeIssuePayload('opened', {
        number: 66,
        title: 'Original',
        body: 'Original body',
      }),
    );
    await sync.handleIssueWebhook(
      makeIssuePayload('edited', {
        number: 66,
        title: 'Updated title',
        body: 'Updated body',
      }),
    );
    const t = tasks.getTask(created.task_id!);
    expect(t!.title).toBe('Updated title');
    expect(t!.description).toBe('Updated body');
  });

  it('returns ok=true with no task change when repository coords are missing', async () => {
    const result = await sync.handleIssueWebhook({
      action: 'opened',
      issue: { number: 1, state: 'open' },
    });
    expect(result.ok).toBe(true);
    expect(result.task_id).toBeUndefined();
  });
});

describe('issues-sync outbound (sync-back)', () => {
  it('skips when github_issues_sync_back is unset (default false)', async () => {
    const created = tasks.createTask({
      title: 'manual',
      context: {
        github_issue: {
          owner: 'owner',
          repo: 'repo',
          number: 77,
          url: 'https://github.com/owner/repo/issues/77',
          state: 'open',
        },
      },
    });
    await sync.syncTaskToIssue({ ...created, status: 'done' });
    expect(ghState.updateIssueSpy).not.toHaveBeenCalled();
  });

  it('closes the issue on task done when sync-back is on', async () => {
    settings.settingsRepository.set('github_issues_sync_back', true);
    const created = tasks.createTask({
      title: 'manual',
      status: 'in_progress',
      context: {
        github_issue: {
          owner: 'owner',
          repo: 'repo',
          number: 88,
          url: 'https://github.com/owner/repo/issues/88',
          state: 'open',
        },
      },
    });
    const updated = { ...created, status: 'done' as const };
    await sync.syncTaskToIssue(updated);
    expect(ghState.updateIssueSpy).toHaveBeenCalledTimes(1);
    const args = ghState.updateIssueSpy.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      number: 88,
      state: 'closed',
    });
  });

  it('reopens the issue when a closed-mirrored task flips back to queued', async () => {
    settings.settingsRepository.set('github_issues_sync_back', true);
    ghState.updateIssueSpy.mockResolvedValue({
      number: 99,
      title: 'x',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/99',
      user_login: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      labels: [],
    });
    const created = tasks.createTask({
      title: 'manual',
      status: 'done',
      context: {
        github_issue: {
          owner: 'owner',
          repo: 'repo',
          number: 99,
          url: 'https://github.com/owner/repo/issues/99',
          state: 'closed',
        },
      },
    });
    const updated = { ...created, status: 'queued' as const };
    await sync.syncTaskToIssue(updated);
    const args = ghState.updateIssueSpy.mock.calls[0]?.[0];
    expect(args?.state).toBe('open');
  });

  it('completion hook fires syncTaskToIssue for done tasks', async () => {
    settings.settingsRepository.set('github_issues_sync_back', true);
    const unsubscribe = sync.installCompletionHook();
    try {
      const created = tasks.createTask({
        title: 'manual',
        status: 'in_progress',
        context: {
          github_issue: {
            owner: 'owner',
            repo: 'repo',
            number: 111,
            url: 'https://github.com/owner/repo/issues/111',
            state: 'open',
          },
        },
      });
      tasks.updateTask(created.id, { status: 'done' });
      // syncTaskToIssue is fire-and-forget but the spy is sync — wait
      // a tick for the microtask queue to drain.
      await new Promise((r) => setImmediate(r));
      expect(ghState.updateIssueSpy).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('swallows GitHubNotConfiguredError without throwing', async () => {
    const ghMod = await import('@/main/github');
    ghState.updateIssueSpy.mockRejectedValue(
      new ghMod.GitHubNotConfiguredError(),
    );
    settings.settingsRepository.set('github_issues_sync_back', true);
    const created = tasks.createTask({
      title: 'manual',
      context: {
        github_issue: {
          owner: 'owner',
          repo: 'repo',
          number: 222,
          url: 'https://github.com/owner/repo/issues/222',
          state: 'open',
        },
      },
    });
    // Should not throw.
    await expect(
      sync.syncTaskToIssue({ ...created, status: 'done' }),
    ).resolves.toBeUndefined();
  });
});
