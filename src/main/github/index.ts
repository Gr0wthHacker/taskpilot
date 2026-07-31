/**
 * Public entry point for the GitHub integration.
 *
 * Exposes the high-level lifecycle (`connect`, `getStatus`, `disconnect`,
 * `getClient`) plus the canonical error taxonomy that the HTTP routes and
 * operations modules translate into API responses.
 *
 * The PAT is never returned to callers — `connect()` validates it by hitting
 * `GET /user` and persists it via the storage module; `getStatus()` exposes
 * the `user` block (login + name + avatar) only. `getClient()` returns an
 * Octokit instance pre-authenticated with the on-disk token; the rest of the
 * codebase should call into `operations.ts` rather than reach for raw Octokit
 * methods.
 */

import { Octokit } from '@octokit/rest';

import { deletePAT, hasPAT, loadPAT, savePAT } from './storage';

/* -------------------------------------------------------------------------- */
/*  Error taxonomy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when GitHub operations are invoked without a stored PAT. The HTTP
 * layer translates this into a 401 with code `GITHUB_NOT_CONFIGURED` and a
 * "Connect from Settings → Integrations" message.
 */
export class GitHubNotConfiguredError extends Error {
  readonly code = 'GITHUB_NOT_CONFIGURED';
  constructor(message = 'GitHub PAT is not configured.') {
    super(message);
    this.name = 'GitHubNotConfiguredError';
  }
}

/**
 * Thrown when GitHub rejects credentials (401/403 in the auth sense). The
 * stored PAT is invalid or has lost the required scopes.
 */
export class GitHubAuthError extends Error {
  readonly code = 'GITHUB_AUTH';
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'GitHubAuthError';
    this.status = status;
  }
}

/**
 * Thrown when GitHub returns a 403 with a rate-limit signal in the headers.
 * Pulled into its own class so callers can present a different UX (try again
 * at HH:MM) instead of treating it as an auth failure.
 */
