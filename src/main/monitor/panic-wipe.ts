/**
 * Panic-wipe operation for the ambient monitor.
 *
 * "Nuke the captures, mark everything pending as skipped, leave a paper
 * trail." Called from both the tray menu (direct in-process invocation) and
 * the `POST /api/context/panic/wipe` route. Extracted into its own module
 * so both call sites share the lock + atomic-rename dance and the audit
 * event isn't duplicated.
 *
 * Flow (each step is best-effort — none of them throw out of the function):
 *
 *   1. Acquire the monitor mutex via {@link MonitorHandle.withLock} so an
 *      in-flight tickScreenshot can't race with the rename. When no monitor
 *      is registered (boot failed, tests), we still proceed — the rename
 *      is the actual ordering primitive that matters.
 *   2. Rename `~/.taskpilot/captures/` to
 *      `~/.taskpilot/captures-deleted-<unix-ts>/`. This is atomic on every
 *      platform we ship on; even if the subsequent `fs.rm` crashes, no
 *      future tick can land a row into the moved tree.
 *   3. Spawn an async `fs.rm({ recursive: true, force: true })` against the
 *      renamed dir. We DON'T await it — the caller gets a fast response and
 *      the disk-clear happens in the background. Failures are logged but
 *      counted as zero.
 *   4. Recreate the empty captures dir so the next tick has somewhere to
 *      write. Idempotent — `mkdir -p`.
 *   5. Mark every pending deliberation as `skipped` so any verdict
 *      Claude was about to deliver against the wiped observations doesn't
 *      come back as a phantom row.
 *   6. Emit an `appendAuditEventSafe({ kind: 'panic_wipe', ... })` record.
 *      Failure here never crashes the wipe; the audit module is fully
 *      best-effort.
 *
 * The return shape is always populated — partial failures show up as a
 * `warnings` field so callers can surface them without exposing exception
 * stack traces.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { CAPTURES_DIR } from '@/shared/constants';
import { logPanicWipe } from '@/main/audit';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';

import { getMonitorHandle } from './handle';

const PREFIX = '[panic-wipe]';

/** Public contract for the wipe outcome — mirrors the route response. */
export interface PanicWipeResult {
  ok: true;
  files_deleted: number;
  rows_skipped: number;
  /**
   * Non-empty when any sub-step failed in a partial-success way (e.g.
   * captures dir was already missing, or the audit append couldn't write).
   * The caller still gets a 200/`ok: true` — the wipe is "best-effort, never
   * throw out".
   */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function countFilesIn(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let n = 0;
    for (const e of entries) if (e.isFile()) n += 1;
    return n;
  } catch {
    return 0;
  }
}

async function renameToDeleted(): Promise<{
  renamedTo: string | null;
  warning: string | null;
}> {
  const ts = Math.floor(Date.now() / 1_000);
  const parent = path.dirname(CAPTURES_DIR);
  const base = path.basename(CAPTURES_DIR);
  const renamedTo = path.join(parent, `${base}-deleted-${ts}`);
  try {
    await fs.rename(CAPTURES_DIR, renamedTo);
    return { renamedTo, warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT — the captures dir was already missing. That's fine: nothing
    // to wipe, and the recreate step below will fix the directory tree.
    if (/ENOENT/i.test(message)) {
      return { renamedTo: null, warning: null };
    }
    return {
      renamedTo: null,
      warning: `rename failed: ${message}`,
    };
  }
}

async function recreateCapturesDir(): Promise<string | null> {
  try {
    await fs.mkdir(CAPTURES_DIR, { recursive: true });
    return null;
  } catch (err) {
    return `recreate failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function markPendingDeliberationsSkipped(): {
  rows_skipped: number;
  warning: string | null;
} {
  try {
    const pending = deliberationsRepository.list({
      status: 'pending',
      limit: 500,
    });
    let n = 0;
    for (const d of pending) {
      const updated = deliberationsRepository.markTerminal(
        d.id,
        'skipped',
        'panic_wipe',
      );
      if (updated) n += 1;
    }
    return { rows_skipped: n, warning: null };
  } catch (err) {
    return {
      rows_skipped: 0,
      warning: `mark skipped failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Public entry                                                              */
/* -------------------------------------------------------------------------- */

function scheduleBackgroundRm(target: string): void {
  // Never awaited — the caller already sees a quiescent captures dir from
  // the rename, so the response is safe to return immediately. Errors land
  // in the [panic-wipe] log only.
  void (async (): Promise<void> => {
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        PREFIX,
        'background rm failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  })();
}

function safeMonitorReset(): string | null {
  try {
    getMonitorHandle()?.resetEnableTime();
    return null;
  } catch (err) {
    return `monitor reset failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function safeAudit(filesDeleted: number, rowsSkipped: number, reason: string): string | null {
  try {
    logPanicWipe({
      files_deleted: filesDeleted,
      rows_skipped: rowsSkipped,
      reason,
    });
    return null;
  } catch (err) {
    return `audit append failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Body of the wipe — extracted from {@link runPanicWipe} so the public entry
 * point can stay under the 50-line house limit and so the monitor-mutex
 * branch + bare-call branch share the same code path verbatim.
 */
async function performWipe(reason: string): Promise<PanicWipeResult> {
  const warnings: string[] = [];

  // Count BEFORE the rename so the report reflects what we're about to lose.
  const filesDeleted = await countFilesIn(CAPTURES_DIR);

  const renameOutcome = await renameToDeleted();
  if (renameOutcome.warning) warnings.push(renameOutcome.warning);
  if (renameOutcome.renamedTo !== null) scheduleBackgroundRm(renameOutcome.renamedTo);

  const recreateWarning = await recreateCapturesDir();
  if (recreateWarning) warnings.push(recreateWarning);

  const { rows_skipped, warning: skipWarning } =
    markPendingDeliberationsSkipped();
  if (skipWarning) warnings.push(skipWarning);

  const resetWarning = safeMonitorReset();
  if (resetWarning) warnings.push(resetWarning);

  const auditWarning = safeAudit(filesDeleted, rows_skipped, reason);
  if (auditWarning) warnings.push(auditWarning);

  return {
    ok: true,
    files_deleted: filesDeleted,
    rows_skipped,
    warnings,
  };
}

/**
 * Run the wipe. Always resolves — every failure mode surfaces as a warning
 * inside {@link PanicWipeResult.warnings}, never as a thrown error.
 *
 * @param opts.reason - Free-form tag baked into the audit payload. Defaults
 *   to `'manual'` for tray / hotkey invocations.
 */
export async function runPanicWipe(
  opts: { reason?: string } = {},
): Promise<PanicWipeResult> {
  const reason = opts.reason ?? 'manual';
  const monitor = getMonitorHandle();
  // When a monitor is registered, run inside its mutex so an in-flight
  // tickScreenshot can't race with the rename. Otherwise (boot failure or
  // test harness) run unguarded — the rename is atomic anyway.
  if (monitor !== null) {
    return monitor.withLock(() => performWipe(reason));
  }
  return performWipe(reason);
}
