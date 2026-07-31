/**
 * Deliberation IO protocol — mirrors the derive/execute pattern.
 *
 * The app writes a `deliberation_request` payload into
 * `~/.taskpilot/io/deliberate/<batch_id>.json`. Claude (via the
 * `ambient-deliberate` skill) reads it, runs the two-agent (interrupter vs
 * waiter) scoring, and writes the verdict to
 * `~/.taskpilot/io/deliberated/<batch_id>.json`. The watcher dispatches the
 * verdict to {@link import('./ingestion').ingestDeliberation}.
 *
 * Atomic writes: serialise → `.tmp` sibling → fsync → rename. Same pattern as
 * `@/main/io/protocol`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { IO_DONE_ARCHIVE_DELIBERATE } from '@/shared/constants';
import {
  deliberatePath,
  deliberatedPath,
  ensureIoDirs,
} from '@/main/io/paths';
import {
  deliberationRequestSchema,
  deliberationResultSchema,
} from '@/shared/io-schemas';
import type {
  DeliberationRequest,
  DeliberationResult,
} from '@/shared/io-schemas';

/**
 * Atomic JSON write. Identical strategy to `@/main/io/protocol#writeJsonAtomic`
 * — duplicated here so the deliberation module has no compile-time dep on the
 * task io protocol (the two layers happen to share an idiom).
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Validate `request` against the schema and write it to
 * `IO_DELIBERATE/<batch_id>.json`. Returns the absolute path written.
 */
export async function writeDeliberationRequest(
  request: DeliberationRequest,
): Promise<string> {
  await ensureIoDirs();
  const parsed = deliberationRequestSchema.parse(request);
  const dest = deliberatePath(parsed.id);
  await writeJsonAtomic(dest, parsed);
  return dest;
}

/**
 * Read + validate `IO_DELIBERATED/<batch_id>.json`. Returns `null` when the
 * file does not exist. Throws on schema failure.
 */
export async function readDeliberationResult(
  batchId: string,
): Promise<DeliberationResult | null> {
  const dest = deliberatedPath(batchId);
  let text: string;
  try {
    text = await fs.readFile(dest, 'utf8');
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const raw: unknown = JSON.parse(text);
  return deliberationResultSchema.parse(raw);
}

/**
 * Remove the request + response files for `batchId` once ingestion has
 * persisted the row. Missing files are ignored.
 */
export async function cleanupDeliberation(batchId: string): Promise<void> {
  for (const p of [deliberatePath(batchId), deliberatedPath(batchId)]) {
    try {
      await fs.unlink(p);
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/**
 * Move the consumed request file at `IO_DELIBERATE/<batchId>.json` into
 * `IO_DONE_ARCHIVE_DELIBERATE/<batchId>.json`. Called by `ingestDeliberation`
 * after the `deliberations` row is committed so the live `deliberate/` dir
 * stays bounded and the watcher cannot re-dispatch an already-consumed batch
 * on next boot.
 *
 * Idempotent: if the request file is missing (race, cold start, hand-crafted
 * result), returns silently with no archive entry created — caller does not
 * need to special-case the missing file. Errors other than ENOENT propagate
 * up so the caller (which catches them) can record a metric without losing
 * the DB commit.
 */
export async function archiveDeliberationRequest(
  batchId: string,
): Promise<void> {
  const src = deliberatePath(batchId);
  const dest = path.join(IO_DONE_ARCHIVE_DELIBERATE, `${batchId}.json`);
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  } catch (err: unknown) {
    if (isNotFound(err)) return;
    // Cross-device fallback: rename can fail across mount points with EXDEV.
    // Copy + unlink preserves the forensic trail in that case.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'EXDEV'
    ) {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
      return;
    }
    throw err;
  }
}
