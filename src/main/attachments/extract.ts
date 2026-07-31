/**
 * Attachment text extraction.
 *
 * Turns binary attachments (PDF, DOCX, XLSX, CSV, plus text-y formats like
 * .txt / .md / .json / source code) into plain text that derive prompts,
 * execute requests, MCP tools, and the FTS5 search index can use.
 *
 * Extractions are cached on disk under
 *   `~/.taskpilot/attachments/<task-id>/.extracted/<filename>.txt`
 * Re-extracting an attachment is therefore a single file read — no parsing.
 * The cache is invalidated implicitly on re-save (the attachment's mtime
 * advances past the cache's, which {@link readCachedText} checks before
 * trusting the cached copy).
 *
 * Every public function is best-effort. Extraction errors are caught, written
 * to a sibling `.err` file (so we don't retry forever), and surface as
 * `{ ok: false, reason }` results — they never throw out of the module.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ATTACHMENTS_DIR,
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
} from '@/shared/constants';
import { settingsRepository } from '@/main/db/repositories/settings';

import {
  attachmentPath,
  attachmentsDirForTask,
  readAttachmentBytes,
} from './index';

/* -------------------------------------------------------------------------- */
/*  Types & constants                                                         */
/* -------------------------------------------------------------------------- */

export type ExtractionFormat =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'text'
  | 'unsupported';

export interface ExtractionResult {
  ok: boolean;
  /** Plain text content, empty string when ok=false. */
  text: string;
  /** Inferred format used for extraction. */
  format: ExtractionFormat;
  /** Bytes in the extracted text payload (after any truncation). */
  byte_length: number;
  /** True when the text was clipped at the per-attachment cap. */
  truncated: boolean;
  /** True when the result came from the on-disk cache. */
  cached: boolean;
  /** Reason for failure when ok=false. */
  reason: string | null;
}

const DEFAULT_MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB of extracted text
const EXTRACTED_SUBDIR = '.extracted';
const TEXT_SUFFIX = '.txt';
const ERR_SUFFIX = '.err';
/** Sidecar holding `{ format, srcSize }` alongside the cached text. */
const META_SUFFIX = '.meta.json';
/** TTL for cached extraction failures before we retry. 1 hour. */
const ERR_TTL_MS = 60 * 60 * 1000;
/** Above this ratio of U+FFFD replacement chars, treat the file as binary garbage. */
const REPLACEMENT_RATIO_THRESHOLD = 0.05;

/** Text-y MIME prefixes and file extensions handled with a raw decode. */
const PLAINTEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.log',
  '.ini',
  '.env',
  '.csv',
  '.tsv',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.php',
  '.sh',
  '.bash',
  '.sql',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
]);

/* -------------------------------------------------------------------------- */
/*  Format detection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Decide how to extract a file based on filename + (optionally) MIME hint.
 * Filename wins when the extension is unambiguous; MIME is the tiebreaker for
 * extensionless uploads.
 */
export function detectFormat(filename: string, mime?: string): ExtractionFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  // ExcelJS only parses the OOXML formats (.xlsx, .xlsm). Legacy binary .xls
  // (BIFF) would throw a confusing "End of data reached" zip-parser error
  // from inside `wb.xlsx.load`. Mark .xls as unsupported so callers get a
  // clean reason instead of a stack from deep in the library.
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (PLAINTEXT_EXTS.has(ext)) return 'text';

  if (mime) {
    const m = mime.toLowerCase();
    if (m.includes('pdf')) return 'pdf';
    if (m.includes('wordprocessingml')) return 'docx';
    if (m.includes('spreadsheetml')) return 'xlsx';
    if (m.includes('csv')) return 'csv';
    if (m.startsWith('text/')) return 'text';
    if (m.includes('json') || m.includes('xml')) return 'text';
  }
  return 'unsupported';
}

/* -------------------------------------------------------------------------- */
/*  Cache helpers                                                             */
/* -------------------------------------------------------------------------- */

function extractedDir(taskId: string): string {
  return path.join(attachmentsDirForTask(taskId), EXTRACTED_SUBDIR);
}

function cachedTextPath(taskId: string, filename: string): string {
  return path.join(extractedDir(taskId), `${filename}${TEXT_SUFFIX}`);
}

