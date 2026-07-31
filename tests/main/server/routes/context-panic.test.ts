/**
 * `POST /api/context/panic/wipe` route tests.
 *
 * Boots the real API server against the mocked TaskPilot home + in-memory
 * DB. Verifies the destructive wipe:
 *   - renames + removes the captures dir (atomic rename, async fs.rm)
 *   - marks every pending deliberation as `skipped`
 *   - emits an `appendAuditEventSafe({ kind: 'panic_wipe', ... })` record
 *   - returns `{ ok: true, files_deleted, rows_skipped, warnings }`
 *
 * Auth is disabled here (matches the other context tests via the env var
 * the helper sets). We don't register a real monitor handle — the wipe
 * module falls back to running without the lock when none is published,
 * which mirrors the boot-failure path in production.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { mockTaskpilotPaths } from '../../../helpers/mock-paths';
import { useMockedDb } from '../../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { readRecentAuditEvents } from '@/main/audit';
import { setMonitorHandle } from '@/main/monitor/handle';

let handle: ApiServerHandle;
let baseUrl: string;

/* -------------------------------------------------------------------------- */
/*  Setup                                                                     */
/* -------------------------------------------------------------------------- */

function seedCaptureFiles(count: number): string[] {
  fs.mkdirSync(PATHS.CAPTURES_DIR, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(
      PATHS.CAPTURES_DIR,
      `cap_${i.toString(16).padStart(16, '0')}.png`,
    );
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    paths.push(p);
  }
  return paths;
}

function seedPendingDeliberations(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = deliberationsRepository.create({
      batch_id: `batch-${i}`,
      observation_ids: [`obs-${i}`],
      trigger_reason: 'manual',
    });
    ids.push(row.id);
  }
  return ids;
}

describe('POST /api/context/panic/wipe', () => {
  useMockedDb();

  beforeAll(async () => {
    handle = await startApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }, 30_000);

  afterAll(async () => {
    if (handle) {
      await Promise.race([
        handle.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }, 30_000);

  beforeEach(() => {
    // No registered monitor — the wipe module falls back to running
    // without the lock, which is the same behavior the boot-failure path
    // exercises in production.
    setMonitorHandle(null);
  });

  it('renames the captures dir, recreates it empty, and reports the file count', async () => {
    const files = seedCaptureFiles(3);
    expect(files.every((p) => fs.existsSync(p))).toBe(true);

    const res = await fetch(`${baseUrl}/api/context/panic/wipe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      files_deleted: number;
      rows_skipped: number;
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.files_deleted).toBe(3);

    // Captures dir was recreated empty.
    expect(fs.existsSync(PATHS.CAPTURES_DIR)).toBe(true);
    const recreated = fs.readdirSync(PATHS.CAPTURES_DIR);
    expect(recreated).toHaveLength(0);

    // The original screenshot files are no longer at their pre-wipe paths.
    expect(files.some((p) => fs.existsSync(p))).toBe(false);
  });

  it('marks every pending deliberation as skipped', async () => {
    const ids = seedPendingDeliberations(2);

    const res = await fetch(`${baseUrl}/api/context/panic/wipe`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      files_deleted: number;
      rows_skipped: number;
      warnings: string[];
    };
    expect(body.rows_skipped).toBe(2);

    for (const id of ids) {
      const row = deliberationsRepository.get(id);
      expect(row?.status).toBe('skipped');
      expect(row?.summary).toBe('panic_wipe');
    }
  });

  it('emits a panic_wipe audit event with the counts', async () => {
    seedCaptureFiles(1);
    seedPendingDeliberations(1);

    const res = await fetch(`${baseUrl}/api/context/panic/wipe`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const recent = readRecentAuditEvents({ limit: 50 });
    const panicEvents = recent.filter((e) => e.kind === 'panic_wipe');
    expect(panicEvents.length).toBeGreaterThan(0);
    const newest = panicEvents[0]!;
    expect(newest.payload['files_deleted']).toBe(1);
    expect(newest.payload['rows_skipped']).toBe(1);
    // Reason is baked in by the route — `api` distinguishes HTTP-triggered
    // wipes from the `tray` and `manual` callers.
    expect(newest.payload['reason']).toBe('api');
  });

  it('returns ok:true with no warnings when the captures dir is already missing', async () => {
    // Pre-condition: scrub the captures dir manually so the wipe sees ENOENT.
    fs.rmSync(PATHS.CAPTURES_DIR, { recursive: true, force: true });
    expect(fs.existsSync(PATHS.CAPTURES_DIR)).toBe(false);

    const res = await fetch(`${baseUrl}/api/context/panic/wipe`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      files_deleted: number;
      rows_skipped: number;
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.files_deleted).toBe(0);
    expect(body.warnings).toEqual([]);
    // Dir was recreated even though it was missing pre-call.
    expect(fs.existsSync(PATHS.CAPTURES_DIR)).toBe(true);
  });
});
