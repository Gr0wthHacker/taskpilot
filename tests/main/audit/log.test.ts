/**
 * Audit log tests.
 *
 * Covers:
 *   - encrypt/decrypt round-trip when Electron `safeStorage` is available
 *   - plaintext fallback when `safeStorage` is unavailable (production path
 *     on Linux without libsecret + the default test environment)
 *   - append-only semantics: a second append doesn't rewrite the first line
 *   - partial-write safety: a corrupt trailing line doesn't break the read
 *     of earlier rows
 *   - retention: per-month files older than the cutoff get unlinked, newer
 *     ones survive
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

import {
  __resetSafeStorageCacheForTests,
  __setSafeStorageForTests,
  appendAuditEvent,
  appendAuditEventSafe,
  auditFilePathFor,
  deserializeAuditLine,
  logPanicWipe,
  readRecentAuditEvents,
  runAuditRetention,
  serializeAuditLine,
} from '@/main/audit';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function readAllLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

function wipeAuditDir(): void {
  if (!fs.existsSync(PATHS.AUDIT_DIR)) return;
  for (const name of fs.readdirSync(PATHS.AUDIT_DIR)) {
    fs.unlinkSync(path.join(PATHS.AUDIT_DIR, name));
  }
}

describe('audit log — append/read', () => {
  beforeEach(() => {
    wipeAuditDir();
    __resetSafeStorageCacheForTests();
  });

  afterEach(() => {
    __resetSafeStorageCacheForTests();
  });

  it('writes plaintext lines when safeStorage is unavailable in tests', () => {
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T10:00:00.000Z',
      payload: { id: 'obs1', source: 'browser' },
    });

    const file = auditFilePathFor('2026-06-02T10:00:00.000Z');
    const lines = readAllLines(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('plain:') || lines[0]?.startsWith('safe:')).toBe(
      true,
    );

    const event = deserializeAuditLine(lines[0]!);
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('observation_created');
    expect(event?.ts).toBe('2026-06-02T10:00:00.000Z');
    expect(event?.payload['id']).toBe('obs1');
  });

  it('round-trips an event through serialize/deserialize', () => {
    const line = serializeAuditLine({
      kind: 'deliberation_requested',
      ts: '2026-06-02T11:00:00.000Z',
      payload: { batch_id: 'b_abc', observation_count: 7 },
    });
    expect(line.endsWith('\n')).toBe(true);
    const event = deserializeAuditLine(line);
    expect(event?.kind).toBe('deliberation_requested');
    expect(event?.payload['batch_id']).toBe('b_abc');
    expect(event?.payload['observation_count']).toBe(7);
  });

  it('handles encrypted (safe:) lines when a safeStorage stub is injected', () => {
    // The lazy `require('electron')` inside loadSafeStorage isn't visible to
    // vi.doMock (which only intercepts `import`), so go through the
    // `__setSafeStorageForTests` injection hook instead. The stub uses an
    // `ENC:` prefix as a stand-in for real encryption — good enough to assert
    // the safe-prefix path is exercised end-to-end.
    __setSafeStorageForTests({
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`ENC:${s}`, 'utf8'),
      decryptString: (b: Buffer) => {
        const raw = b.toString('utf8');
        if (!raw.startsWith('ENC:')) throw new Error('bad ciphertext');
        return raw.slice(4);
      },
    });

    try {
      appendAuditEvent({
        kind: 'deliberation_completed',
        ts: '2026-06-02T12:00:00.000Z',
        payload: { batch_id: 'b_xyz', decision: 'wait' },
      });

      const file = auditFilePathFor('2026-06-02T12:00:00.000Z');
      const lines = readAllLines(file);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.startsWith('safe:')).toBe(true);

      const event = deserializeAuditLine(lines[0]!);
      expect(event?.kind).toBe('deliberation_completed');
      expect(event?.payload['batch_id']).toBe('b_xyz');
    } finally {
      __resetSafeStorageCacheForTests();
    }
  });

  it('is append-only across multiple writes (later append does not rewrite earlier lines)', () => {
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T10:00:00.000Z',
      payload: { n: 1 },
    });
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T10:05:00.000Z',
      payload: { n: 2 },
    });
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T10:10:00.000Z',
      payload: { n: 3 },
    });

    const file = auditFilePathFor('2026-06-02T10:00:00.000Z');
    const lines = readAllLines(file);
    expect(lines).toHaveLength(3);

    const decoded = lines.map((l) => deserializeAuditLine(l));
    expect(decoded[0]?.payload['n']).toBe(1);
    expect(decoded[1]?.payload['n']).toBe(2);
    expect(decoded[2]?.payload['n']).toBe(3);
  });

  it('reads recent events newest-first via readRecentAuditEvents', () => {
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T08:00:00.000Z',
      payload: { n: 1 },
    });
    appendAuditEvent({
      kind: 'deliberation_requested',
      ts: '2026-06-02T09:00:00.000Z',
      payload: { n: 2 },
    });
    appendAuditEvent({
      kind: 'deliberation_completed',
      ts: '2026-06-02T10:00:00.000Z',
      payload: { n: 3 },
    });

    const events = readRecentAuditEvents({ limit: 10 });
    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe('deliberation_completed');
    expect(events[2]?.kind).toBe('observation_created');
  });

  it('filters by kind in readRecentAuditEvents', () => {
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T08:00:00.000Z',
      payload: {},
    });
    appendAuditEvent({
      kind: 'deliberation_requested',
      ts: '2026-06-02T09:00:00.000Z',
      payload: {},
    });
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T10:00:00.000Z',
      payload: {},
    });

    const onlyObs = readRecentAuditEvents({ kind: 'observation_created' });
    expect(onlyObs).toHaveLength(2);
    for (const e of onlyObs) expect(e.kind).toBe('observation_created');
  });

  it('survives a corrupt trailing line — earlier rows are still readable', () => {
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T10:00:00.000Z',
      payload: { n: 1 },
    });
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T10:05:00.000Z',
      payload: { n: 2 },
    });

    // Simulate a partial write by appending a half-truncated line. The reader
    // must drop the bad line, not abort.
    const file = auditFilePathFor('2026-06-02T10:00:00.000Z');
    fs.appendFileSync(file, 'plain:!!!!not-valid-base64??\n', 'utf8');

    const events = readRecentAuditEvents({ limit: 10 });
    expect(events).toHaveLength(2);
    expect(events[0]?.payload['n']).toBe(2);
    expect(events[1]?.payload['n']).toBe(1);
  });

  it('appendAuditEventSafe never throws even if the audit dir is replaced by a file', () => {
    // Wipe + place a regular file where the directory should be. The next
    // append() should warn and return without raising.
    wipeAuditDir();
    try {
      fs.rmdirSync(PATHS.AUDIT_DIR);
    } catch {
      /* dir may not exist */
    }
    fs.writeFileSync(PATHS.AUDIT_DIR, 'I am a file, not a directory', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() =>
        appendAuditEventSafe({
          kind: 'observation_created',
          payload: { id: 'will-fail' },
        }),
      ).not.toThrow();
    } finally {
      warn.mockRestore();
      try {
        fs.unlinkSync(PATHS.AUDIT_DIR);
      } catch {
        /* tolerate */
      }
      fs.mkdirSync(PATHS.AUDIT_DIR, { recursive: true });
    }
  });

  it('logPanicWipe records a typed panic_wipe row', () => {
    logPanicWipe({
      files_deleted: 4,
      rows_skipped: 1,
      lookback_hours: 24,
      reason: 'manual',
    });
    const events = readRecentAuditEvents({ kind: 'panic_wipe' });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['files_deleted']).toBe(4);
    expect(events[0]?.payload['rows_skipped']).toBe(1);
    expect(events[0]?.payload['lookback_hours']).toBe(24);
    expect(events[0]?.payload['reason']).toBe('manual');
  });

  it('routes events into per-month files based on the ts', () => {
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-05-15T12:00:00.000Z',
      payload: { n: 1 },
    });
    appendAuditEvent({
      kind: 'observation_created',
      ts: '2026-06-02T12:00:00.000Z',
      payload: { n: 2 },
    });

    const may = path.join(PATHS.AUDIT_DIR, 'ambient-2026-05.jsonl.enc');
    const jun = path.join(PATHS.AUDIT_DIR, 'ambient-2026-06.jsonl.enc');
    expect(fs.existsSync(may)).toBe(true);
    expect(fs.existsSync(jun)).toBe(true);
    expect(readAllLines(may)).toHaveLength(1);
    expect(readAllLines(jun)).toHaveLength(1);
  });
});