export class GitHubRateLimitError extends Error {
  readonly code = 'GITHUB_RATE_LIMIT';
  /** Unix epoch seconds when the rate limit resets. */
  readonly resetAt: number | null;
  constructor(message: string, resetAt: number | null = null) {
    super(message);
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

/**
 * Generic GitHub API failure (4xx/5xx other than auth / rate limit).
 * Carries the upstream status so the HTTP layer can mirror it.
 */
export class GitHubApiError extends Error {
  readonly code = 'GITHUB_API_ERROR';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/*  Octokit error helpers                                                     */
/* -------------------------------------------------------------------------- */

interface OctokitErrorShape {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

/**
 * Translate any error from `@octokit/rest` into our typed taxonomy. Callers
 * in `operations.ts` wrap their API calls in try/catch and forward into this.
 */
export function classifyOctokitError(err: unknown): Error {
  if (
    err instanceof GitHubAuthError ||
    err instanceof GitHubRateLimitError ||
    err instanceof GitHubApiError ||
    err instanceof GitHubNotConfiguredError
  ) {
    return err;
  }

  const e = err as OctokitErrorShape;
  const status = typeof e?.status === 'number' ? e.status : 0;
  // Strip any token from error messages defensively. Octokit doesn't echo it
  // by default but message text varies upstream.
  const safeMessage = sanitizeErrorMessage(
    typeof e?.message === 'string' ? e.message : 'GitHub request failed',
  );

  if (status === 401) {
    return new GitHubAuthError(safeMessage, 401);
  }
  if (status === 403) {
    // GitHub uses 403 for both forbidden and rate limit. Sniff the headers.
    const headers = e.response?.headers ?? {};
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    const remainingNum =
      typeof remaining === 'string' ? Number.parseInt(remaining, 10) : NaN;
    if (Number.isFinite(remainingNum) && remainingNum === 0) {
      const resetNum =
        typeof reset === 'string' ? Number.parseInt(reset, 10) : NaN;
      return new GitHubRateLimitError(
        safeMessage,
        Number.isFinite(resetNum) ? resetNum : null,
      );
    }
    return new GitHubAuthError(safeMessage, 403);
  }
  if (status >= 400) {
    return new GitHubApiError(safeMessage, status);
  }
  return new GitHubApiError(safeMessage, status || 500);
}

/**
 * Best-effort scrub of any GitHub-shaped token from a string. The first
 * regex covers fine-grained PATs (`github_pat_*`) and the classic format
 * (`ghp_*`, `gho_*`, etc.). The second catches any 36+ char hex string
 * that might be a token. We err on the side of over-redacting because the
 * cost of leaking is high and the message text isn't load-bearing.
 */
function sanitizeErrorMessage(input: string): string {
  return input
    .replace(/(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '<redacted>')
    .replace(/\b[A-Fa-f0-9]{36,}\b/g, '<redacted>');
}

/* -------------------------------------------------------------------------- */
/*  Octokit client cache                                                      */
/* -------------------------------------------------------------------------- */

let cachedClient: Octokit | null = null;
let cachedToken: string | null = null;

function resetClient(): void {
  cachedClient = null;
  cachedToken = null;
}

/**
 * Lazily construct an Octokit instance using the on-disk PAT. The client is
 * cached for the lifetime of the process (until disconnect or token change).
 * Callers MUST handle `GitHubNotConfiguredError` — there is no implicit
 * "anonymous" mode.
 */
export async function getClient(): Promise<Octokit> {
  const token = await loadPAT();
  if (!token) {
    resetClient();
    throw new GitHubNotConfiguredError();
  }
  if (cachedClient && cachedToken === token) {
    return cachedClient;
  }
  cachedClient = new Octokit({
    auth: token,
    userAgent: 'TaskPilot',
  });
  cachedToken = token;
  return cachedClient;
}

/* -------------------------------------------------------------------------- */
/*  User shape exposed via status / connect                                   */
/* -------------------------------------------------------------------------- */

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GitHubStatus {
  connected: boolean;
  user?: GitHubUser;
}

interface RawAuthenticatedUser {
  login?: string;
  name?: string | null;
  avatar_url?: string;
}

function shapeUser(raw: RawAuthenticatedUser): GitHubUser {
  const login = typeof raw.login === 'string' ? raw.login : '';
  const avatar = typeof raw.avatar_url === 'string' ? raw.avatar_url : '';
  const name = typeof raw.name === 'string' ? raw.name : null;
  return { login, name, avatar_url: avatar };
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate the supplied PAT by hitting `GET /user`, then persist it.
 *
 * On success: returns the public user info, caches the client.
 * On a 401/403 from GitHub: throws `GitHubAuthError` (HTTP layer 401s).
 * Never returns or logs the raw token.
 */
export async function connect(token: string): Promise<{ user: GitHubUser }> {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new GitHubAuthError('PAT is empty.', 400);
  }
  const trimmed = token.trim();
  // Probe with a one-shot Octokit instance so we don't clobber the cache
  // until we know the token works.
  const probe = new Octokit({ auth: trimmed, userAgent: 'TaskPilot' });
  let user: GitHubUser;
  try {
    const res = await probe.users.getAuthenticated();
    user = shapeUser(res.data as RawAuthenticatedUser);
  } catch (err) {
    throw classifyOctokitError(err);
  }

  await savePAT(trimmed);
  // Invalidate any previously-cached client so the next getClient() picks up
  // the new token.
  resetClient();
  return { user };
}

/**
 * Synchronous-ish status probe.
 *
 * Returns `{ connected: false }` if no PAT is stored. If one exists, we hit
 * `GET /user` to confirm it still works — a 401 means it's been revoked, so
 * `connected: false` is returned but the file is left on disk (the user can
 * fix it via Settings without losing the file as a hint of "you used to be
 * connected"). On any other failure we treat it as connected-but-degraded
 * to avoid surfacing transient network errors as a disconnect.
 */
export async function getStatus(): Promise<GitHubStatus> {
  const present = await hasPAT();
  if (!present) {
    return { connected: false };
  }
  try {
    const client = await getClient();
    const res = await client.users.getAuthenticated();
    return { connected: true, user: shapeUser(res.data as RawAuthenticatedUser) };
  } catch (err) {
    const classified = classifyOctokitError(err);
    if (classified instanceof GitHubAuthError) {
      return { connected: false };
    }
    // Network blip / 5xx — say we're still connected but skip the user block.
    return { connected: true };
  }
}

/**
 * Drop the persisted PAT and tear down the cached Octokit client.
 */
export async function disconnect(): Promise<void> {
  resetClient();
  await deletePAT();
}

/* -------------------------------------------------------------------------- */
/*  Test-only escape hatch                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Test-only: reset the cached client. Not part of the public API but useful
 * to mocks that swap the on-disk token between assertions.
 */
export const __internals = {
  reset(): void {
    resetClient();
  },
};