function cachedErrorPath(taskId: string, filename: string): string {
  return path.join(extractedDir(taskId), `${filename}${ERR_SUFFIX}`);
}

function cachedMetaPath(taskId: string, filename: string): string {
  return path.join(extractedDir(taskId), `${filename}${META_SUFFIX}`);
}

interface CacheFreshness {
  fresh: boolean;
  exists: boolean;
}

interface CachedMeta {
  format: ExtractionFormat;
  srcSize: number;
}

/**
 * Compare attachment vs cached text. The cache is "fresh" when:
 *   1. it exists, AND
 *   2. the cached file's mtime is STRICTLY GREATER than the source's, AND
 *   3. the source size matches what we recorded when we built the cache
 *
 * `mtimeMs >=` was previously enough but breaks on filesystems with coarse
 * mtime resolution (FAT32 = 2s; some Windows network shares = 1s). When a
 * user re-saves an attachment within the same second, the cache would
 * incorrectly serve the stale text. The size cross-check catches the case
 * where mtime ties and content differs.
 */
async function cacheFreshness(
  taskId: string,
  filename: string,
): Promise<CacheFreshness> {
  try {
    const src = await fs.stat(attachmentPath(taskId, filename));
    let cached: Awaited<ReturnType<typeof fs.stat>>;
    try {
      cached = await fs.stat(cachedTextPath(taskId, filename));
    } catch {
      return { fresh: false, exists: false };
    }
    if (cached.mtimeMs <= src.mtimeMs) {
      return { fresh: false, exists: true };
    }
    // Source size must match the one recorded at cache time. Different size
    // → content changed → cache is stale even if mtime says otherwise.
    const meta = await readCachedMeta(taskId, filename);
    if (meta && meta.srcSize !== src.size) {
      return { fresh: false, exists: true };
    }
    return { fresh: true, exists: true };
  } catch {
    return { fresh: false, exists: false };
  }
}

