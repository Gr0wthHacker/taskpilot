/**
 * Typed repo operations on top of `@octokit/rest`.
 *
 * Each function fetches a cached client via `getClient()` and translates any
 * upstream error through `classifyOctokitError()` so callers see our error
 * taxonomy (`GitHubAuthError` / `GitHubRateLimitError` / `GitHubApiError` /
 * `GitHubNotConfiguredError`) instead of raw Octokit shapes.
 *
 * Multi-file commits use the contents API (one PUT per file). This is simpler
 * than the trees/blobs/commit dance and is enough for the agent workflow:
 * branches are short-lived and file counts are typically small. Switch to
 * git-data API if that ever stops being true.
 */

import { GitHubApiError, classifyOctokitError, getClient } from './index';

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

/** Light repo summary surfaced to the renderer / agent. */
export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  html_url: string;
  updated_at: string | null;
}

export interface CommitFileEntry {
  /** Repo-relative path (no leading slash). */
  path: string;
  /** UTF-8 file contents. The function handles base64 encoding for the API. */
  content: string;
}

export interface ListIssueSummary {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user_login: string | null;
  created_at: string;
  updated_at: string;
  labels: string[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head_ref: string;
  base_ref: string;
  merged: boolean;
  draft: boolean;
  created_at: string;
  updated_at: string;
  user_login: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Wrap an Octokit call so any thrown error flows through our classification
 * pipeline. Keeps each operation a one-liner instead of try/catch on every
 * line.
 */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyOctokitError(err);
  }
}

function shapeRepo(raw: {
  id: number;
  name: string;
  full_name: string;
  owner?: { login?: string };
  default_branch?: string;
  private?: boolean;
  description?: string | null;
  html_url?: string;
  updated_at?: string | null;
}): RepoSummary {
  return {
    id: raw.id,
    name: raw.name,
    full_name: raw.full_name,
    owner: raw.owner?.login ?? '',
    default_branch: raw.default_branch ?? 'main',
    private: Boolean(raw.private),
    description: raw.description ?? null,
    html_url: raw.html_url ?? '',
    updated_at: raw.updated_at ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Repos                                                                     */
/* -------------------------------------------------------------------------- */

export interface ListReposOptions {
  per_page?: number;
  page?: number;
}

/**
 * List the authenticated user's accessible repos, sorted by most recently
 * updated. GitHub caps per_page at 100.
 */
export async function listRepos(
  options: ListReposOptions = {},
): Promise<RepoSummary[]> {
  const client = await getClient();
  const perPage = Math.min(Math.max(options.per_page ?? 100, 1), 100);
  const page = Math.max(options.page ?? 1, 1);

  return wrap(async () => {
    const res = await client.repos.listForAuthenticatedUser({
      per_page: perPage,
      page,
      sort: 'updated',
    });
    return (res.data as Parameters<typeof shapeRepo>[0][]).map(shapeRepo);
  });
}

/**
 * Fetch a single repo's metadata. Useful for resolving the default branch
 * before opening a PR.
 */
export async function getRepo(
  owner: string,
  repo: string,
): Promise<RepoSummary> {
  const client = await getClient();
  return wrap(async () => {
    const res = await client.repos.get({ owner, repo });
    return shapeRepo(res.data as Parameters<typeof shapeRepo>[0]);
  });
}

/* -------------------------------------------------------------------------- */
/*  Reads — file contents + tree                                              */
/* -------------------------------------------------------------------------- */

/** Cap on how much of a single file we decode + return to the caller. */
const MAX_FILE_BYTES = 512 * 1024;

export interface RepoDirEntry {
  type: string; // 'file' | 'dir' | 'symlink' | 'submodule'
  name: string;
  path: string;
  size: number;
  sha: string;
}

export type RepoContents =
  | {
      kind: 'file';
      path: string;
      content: string; // decoded UTF-8 (capped)
      size: number;
      sha: string;
      truncated: boolean;
    }
  | { kind: 'dir'; path: string; entries: RepoDirEntry[] };

/**
 * Read a file or directory at `path` in a repo. Files are decoded to UTF-8
 * (capped at {@link MAX_FILE_BYTES}); directories return their immediate
 * entries. Read-only — uses the same PAT as every other op.
 */
export async function getContents(
  owner: string,
  repo: string,
  path = '',
  ref?: string,
): Promise<RepoContents> {
  const client = await getClient();
  return wrap(async () => {
    const res = await client.repos.getContent({
      owner,
      repo,
      path,
      ...(ref ? { ref } : {}),
    });
    const data = res.data as unknown;
    if (Array.isArray(data)) {
      const entries = (data as Array<Record<string, unknown>>).map((e) => ({
        type: String(e.type ?? 'file'),
        name: String(e.name ?? ''),
        path: String(e.path ?? ''),
        size: typeof e.size === 'number' ? e.size : 0,
        sha: String(e.sha ?? ''),
      }));
      return { kind: 'dir', path, entries };
    }
    const file = data as Record<string, unknown>;
    let content = '';
    let truncated = false;
    if (typeof file.content === 'string') {
      const raw = Buffer.from(
        file.content,
        (file.encoding as BufferEncoding) || 'base64',
      );
      truncated = raw.length > MAX_FILE_BYTES;
      content = (truncated ? raw.subarray(0, MAX_FILE_BYTES) : raw).toString(
        'utf8',
      );
    }
    return {
      kind: 'file',
      path: String(file.path ?? path),
      content,
      size: typeof file.size === 'number' ? file.size : 0,
      sha: String(file.sha ?? ''),
      truncated,
    };
  });
}

export interface RepoTreeEntry {
  path: string;
  type: string; // 'blob' | 'tree'
  size?: number;
  sha: string;
}

/**
 * Recursively list every path in a repo (one call). Resolves the default
 * branch when `ref` is omitted. `truncated` is true when GitHub capped the
 * tree (very large repos) — fall back to per-directory `getContents` then.
 */
export async function getTree(
  owner: string,
  repo: string,
  ref?: string,
): Promise<{ ref: string; truncated: boolean; entries: RepoTreeEntry[] }> {
  const client = await getClient();
  return wrap(async () => {
    const branch =
      ref ?? (await client.repos.get({ owner, repo })).data.default_branch;
    const res = await client.git.getTree({
      owner,
      repo,
      tree_sha: branch,
      recursive: '1',
    });
    const tree = (res.data.tree ?? []) as Array<Record<string, unknown>>;
    const entries = tree.map((t) => ({
      path: String(t.path ?? ''),
      type: String(t.type ?? 'blob'),
      ...(typeof t.size === 'number' ? { size: t.size } : {}),
      sha: String(t.sha ?? ''),
    }));
    return { ref: branch, truncated: Boolean(res.data.truncated), entries };
  });
}

/**
 * Does a repo at `owner/name` exist + is it reachable with the current PAT?
 * Cheap probe used by the resolver to decide between "use existing" vs
 * "create new" without hitting the create endpoint (which would 422 on
 * conflict but cost a write attempt).
 */
export async function repoExists(
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    await getRepo(owner, repo);
    return true;
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 403)) {
      return false;
    }
    throw err;
  }
}

