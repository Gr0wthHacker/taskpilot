/**
 * GitHub integration tests.
 *
 * Coverage:
 *   - connect persists the PAT and never returns it
 *   - getStatus reports connected: false when no PAT is stored
 *   - getStatus never echoes the token, only the public user shape
 *   - disconnect deletes the on-disk PAT and resets the cached client
 *   - operations propagate to the expected Octokit calls
 *   - operations throw `GitHubNotConfiguredError` when no PAT exists
 *
 * Octokit is mocked module-wide so no network IO happens during tests. The
 * tests touch the real on-disk storage module against a mocked TaskPilot
 * home (via `mockTaskpilotPaths`) — this gives us coverage of the
 * save/load/delete cycle without exercising Electron safeStorage (which the
 * task description explicitly carves out of scope).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

/* -------------------------------------------------------------------------- */
/*  Octokit mock                                                              */
/* -------------------------------------------------------------------------- */

// Hoisted so the `vi.mock` factory below sees the same object the tests
// reach into for assertions.
const octokitState = vi.hoisted(() => ({
  /** Last instance constructed, or null. */
  lastInstance: null as null | OctokitMockInstance,
  /** Stack of constructor-side hooks to inject pre-built mock data. */
  constructorSpy: vi.fn(),
}));

interface OctokitMockInstance {
  auth: string;
  users: {
    getAuthenticated: ReturnType<typeof vi.fn>;
  };
  repos: {
    listForAuthenticatedUser: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    getContent: ReturnType<typeof vi.fn>;
    createOrUpdateFileContents: ReturnType<typeof vi.fn>;
  };
  git: {
    getRef: ReturnType<typeof vi.fn>;
    createRef: ReturnType<typeof vi.fn>;
  };
  pulls: {
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  issues: {
    listForRepo: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function buildOctokitInstance(auth: string): OctokitMockInstance {
  return {
    auth,
    users: {
      getAuthenticated: vi.fn().mockResolvedValue({
        data: {
          login: 'jackgierlich',
          name: 'Jack Gierlich',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        },
      }),
    },
    repos: {
      listForAuthenticatedUser: vi.fn().mockResolvedValue({
        data: [
          {
            id: 1,
            name: 'taskpilot',
            full_name: 'jackgierlich/taskpilot',
            owner: { login: 'jackgierlich' },
            default_branch: 'main',
            private: false,
            description: null,
            html_url: 'https://github.com/jackgierlich/taskpilot',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          id: 1,
          name: 'taskpilot',
          full_name: 'jackgierlich/taskpilot',
          owner: { login: 'jackgierlich' },
          default_branch: 'main',
          private: false,
          description: null,
          html_url: 'https://github.com/jackgierlich/taskpilot',
          updated_at: '2026-01-01T00:00:00Z',
        },
      }),
      getContent: vi.fn().mockRejectedValue(
        Object.assign(new Error('Not Found'), { status: 404 }),
      ),
      createOrUpdateFileContents: vi.fn().mockResolvedValue({
        data: {
          commit: { sha: 'deadbeef' },
          content: { sha: 'cafebabe' },
        },
      }),
    },
    git: {
      getRef: vi.fn().mockResolvedValue({
        data: { object: { sha: 'aabbccdd' } },
      }),
      createRef: vi.fn().mockResolvedValue({
        data: { ref: 'refs/heads/agent/test', object: { sha: 'aabbccdd' } },
      }),
    },
    pulls: {
      create: vi.fn().mockResolvedValue({
        data: { number: 42, html_url: 'https://github.com/x/y/pull/42' },
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          title: 'Test PR',
          state: 'open',
          html_url: 'https://github.com/x/y/pull/42',
          head: { ref: 'agent/test' },
          base: { ref: 'main' },
          merged: false,
          draft: false,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          user: { login: 'jackgierlich' },
        },
      }),
    },
    issues: {
      listForRepo: vi.fn().mockResolvedValue({
        data: [
          {
            number: 1,
            title: 'Fix something',
            state: 'open',
            html_url: 'https://github.com/x/y/issues/1',
            user: { login: 'jackgierlich' },
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            labels: [{ name: 'bug' }, 'help-wanted'],
            pull_request: undefined,
          },
        ],
      }),
      create: vi.fn().mockResolvedValue({
        data: { number: 99, html_url: 'https://github.com/x/y/issues/99' },
      }),
    },
  };
}

vi.mock('@octokit/rest', () => {
  return {
    Octokit: class {
      constructor(opts: { auth?: string }) {
        const inst = buildOctokitInstance(opts?.auth ?? '');
        octokitState.lastInstance = inst;
        octokitState.constructorSpy(opts);
        // Mirror the instance's properties onto `this` so callers using
        // `client.users.getAuthenticated()` route through the mock.
        Object.assign(this, inst);
      }
    },
  };
});

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

// Imported after mock setup so the mocked Octokit is wired in. Re-imported in
// each `beforeEach` to reset module state between tests.
let github: typeof import('@/main/github');
let storage: typeof import('@/main/github/storage');
let operations: typeof import('@/main/github/operations');

beforeEach(async () => {
  vi.resetModules();
  octokitState.constructorSpy.mockClear();
  octokitState.lastInstance = null;
  github = await import('@/main/github');
  storage = await import('@/main/github/storage');
  operations = await import('@/main/github/operations');
  // Belt-and-suspenders: ensure no PAT survives from a prior test.
  await storage.deletePAT();
});

afterEach(async () => {
  if (storage) {
    await storage.deletePAT().catch(() => {
      /* file may not exist */
    });
  }
});

describe('github/storage', () => {
  it('savePAT writes a 0600-mode file and loadPAT reads it back', async () => {
    await storage.savePAT('github_pat_abc123');
    const stored = await storage.loadPAT();
    expect(stored).toBe('github_pat_abc123');

    const stat = await fs.stat(storage.GITHUB_PAT_PATH);
    expect(stat.isFile()).toBe(true);

    // Make sure the file ended up where mockTaskpilotPaths expects.
    expect(storage.GITHUB_PAT_PATH).toBe(
      path.join(PATHS.TASKPILOT_HOME, 'github-pat'),
    );
  });

  it('hasPAT and deletePAT round-trip cleanly', async () => {
    expect(await storage.hasPAT()).toBe(false);
    await storage.savePAT('token');
    expect(await storage.hasPAT()).toBe(true);
    await storage.deletePAT();
    expect(await storage.hasPAT()).toBe(false);
  });

  it('loadPAT returns null when nothing is stored', async () => {
    const result = await storage.loadPAT();
    expect(result).toBeNull();
  });
});

describe('github/connect', () => {
  it('validates token by calling GET /user and persists on success', async () => {
    const result = await github.connect('github_pat_validtoken');
    expect(result.user.login).toBe('jackgierlich');
    expect(result.user.name).toBe('Jack Gierlich');
    expect(result.user.avatar_url).toContain('avatars.githubusercontent.com');

    // Octokit was constructed with the token.
    expect(octokitState.constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'github_pat_validtoken' }),
    );

    // PAT now on disk.
    expect(await storage.hasPAT()).toBe(true);
    expect(await storage.loadPAT()).toBe('github_pat_validtoken');
  });

  it('rejects empty tokens with GitHubAuthError before any network call', async () => {
    await expect(github.connect('')).rejects.toBeInstanceOf(
      github.GitHubAuthError,
    );
    await expect(github.connect('   ')).rejects.toBeInstanceOf(
      github.GitHubAuthError,
    );
    expect(await storage.hasPAT()).toBe(false);
  });

  it('translates a 401 from GitHub into GitHubAuthError', async () => {
    // Install a one-shot constructor side effect: mutate the freshly-built
    // instance to reject with a 401 from `users.getAuthenticated`. The mock
    // factory above sets `octokitState.lastInstance` BEFORE invoking
    // `constructorSpy`, so the override here lands on the instance that
    // `connect()` is about to use.
    octokitState.constructorSpy.mockImplementationOnce(() => {
      if (octokitState.lastInstance) {
        octokitState.lastInstance.users.getAuthenticated = vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Bad credentials'), { status: 401 }),
          );
      }
    });

    await expect(github.connect('bad-token')).rejects.toBeInstanceOf(
      github.GitHubAuthError,
    );
    // PAT must NOT be persisted on auth failure.
    expect(await storage.hasPAT()).toBe(false);
  });
});

