/**
 * Anonymous telemetry collector.
 *
 * Always-on local logging: every `record()` call appends a sanitized event
 * line to `~/.taskpilot/logs/telemetry.jsonl`. Upload only happens when both
 * `telemetry_enabled` is true AND `telemetry_endpoint` is set — the user has
 * to opt in twice (toggle + endpoint URL).
 *
 * Sanitization rules:
 *   - Home directory paths replaced with `~`.
 *   - Known PII keys (`title`, `description`, `content`, `body`, `secret`,
 *     `token`, `password`, `email`) stripped from payloads.
 *   - Stack traces have file paths normalized via the same `~` rewrite.
 *   - Env vars never logged.
 *
 * The collector is sync-fast: `record()` only does an `fs.appendFileSync` and
 * returns. The upload pass runs on a 60s interval and ships up to 100 events
 * per batch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APP_VERSION,
  LOGS_DIR,
  TELEMETRY_LOG_PATH,
} from '@/shared/constants';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type TelemetryKind =
  | 'launch'
  | 'task_created'
  | 'task_done'
  | 'task_failed'
  | 'error'
  | 'derive'
  | 'execute';

export interface TelemetryEvent {
  kind: TelemetryKind;
  payload?: Record<string, unknown>;
  at: string;
}

export interface FlushResult {
  uploaded: number;
  errors: number;
}

export interface StartTelemetryOptions {
  /** Settings key holding the on/off flag. Defaults to `telemetry_enabled`. */
  optInSetting?: string;
  /** Settings key holding the destination URL. Defaults to `telemetry_endpoint`. */
  endpointSetting?: string;
  /** Override interval between upload passes, ms. Defaults to 60s. */
  intervalMs?: number;
  /** Max events per upload batch. Defaults to 100. */
  batchSize?: number;
}

export interface TelemetryHandle {
  stop(): void;
}

/* -------------------------------------------------------------------------- */
/*  Sanitization                                                              */
/* -------------------------------------------------------------------------- */

const HOME = os.homedir();
const SENSITIVE_KEYS = new Set([
  'title',
  'description',
  'content',
  'body',
  'message',
  'secret',
  'token',
  'password',
  'email',
  'authorization',
  'cookie',
  'api_key',
  'credentials',
]);

/**
 * Replace any occurrence of the user's home dir in a string with `~`. Handles
 * both forward and backslash forms (Windows / POSIX) so backtraces from
 * Electron's V8 land normalized.
 */
function sanitizePath(value: string): string {
  if (!HOME || HOME.length === 0) return value;
  // Use split/join — RegExp would need escaping of every backslash.
  const homeWithSlashes = HOME.replace(/\\/g, '/');
  let out = value;
  if (out.includes(HOME)) {
    out = out.split(HOME).join('~');
  }
  if (out.includes(homeWithSlashes)) {
    out = out.split(homeWithSlashes).join('~');
  }
  return out;
}

/**
 * Recursively strip sensitive keys and rewrite paths. Returns a fresh object —
 * the input is never mutated.
 */
export function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizePath(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        // Replace with a length marker so we still know "something was here".
        if (typeof v === 'string') {
          out[key] = `[redacted len=${v.length}]`;
        } else if (v === null || v === undefined) {
          out[key] = v;
        } else {
          out[key] = '[redacted]';
        }
        continue;
      }
      out[key] = sanitizeValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Build the on-disk record. Annotates every event with `app_version`,
 * `platform`, and the sanitized payload.
 */
function buildRecord(event: TelemetryEvent): Record<string, unknown> {
  const payload =
    event.payload === undefined
      ? undefined
      : (sanitizeValue(event.payload) as Record<string, unknown>);
  return {
    at: event.at,
    kind: event.kind,
    app_version: APP_VERSION,
    platform: process.platform,
    payload,
  };
}