export interface CreateRepoInput {
  /**
   * Repository name. Must follow GitHub's rules: ASCII letters/digits/`._-`,
   * no leading dot, max 100 chars. The route validates this; we don't.
   */
  name: string;
  /**
   * Owner. Leave blank or set to the authenticated user's login to create
   * under the user account; set to an org slug to create under that org.
   */
  owner?: string;
  description?: string;
  /** Defaults to `true` — fail-safe so we don't leak Jack's code by default. */
  private?: boolean;
  /** Seed the repo with an empty README so we can branch off `main` right away. */
  auto_init?: boolean;
  /** SPDX license id (e.g. `'mit'`, `'apache-2.0'`). */
  license_template?: string;
  /** Gitignore template name (e.g. `'Node'`, `'Python'`). */
  gitignore_template?: string;
  /** Default branch name. Defaults to `'main'`. */
  default_branch?: string;
}

/**
 * Create a new repo. Picks the user-account vs org endpoint based on whether
 * `owner` matches the authenticated user. Returns the same `RepoSummary`
 * shape as `getRepo` so callers can chain.
 */
export async function createRepo(
  input: CreateRepoInput,
): Promise<RepoSummary> {
  const client = await getClient();
  return wrap(async () => {
    const authUser = await client.users.getAuthenticated();
    const authLogin = authUser.data.login;
    const owner = input.owner && input.owner.length > 0 ? input.owner : authLogin;
    const isSelf = owner.toLowerCase() === authLogin.toLowerCase();
    const body = {
      name: input.name,
      description: input.description,
      private: input.private ?? true,
      auto_init: input.auto_init ?? true,
      license_template: input.license_template,
      gitignore_template: input.gitignore_template,
      // GitHub honors the default_branch field on create only when auto_init is true.
      // If the user wanted a non-main default, they'd typically rename after create.
    };
    if (isSelf) {
      const res = await client.repos.createForAuthenticatedUser(body);
      return shapeRepo(res.data as Parameters<typeof shapeRepo>[0]);
    }
    const res = await client.repos.createInOrg({ ...body, org: owner });
    return shapeRepo(res.data as Parameters<typeof shapeRepo>[0]);
  });
}