describe('audit retention', () => {
  beforeEach(() => {
    wipeAuditDir();
    __resetSafeStorageCacheForTests();
  });

  it('unlinks per-month files older than the retention window', () => {
    // Create fixture files directly so we don't depend on the system clock.
    fs.writeFileSync(
      path.join(PATHS.AUDIT_DIR, 'ambient-2025-01.jsonl.enc'),
      'plain:e30=\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(PATHS.AUDIT_DIR, 'ambient-2026-05.jsonl.enc'),
      'plain:e30=\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(PATHS.AUDIT_DIR, 'ambient-2026-06.jsonl.enc'),
      'plain:e30=\n',
      'utf8',
    );

    // Pretend "now" is 2026-06-02 with a 90-day window. 2025-01 is way out;
    // 2026-05 (ended 2026-05-31) is ~3 days inside the window, so it stays;
    // 2026-06 (current) stays trivially.
    const now = new Date('2026-06-02T00:00:00.000Z');
    const result = runAuditRetention(90, now);
    expect(result.filesDeleted).toBe(1);
    expect(
      fs.existsSync(path.join(PATHS.AUDIT_DIR, 'ambient-2025-01.jsonl.enc')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(PATHS.AUDIT_DIR, 'ambient-2026-05.jsonl.enc')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(PATHS.AUDIT_DIR, 'ambient-2026-06.jsonl.enc')),
    ).toBe(true);
  });

  it('ignores stray non-audit files in the directory', () => {
    fs.writeFileSync(
      path.join(PATHS.AUDIT_DIR, 'README.md'),
      '# do not delete me',
      'utf8',
    );
    fs.writeFileSync(
      path.join(PATHS.AUDIT_DIR, 'ambient-2025-01.jsonl.enc'),
      'plain:e30=\n',
      'utf8',
    );
    const now = new Date('2026-06-02T00:00:00.000Z');
    runAuditRetention(90, now);
    expect(fs.existsSync(path.join(PATHS.AUDIT_DIR, 'README.md'))).toBe(true);
  });

  it('returns scanned=0 deleted=0 when the directory is missing', () => {
    wipeAuditDir();
    fs.rmdirSync(PATHS.AUDIT_DIR);
    const result = runAuditRetention(90, new Date('2026-06-02T00:00:00.000Z'));
    expect(result.filesScanned).toBe(0);
    expect(result.filesDeleted).toBe(0);
    // Recreate so subsequent tests in the suite still have a place to write.
    fs.mkdirSync(PATHS.AUDIT_DIR, { recursive: true });
  });
});