/* -------------------------------------------------------------------------- */
/*  Local jsonl logging                                                       */
/* -------------------------------------------------------------------------- */

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB
const LOG_ROTATE_SUFFIX = '.1';

function ensureLogDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(TELEMETRY_LOG_PATH)) return;
    const stat = fs.statSync(TELEMETRY_LOG_PATH);
    if (stat.size < MAX_LOG_BYTES) return;
    const rotated = `${TELEMETRY_LOG_PATH}${LOG_ROTATE_SUFFIX}`;
    if (fs.existsSync(rotated)) {
      try {
        fs.rmSync(rotated);
      } catch {
        // best-effort
      }
    }
    fs.renameSync(TELEMETRY_LOG_PATH, rotated);
  } catch {
    // Logging is best-effort. If rotation fails the next append will still
    // succeed — the file just grows past 10 MB until disk pressure resolves.
  }
}

/**
 * Append a sanitized event line to the local jsonl log. Sync-fast — no IPC,
 * no network, no DB.
 *
 * `at` is auto-populated when missing so callers can write `record({kind})`.
 */
export function record(event: Omit<TelemetryEvent, 'at'> & { at?: string }): void {
  try {
    ensureLogDir();
    rotateIfNeeded();
    const normalized: TelemetryEvent = {
      kind: event.kind,
      payload: event.payload,
      at: event.at ?? new Date().toISOString(),
    };
    const line = JSON.stringify(buildRecord(normalized));
    fs.appendFileSync(TELEMETRY_LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // Telemetry must never crash the caller.
  }
}

/* -------------------------------------------------------------------------- */
/*  Upload pass                                                               */
/* -------------------------------------------------------------------------- */

interface UploadSettings {
  enabled: boolean;
  endpoint: string;
}

/**
 * Read the opt-in flag + endpoint URL from the settings repository. Wrapped
 * in a try/catch so we don't crash if the DB isn't ready yet (e.g. during
 * the first second of startup).
 */
async function readUploadSettings(
  optInKey: string,
  endpointKey: string,
): Promise<UploadSettings> {
  try {
    const mod = (await import('@/main/db/repositories/settings')) as {
      settingsRepository: {
        get<T>(key: string): T | null;
      };
    };
    const enabled = mod.settingsRepository.get<boolean>(optInKey) === true;
    const endpointRaw = mod.settingsRepository.get<string>(endpointKey);
    const endpoint =
      typeof endpointRaw === 'string' ? endpointRaw.trim() : '';
    return { enabled, endpoint };
  } catch {
    return { enabled: false, endpoint: '' };
  }
}

/**
 * Tracks how far we've shipped. Persisted under settings so we don't
 * re-upload the same lines after a restart.
 */
const CURSOR_SETTING = 'telemetry_upload_cursor';

async function readCursor(): Promise<number> {
  try {
    const mod = (await import('@/main/db/repositories/settings')) as {
      settingsRepository: { get<T>(key: string): T | null };
    };
    const raw = mod.settingsRepository.get<number>(CURSOR_SETTING);
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
    return 0;
  } catch {
    return 0;
  }
}

async function writeCursor(value: number): Promise<void> {
  try {
    const mod = (await import('@/main/db/repositories/settings')) as {
      settingsRepository: { set(key: string, value: unknown): void };
    };
    mod.settingsRepository.set(CURSOR_SETTING, value);
  } catch {
    // Persisting the cursor is best-effort; on the next boot we may re-ship
    // a few lines but the receiver is expected to dedupe.
  }
}

function readLogLines(maxLines: number, startLine: number): string[] {
  try {
    if (!fs.existsSync(TELEMETRY_LOG_PATH)) return [];
    const raw = fs.readFileSync(TELEMETRY_LOG_PATH, 'utf8');
    const all = raw.split('\n').filter((l) => l.length > 0);
    return all.slice(startLine, startLine + maxLines);
  } catch {
    return [];
  }
}

/**
 * Ship as many pending events as fit in a batch. Honors the opt-in flag and
 * endpoint setting; otherwise it's a no-op.
 */
export async function flush(
  options: { batchSize?: number; endpoint?: string; enabled?: boolean } = {},
): Promise<FlushResult> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  let enabled = options.enabled;
  let endpoint = options.endpoint;
  if (enabled === undefined || endpoint === undefined) {
    const s = await readUploadSettings('telemetry_enabled', 'telemetry_endpoint');
    enabled = enabled ?? s.enabled;
    endpoint = endpoint ?? s.endpoint;
  }
  if (!enabled || !endpoint || endpoint.length === 0) {
    return { uploaded: 0, errors: 0 };
  }

  const cursor = await readCursor();
  const lines = readLogLines(batchSize, cursor);
  if (lines.length === 0) return { uploaded: 0, errors: 0 };

  // Ship as a JSONL body — the endpoint can split on newlines without
  // parsing the full payload as a single document.
  const body = lines.join('\n') + '\n';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body,
    });
    if (!res.ok) {
      return { uploaded: 0, errors: 1 };
    }
    await writeCursor(cursor + lines.length);
    return { uploaded: lines.length, errors: 0 };
  } catch {
    return { uploaded: 0, errors: 1 };
  }
}

