/**
 * `/api/github/...` routes.
 *
 * Lifecycle endpoints (connect / disconnect / status) plus the repo
 * operations used by Claude when it acts on a repo: list repos, create
 * branches, commit files, open PRs, list / create issues.
 *
 * The PAT is never returned in any response or written to a log line. The
 * routes deliberately only return the public `user` shape from `getStatus()`
 * / `connect()` and forward Octokit results through their summary-shape
 * conversions in `operations.ts`. Errors are mapped to canonical
 * `{ error: { code, message } }` envelopes by the parent error handler.
 *
 * Mounted by `server/index.ts` (Agent X owns the mount line, but the import
 * is best-effort so a partial build doesn't take the whole server down):
 *
 *     import { githubRouter } from './routes/github';
 *     app.use('/api/github', githubRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  GitHubApiError,
  GitHubAuthError,
  GitHubNotConfiguredError,
  GitHubRateLimitError,
  connect as githubConnect,
  disconnect as githubDisconnect,
  getStatus as githubGetStatus,
} from '@/main/github';
import {
  commitFiles,
  createBranch,
  createIssue,
  createRepo,
  deleteFiles,
  getContents,
  getPullRequest,
  getRepo,
  getTree,
  listIssues,
  listRepos,
  markPullRequestReadyForReview,
  mergePullRequest,
  openPR,
  repoExists,
  updatePullRequestBranch,
  updateRepo,
} from '@/main/github/operations';
import { resolveTaskRepo } from '@/main/github/resolve';
import { getTask } from '@/main/db/repositories/tasks';
import { taskIdSchema } from '@/shared/io-schemas';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

// PATs themselves are short — fine-grained ones max out around 250 chars.
// Cap generously but bound the upload size so we never accept a huge string
// that could DoS the parser.
const connectSchema = z.object({
  token: z.string().min(8).max(2_048),
});

const ownerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, {
    message: 'Invalid owner/repo segment',
  });

const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  // Branch names disallow ASCII control chars, space, ~, ^, :, ?, *, [, \, ..
  // We keep the validation tight but permissive enough for `agent/<id>` style
  // names which include slashes and dashes.
  .regex(/^[^\s~^:?*\[\\\x00-\x1f]+$/, { message: 'Invalid branch name' });

const branchesSchema = z.object({
  owner: ownerNameSchema,
  repo: ownerNameSchema,
  branch: branchNameSchema,
  fromRef: branchNameSchema.optional(),
});

const commitsSchema = z.object({
  owner: ownerNameSchema,
  repo: ownerNameSchema,
  branch: branchNameSchema,
  message: z.string().min(1).max(4_096),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(1_024)
          // No leading slash, no `..` segments — defense-in-depth on top of
          // GitHub's own validation.
          .refine((p) => !p.startsWith('/'), 'path must be repo-relative')
          .refine(
            (p) => !p.split('/').some((seg) => seg === '..'),
            'path may not contain ..',
          ),
        content: z.string().max(1_000_000),
      }),
    )
    .min(1)
    .max(50),
});

const deletesSchema = z.object({
  owner: ownerNameSchema,
  repo: ownerNameSchema,
  branch: branchNameSchema,
  message: z.string().min(1).max(4_096),
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(1_024)
        .refine((p) => !p.startsWith('/'), 'path must be repo-relative')
        .refine(
          (p) => !p.split('/').some((seg) => seg === '..'),
          'path may not contain ..',
        ),
    )
    .min(1)
    .max(50),
});

const pullsSchema = z.object({
  owner: ownerNameSchema,
  repo: ownerNameSchema,
  head: branchNameSchema,
  base: branchNameSchema.optional(),
  title: z.string().min(1).max(256),
  body: z.string().max(65_536).optional(),
  draft: z.boolean().optional(),
});

const issuesQuerySchema = z.object({
  owner: ownerNameSchema,
  repo: ownerNameSchema,
  state: z.enum(['open', 'closed', 'all']).optional(),
});

const issuesCreateSchema = z.object({
  owner: ownerNameSchema,
  repo: ownerNameSchema,
  title: z.string().min(1).max(256),
  body: z.string().max(65_536).optional(),
  labels: z.array(z.string().min(1).max(64)).max(20).optional(),
});

const createRepoSchema = z.object({
  // GitHub repo names: ASCII alnum + `.`, `-`, `_`. Max 100. No leading dot.
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
      message: 'Repo name must start with alphanumeric and contain only [A-Za-z0-9._-]',
    }),
  owner: ownerNameSchema.optional(),
  description: z.string().max(350).optional(),
  private: z.boolean().optional(),
  auto_init: z.boolean().optional(),
  license_template: z.string().min(1).max(64).optional(),
  gitignore_template: z.string().min(1).max(64).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Repo cache                                                                */
