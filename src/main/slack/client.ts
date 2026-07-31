/**
 * Thin wrapper around `@slack/web-api`'s WebClient.
 *
 * Exists so the rest of the codebase doesn't need to know which Slack SDK
 * we use — and so tests can `vi.mock('@slack/web-api')` once and have
 * every consumer route through the mock.
 *
 * The bot token is loaded lazily via `slack/storage` and the WebClient is
 * cached for the life of the process (cleared on disconnect or token
 * rotation).
 */

import { WebClient } from '@slack/web-api';

import { loadToken } from './storage';

/* -------------------------------------------------------------------------- */
/*  Error taxonomy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when Slack operations are invoked without a stored bot token.
 * The HTTP layer translates this into a 401 with code
 * `slack_not_configured` and a "Connect from Settings → Integrations"
 * message.
 */
export class SlackNotConfiguredError extends Error {
  readonly code = 'SLACK_NOT_CONFIGURED';
  constructor(message = 'Slack bot token is not configured.') {
    super(message);
    this.name = 'SlackNotConfiguredError';
  }
}

/**
 * Thrown when Slack rejects credentials (`invalid_auth`, `not_authed`,
 * `token_revoked`). The stored bot token is invalid or has been revoked.
 */
export class SlackAuthError extends Error {
  readonly code = 'SLACK_AUTH';
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'SlackAuthError';
    this.status = status;
  }
}

/**
 * Thrown when Slack returns a `ratelimited` response or 429. Slack
 * surfaces a `Retry-After` seconds value that we expose so the UI can
 * present a meaningful retry hint.
 */
export class SlackRateLimitError extends Error {
  readonly code = 'SLACK_RATE_LIMIT';
  readonly retryAfter: number | null;
  constructor(message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'SlackRateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Generic Slack API failure for everything that isn't auth / rate limit.
 */
export class SlackApiError extends Error {
  readonly code = 'SLACK_API_ERROR';
  readonly status: number;
  readonly slackError: string | null;
  constructor(message: string, status = 502, slackError: string | null = null) {
    super(message);
    this.name = 'SlackApiError';
    this.status = status;
    this.slackError = slackError;
  }
}

/* -------------------------------------------------------------------------- */
/*  Error sanitization                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort scrub of any Slack-shaped token (`xoxb-…`, `xoxp-…`,
 * `xapp-…`, `xoxe.…`) from a string. We err on the side of over-redacting
 * because the cost of leaking is high.
 */
function sanitizeErrorMessage(input: string): string {
  return input.replace(/x(?:ox[bpasor]|app|oxe)-[A-Za-z0-9-]+/g, '<redacted>');
}

interface SlackErrorShape {
  code?: string;
  data?: {
    error?: string;
    response_metadata?: { messages?: string[] };
  };
  message?: string;
  status?: number;
  /** `@slack/web-api`'s WebAPIPlatformError shape carries `retryAfter` here. */
  retryAfter?: number;
}

/**
 * Translate any error from `@slack/web-api` into our typed taxonomy.
 * Callers wrap their API calls in try/catch and forward into this.
 */
export function classifySlackError(err: unknown): Error {
  if (
    err instanceof SlackAuthError ||
    err instanceof SlackRateLimitError ||
    err instanceof SlackApiError ||
    err instanceof SlackNotConfiguredError
  ) {
    return err;
  }

  const e = err as SlackErrorShape;
  const slackError = e?.data?.error ?? null;
  const safeMessage = sanitizeErrorMessage(
    typeof e?.message === 'string' ? e.message : 'Slack request failed',
  );

  // Rate-limited errors from @slack/web-api set `code: 'slack_webapi_rate_limited_error'`
  // and surface `retryAfter` directly. Sniff both.
  if (e?.code === 'slack_webapi_rate_limited_error' || e?.status === 429) {
    const retry =
      typeof e.retryAfter === 'number' && Number.isFinite(e.retryAfter)
        ? e.retryAfter
        : null;
    return new SlackRateLimitError(safeMessage, retry);
  }

  // Auth-class Slack error codes. These come back as 200 OK with
  // `ok: false, error: '...'` — `@slack/web-api` throws on those, putting
  // the code in `err.data.error`.
  if (
    slackError === 'invalid_auth' ||
    slackError === 'not_authed' ||
    slackError === 'token_revoked' ||
    slackError === 'account_inactive' ||
    slackError === 'token_expired'
  ) {
    return new SlackAuthError(safeMessage, 401);
  }

  // HTTP-level auth failures.
  if (e?.status === 401 || e?.status === 403) {
    return new SlackAuthError(safeMessage, e.status);
  }

  return new SlackApiError(
    safeMessage,
    typeof e?.status === 'number' && e.status >= 400 ? e.status : 502,
    slackError,
  );
}

/* -------------------------------------------------------------------------- */
/*  WebClient cache                                                           */
/* -------------------------------------------------------------------------- */

let cachedClient: WebClient | null = null;
let cachedToken: string | null = null;

export function resetClient(): void {
  cachedClient = null;
  cachedToken = null;
}

/**
 * Lazily construct a WebClient using the on-disk token. The client is
 * cached for the life of the process (until disconnect or token change).
 * Callers MUST handle `SlackNotConfiguredError` — there is no implicit
 * "anonymous" mode.
 */
export async function getClient(): Promise<WebClient> {
  const token = await loadToken();
  if (!token) {
    resetClient();
    throw new SlackNotConfiguredError();
  }
  if (cachedClient && cachedToken === token) {
    return cachedClient;
  }
  cachedClient = new WebClient(token);
  cachedToken = token;
  return cachedClient;
}

/**
 * Wrap a WebClient call so any thrown error flows through our
 * classification pipeline. Keeps each operation a one-liner instead of
 * try/catch on every line.
 */
export async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifySlackError(err);
  }
}