describe('github/getStatus', () => {
  it('returns connected: false when no PAT is stored', async () => {
    const status = await github.getStatus();
    expect(status.connected).toBe(false);
    expect(status.user).toBeUndefined();
  });

  it('returns connected: true with public user shape when valid', async () => {
    await storage.savePAT('valid-token');
    const status = await github.getStatus();
    expect(status.connected).toBe(true);
    expect(status.user?.login).toBe('jackgierlich');

    // Critically: the response shape must NOT contain the token.
    const json = JSON.stringify(status);
    expect(json).not.toContain('valid-token');
  });
});

describe('github/disconnect', () => {
  it('removes the PAT file and resets cached client', async () => {
    await storage.savePAT('to-be-removed');
    expect(await storage.hasPAT()).toBe(true);
    await github.disconnect();
    expect(await storage.hasPAT()).toBe(false);
    // After disconnect, getClient must throw NotConfigured.
    await expect(github.getClient()).rejects.toBeInstanceOf(
      github.GitHubNotConfiguredError,
    );
  });
});

describe('github/operations', () => {
  it('listRepos calls Octokit repos.listForAuthenticatedUser', async () => {
    await storage.savePAT('valid');
    const repos = await operations.listRepos();
    expect(repos.length).toBe(1);
    expect(repos[0]?.full_name).toBe('jackgierlich/taskpilot');
    expect(octokitState.lastInstance?.repos.listForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100, page: 1, sort: 'updated' }),
    );
  });

  it('getRepo passes owner/repo through to Octokit', async () => {
    await storage.savePAT('valid');
    const repo = await operations.getRepo('jackgierlich', 'taskpilot');
    expect(repo.default_branch).toBe('main');
    expect(octokitState.lastInstance?.repos.get).toHaveBeenCalledWith({
      owner: 'jackgierlich',
      repo: 'taskpilot',
    });
  });

  it('createBranch resolves base ref to SHA and creates a new ref', async () => {
    await storage.savePAT('valid');
    const result = await operations.createBranch(
      'jackgierlich',
      'taskpilot',
      'agent/test',
    );
    expect(result.ref).toBe('refs/heads/agent/test');
    expect(octokitState.lastInstance?.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/main' }),
    );
    expect(octokitState.lastInstance?.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'refs/heads/agent/test',
        sha: 'aabbccdd',
      }),
    );
  });

  it('commitFiles base64-encodes content and PUTs each file', async () => {
    await storage.savePAT('valid');
    const result = await operations.commitFiles({
      owner: 'jackgierlich',
      repo: 'taskpilot',
      branch: 'agent/test',
      message: 'add hello',
      files: [{ path: 'hello.txt', content: 'hi there' }],
    });
    expect(result.sha).toBe('deadbeef');
    expect(
      octokitState.lastInstance?.repos.createOrUpdateFileContents,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'jackgierlich',
        repo: 'taskpilot',
        branch: 'agent/test',
        path: 'hello.txt',
        message: 'add hello',
        content: Buffer.from('hi there', 'utf8').toString('base64'),
      }),
    );
  });

  it('openPR resolves default base when not provided', async () => {
    await storage.savePAT('valid');
    const result = await operations.openPR({
      owner: 'jackgierlich',
      repo: 'taskpilot',
      head: 'agent/test',
      title: 'Test PR',
    });
    expect(result.number).toBe(42);
    expect(result.url).toContain('/pull/42');
    expect(octokitState.lastInstance?.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'jackgierlich',
        repo: 'taskpilot',
        head: 'agent/test',
        base: 'main',
        title: 'Test PR',
      }),
    );
  });

  it('listIssues filters out pull requests', async () => {
    await storage.savePAT('valid');
    // Patch the NEXT Octokit instance's `issues.listForRepo` so it includes
    // a PR-shaped issue alongside a real issue. The mock factory invokes
    // `constructorSpy` before `Object.assign(this, inst)` runs, so mutating
    // `lastInstance.issues` here is what ultimately gets copied onto the
    // operation's client.
    octokitState.constructorSpy.mockImplementationOnce(() => {
      if (octokitState.lastInstance) {
        octokitState.lastInstance.issues.listForRepo = vi
          .fn()
          .mockResolvedValue({
            data: [
              {
                number: 1,
                title: 'PR pretending to be an issue',
                state: 'open',
                html_url: 'https://github.com/x/y/pull/1',
                user: { login: 'foo' },
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                labels: [],
                pull_request: { url: '…' },
              },
              {
                number: 2,
                title: 'Real issue',
                state: 'open',
                html_url: 'https://github.com/x/y/issues/2',
                user: { login: 'foo' },
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                labels: ['bug'],
                pull_request: undefined,
              },
            ],
          });
      }
    });
    const issues = await operations.listIssues({
      owner: 'jackgierlich',
      repo: 'taskpilot',
    });
    expect(issues.length).toBe(1);
    expect(issues[0]?.number).toBe(2);
    expect(issues[0]?.labels).toEqual(['bug']);
  });

  it('createIssue forwards labels and body', async () => {
    await storage.savePAT('valid');
    const result = await operations.createIssue({
      owner: 'jackgierlich',
      repo: 'taskpilot',
      title: 'New issue',
      body: 'desc',
      labels: ['triage'],
    });
    expect(result.number).toBe(99);
    expect(octokitState.lastInstance?.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'jackgierlich',
        repo: 'taskpilot',
        title: 'New issue',
        body: 'desc',
        labels: ['triage'],
      }),
    );
  });
});

describe('github/operations without a PAT', () => {
  it('listRepos throws GitHubNotConfiguredError', async () => {
    expect(await storage.hasPAT()).toBe(false);
    await expect(operations.listRepos()).rejects.toBeInstanceOf(
      github.GitHubNotConfiguredError,
    );
  });

  it('createBranch throws GitHubNotConfiguredError', async () => {
    expect(await storage.hasPAT()).toBe(false);
    await expect(
      operations.createBranch('owner', 'repo', 'agent/x'),
    ).rejects.toBeInstanceOf(github.GitHubNotConfiguredError);
  });

  it('commitFiles throws GitHubNotConfiguredError', async () => {
    expect(await storage.hasPAT()).toBe(false);
    await expect(
      operations.commitFiles({
        owner: 'a',
        repo: 'b',
        branch: 'c',
        message: 'd',
        files: [{ path: 'e.txt', content: 'f' }],
      }),
    ).rejects.toBeInstanceOf(github.GitHubNotConfiguredError);
  });
});
