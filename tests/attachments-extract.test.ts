/**
 * Attachment text extraction tests.
 *
 * Covers:
 *   - detectFormat — extension-first, MIME tiebreak
 *   - clipUtf8 — never splits a multi-byte codepoint
 *   - text / csv extraction (no binary fixtures required)
 *   - cache freshness — re-saving the source invalidates the cached text
 *   - readCachedTextSync — what the FTS5 indexer relies on
 *   - unsupported formats fail loud with ok: false
 *   - format-specific extractors (PDF / DOCX / XLSX) are NOT exercised here —
 *     they're thin wrappers around well-tested libs; a real run on a Windows
 *     desktop with sample documents is the integration check.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import {
  detectFormat,
  extractAttachmentText,
  extractAndCache,
  readCachedTextSync,
  __testing,
} from '@/main/attachments/extract';
import { flushExtractionQueue, saveAttachment } from '@/main/attachments';
import { createTask } from '@/main/db/repositories/tasks';

function makeTask(): { id: string } {
  return { id: createTask({ title: 'extract-test', priority: 'p2' }).id };
}

describe('extract — detectFormat', () => {
  it('maps known extensions', () => {
    expect(detectFormat('a.pdf')).toBe('pdf');
    expect(detectFormat('A.PDF')).toBe('pdf');
    expect(detectFormat('a.docx')).toBe('docx');
    expect(detectFormat('a.xlsx')).toBe('xlsx');
    expect(detectFormat('a.xlsm')).toBe('xlsx');
    expect(detectFormat('a.csv')).toBe('csv');
    expect(detectFormat('a.tsv')).toBe('csv');
    expect(detectFormat('a.md')).toBe('text');
    expect(detectFormat('a.json')).toBe('text');
    expect(detectFormat('a.ts')).toBe('text');
    expect(detectFormat('a.py')).toBe('text');
  });

  it('treats legacy binary .xls as unsupported (ExcelJS only parses OOXML)', () => {
    expect(detectFormat('a.xls')).toBe('unsupported');
  });

  it('falls back to MIME for unknown extensions', () => {
    expect(detectFormat('blob', 'application/pdf')).toBe('pdf');
    expect(
      detectFormat(
        'blob',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
    expect(
      detectFormat(
        'blob',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('xlsx');
    expect(detectFormat('blob', 'text/plain; charset=utf-8')).toBe('text');
    expect(detectFormat('blob', 'application/json')).toBe('text');
  });

  it('returns unsupported when neither extension nor MIME hints anything', () => {
    expect(detectFormat('mystery')).toBe('unsupported');
    expect(detectFormat('mystery', 'application/octet-stream')).toBe(
      'unsupported',
    );
  });
});

describe('extract — clipUtf8', () => {
  const { clipUtf8 } = __testing;

  it('returns input unchanged when under the cap', () => {
    expect(clipUtf8('hello', 100)).toBe('hello');
  });

  it('clips to byte length, not character count', () => {
    const long = 'a'.repeat(2000);
    const out = clipUtf8(long, 100);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('does not split a multi-byte codepoint', () => {
    // 'é' is 2 UTF-8 bytes; cap of 3 should give us "aé" or "a", never half-é.
    const out = clipUtf8('aéaéaéaé', 3);
    // No replacement characters — i.e. nothing got mangled.
    expect(out).not.toContain('�');
    // Cap respected.
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(3);
  });
});

describe('extract — text + csv roundtrip', () => {
  useMockedDb();

  beforeEach(async () => {
    // Drain any extraction kicked off by a previous test so its writeCache
    // can't race the rm below.
    await flushExtractionQueue();
    if (fs.existsSync(PATHS.ATTACHMENTS_DIR)) {
      fs.rmSync(PATHS.ATTACHMENTS_DIR, { recursive: true, force: true });
    }
  });

  it('extracts plain text and caches the result', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'note.md',
      data: Buffer.from('# heading\n\nbody text here', 'utf8'),
      contentType: 'text/markdown',
    });

    const result = await extractAndCache(id, 'note.md');
    expect(result.ok).toBe(true);
    expect(result.format).toBe('text');
    expect(result.text).toContain('body text here');
    expect(result.cached).toBe(false);

    // Cache file should now exist
    const cached = readCachedTextSync(id, 'note.md');
    expect(cached).not.toBeNull();
    expect(cached).toContain('body text here');
  });

  it('reads the cached text on subsequent calls', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'a.txt',
      data: Buffer.from('one line', 'utf8'),
    });
    // Drain the background extract triggered by saveAttachment so the cache
    // is populated. The next call should be a cache hit.
    await flushExtractionQueue();
    const cached = await extractAttachmentText(id, 'a.txt');
    expect(cached.cached).toBe(true);
    expect(cached.text).toBe('one line');
  });

  it('extracts CSV verbatim', async () => {
    const { id } = makeTask();
    const csv = 'name,age\nalice,30\nbob,25\n';
    await saveAttachment({
      taskId: id,
      filename: 'people.csv',
      data: Buffer.from(csv, 'utf8'),
    });
    const result = await extractAndCache(id, 'people.csv');
    expect(result.ok).toBe(true);
    expect(result.format).toBe('csv');
    expect(result.text.replace(/\n+/g, '\n')).toBe(csv.trim());
  });
});

describe('extract — cache invalidation', () => {
  useMockedDb();

  beforeEach(async () => {
    // Drain any extraction kicked off by a previous test so its writeCache
    // can't race the rm below.
    await flushExtractionQueue();
    if (fs.existsSync(PATHS.ATTACHMENTS_DIR)) {
      fs.rmSync(PATHS.ATTACHMENTS_DIR, { recursive: true, force: true });
    }
  });

  it('re-saving an attachment invalidates the cached text', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'v.txt',
      data: Buffer.from('version 1', 'utf8'),
    });
    // Drain the background extraction so we observe a clean cache state.
    await flushExtractionQueue();
    const first = await extractAttachmentText(id, 'v.txt');
    expect(first.text).toBe('version 1');

    // Re-save with new bytes. The size cross-check in `cacheFreshness` —
    // not the mtime — is what guarantees the stale cache is rejected here:
    // sub-millisecond re-saves can land with the same mtimeMs on some
    // filesystems, but the recorded srcSize ('version 1'.length = 9) won't
    // match the new srcSize ('version 22'.length = 10).
    await saveAttachment({
      taskId: id,
      filename: 'v.txt',
      data: Buffer.from('version 22', 'utf8'),
    });
    await flushExtractionQueue();
    const second = await extractAttachmentText(id, 'v.txt');
    expect(second.text).toBe('version 22');
  });
});

describe('extract — failure modes', () => {
  useMockedDb();

  beforeEach(async () => {
    // Drain any extraction kicked off by a previous test so its writeCache
    // can't race the rm below.
    await flushExtractionQueue();
    if (fs.existsSync(PATHS.ATTACHMENTS_DIR)) {
      fs.rmSync(PATHS.ATTACHMENTS_DIR, { recursive: true, force: true });
    }
  });

  it('returns ok: false for unsupported formats', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'unknown.bin',
      data: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      contentType: 'application/octet-stream',
    });
    const result = await extractAndCache(id, 'unknown.bin');
    expect(result.ok).toBe(false);
    expect(result.format).toBe('unsupported');
    expect(result.reason).toMatch(/Unsupported/i);
  });

  it('returns ok: false when the attachment does not exist', async () => {
    const { id } = makeTask();
    const result = await extractAndCache(id, 'missing.txt');
    expect(result.ok).toBe(false);
    // The attachment metadata lookup throws before we read bytes, so the
    // reason carries the "not_found" message.
    expect(result.reason).toMatch(/not found/i);
  });

  it('short-circuits on a cached error marker for unsupported files', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'binary.bin',
      data: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      contentType: 'application/octet-stream',
    });
    // Drain the background extract so an .err marker has been written.
    await flushExtractionQueue();
    // First read after drain — should hit the cached .err marker rather
    // than re-reading the bytes.
    const first = await extractAttachmentText(id, 'binary.bin');
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/Unsupported/i);
    // Second read — same behavior; the .err marker is still within TTL.
    const second = await extractAttachmentText(id, 'binary.bin');
    expect(second.ok).toBe(false);
  });
});

describe('extract — readCachedTextSync', () => {
  useMockedDb();

  beforeEach(async () => {
    // Drain any extraction kicked off by a previous test so its writeCache
    // can't race the rm below.
    await flushExtractionQueue();
    if (fs.existsSync(PATHS.ATTACHMENTS_DIR)) {
      fs.rmSync(PATHS.ATTACHMENTS_DIR, { recursive: true, force: true });
    }
  });

  it('returns null when no cache exists', () => {
    const { id } = makeTask();
    expect(readCachedTextSync(id, 'nope.txt')).toBeNull();
  });

  it('returns the cached text after extraction', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'c.txt',
      data: Buffer.from('hi from cache', 'utf8'),
    });
    await extractAndCache(id, 'c.txt');

    const cached = readCachedTextSync(id, 'c.txt');
    expect(cached).not.toBeNull();
    expect(cached).toContain('hi from cache');

    // Path matches the documented contract.
    const expected = path.join(
      PATHS.ATTACHMENTS_DIR,
      id,
      '.extracted',
      'c.txt.txt',
    );
    expect(fs.existsSync(expected)).toBe(true);
  });
});
