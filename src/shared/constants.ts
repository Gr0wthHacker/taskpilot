import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * TaskPilot application metadata.
 */
export const APP_NAME = 'TaskPilot';
export const APP_VERSION = '0.1.0';

/**
 * Locked HTTP API port for the local server.
 */
export const API_PORT = 7847;

/**
 * Filesystem layout. All paths under `~/.taskpilot/`.
 */
const HOME = os.homedir();

export const TASKPILOT_HOME = path.join(HOME, '.taskpilot');
export const DB_PATH = path.join(TASKPILOT_HOME, 'taskpilot.db');
export const CREDS_PATH = path.join(TASKPILOT_HOME, 'credentials.json');
export const LOGS_DIR = path.join(TASKPILOT_HOME, 'logs');

/**
 * Wave 12 — operational hardening. Backups land under `~/.taskpilot/backups/`;
 * the telemetry collector tails an append-only JSONL log under `LOGS_DIR`.
 * Both directories are created on demand by their respective subsystems but
 * are listed in `REQUIRED_DIRS` so `ensureDirs()` provisions them at boot.
 */
export const BACKUPS_DIR = path.join(TASKPILOT_HOME, 'backups');
export const TELEMETRY_LOG_PATH = path.join(LOGS_DIR, 'telemetry.jsonl');

export const IO_ROOT = path.join(TASKPILOT_HOME, 'io');
export const IO_INBOX = path.join(IO_ROOT, 'inbox');
export const IO_DERIVE = path.join(IO_ROOT, 'derive');
export const IO_DERIVED = path.join(IO_ROOT, 'derived');
export const IO_EXECUTE = path.join(IO_ROOT, 'execute');
export const IO_RESULTS = path.join(IO_ROOT, 'results');
export const IO_REVIEW = path.join(IO_ROOT, 'review');
export const IO_CONTEXT = path.join(IO_ROOT, 'context');

/**
 * Ambient-monitor deliberation queue. `IO_DELIBERATE` is the request side —
 * the app drops a `deliberation_request` JSON blob into here and Claude (via
 * the `ambient-deliberate` skill) processes it. `IO_DELIBERATED` is the
 * response side — Claude writes the two-agent scoring result and the watcher
 * ingests it into the `deliberations` table.
 */
export const IO_DELIBERATE = path.join(IO_ROOT, 'deliberate');
export const IO_DELIBERATED = path.join(IO_ROOT, 'deliberated');

/**
 * Wave 18 — conversations subsystem. `IO_SUMMARIZE` is the request side: the
 * compactor drops a `summarize_request` JSON in here when a conversation is
 * past `conversation_compression_days`. Claude reads it, writes the response
 * to `IO_SUMMARIZED`, and the watcher swaps the digest for the summary.
 *
 * Pattern mirrors `IO_DELIBERATE` → `IO_DELIBERATED`.
 */
export const IO_SUMMARIZE = path.join(IO_ROOT, 'summarize');
export const IO_SUMMARIZED = path.join(IO_ROOT, 'summarized');

/**
 * Forensic archive of consumed deliberation request files. After
 * `ingestDeliberation()` commits the `deliberations` row, the original
 * request file at `IO_DELIBERATE/<batch_id>.json` is moved here so:
 *
 *   - the live `deliberate/` directory doesn't grow unboundedly;
 *   - the watcher can't re-dispatch a request that's already been consumed
 *     on a subsequent boot;
 *   - the raw observation payload is preserved for post-hoc debugging.
 *
 * Layout mirrors `IO_DELIBERATE` so a sysadmin can `mv` files back if needed.
 */
export const IO_DONE_ARCHIVE_DELIBERATE = path.join(
  IO_ROOT,
  '_done-archive',
  'deliberate',
);

/** Forensic archive of consumed summarize requests. Same shape/reasoning as the deliberation archive. */
export const IO_DONE_ARCHIVE_SUMMARIZE = path.join(
  IO_ROOT,
  '_done-archive',
  'summarize',
);

/**
 * Forensic archive of consumed derivation responses. After the watcher
 * dispatches a `derived/<task-id>.json` file to ingestion successfully, the
 * original is moved here so:
 *   - rescans (POST /api/io/ingest, polling fallback) don't re-create the
 *     same children; this was the source of the 33k-task runaway in v8;
 *   - the raw response is preserved for post-hoc debugging.
 */
