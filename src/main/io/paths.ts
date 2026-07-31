import path from 'node:path';
import fs from 'node:fs/promises';

import {
  IO_CONTEXT,
  IO_DELIBERATE,
  IO_DELIBERATED,
  IO_DERIVE,
  IO_DERIVED,
  IO_EXECUTE,
  IO_INBOX,
  IO_INVALID,
  IO_RESULTS,
  IO_REVIEW,
  IO_ROOT,
  IO_STATUS_UPDATE,
  LOGS_DIR,
  REQUIRED_DIRS,
  TASKPILOT_HOME,
} from '@/shared/constants';

/**
 * Re-export the path constants from `@/shared/constants` so callers in the
 * I/O layer only need a single import.
 */
export {
  IO_CONTEXT,
  IO_DELIBERATE,
  IO_DELIBERATED,
  IO_DERIVE,
  IO_DERIVED,
  IO_EXECUTE,
  IO_INBOX,
  IO_INVALID,
  IO_RESULTS,
  IO_REVIEW,
  IO_ROOT,
  IO_STATUS_UPDATE,
  LOGS_DIR,
  TASKPILOT_HOME,
};

/* -------------------------------------------------------------------------- */
/*  Task-id validation + path-escape protection                                */
/* -------------------------------------------------------------------------- */

/**
 * Strict task id regex. Matches nanoid alphabet (`A-Za-z0-9_-`) plus a length
 * cap so a task id can never be a path traversal token like `..` or contain
 * a slash. Mirrored in `@/shared/io-schemas#taskIdSchema`.
 */
const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a task id. Used to gate any code path that joins an externally
 * supplied id into a filesystem path. The check is intentionally strict —
 * see `safeJoin` for the secondary check that runs on the resolved path.
 */
export function isValidTaskId(id: string): boolean {
  return typeof id === 'string' && ID_REGEX.test(id);
}

/**
 * Path joiner that guarantees the resulting path stays inside `root`.
 *
 * Defends against directory-traversal attacks where a malicious task id like
 * `"../../../tokens"` could otherwise escape the I/O root. The resolved path
 * MUST equal `root` itself or be a descendant; everything else throws.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    throw new Error(
      `Path escape: ${segments.join('/')} resolves outside ${root}`,
    );
  }
  return resolved;
}

/**
 * Throw if `taskId` is not in the canonical regex form. Callers that join a
 * task id into a filesystem path should call this first so the error message
 * surfaces a clean "invalid task id" rather than a confusing path error.
 */
function assertTaskId(taskId: string): void {
  if (!isValidTaskId(taskId)) {
    throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Path to the derivation request file for a task.
 * Written by the app, read by Claude.
 */
export function derivePath(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_DERIVE, `${taskId}.json`);
}

/**
 * Path to the derivation response file for a task.
 * Written by Claude, read by the app.
 */
export function derivedPath(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_DERIVED, `${taskId}.json`);
}

/* -------------------------------------------------------------------------- */
/*  Execution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Path to the execution request file for a task.
 * Written by the app, read by Claude.
 */
export function executePath(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_EXECUTE, `${taskId}.json`);
}

/**
 * Path to the per-task results directory, which holds `result.json` and an
 * `output/` subdirectory of generated files.
 */
export function resultsDir(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_RESULTS, taskId);
}

/**
 * Path to the `result.json` for a given task.
 */
export function resultPath(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_RESULTS, taskId, 'result.json');
}

/**
 * Path to a task's review marker file.
 */
export function reviewPath(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_REVIEW, `${taskId}.json`);
}

/**
 * Path to a task's inbox marker file.
 */
export function inboxPath(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_INBOX, `${taskId}.json`);
}

/* -------------------------------------------------------------------------- */
/*  Deliberation (ambient monitor)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Path to the deliberation request file for an ambient batch.
 * Written by the app, read by Claude. `batchId` re-uses the same alphabet
 * constraint as a task id so it round-trips safely through the path layer.
 */
export function deliberatePath(batchId: string): string {
  assertTaskId(batchId);
  return safeJoin(IO_DELIBERATE, `${batchId}.json`);
}

/**
 * Path to the deliberation result file for an ambient batch.
 * Written by Claude (via the `ambient-deliberate` skill), read by the app.
 */
export function deliberatedPath(batchId: string): string {
  assertTaskId(batchId);
  return safeJoin(IO_DELIBERATED, `${batchId}.json`);
}

/**
 * Path to a status-update drop under `IO_STATUS_UPDATE/`. The `id` field is
 * a free-form-but-validated token (typically `<biz-tag>-<iso>` or a nanoid)
 * picked by the producer — the payload carries the target business.
 */
export function statusUpdatePath(id: string): string {
  assertTaskId(id);
  return safeJoin(IO_STATUS_UPDATE, `${id}.json`);
}

/**
 * Path to a named context snapshot file under `IO_CONTEXT/`.
 *
 * @param name - The base name (e.g. `'calendar'`); `.json` is appended.
 */
export function contextPath(name: string): string {
  const base = name.endsWith('.json') ? name : `${name}.json`;
  // Context filenames are app-controlled (callers pass a literal like
  // `'calendar'`), but route through safeJoin defensively so a future caller
  // can't accidentally introduce a traversal.
  return safeJoin(IO_CONTEXT, base);
}

/**
 * Path inside `_invalid/` where a quarantined file should be stored.
 */
export function invalidPath(filename: string): string {
  return safeJoin(IO_INVALID, filename);
}

/**
 * Per-task output directory inside `IO_RESULTS/<taskId>/output/`.
 * Convenience helper that mirrors the on-disk layout.
 */
export function outputDir(taskId: string): string {
  assertTaskId(taskId);
  return safeJoin(IO_RESULTS, taskId, 'output');
}

/**
 * Asynchronously create every directory the I/O layer expects.
 * Safe to call repeatedly. Mirrors `ensureDirs()` in shared/constants but
 * uses `fs/promises` so it can be awaited from async startup code.
 */
export async function ensureIoDirs(): Promise<void> {
  for (const dir of REQUIRED_DIRS) {
    await fs.mkdir(dir, { recursive: true });
  }
}
