/**
 * Archive-on-ingestion tests for the deliberation pipeline.
 *
 * Verifies the watcher-leak fix: after `ingestDeliberation()` commits the
 * `deliberations` row, the original `IO_DELIBERATE/<batch_id>.json` request
 * file MUST be moved to `IO_DONE_ARCHIVE_DELIBERATE/<batch_id>.json` so:
 *
 *   - the live `deliberate/` directory doesn't grow unboundedly;
 *   - the watcher can't re-dispatch a request that's already been consumed
 *     on a subsequent boot.
 *
 * Cases covered:
 *   (a) successful archival when the request file exists;
 *   (b) idempotent / no-throw when the request file is missing;
 *   (c) DB row is still completed even if the archive step throws.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

vi.mock('@/main/notifications', () => ({
  notify: () => {
    /* no-op for tests */
  },
}));

import { ingestDeliberation } from '@/main/deliberation/ingestion';
import * as deliberationProtocol from '@/main/deliberation/protocol';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import type { DeliberationResult } from '@/shared/io-schemas';

function seedPending(batchId: string): string {
  const row = deliberationsRepository.create({
    batch_id: batchId,
    observation_ids: ['obs1'],
    trigger_reason: 'batch_size',
  });
  return row.id;
}

function buildResult(batchId: string): DeliberationResult {
  return {
    batch_id: batchId,
    completed_at: '2026-06-01T12:00:00Z',
    interrupter: {
      score: 0.2,
      reasoning: 'low signal',
      proposed_action: { type: 'none' },
    },
    waiter: { score: 0.9, reasoning: 'routine' },
    decision: 'wait',
    summary: 'no action needed',
    confidence: 0.8,
  };
}

async function writeRequestFile(batchId: string, payload: unknown): Promise<string> {
  const dest = path.join(PATHS.IO_DELIBERATE, `${batchId}.json`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return dest;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('ingestDeliberation — request archival', () => {
  useMockedDb();

  it('(a) moves the request file from deliberate/ into _done-archive/deliberate/ on success', async () => {
    const batchId = 'b_archive_ok';
    seedPending(batchId);

    const requestPath = await writeRequestFile(batchId, {
      kind: 'deliberation_request',
      id: batchId,
      observations: [],
    });
    const archivePath = path.join(
      PATHS.IO_DONE_ARCHIVE_DELIBERATE,
      `${batchId}.json`,
    );

    expect(await fileExists(requestPath)).toBe(true);
    expect(await fileExists(archivePath)).toBe(false);

    const updated = await ingestDeliberation(buildResult(batchId));
    expect(updated?.status).toBe('completed');

    // Live request gone, archived copy present.
    expect(await fileExists(requestPath)).toBe(false);
    expect(await fileExists(archivePath)).toBe(true);

    // Original payload preserved (forensic trail).
    const archivedBody = await fs.readFile(archivePath, 'utf8');
    expect(archivedBody).toContain(batchId);
  });

  it('(b) is idempotent when the source request file is missing (race / cold start)', async () => {
    const batchId = 'b_archive_missing';
    seedPending(batchId);

    const requestPath = path.join(PATHS.IO_DELIBERATE, `${batchId}.json`);
    const archivePath = path.join(
      PATHS.IO_DONE_ARCHIVE_DELIBERATE,
      `${batchId}.json`,
    );

    // No request file on disk — simulates a watcher restart after the request
    // was already cleaned up (or the operator hand-crafted the result).
    expect(await fileExists(requestPath)).toBe(false);

    // Should NOT throw, should still complete the row.
    const updated = await ingestDeliberation(buildResult(batchId));
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('completed');

    // No archive entry was created (there was nothing to move).
    expect(await fileExists(archivePath)).toBe(false);
  });

  it('(c) still completes the deliberations row when the archive step throws', async () => {
    const batchId = 'b_archive_throws';
    seedPending(batchId);

    await writeRequestFile(batchId, { kind: 'deliberation_request', id: batchId });

    // Force the archive step to blow up — proves the try/catch in
    // ingestDeliberation insulates the DB commit from filesystem failure.
    const spy = vi
      .spyOn(deliberationProtocol, 'archiveDeliberationRequest')
      .mockRejectedValueOnce(new Error('simulated filesystem failure'));

    let updated;
    try {
      updated = await ingestDeliberation(buildResult(batchId));
    } finally {
      spy.mockRestore();
    }

    // Row was committed regardless of the archive failure.
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('completed');
    expect(updated?.decision).toBe('wait');
  });
});
