/**
 * Typed fetch wrapper for the local TaskPilot HTTP API.
 *
 * Reads the base URL from `window.taskpilot.getConfig()` when available
 * (Electron context) and falls back to `http://localhost:7847` otherwise.
 * The resolved base URL is cached after the first call.
 *
 * All helpers are generic over the response type. Path params should be
 * substituted by the caller (e.g. `api.get<...>('/api/tasks/' + id)`). Query
 * strings are built from a plain object via `buildQuery`.
 *
 * On a non-2xx response the helpers throw an `ApiError` that includes the
 * HTTP status and the parsed body (when JSON) or raw text.
 */

const DEFAULT_BASE_URL = 'http://localhost:7847';

let cachedBaseUrl: string | null = null;
let baseUrlPromise: Promise<string> | null = null;
let cachedToken: string | null = null;
let tokenPromise: Promise<string | null> | null = null;

interface MinimalBridge {
  getConfig?: () => Promise<{ api_port?: number }>;
  getApiToken?: () => Promise<
    string | { error?: { code?: string; message?: string } }
  >;
}

function readBridge(): MinimalBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { taskpilot?: MinimalBridge };
  return w.taskpilot;
}

/**
 * Resolve the per-install bearer token. Cached after the first call so the
 * IPC round-trip happens once per renderer session. Returns null when the
 * bridge is unavailable (e.g. unit tests, browser preview); callers should
 * treat that as "skip the header" — the test server is launched with
 * `TASKPILOT_DISABLE_AUTH=1`.
 */
export async function resolveApiToken(): Promise<string | null> {
  if (cachedToken !== null) return cachedToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async (): Promise<string | null> => {
    const bridge = readBridge();
    if (!bridge?.getApiToken) return null;
    try {
      const result = await bridge.getApiToken();
      if (typeof result === 'string' && result.length > 0) {
        cachedToken = result;
        return result;
      }
      return null;
    } catch {
      return null;
    }
  })();

  return tokenPromise;
}

/**
 * Synchronously read the cached bearer token. Returns null if resolution
 * hasn't happened yet. Used by SSE construction sites that build the URL
 * inside `useEffect` after the renderer has already booted the API
 * wrapper (which guarantees `resolveApiToken()` was called).
 */
export function getCachedApiToken(): string | null {
  return cachedToken;
}

/**
 * Prefetch the bearer token. Renderer-side bootstrap can call this once at
 * mount so subsequent requests don't pay the IPC round-trip.
 */
export async function prefetchApiToken(): Promise<void> {
  await resolveApiToken();
}

async function resolveBaseUrl(): Promise<string> {
  if (cachedBaseUrl) return cachedBaseUrl;
  if (baseUrlPromise) return baseUrlPromise;

  baseUrlPromise = (async (): Promise<string> => {
    const bridge = readBridge();
    if (bridge?.getConfig) {
      try {
        const config = await bridge.getConfig();
        const port = config?.api_port;
        if (typeof port === 'number' && Number.isFinite(port)) {
          cachedBaseUrl = `http://localhost:${port}`;
          return cachedBaseUrl;
        }
      } catch {
        // fall through to default
      }
    }
    cachedBaseUrl = DEFAULT_BASE_URL;
    return cachedBaseUrl;
  })();

  return baseUrlPromise;
}

/**
 * Server error envelope. The TaskPilot API returns errors as
 * `{ error: { code, message, details? } }`. Older responses (and some
 * test fixtures) may still surface a plain string under `body.error` —
 * we accept both shapes so the UI degrades gracefully during the API
 * transition. Use `getErrorCode()` / `getErrorMessage()` instead of
 * reading `body.error` directly.
 */
export interface ApiErrorEnvelope {
  error?:
    | string
    | {
        code?: string;
        message?: string;
        details?: unknown;
      };
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly body: ApiErrorEnvelope | string | null;

