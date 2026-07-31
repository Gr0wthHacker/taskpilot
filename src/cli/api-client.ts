/**
 * Tiny fetch-based HTTP client for the TaskPilot local API.
 *
 * Resolves the base URL in this order:
 *   1. Explicit `apiBase` argument (passed by command after reading the global
 *      `--api` flag).
 *   2. `TASKPILOT_API` env var.
 *   3. `http://localhost:7847` (default per BUILD_CONTRACTS).
 *
 * Throws `ApiError` on non-2xx responses with a parsed body when possible.
 * Surfaces a friendly hint when the local server is unreachable.
 */

import { readApiTokenSync } from '@/main/api-auth';
import { API_PORT } from '@/shared/constants';

const DEFAULT_API_BASE = `http://localhost:${API_PORT}`;

let configuredBase: string | null = null;

/**
 * Per-process cache for the bearer token. Read once from
 * `~/.taskpilot/api-token` on first use. The CLI is short-lived so a
 * sync-on-first-use read is fine; we never block startup with it.
 *
 * Returns null when the token file is missing — the CLI surfaces a
 * friendlier message in that case ("Open the desktop app at least once …").
 */
let cachedToken: string | null | undefined;
function getCachedToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = readApiTokenSync();
  return cachedToken;
}

/**
 * Persist the API base URL parsed from the global `--api` flag so command
 * modules don't need to thread it through every call.
 */
export function setApiBase(base: string | undefined): void {
  configuredBase = base ?? null;
}

export function getApiBase(): string {
  if (configuredBase && configuredBase.length > 0) return stripTrailingSlash(configuredBase);
  const fromEnv = process.env.TASKPILOT_API;
  if (fromEnv && fromEnv.length > 0) return stripTrailingSlash(fromEnv);
  return DEFAULT_API_BASE;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Server error envelope. The API returns errors as
 * `{ error: { code, message, details? } }`. Some older endpoints still
 * return a plain string under `error` — we accept both shapes and expose
 * `.code` / `.message` getters that paper over the difference so command
 * modules can keep checking `err.body?.code === 'needs_review'` etc.
 */
export interface ApiErrorInner {
  code?: string;
  message?: string;
  details?: unknown;
}

export interface ApiErrorBody {
  /** Convenience: parsed `code`, regardless of envelope shape. */
  code?: string;
  /** Convenience: parsed `message`, regardless of envelope shape. */
  message?: string;
  /** Convenience: parsed `details`, regardless of envelope shape. */
  details?: unknown;
  /** Raw envelope `error` field — string (legacy) or object (current). */
  error?: string | ApiErrorInner;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, message: string, body: ApiErrorBody | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeErrorBody(parsed: unknown): ApiErrorBody | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as { error?: unknown; code?: unknown; message?: unknown; details?: unknown };
  const inner = raw.error;
  // Legacy shape: { error: 'code_string' }
  if (typeof inner === 'string') {
    return {
      error: inner,
      code: inner,
      ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
      ...(raw.details !== undefined ? { details: raw.details } : {}),
    };
  }
  // New shape: { error: { code, message, details? } }
  if (inner && typeof inner === 'object') {
    const obj = inner as ApiErrorInner;
    return {
      error: obj,
      ...(typeof obj.code === 'string' ? { code: obj.code } : {}),
      ...(typeof obj.message === 'string' ? { message: obj.message } : {}),
      ...(obj.details !== undefined ? { details: obj.details } : {}),
    };
  }
  // Bare body — only top-level code/message/details (e.g. 500 plain text path).
  return {
    ...(typeof raw.code === 'string' ? { code: raw.code as string } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message as string } : {}),
    ...(raw.details !== undefined ? { details: raw.details } : {}),
  };
}

export class ApiConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConnectionError';
  }
}

function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const base = getApiBase();
  const rel = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(base + rel);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {},
): Promise<T> {
  const url = buildUrl(path, options.query);
  const token = getCachedToken();
  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Node's undici surfaces refused/unreachable as `ECONNREFUSED`, `fetch failed`, etc.
    throw new ApiConnectionError(
      [
        `Cannot reach TaskPilot API at ${getApiBase()}.`,
        '',
        'Start the local API with one of:',
        '  npm run dev      # full Electron desktop app',
        '  npm run server   # headless API server (Claude Code / CI / scripts)',
        '',
        'Override the URL with --api <base> or the TASKPILOT_API env var.',
        `(Underlying error: ${msg})`,
      ].join('\n'),
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const body = normalizeErrorBody(parsed);
    // Friendlier guidance when the local API rejects us with 401 and the
    // token file isn't on disk yet. Most often this means the user has
    // only ever run the CLI and never opened the desktop app — which is
    // when the per-install token gets generated.
    if (response.status === 401 && getCachedToken() === null) {
      throw new ApiError(
        401,
        [
          'TaskPilot API token not found.',
          '',
          `Open the desktop app at least once to generate it (it writes to`,
          `~/.taskpilot/api-token), then retry. If you've already opened`,
          `the app, check that the file exists and that this CLI run is`,
          `using the same home directory.`,
        ].join('\n'),
        body,
      );
    }
    const messageFromBody =
      body?.message ??
      (typeof body?.error === 'string' ? body.error : undefined) ??
      body?.code;
    const message =
      messageFromBody ??
      (typeof parsed === 'string' && parsed.length > 0
        ? parsed
        : `HTTP ${response.status}`);
    throw new ApiError(response.status, message, body);
  }

  return parsed as T;
}

export function apiGet<T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  return request<T>('GET', path, { query });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, { body });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, { body });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}