/* -------------------------------------------------------------------------- */
/*  Long-running pump                                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Start the upload loop. Runs once on boot (to ship anything left over from
 * a crashed prior session) and then every `intervalMs`.
 */
export function startTelemetry(
  options: StartTelemetryOptions = {},
): TelemetryHandle {
  const optInKey = options.optInSetting ?? 'telemetry_enabled';
  const endpointKey = options.endpointSetting ?? 'telemetry_endpoint';
  const interval = Math.max(5_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const batchSize = Math.max(1, options.batchSize ?? 100);

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const s = await readUploadSettings(optInKey, endpointKey);
      if (!s.enabled || !s.endpoint) return;
      await flush({ batchSize, enabled: s.enabled, endpoint: s.endpoint });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[taskpilot:telemetry] tick failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Fire the first pass after a short delay so the DB has time to initialize.
  setTimeout(() => {
    void tick();
  }, 3_000);
  timer = setInterval(() => {
    void tick();
  }, interval);

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Error-handler integration                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Convenience wrapper for `record({kind:'error'})`. Sanitizes the error
 * message + stack trace via the standard path-rewrite rule.
 */
export function recordError(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const stack = err instanceof Error && err.stack ? err.stack : null;
  record({
    kind: 'error',
    payload: {
      message: sanitizePath(message),
      stack: stack ? sanitizePath(stack) : null,
      context: context ? (sanitizeValue(context) as Record<string, unknown>) : undefined,
    },
  });
}

/**
 * Path to the local log — exposed so the UI ("Open log") can link to it.
 */
export const TELEMETRY_LOG = TELEMETRY_LOG_PATH;

/* -------------------------------------------------------------------------- */
/*  Helpers for tests                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the local log path. Re-exports `TELEMETRY_LOG_PATH` so tests don't
 * need to import the constants module directly.
 */
export function logPath(): string {
  return TELEMETRY_LOG_PATH;
}

/**
 * Read every persisted event. Test-only convenience — the production code
 * reads via `readLogLines`.
 */
export function readAll(): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(TELEMETRY_LOG_PATH)) return [];
    const raw = fs.readFileSync(TELEMETRY_LOG_PATH, 'utf8');
    const out: Record<string, unknown>[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Reset the upload cursor (test-only). Lets a test that wants to flush
 * everything start from the top of the log file.
 */
export async function resetCursor(): Promise<void> {
  await writeCursor(0);
}

// `path` import used by sanitization callers indirectly via stack rewriting.
// Re-export for downstream tests/scripts.
export const _internal = {
  sanitizePath,
  buildRecord,
  pathSep: path.sep,
};