  constructor(
    message: string,
    status: number,
    body: ApiErrorEnvelope | string | null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Pull a `code` out of a parsed error body, handling both the new
 * `{ error: { code } }` envelope and the legacy `{ error: 'code' }` form.
 */
export function getErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const envelope = body as ApiErrorEnvelope;
  const inner = envelope.error;
  if (typeof inner === 'string') return inner;
  if (inner && typeof inner === 'object' && typeof inner.code === 'string') {
    return inner.code;
  }
  return null;
}

/**
 * Pull a human-readable message out of an error body. Falls back through
 * the new envelope → legacy string → null.
 */
export function getErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const envelope = body as ApiErrorEnvelope;
  const inner = envelope.error;
  if (typeof inner === 'string') return inner;
  if (
    inner &&
    typeof inner === 'object' &&
    typeof inner.message === 'string'
  ) {
    return inner.message;
  }
  return null;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs.length === 0 ? '' : `?${qs}`;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { query?: QueryParams; body?: unknown } = {},
): Promise<T> {
  const [baseUrl, token] = await Promise.all([
    resolveBaseUrl(),
    resolveApiToken(),
  ]);
  const url = `${baseUrl}${path}${buildQuery(options.query)}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const init: RequestInit = {
    method,
    headers,
  };

  if (options.body !== undefined) {
    init.headers = {
      ...headers,
      'Content-Type': 'application/json',
    };
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'network request failed';
    throw new ApiError(`network error: ${message}`, 0, null);
  }

  const body = await parseBody(response);

  if (!response.ok) {
    const message =
      getErrorMessage(body) ?? `${method} ${path} failed (${response.status})`;
    const safeBody =
      body === null || typeof body === 'string'
        ? body
        : typeof body === 'object'
          ? (body as ApiErrorEnvelope)
          : null;
    throw new ApiError(message, response.status, safeBody);
  }

  return body as T;
}

export const api = {
  get<T>(path: string, query?: QueryParams): Promise<T> {
    return request<T>('GET', path, { query });
  },
  post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
    return request<T>('POST', path, { body, query });
  },
  patch<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
    return request<T>('PATCH', path, { body, query });
  },
  delete<T>(path: string, query?: QueryParams): Promise<T> {
    return request<T>('DELETE', path, { query });
  },
} as const;

/**
 * Build a full URL for the API. When `path` targets the SSE endpoint, the
 * bearer token is appended as a `?token=` query parameter — EventSource
 * cannot send custom headers, so the middleware also accepts the token
 * via the query string for that single route. All other URLs returned
 * here carry no auth (callers should use the `api.*` helpers which
 * apply `Authorization: Bearer …` via the request wrapper).
 */
export async function apiUrl(path: string): Promise<string> {
  const baseUrl = await resolveBaseUrl();
  // For SSE we mint a short-lived (5min) SSE-only token via
  // POST /api/events/token instead of putting the long-lived bearer token
  // in the URL. The bearer leaks via browser history, server logs, and
  // proxy caches if used directly. If the mint fails (older server, etc.)
  // we fall back to the bearer with the same caveat as before so SSE
  // still works.
  if (path.startsWith('/api/events') && !path.startsWith('/api/events/token')) {
    let urlToken: string | null = null;
    try {
      const sseToken = await api.post<{ token: string }>('/api/events/token');
      if (sseToken && typeof sseToken.token === 'string') {
        urlToken = sseToken.token;
      }
    } catch {
      // Fall through to bearer if mint fails.
    }
    if (!urlToken) urlToken = await resolveApiToken();
    if (!urlToken) return `${baseUrl}${path}`;
    const sep = path.includes('?') ? '&' : '?';
    return `${baseUrl}${path}${sep}token=${encodeURIComponent(urlToken)}`;
  }
  return `${baseUrl}${path}`;
}

/**
 * Synchronously read the cached base URL. Returns the default if resolution
 * has not yet happened. Useful for EventSource construction in effects after
 * the app has already booted (which guarantees `getConfig` was called).
 */
export function getCachedBaseUrl(): string {
  return cachedBaseUrl ?? DEFAULT_BASE_URL;
}