/**
 * Patch repo metadata (description, homepage, topics-via-separate-call, etc.).
 * Only the provided fields are sent so we don't accidentally clear others.
 * Returns the refreshed `RepoSummary`.
 */
export async function updateRepo(input: {
  owner: string;
  repo: string;
  description?: string;
  homepage?: string;
  private?: boolean;
  default_branch?: string;
}): Promise<RepoSummary> {
  const client = await getClient();
  return wrap(async () => {
    const body: Record<string, unknown> = {};
    if (input.description !== undefined) body.description = input.description;
    if (input.homepage !== undefined) body.homepage = input.homepage;
    if (input.private !== undefined) body.private = input.private;
    if (input.default_branch !== undefined) body.default_branch = input.default_branch;
    const res = await client.repos.update({
      owner: input.owner,
      repo: input.repo,
      ...body,
    });
    return shapeRepo(res.data as Parameters<typeof shapeRepo>[0]);
  });
}

/* -------------------------------------------------------------------------- */
/*  Branches                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a ref name (branch or full ref) to a commit SHA. Accepts either
 * `main` or `refs/heads/main` style refs.
 */
async function resolveRefSha(
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const client = await getClient();
  const normalized = ref.startsWith('refs/') ? ref.slice('refs/'.length) : `heads/${ref}`;
  return wrap(async () => {
    const res = await client.git.getRef({ owner, repo, ref: normalized });
    return res.data.object.sha;
  });
}

/**
 * Create a new branch from `fromRef` (defaults to the repo's default branch).
 * Returns the fully qualified ref name that was created.
 */
export async function createBranch(
  owner: string,
  repo: string,
  branch: string,
  fromRef?: string,
): Promise<{ ref: string; sha: string }> {
  const client = await getClient();
  return wrap(async () => {
    let baseRef = fromRef;
    if (!baseRef) {
      const meta = await client.repos.get({ owner, repo });
      baseRef = meta.data.default_branch;
    }
    const baseSha = await resolveRefSha(owner, repo, baseRef);
    const res = await client.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
    return { ref: res.data.ref, sha: baseSha };
  });
}

/* -------------------------------------------------------------------------- */
/*  Commits                                                                   */
/* -------------------------------------------------------------------------- */

export interface CommitFilesParams {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: CommitFileEntry[];
}

/**
 * Commit one or more files to a branch.
 *
 * NOTE: this issues one PUT per file via the contents API. The last SHA is
 * returned but each file is technically its own commit. For agent workflows
 * this is fine (we want atomic visibility on each file write); when we ever
 * need true single-commit-multiple-files we should migrate to the git-data
 * API (createTree + createCommit + updateRef).
 */
export async function commitFiles(
  params: CommitFilesParams,
): Promise<{ sha: string; commits: { path: string; sha: string }[] }> {
  if (params.files.length === 0) {
    throw new Error('commitFiles: at least one file is required');
  }
  const client = await getClient();
  return wrap(async () => {
    const commits: { path: string; sha: string }[] = [];
    let latestSha = '';
    for (const file of params.files) {
      // Look up the current file SHA (required when updating an existing path).
      let existingSha: string | undefined;
      try {
        const existing = await client.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path: file.path,
          ref: params.branch,
        });
        if (Array.isArray(existing.data)) {
          // A directory at the target path — let GitHub reject the PUT.
          existingSha = undefined;
        } else if (
          existing.data &&
          typeof existing.data === 'object' &&
          'sha' in existing.data &&
          typeof (existing.data as { sha: unknown }).sha === 'string'
        ) {
          existingSha = (existing.data as { sha: string }).sha;
        }
      } catch (err) {
        // 404 means the file doesn't exist yet — that's fine for a new file.
        const status =
          err && typeof err === 'object' && 'status' in err
            ? (err as { status?: number }).status
            : undefined;
        if (status !== 404) {
          throw err;
        }
      }

      const putRes = await client.repos.createOrUpdateFileContents({
        owner: params.owner,
        repo: params.repo,
        path: file.path,
        message: params.message,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch: params.branch,
        ...(existingSha ? { sha: existingSha } : {}),
      });
      const commitSha =
        putRes.data.commit?.sha ?? putRes.data.content?.sha ?? '';
      commits.push({ path: file.path, sha: commitSha });
      latestSha = commitSha || latestSha;
    }
    return { sha: latestSha, commits };
  });
}