export const IO_DONE_ARCHIVE_DERIVED = path.join(
  IO_ROOT,
  '_done-archive',
  'derived',
);

/**
 * Forensic archive of consumed inbox drops. Same rationale as the derived
 * archive — a successfully-ingested inbox payload must not be re-dispatched
 * on the next rescan.
 */
export const IO_DONE_ARCHIVE_INBOX = path.join(
  IO_ROOT,
  '_done-archive',
  'inbox',
);

/**
 * Forensic archive of consumed execute requests. Populated by the runner
 * (Claude Code / Cowork) when it writes a result file; the server-side
 * watcher doesn't touch `execute/` so this constant is for runner-mode
 * scripts. Kept here so the path layout stays consistent.
 */
export const IO_DONE_ARCHIVE_EXECUTE = path.join(
  IO_ROOT,
  '_done-archive',
  'execute',
);

/**
 * Memory subsystem — enrichment bridge.
 *
 * The app writes an enrichment REQUEST to `memory_enrich/<item-id>.json`
 * whenever a new memory item lands in `status='raw'`. A runner (the
 * `memory-enrich` skill or `/tp-watch`) picks it up, summarizes /
 * categorizes / extracts entities, and writes a RESPONSE to
 * `memory_enriched/<item-id>.json`. The watcher ingests the response and
 * archives the request — mirrors the derive/derived pattern from tasks.
 *
 * `memory/files/` holds raw file drops for `kind='file'` items.
 */
export const IO_MEMORY_ENRICH = path.join(IO_ROOT, 'memory_enrich');
export const IO_MEMORY_ENRICHED = path.join(IO_ROOT, 'memory_enriched');
export const IO_MEMORY_INBOX = path.join(IO_ROOT, 'memory_inbox');

/**
 * Per-business status delta drop folder. Any Claude session can write a
 * `status_update` payload here (typically via the SessionEnd hook installed
 * under `~/.claude/hooks/`). The watcher ingests the file, appends the row to
 * the business's `updates.jsonl`, re-renders the cached snapshot, then moves
 * the source to `_done-archive/status_update/` so a rescan doesn't re-apply
 * it.
 *
 * Filenames must match the io-id regex (`[A-Za-z0-9_-]{1,64}.json`) — the
 * payload itself names the target business via the `business` field.
 */
export const IO_STATUS_UPDATE = path.join(IO_ROOT, 'status_update');
export const IO_DONE_ARCHIVE_STATUS_UPDATE = path.join(
  IO_ROOT,
  '_done-archive',
  'status_update',
);
export const IO_DONE_ARCHIVE_MEMORY_ENRICH = path.join(
  IO_ROOT,
  '_done-archive',
  'memory_enrich',
);
export const IO_DONE_ARCHIVE_MEMORY_ENRICHED = path.join(
  IO_ROOT,
  '_done-archive',
  'memory_enriched',
);
export const MEMORY_FILES_DIR = path.join(TASKPILOT_HOME, 'memory', 'files');

/**
 * Wave 13 — file attachments. Per-task uploads live under
 * `~/.taskpilot/attachments/<task-id>/<sanitized-filename>` and are referenced
 * from `task.context.attachments`. Created lazily (no row in REQUIRED_DIRS
 * to avoid spinning up a directory until the user actually uploads).
 */
export const ATTACHMENTS_DIR = path.join(TASKPILOT_HOME, 'attachments');

/**
 * Ambient monitor screenshot store. Created lazily by the monitor + by
 * `GET /api/context/screenshots/:filename` whenever it has to resolve a path.
 * Files inside are named with the captured-at ISO timestamp (`:` replaced by
 * `-` to be Windows-safe) plus a `.png` suffix; the served route validates
 * the filename against a tight regex to block path traversal.
 */
export const CAPTURES_DIR = path.join(TASKPILOT_HOME, 'captures');

/**
 * Default attachment size limits. Overridable via settings keys
 * `attachment_max_file_bytes` and `attachment_max_task_bytes`.
 */