/* -------------------------------------------------------------------------- */

interface RepoCache {
  repos: Awaited<ReturnType<typeof listRepos>>;
  fetchedAt: number;
}

const REPO_CACHE_TTL_MS = 5 * 60 * 1_000;
let repoCache: RepoCache | null = null;

function invalidateRepoCache(): void {
  repoCache = null;
}

/* -------------------------------------------------------------------------- */
/*  Error translation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Convert any error from the github module into an `ApiHttpError`. The route
 * handlers wrap their operations and rethrow into this so the central error
 * middleware sees a typed status + code.
 */
function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof GitHubNotConfiguredError) {
    return new ApiHttpError(
      401,
      'github_not_configured',
      'GitHub is not connected. Open Settings → Integrations to connect.',
    );
  }
  if (err instanceof GitHubAuthError) {
    return new ApiHttpError(
      401,
      'github_auth',
      err.message || 'GitHub rejected the request.',
    );
  }
  if (err instanceof GitHubRateLimitError) {
    return new ApiHttpError(
      429,
      'github_rate_limit',
      err.message || 'GitHub rate limit exceeded.',
      err.resetAt !== null ? { reset_at: err.resetAt } : undefined,
    );
  }
  if (err instanceof GitHubApiError) {
    const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
    return new ApiHttpError(
      status,
      'github_api_error',
      err.message || 'GitHub request failed.',
    );
  }
  return new ApiHttpError(
    500,
    'github_unknown',
    err instanceof Error ? err.message : 'Unknown GitHub error',
  );
}

/**
 * Route-handler wrapper: forwards any error through `toApiError()` so the
 * canonical error envelope wins.
 */