/* -------------------------------------------------------------------------- */
/*  Deletes                                                                   */
/* -------------------------------------------------------------------------- */

export interface DeleteFilesParams {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  /** Repo-relative paths to delete. Each becomes one commit on the branch. */
  paths: string[];
}

/**
 * Delete one or more files from a branch. Mirrors `commitFiles` shape — one
 * Octokit `repos.deleteFile` call per path, fetching the current sha first.
 * Paths that 404 (already gone) are reported as `skipped` rather than throwing
 * so a partial re-run is idempotent.
 */
export async function deleteFiles(
  params: DeleteFilesParams,
): Promise<{
  deleted: { path: string; sha: string }[];
  skipped: { path: string; reason: string }[];
}> {
  if (params.paths.length === 0) {
    throw new Error('deleteFiles: at least one path is required');
  }
  const client = await getClient();
  return wrap(async () => {
    const deleted: { path: string; sha: string }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const path of params.paths) {
      // Get the current blob sha for this path on the branch.
      let existingSha: string | null = null;
      try {
        const existing = await client.repos.getContent({
          owner: params.owner,
          repo: params.repo,
          path,
          ref: params.branch,
        });
        if (Array.isArray(existing.data)) {
          skipped.push({ path, reason: 'is_directory' });
          continue;
        }
        if (
          existing.data &&
          typeof existing.data === 'object' &&
          'sha' in existing.data &&
          typeof (existing.data as { sha: unknown }).sha === 'string'
        ) {
          existingSha = (existing.data as { sha: string }).sha;
        }
      } catch (err) {
        const status =
          err && typeof err === 'object' && 'status' in err
            ? (err as { status?: number }).status
            : undefined;
        if (status === 404) {
          skipped.push({ path, reason: 'not_found' });
          continue;
        }
        throw err;
      }
      if (!existingSha) {
        skipped.push({ path, reason: 'no_sha' });
        continue;
      }

      const delRes = await client.repos.deleteFile({
        owner: params.owner,
        repo: params.repo,
        path,
        message: params.message,
        sha: existingSha,
        branch: params.branch,
      });
      const commitSha = delRes.data.commit?.sha ?? '';
      deleted.push({ path, sha: commitSha });
    }
    return { deleted, skipped };
  });
}

/* -------------------------------------------------------------------------- */
/*  Pull requests                                                             */
/* -------------------------------------------------------------------------- */

export interface OpenPRParams {
  owner: string;
  repo: string;
  head: string;
  base?: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export async function openPR(
  params: OpenPRParams,
): Promise<{ number: number; url: string }> {
  const client = await getClient();
  return wrap(async () => {
    let base = params.base;
    if (!base) {
      const meta = await client.repos.get({
        owner: params.owner,
        repo: params.repo,
      });
      base = meta.data.default_branch;
    }
    const res = await client.pulls.create({
      owner: params.owner,
      repo: params.repo,
      head: params.head,
      base,
      title: params.title,
      ...(params.body ? { body: params.body } : {}),
      ...(params.draft ? { draft: params.draft } : {}),
    });
    return { number: res.data.number, url: res.data.html_url };
  });
}

export interface GetPullRequestParams {
  owner: string;
  repo: string;
  number: number;
}

export async function getPullRequest(
  params: GetPullRequestParams,
): Promise<PullRequestSummary> {
  const client = await getClient();
  return wrap(async () => {
    const res = await client.pulls.get({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.number,
    });
    const data = res.data;
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      html_url: data.html_url,
      head_ref: data.head?.ref ?? '',
      base_ref: data.base?.ref ?? '',
      merged: Boolean(data.merged),
      draft: Boolean(data.draft),
      created_at: data.created_at,
      updated_at: data.updated_at,
      user_login: data.user?.login ?? null,
    };
  });
}

/**
 * Flip a PR from draft -> ready_for_review.
 *
 * The REST API doesn't expose this; only GraphQL does, via
 * `markPullRequestReadyForReview`. We resolve the PR's node_id via REST then
 * fire the mutation. Returns the new state for the caller's verification.
 */
export async function markPullRequestReadyForReview(params: {
  owner: string;
  repo: string;
  number: number;
}): Promise<{ ok: true; draft: false }> {
  const client = await getClient();
  return wrap(async () => {
    const meta = await client.pulls.get({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.number,
    });
    const nodeId = meta.data.node_id;
    if (!nodeId) {
      throw new Error('PR node_id missing — cannot mark ready_for_review');
    }
    const mutation = `mutation($id: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $id }) {
        pullRequest { isDraft }
      }
    }`;
    await client.graphql<{
      markPullRequestReadyForReview: { pullRequest: { isDraft: boolean } };
    }>(mutation, { id: nodeId });
    return { ok: true as const, draft: false as const };
  });
}