export const DEFAULT_ATTACHMENT_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_ATTACHMENT_MAX_TASK_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Quarantine directory for I/O files that fail validation.
 * Not exported via BUILD_CONTRACTS but referenced by the I/O protocol.
 */
export const IO_INVALID = path.join(IO_ROOT, '_invalid');

/**
 * Encrypted append-only audit log for ambient events.
 *
 * Each calendar month gets its own file at
 * `~/.taskpilot/audit/ambient-<YYYY-MM>.jsonl.enc`. Every logical line is an
 * independently-encrypted JSON blob (`safeStorage.encryptString` → base64,
 * one line per event) so a partial write can corrupt at most the trailing
 * row, not the whole file. Retention sweeps drop files older than
 * `ambient_audit_retention_days` (default 90).
 */
export const AUDIT_DIR = path.join(TASKPILOT_HOME, 'audit');

/**
 * Ordered list of every directory the runtime expects to exist.
 */
export const REQUIRED_DIRS: readonly string[] = [
  TASKPILOT_HOME,
  LOGS_DIR,
  BACKUPS_DIR,
  IO_ROOT,
  IO_INBOX,
  IO_DERIVE,
  IO_DERIVED,
  IO_EXECUTE,
  IO_RESULTS,
  IO_REVIEW,
  IO_CONTEXT,
  IO_DELIBERATE,
  IO_DELIBERATED,
  IO_DONE_ARCHIVE_DELIBERATE,
  IO_SUMMARIZE,
  IO_SUMMARIZED,
  IO_DONE_ARCHIVE_SUMMARIZE,
  IO_DONE_ARCHIVE_DERIVED,
  IO_DONE_ARCHIVE_INBOX,
  IO_DONE_ARCHIVE_EXECUTE,
  IO_MEMORY_ENRICH,
  IO_MEMORY_ENRICHED,
  IO_MEMORY_INBOX,
  IO_DONE_ARCHIVE_MEMORY_ENRICH,
  IO_DONE_ARCHIVE_MEMORY_ENRICHED,
  IO_STATUS_UPDATE,
  IO_DONE_ARCHIVE_STATUS_UPDATE,
  MEMORY_FILES_DIR,
  IO_INVALID,
  AUDIT_DIR,
];

/**
 * Synchronously create every required directory if it doesn't already exist.
 * Safe to call repeatedly. Throws if a non-directory file occupies a target path.
 *
 * Also kicks off a best-effort filesystem-masking pass on the captures dir +
 * the deliberation archive (Windows hidden/system attribs + Search exclusion
 * hint). The masking helper logs and swallows any failure, so an
 * `attrib.exe` outage never blocks boot.
 *
 * The require() is intentional: `@/main/security/fs-mask` is only available
 * inside the Electron main / Node bundle. Renderer code never calls
 * ensureDirs() (it has no fs access), so a missing module is loaded lazily
 * and squelched.
 */
export function ensureDirs(): void {
  for (const dir of REQUIRED_DIRS) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      continue;
    }
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`TaskPilot path exists but is not a directory: ${dir}`);
    }
  }

  // Captures dir lives outside REQUIRED_DIRS (created lazily by the monitor)
  // but if it's there we want the hidden bits re-applied on every boot —
  // `attrib +H +S +I` is a no-op when the bits are already set.
  if (!fs.existsSync(CAPTURES_DIR)) {
    try {
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
    } catch {
      /* non-fatal — monitor will retry on first capture */
    }
  }

  void applyFsMasking();
}

/**
 * Lazy-loaded entry into the fs-mask module. Kept out of the top-level
 * `import` block so:
 *   1. The renderer bundle never tries to pull in Node child_process,
 *   2. A missing module (e.g. during early bootstrap, before main is built)
 *      degrades silently rather than crashing `ensureDirs()`.
 */
async function applyFsMasking(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../main/security/fs-mask') as
      | { applyHiddenAttribs?: (p: string) => Promise<void> }
      | undefined;
    if (!mod || typeof mod.applyHiddenAttribs !== 'function') return;
    await Promise.all([
      mod.applyHiddenAttribs(CAPTURES_DIR),
      mod.applyHiddenAttribs(path.join(IO_ROOT, '_done-archive')),
    ]);
  } catch {
    /* best-effort — never crash boot over masking */
  }
}