async function readCachedMeta(
  taskId: string,
  filename: string,
): Promise<CachedMeta | null> {
  try {
    const raw = await fs.readFile(cachedMetaPath(taskId, filename), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CachedMeta>;
    if (
      typeof parsed.format === 'string' &&
      typeof parsed.srcSize === 'number'
    ) {
      return { format: parsed.format as ExtractionFormat, srcSize: parsed.srcSize };
    }
  } catch {
    /* missing or corrupt — treat as no meta */
  }
  return null;
}

/**
 * Check for a recent cached failure marker. Returns the failure reason if
 * the marker is fresh (within ERR_TTL_MS), otherwise null. Used to short-
 * circuit repeated extraction attempts on the same unparseable file —
 * without this, calling `extractAttachmentText` on a 100 MB binary in a
 * loop re-reads + re-parses every time.
 */
async function readCachedError(
  taskId: string,
  filename: string,
): Promise<string | null> {
  try {
    const errPath = cachedErrorPath(taskId, filename);
    const stat = await fs.stat(errPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > ERR_TTL_MS) return null;
    const raw = await fs.readFile(errPath, 'utf8');
    // File format: `<iso> <reason>\n`
    const newline = raw.indexOf('\n');
    const line = newline >= 0 ? raw.slice(0, newline) : raw;
    const space = line.indexOf(' ');
    return space >= 0 ? line.slice(space + 1) : line;
  } catch {
    return null;
  }
}

/**
 * Synchronous cache read used by the search indexer (which runs inside a
 * better-sqlite3 transaction and can't await). Returns `null` when no cache
 * exists; does NOT trigger a fresh extraction. The freshness check is
 * intentionally skipped here — a stale cached extraction is still better
 * indexing input than no body, and re-saves trigger an explicit re-extract
 * via {@link extractAndCache} that will overwrite the file.
 */
export function readCachedTextSync(
  taskId: string,
  filename: string,
): string | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('node:fs') as typeof import('node:fs');
  try {
    const p = path.join(
      ATTACHMENTS_DIR,
      taskId,
      EXTRACTED_SUBDIR,
      `${filename}${TEXT_SUFFIX}`,
    );
    if (!fsSync.existsSync(p)) return null;
    const buf = fsSync.readFileSync(p, 'utf8');
    return buf;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Limits                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cap on extracted text per attachment. Overridable via the
 * `attachment_max_extracted_text_bytes` setting.
 */
function maxTextBytes(): number {
  try {
    const raw = settingsRepository.get('attachment_max_extracted_text_bytes');
    if (raw === null || raw === undefined) return DEFAULT_MAX_TEXT_BYTES;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* fall through */
  }
  return DEFAULT_MAX_TEXT_BYTES;
}

/**
 * Cap on the binary input we'll bother to parse. We refuse to parse anything
 * larger than the per-file attachment limit — past that the parser is likely
 * to blow up memory anyway.
 */
function maxBinaryBytes(): number {
  try {
    const raw = settingsRepository.get('attachment_max_file_bytes');
    if (raw === null || raw === undefined) return DEFAULT_ATTACHMENT_MAX_FILE_BYTES;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* fall through */
  }
  return DEFAULT_ATTACHMENT_MAX_FILE_BYTES;
}

/* -------------------------------------------------------------------------- */
/*  Format extractors                                                         */
/* -------------------------------------------------------------------------- */

async function extractPdf(buf: Buffer): Promise<string> {
  // pdf-parse's package main has a debug path that auto-reads a test fixture
  // when the module is required at the top level. Importing the actual
  // implementation file avoids that and shaves ~250ms off boot.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
    data: Buffer,
  ) => Promise<{ text: string }>;
  const result = await pdfParse(buf);
  return result.text ?? '';
}

async function extractDocx(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require('mammoth') as {
    extractRawText: (input: {
      buffer: Buffer;
    }) => Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value ?? '';
}

interface ExcelWorksheet {
  name: string;
  rowCount: number;
  eachRow: (
    options: { includeEmpty: boolean },
    cb: (row: { values: unknown[] }, rowNumber: number) => void,
  ) => void;
}

interface ExcelWorkbook {
  worksheets: ExcelWorksheet[];
  xlsx: {
    load: (buf: ArrayBuffer | Buffer) => Promise<ExcelWorkbook>;
  };
}

async function extractXlsx(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExcelJS = require('exceljs') as { Workbook: new () => ExcelWorkbook };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out: string[] = [];
  for (const sheet of wb.worksheets) {
    out.push(`# Sheet: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      // row.values is 1-indexed; slot 0 is undefined.
      const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
      const line = cells
        .map((v) => (v === null || v === undefined ? '' : formatCell(v)))
        .join('\t')
        .trimEnd();
      if (line.length > 0) out.push(line);
    });
    out.push('');
  }
  return out.join('\n');
}

/**
 * Render an Excel cell value as a flat string. Hyperlinks come through as
 * `{ text, hyperlink }`, rich text as `{ richText: [{ text }] }`, formulas
 * as `{ result, formula }` — we surface the displayed text in every case.
 */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  const v = value as Record<string, unknown>;
  if (typeof v.text === 'string') return v.text;
  if ('richText' in v && Array.isArray(v.richText)) {
    return (v.richText as Array<{ text?: string }>)
      .map((r) => r.text ?? '')
      .join('');
  }
  if ('result' in v) return String(v.result ?? '');
  if ('formula' in v) return String(v.formula ?? '');
  return JSON.stringify(value);
}

/**
 * CSV / TSV. We don't parse — the raw text is what callers want.
 */
function extractCsv(buf: Buffer): string {
  return buf.toString('utf8');
}

/**
 * Plain-text / source-code formats. Decode as UTF-8 with replacement chars
 * for invalid sequences — the `fatal: false` decoder never throws, so a
 * truly binary file decodes to a string full of U+FFFD and is caught by
 * the garbage-detection check in `doExtractAndCache`.
 */
function extractText(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/* -------------------------------------------------------------------------- */
/*  Public entry points                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read the cached extraction if fresh; otherwise extract, cache, and return.
 * Short-circuits on a fresh cached error marker so repeated calls on an
 * unparseable file don't re-read the bytes every time. The async path is
 * what API/MCP callers use. The synchronous {@link readCachedTextSync} is
 * the indexer's lighter-weight path.
 */
export async function extractAttachmentText(
  taskId: string,
  filename: string,
): Promise<ExtractionResult> {
  const freshness = await cacheFreshness(taskId, filename);
  if (freshness.fresh) {
    try {
      const text = await fs.readFile(cachedTextPath(taskId, filename), 'utf8');
      // Prefer the stored format from the sidecar — for extensionless files
      // whose format was resolved via MIME at extract time, the filename
      // alone can't recover that decision.
      const meta = await readCachedMeta(taskId, filename);
      return {
        ok: true,
        text,
        format: meta?.format ?? detectFormatForKnown(filename),
        byte_length: Buffer.byteLength(text, 'utf8'),
        truncated: false,
        cached: true,
        reason: null,
      };
    } catch {
      /* fall through to fresh extraction */
    }
  }
  // Cached failure marker still within TTL — return the failure instead of
  // grinding through the same broken parse again.
  const cachedErr = await readCachedError(taskId, filename);
  if (cachedErr !== null) {
    return failResult(detectFormatForKnown(filename), cachedErr);
  }
  return await extractAndCache(taskId, filename);
}

/**
 * In-flight extraction map. When two callers (typically: the fire-and-forget
 * background extraction kicked off by `saveAttachment` and an explicit
 * `extractAttachmentText` from a route/MCP tool) ask for the same file at
 * the same time, the second call awaits the first instead of racing it.
 *
 * Especially important on Windows, where `fs.rename` over an open destination
 * fails with EPERM and the atomic-write pattern breaks.
 */
const pendingExtractions = new Map<string, Promise<ExtractionResult>>();

function extractionKey(taskId: string, filename: string): string {
  return `${taskId}\x00${filename}`;
}

/**
 * Force-extract (skipping the freshness check) and write the result to the
 * cache. Used by the post-save hook and by callers that want to invalidate
 * a stale cache. Always returns a result — never throws. Concurrent calls
 * for the same (taskId, filename) coalesce into a single underlying
 * extraction.
 */
export async function extractAndCache(
  taskId: string,
  filename: string,
): Promise<ExtractionResult> {
  const key = extractionKey(taskId, filename);
  const inflight = pendingExtractions.get(key);
  if (inflight) return inflight;
  const promise = doExtractAndCache(taskId, filename);
  pendingExtractions.set(key, promise);
  try {
    return await promise;
  } finally {
    pendingExtractions.delete(key);
  }
}

async function doExtractAndCache(
  taskId: string,
  filename: string,
): Promise<ExtractionResult> {
  const format = detectFormatForKnown(filename);

  // Load bytes + metadata (this also validates filename safety).
  let bytes: Buffer;
  let mime = 'application/octet-stream';
  try {
    const { data, meta } = await readAttachmentBytes(taskId, filename);
    bytes = data;
    mime = meta.content_type;
  } catch (err) {
    return failResult(format, err instanceof Error ? err.message : 'read_failed');
  }

  // Refine format using the actual MIME if the filename was ambiguous.
  const effectiveFormat = format === 'unsupported'
    ? detectFormat(filename, mime)
    : format;

  if (effectiveFormat === 'unsupported') {
    const reason = `Unsupported attachment type ${JSON.stringify(mime)} (${path.extname(filename) || '<no ext>'})`;
    // Write the .err marker so subsequent extractAttachmentText calls
    // short-circuit instead of re-reading the bytes + redetecting format.
    await writeError(taskId, filename, reason);
    return failResult('unsupported', reason);
  }

  if (bytes.byteLength > maxBinaryBytes()) {
    const reason = `Attachment exceeds extraction limit (${bytes.byteLength} > ${maxBinaryBytes()} bytes)`;
    await writeError(taskId, filename, reason);
    return failResult(effectiveFormat, reason);
  }

  let raw: string;
  try {
    switch (effectiveFormat) {
      case 'pdf':
        raw = await extractPdf(bytes);
        break;
      case 'docx':
        raw = await extractDocx(bytes);
        break;
      case 'xlsx':
        raw = await extractXlsx(bytes);
        break;
      case 'csv':
        raw = extractCsv(bytes);
        break;
      case 'text':
        raw = extractText(bytes);
        break;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'extract_failed';
    await writeError(taskId, filename, reason);
    return failResult(effectiveFormat, reason);
  }

  raw = (raw ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Catch garbage output — `text` extraction of a binary file decodes to a
  // string full of U+FFFD replacement chars (the utf-8 decoder uses
  // `fatal: false`). Cache that as a failure rather than as "successful text".
  if (effectiveFormat === 'text' && raw.length > 0) {
    const replacements = (raw.match(/�/g) ?? []).length;
    if (replacements / raw.length > REPLACEMENT_RATIO_THRESHOLD) {
      const reason = 'binary content decoded to replacement chars';
      await writeError(taskId, filename, reason);
      return failResult(effectiveFormat, reason);
    }
  }

  const cap = maxTextBytes();
  let truncated = false;
  let final = raw;
  if (Buffer.byteLength(raw, 'utf8') > cap) {
    truncated = true;
    final = clipUtf8(raw, cap);
  }

  await writeCache(taskId, filename, final, {
    format: effectiveFormat,
    srcSize: bytes.byteLength,
  });

  return {
    ok: true,
    text: final,
    format: effectiveFormat,
    byte_length: Buffer.byteLength(final, 'utf8'),
    truncated,
    cached: false,
    reason: null,
  };
}

function detectFormatForKnown(filename: string): ExtractionFormat {
  return detectFormat(filename);
}

function failResult(
  format: ExtractionFormat,
  reason: string,
): ExtractionResult {
  return {
    ok: false,
    text: '',
    format,
    byte_length: 0,
    truncated: false,
    cached: false,
    reason,
  };
}

/* -------------------------------------------------------------------------- */
/*  Cache writes                                                              */
/* -------------------------------------------------------------------------- */

async function writeCache(
  taskId: string,
  filename: string,
  text: string,
  meta: CachedMeta,
): Promise<void> {
  const dir = extractedDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  const dest = cachedTextPath(taskId, filename);
  // Unique tmp suffix so concurrent writers (e.g. the post-save background
  // extraction racing an explicit read) don't fight over a shared filename
  // and ENOENT on rename. Node is single-threaded so the counter increment
  // is safely sequential — no atomicity primitive needed.
  const tmp = `${dest}.${process.pid}.${nextTmpCounter()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, dest);
  } catch (err) {
    // Best-effort cleanup of the orphan tmp on failure.
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  // Sidecar with the resolved format + source size. Best-effort: a missing
  // sidecar just means the cache-hit path falls back to filename detection
  // and the size cross-check is skipped.
  try {
    await fs.writeFile(
      cachedMetaPath(taskId, filename),
      JSON.stringify(meta),
      'utf8',
    );
  } catch {
    /* sidecar is advisory */
  }
  // Drop any prior error marker — this extraction succeeded.
  try {
    await fs.unlink(cachedErrorPath(taskId, filename));
  } catch {
    /* nothing to clear */
  }
}

let tmpCounter = 0;
function nextTmpCounter(): number {
  tmpCounter = (tmpCounter + 1) >>> 0;
  return tmpCounter;
}

async function writeError(
  taskId: string,
  filename: string,
  reason: string,
): Promise<void> {
  try {
    const dir = extractedDir(taskId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      cachedErrorPath(taskId, filename),
      `${new Date().toISOString()} ${reason}\n`,
      'utf8',
    );
  } catch {
    /* best-effort — error markers are not load-bearing */
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Truncate a string so its UTF-8 byte length is <= `cap`. Walks back from the
 * cut point until we land on a codepoint boundary so we never split a
 * multi-byte char in half.
 */
function clipUtf8(input: string, cap: number): string {
  if (Buffer.byteLength(input, 'utf8') <= cap) return input;
  const buf = Buffer.from(input, 'utf8');
  let end = cap;
  // UTF-8 continuation bytes are 10xxxxxx — back up until we hit a non-continuation.
  while (end > 0 && (buf[end] !== undefined) && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.slice(0, end).toString('utf8');
}

/* -------------------------------------------------------------------------- */
/*  Test-only                                                                  */
/* -------------------------------------------------------------------------- */

export const __testing = {
  cachedTextPath,
  cachedErrorPath,
  extractedDir,
  clipUtf8,
};