/**
 * Update the PR's head branch with the latest base. Equivalent to the
 * "Update branch" button on a PR page. Returns the new branch SHA on success.
 * GitHub auto-resolves what it can; truly conflicting changes still surface
 * on the next merge attempt.
 */
export async function updatePullRequestBranch(params: {
  owner: string;
  repo: string;
  number: number;
}): Promise<{ ok: true; message: string }> {
  const client = await getClient();
  return wrap(async () => {
    const res = await client.pulls.updateBranch({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.number,
    });
    return {
      ok: true as const,
      message: (res.data as { message?: string }).message ?? 'updated',
    };
  });
}

/**
 * Merge a PR. Defaults to squash because that's the repo convention Jack uses
 * everywhere (per global CLAUDE.md). `commitTitle`/`commitMessage` override the
 * default GitHub-generated values; leave undefined to let GitHub pick.
 */
export async function mergePullRequest(params: {
  owner: string;
  repo: string;
  number: number;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
}): Promise<{ merged: boolean; sha: string; message: string }> {
  const client = await getClient();
  return wrap(async () => {
    const res = await client.pulls.merge({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.number,
      merge_method: params.mergeMethod ?? 'squash',
      ...(params.commitTitle ? { commit_title: params.commitTitle } : {}),
      ...(params.commitMessage ? { commit_message: params.commitMessage } : {}),
    });
    return {
      merged: Boolean(res.data.merged),
      sha: res.data.sha ?? '',
      message: res.data.message ?? '',
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Issues                                                                    */
/* -------------------------------------------------------------------------- */

export interface ListIssuesParams {
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  per_page?: number;
}

export async function listIssues(
  params: ListIssuesParams,
): Promise<ListIssueSummary[]> {
  const client = await getClient();
  const state = params.state ?? 'open';
  const perPage = Math.min(Math.max(params.per_page ?? 30, 1), 100);
  return wrap(async () => {
    const res = await client.issues.listForRepo({
      owner: params.owner,
      repo: params.repo,
      state,
      per_page: perPage,
    });
    return res.data
      // GitHub's list-issues endpoint includes PRs by default; filter them out.
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        html_url: issue.html_url,
        user_login: issue.user?.login ?? null,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        labels: Array.isArray(issue.labels)
          ? issue.labels
              .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
              .filter((s) => s.length > 0)
          : [],
      }));
  });
}

export interface CreateIssueParams {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}

export async function createIssue(
  params: CreateIssueParams,
): Promise<{ number: number; html_url: string }> {
  const client = await getClient();
  return wrap(async () => {
    const res = await client.issues.create({
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      ...(params.body ? { body: params.body } : {}),
      ...(params.labels && params.labels.length > 0
        ? { labels: params.labels }
        : {}),
    });
    return { number: res.data.number, html_url: res.data.html_url };
  });
}

export interface UpdateIssueParams {
  owner: string;
  repo: string;
  number: number;
  /** When set, `'open'` reopens the issue and `'closed'` closes it. */
  state?: 'open' | 'closed';
  title?: string;
  body?: string;
}

/**
 * Patch an existing issue. Used by the two-way sync to mirror TaskPilot
 * task state back to GitHub (close on done, reopen on requeue, push
 * edits when the user changes title/description).
 *
 * Returns the canonical issue summary so callers can persist the latest
 * state on the linked task without a second round trip.
 */
export async function updateIssue(
  params: UpdateIssueParams,
): Promise<ListIssueSummary> {
  const client = await getClient();
  return wrap(async () => {
    const patch: {
      owner: string;
      repo: string;
      issue_number: number;
      state?: 'open' | 'closed';
      title?: string;
      body?: string;
    } = {
      owner: params.owner,
      repo: params.repo,
      issue_number: params.number,
    };
    if (params.state) patch.state = params.state;
    if (typeof params.title === 'string') patch.title = params.title;
    if (typeof params.body === 'string') patch.body = params.body;
    const res = await client.issues.update(patch);
    const issue = res.data;
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      html_url: issue.html_url,
      user_login: issue.user?.login ?? null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      labels: Array.isArray(issue.labels)
        ? issue.labels
            .map((l) =>
              typeof l === 'string' ? l : (l.name ?? ''),
            )
            .filter((s) => s.length > 0)
        : [],
    };
  });
}
