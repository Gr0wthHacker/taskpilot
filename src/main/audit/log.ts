/**
 * Encrypted append-only audit log for ambient events.
 *
 * Layout: each calendar month gets its own file at
 * `~/.taskpilot/audit/ambient-<YYYY-MM>.jsonl.enc`. A logical "row" is one
 * line in that file, formatted as:
 *
 *   safe:<base64(ciphertext)>\n          (encryption available)
 *   plain:<base64(utf8(plaintext))>\n    (fallback when safeStorage is off)
 *
 * Each line is encrypted independently so a torn write (process crash, OOM,
 * power loss) can corrupt at most the trailing row — every earlier event is
 * still readable. Reads tolerate mixed lines and skip anything that fails to
 * decode rather than aborting the scan.
 *
 * The writer is intentionally synchronous (`fs.appendFileSync`) so callers
 * don't have to await it; the volume is tiny (one short JSON object per
 * ambient event) and a brief stall is better than a queued-write back-pressure
 * surprise on shutdown. All file-system errors are swallowed and surfaced via
 * `console.warn` — audit failures must NEVER block the originating event.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AUDIT_DIR } from '@/shared/constants';

/* -------------------------------------------------------------------------- */
/*  Public event shape                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Discriminator for what kind of ambient event happened. Open string union so
 * future kinds don't require a schema migration — the on-disk format is just
 * JSON, the kind is a free-form tag the reader can filter on.
 */
export type AuditEventKind =
  | 'observation_created'
  | 'deliberation_requested'
  | 'deliberation_completed'
  | 'ambient_task_created'
  | 'panic_wipe'
  | 'safe_storage_unavailable'
  | 'audit_write_failed'
  | string;

/**
 * The public record shape. `ts` is set by the caller or defaults to `now()`.
 * `payload` is any JSON-serializable bag — callers should keep it small and
 * NEVER include raw secrets (tokens, PII).
 */
export interface AuditEvent {
  kind: AuditEventKind;
  ts: string;
  payload: Record<string, unknown>;
}

export interface AppendAuditEventInput {
  kind: AuditEventKind;
  payload?: Record<string, unknown>;
  ts?: string;
}

/* -------------------------------------------------------------------------- */
/*  Electron safeStorage (lazy)                                                */
/* -------------------------------------------------------------------------- */

interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (s: string) => Buffer;
  decryptString: (b: Buffer) => string;
}

let cachedSafeStorage: SafeStorageLike | null | undefined;

/**
 * Load Electron's safeStorage lazily. Cached so we only attempt the require
 * once per process. Returns `null` outside Electron or when the import fails.
 *
 * Exported via `__resetSafeStorageCacheForTests` so the test suite can flip
 * the availability flag mid-run.
 */
function loadSafeStorage(): SafeStorageLike | null {
  if (cachedSafeStorage !== undefined) return cachedSafeStorage;
  if (
    typeof process === 'undefined' ||
    !process.versions ||
    !process.versions.electron
  ) {
    cachedSafeStorage = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    cachedSafeStorage = electron.safeStorage ?? null;
  } catch {
    cachedSafeStorage = null;
  }
  return cachedSafeStorage;
}

/**
 * Test-only hook: reset the cached safeStorage handle so a subsequent call to
 * the logger re-evaluates. Pair with `__setSafeStorageForTests(...)` to
 * simulate encryption availability transitions without going through
 * `vi.doMock('electron', ...)` (which doesn't intercept the dynamic `require`
 * the lazy loader uses).
 *
 * @internal
 */
export function __resetSafeStorageCacheForTests(): void {
  cachedSafeStorage = undefined;
}

/**
 * Test-only injection hook: install a stub safeStorage. Pass `null` to
 * simulate Electron-without-libsecret / non-Electron host. The override
 * persists across calls until `__resetSafeStorageCacheForTests()` clears it.
 *
 * @internal
 */
export function __setSafeStorageForTests(
  stub: SafeStorageLike | null | undefined,
): void {
  cachedSafeStorage = stub === undefined ? null : stub;
}

/* -------------------------------------------------------------------------- */
/*  File layout                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the per-month file the given timestamp should land in. Always
 * returns a path inside {@link AUDIT_DIR}.
 */
export function auditFilePathFor(ts: Date | string): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const safe = Number.isFinite(d.getTime()) ? d : new Date();
  const y = safe.getUTCFullYear().toString().padStart(4, '0');
  const m = (safe.getUTCMonth() + 1).toString().padStart(2, '0');
  return path.join(AUDIT_DIR, `ambient-${y}-${m}.jsonl.enc`);
}