function safe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw toApiError(err);
  });
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function githubRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const status = await safe(() => githubGetStatus());
      res.json(status);
    }),
  );

  router.post(
    '/connect',
    validateBody(connectSchema),
    asyncHandler(async (req, res) => {
      const { token } = req.body as z.infer<typeof connectSchema>;
      const result = await safe(() => githubConnect(token));
      // Bust the repo cache — the connecting user's repos are different from
      // anything cached from a prior session.
      invalidateRepoCache();
      res.json({ connected: true, user: result.user });
    }),
  );

  router.post(
    '/disconnect',
    asyncHandler(async (_req, res) => {
      await safe(() => githubDisconnect());
      invalidateRepoCache();
      res.json({ ok: true });
    }),
  );

  router.get(
    '/repos',
    asyncHandler(async (req, res) => {
      // ?all=1 → walk every page until empty (max 10 pages = 1000 repos as
      // a guardrail). Otherwise honor ?page=N (default 1) without caching
      // the paginated requests — only page 1 default fills the cache.
      const all = req.query.all === '1' || req.query.all === 'true';
      const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
      const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

      if (all) {
        const accumulated: Awaited<ReturnType<typeof listRepos>> = [];
        for (let p = 1; p <= 10; p++) {
          const chunk = await safe(() => listRepos({ per_page: 100, page: p }));
          if (chunk.length === 0) break;
          accumulated.push(...chunk);
          if (chunk.length < 100) break;
        }
        res.json({ repos: accumulated, cached: false, pages_walked: Math.ceil(accumulated.length / 100) });
        return;
      }

      if (page > 1) {
        const repos = await safe(() => listRepos({ per_page: 100, page }));
        res.json({ repos, cached: false, page });
        return;
      }

      const now = Date.now();
      if (repoCache && now - repoCache.fetchedAt < REPO_CACHE_TTL_MS) {
        res.json({ repos: repoCache.repos, cached: true });
        return;
      }
      const repos = await safe(() => listRepos({ per_page: 100, page: 1 }));
      repoCache = { repos, fetchedAt: now };
      res.json({ repos, cached: false });
    }),
  );

  router.get(
    '/repos/:owner/:repo',
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      if (!owner.success || !repo.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid owner or repo');
      }
      const result = await safe(() => getRepo(owner.data, repo.data));
      res.json({ repo: result });
    }),
  );

  router.get(
    '/repos/:owner/:repo/exists',
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      if (!owner.success || !repo.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid owner or repo');
      }
      const exists = await safe(() => repoExists(owner.data, repo.data));
      res.json({ exists });
    }),
  );

  // Read a file or directory listing at a path (read-only).
  router.get(
    '/repos/:owner/:repo/contents',
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      if (!owner.success || !repo.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid owner or repo');
      }
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
      const contents = await safe(() =>
        getContents(owner.data, repo.data, path, ref),
      );
      res.json(contents);
    }),
  );

  // Recursively list every path in a repo (read-only).
  router.get(
    '/repos/:owner/:repo/tree',
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      if (!owner.success || !repo.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid owner or repo');
      }
      const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
      const tree = await safe(() => getTree(owner.data, repo.data, ref));
      res.json(tree);
    }),
  );

  router.post(
    '/repos',
    validateBody(createRepoSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createRepoSchema>;
      const repo = await safe(() => createRepo(body));
      // Bust the list cache so the new repo shows up immediately on the next
      // /api/github/repos call.
      invalidateRepoCache();
      res.status(201).json({ repo });
    }),
  );

  // PATCH /repos/:owner/:repo — partial update of repo metadata.
  router.patch(
    '/repos/:owner/:repo',
    validateBody(
      z.object({
        description: z.string().max(350).optional(),
        homepage: z.string().max(2_048).optional(),
        private: z.boolean().optional(),
        default_branch: z.string().min(1).max(255).optional(),
      }),
    ),
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      if (!owner.success || !repo.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid owner or repo');
      }
      const body = req.body as {
        description?: string;
        homepage?: string;
        private?: boolean;
        default_branch?: string;
      };
      const result = await safe(() =>
        updateRepo({ owner: owner.data, repo: repo.data, ...body }),
      );
      invalidateRepoCache();
      res.json({ repo: result });
    }),
  );

  router.get(
    '/resolve/:taskId',
    asyncHandler(async (req, res) => {
      const parsed = taskIdSchema.safeParse(req.params.taskId);
      if (!parsed.success) {
        throw new ApiHttpError(400, 'invalid_task_id', 'Invalid task id');
      }
      const task = getTask(parsed.data);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${parsed.data} not found`);
      }
      const resolution = resolveTaskRepo(task);
      res.json({ resolution });
    }),
  );

  router.post(
    '/branches',
    validateBody(branchesSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof branchesSchema>;
      const result = await safe(() =>
        createBranch(body.owner, body.repo, body.branch, body.fromRef),
      );
      res.json({ ok: true, ref: result.ref, sha: result.sha });
    }),
  );

  router.post(
    '/commits',
    validateBody(commitsSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof commitsSchema>;
      const result = await safe(() =>
        commitFiles({
          owner: body.owner,
          repo: body.repo,
          branch: body.branch,
          message: body.message,
          files: body.files,
        }),
      );
      res.json({ ok: true, sha: result.sha, commits: result.commits });
    }),
  );

  router.post(
    '/deletes',
    validateBody(deletesSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof deletesSchema>;
      const result = await safe(() =>
        deleteFiles({
          owner: body.owner,
          repo: body.repo,
          branch: body.branch,
          message: body.message,
          paths: body.paths,
        }),
      );
      res.json({ ok: true, deleted: result.deleted, skipped: result.skipped });
    }),
  );

  router.post(
    '/pulls',
    validateBody(pullsSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof pullsSchema>;
      const result = await safe(() =>
        openPR({
          owner: body.owner,
          repo: body.repo,
          head: body.head,
          ...(body.base !== undefined ? { base: body.base } : {}),
          title: body.title,
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.draft !== undefined ? { draft: body.draft } : {}),
        }),
      );
      res.json({ ok: true, number: result.number, url: result.url });
    }),
  );

  router.get(
    '/pulls/:owner/:repo/:number',
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      const numberRaw = Number.parseInt(req.params.number ?? '', 10);
      if (!owner.success || !repo.success || !Number.isFinite(numberRaw)) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid PR identifier');
      }
      const result = await safe(() =>
        getPullRequest({ owner: owner.data, repo: repo.data, number: numberRaw }),
      );
      res.json({ pull: result });
    }),
  );

  // PR.update-branch: bring base's latest into the PR head as a merge commit.
  // GitHub auto-resolves what it can; real conflicts still surface at merge.
  router.post(
    '/pulls/:owner/:repo/:number/update-branch',
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      const numberRaw = Number.parseInt(String(req.params.number ?? ''), 10);
      if (!owner.success || !repo.success || !Number.isFinite(numberRaw)) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid PR identifier');
      }
      const result = await safe(() =>
        updatePullRequestBranch({
          owner: owner.data,
          repo: repo.data,
          number: numberRaw,
        }),
      );
      res.json(result);
    }),
  );

  // Flip draft → ready_for_review. POST with empty body.
  router.post(
    '/pulls/:owner/:repo/:number/ready',
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      const numberRaw = Number.parseInt(req.params.number ?? '', 10);
      if (!owner.success || !repo.success || !Number.isFinite(numberRaw)) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid PR identifier');
      }
      const result = await safe(() =>
        markPullRequestReadyForReview({
          owner: owner.data,
          repo: repo.data,
          number: numberRaw,
        }),
      );
      res.json(result);
    }),
  );

  // Merge a PR. Body: { method?: 'merge'|'squash'|'rebase', title?, message? }
  router.put(
    '/pulls/:owner/:repo/:number/merge',
    validateBody(
      z.object({
        method: z.enum(['merge', 'squash', 'rebase']).optional(),
        title: z.string().min(1).max(256).optional(),
        message: z.string().min(1).max(65_536).optional(),
      }),
    ),
    asyncHandler(async (req, res) => {
      const owner = ownerNameSchema.safeParse(req.params.owner);
      const repo = ownerNameSchema.safeParse(req.params.repo);
      const numberRaw = Number.parseInt(String(req.params.number ?? ''), 10);
      if (!owner.success || !repo.success || !Number.isFinite(numberRaw)) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid PR identifier');
      }
      const body = req.body as {
        method?: 'merge' | 'squash' | 'rebase';
        title?: string;
        message?: string;
      };
      const result = await safe(() =>
        mergePullRequest({
          owner: owner.data,
          repo: repo.data,
          number: numberRaw,
          ...(body.method ? { mergeMethod: body.method } : {}),
          ...(body.title ? { commitTitle: body.title } : {}),
          ...(body.message ? { commitMessage: body.message } : {}),
        }),
      );
      res.json(result);
    }),
  );

  router.get(
    '/issues',
    asyncHandler(async (req, res) => {
      const parsed = issuesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiHttpError(400, 'bad_request', 'Invalid issues query');
      }
      const result = await safe(() =>
        listIssues({
          owner: parsed.data.owner,
          repo: parsed.data.repo,
          ...(parsed.data.state !== undefined
            ? { state: parsed.data.state }
            : {}),
        }),
      );
      res.json({ issues: result });
    }),
  );

  router.post(
    '/issues',
    validateBody(issuesCreateSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof issuesCreateSchema>;
      const result = await safe(() =>
        createIssue({
          owner: body.owner,
          repo: body.repo,
          title: body.title,
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.labels !== undefined ? { labels: body.labels } : {}),
        }),
      );
      res.json({ ok: true, number: result.number, html_url: result.html_url });
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Test-only helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Exported for tests so the repo-cache can be reset between assertions.
 */
export const __testing = {
  resetRepoCache: invalidateRepoCache,
};