const SAFE_PREFIX = 'safe:';
const PLAIN_PREFIX = 'plain:';

/* -------------------------------------------------------------------------- */
/*  Internal serialization                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the canonical JSON line for a single event. Pure — does NOT touch
 * disk. Returns the trailing newline already baked in.
 */
export function serializeAuditLine(event: AuditEvent): string {
  const json = JSON.stringify(event);
  const safeStorage = loadSafeStorage();
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const cipher = safeStorage.encryptString(json);
      return `${SAFE_PREFIX}${cipher.toString('base64')}\n`;
    } catch {
      // Fall through to plaintext — better to leave a paper trail than to
      // drop the event on the floor.
    }
  }
  return `${PLAIN_PREFIX}${Buffer.from(json, 'utf8').toString('base64')}\n`;
}

/**
 * Decode a single on-disk line back into an `AuditEvent`. Returns `null` for
 * unknown prefixes, malformed base64, decryption failures, or non-object JSON
 * so a corrupt tail can never break a forward scan.
 */
export function deserializeAuditLine(line: string): AuditEvent | null {
  const trimmed = line.replace(/\r?\n+$/, '');
  if (trimmed.length === 0) return null;
  let json: string;
  try {
    if (trimmed.startsWith(SAFE_PREFIX)) {
      const safeStorage = loadSafeStorage();
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
      const cipher = Buffer.from(trimmed.slice(SAFE_PREFIX.length), 'base64');
      json = safeStorage.decryptString(cipher);
    } else if (trimmed.startsWith(PLAIN_PREFIX)) {
      json = Buffer.from(trimmed.slice(PLAIN_PREFIX.length), 'base64').toString(
        'utf8',
      );
    } else {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    const kind = rec['kind'];
    const ts = rec['ts'];
    const payload = rec['payload'];
    if (typeof kind !== 'string' || typeof ts !== 'string') return null;
    if (
      payload === null ||
      payload === undefined ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return { kind, ts, payload: {} };
    }
    return { kind, ts, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API — append                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Append one ambient event to the encrypted log. Synchronous; never throws.
 *
 * Hard guarantees:
 *   - Failure here cannot propagate back to the caller (try/catch around
 *     every disk op).
 *   - Crash mid-write corrupts at most one row — earlier rows are sealed.
 *   - When safeStorage is unavailable the line is base64-wrapped plaintext
 *     and we self-record an `audit_write_failed` follow-up the first time so
 *     the operator notices via /api/audit/recent.
 */
export function appendAuditEvent(input: AppendAuditEventInput): void {
  const event: AuditEvent = {
    kind: input.kind,
    ts: input.ts ?? new Date().toISOString(),
    payload: input.payload ?? {},
  };

  let line: string;
  try {
    line = serializeAuditLine(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[audit] serialize failed (event dropped):',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const target = auditFilePathFor(event.ts);
    // appendFileSync is atomic for short writes on every platform we ship on
    // (Windows, macOS, Linux — line length is well under PIPE_BUF). For the
    // few-hundred-byte ciphertext we produce, a torn write is essentially
    // impossible without a kernel panic, which would corrupt at most the
    // trailing line anyway.
    fs.appendFileSync(target, line, { encoding: 'utf8' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[audit] append failed (event dropped):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Convenience wrapper for the "best-effort, never throws" call shape. Drops
 * the return value so callers can `void appendAuditEventSafe(...)` without
 * lint complaints when ignoring the result.
 */
export function appendAuditEventSafe(input: AppendAuditEventInput): void {
  try {
    appendAuditEvent(input);
  } catch (err) {
    // Belt-and-braces — appendAuditEvent already swallows, but if something
    // truly exotic escapes (e.g. JSON.stringify on a circular payload thrown
    // synchronously from the input shape) we still don't propagate.
    // eslint-disable-next-line no-console
    console.warn(
      '[audit] unexpected error:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Typed convenience wrapper for the panic-wipe flow. The panic feature itself
 * doesn't exist yet — when it lands, the wipe path should call this helper
 * BEFORE the file/row delete so the operator has a paper trail of the action,
 * even after the wipe completes.
 *
 * Kept separate from the generic helper so callers can grep for it and so
 * the payload shape is documented in one place rather than scattered across
 * call sites.
 */
export function logPanicWipe(input: {
  files_deleted: number;
  rows_skipped: number;
  lookback_hours?: number;
  reason?: string;
}): void {
  appendAuditEventSafe({
    kind: 'panic_wipe',
    payload: {
      files_deleted: input.files_deleted,
      rows_skipped: input.rows_skipped,
      ...(input.lookback_hours !== undefined
        ? { lookback_hours: input.lookback_hours }
        : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  });
}
