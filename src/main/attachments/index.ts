/**
 * File attachments (Wave 13).
 *
 * Per-task file uploads. Bytes live under
 * `~/.taskpilot/attachments/<task-id>/<sanitized-filename>`. Metadata lives
 * on the task row at `task.context.attachments` as an array of
 * {@link Attachment}.
 *
 * The module is intentionally narrow: it owns the on-disk side (save / read /
 * list / delete) and the metadata sync. Higher layers (HTTP routes, MCP
 * tools, IPC) build on top.
 *
 * Path safety: every external input (task id, filename) is validated through
 * the same `safeJoin` guard the rest of the I/O layer uses, so a malicious
 * caller can never traverse out of the attachments root.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ATTACHMENTS_DIR,
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_MAX_TASK_BYTES,
} from '@/shared/constants';
import { isValidTaskId, safeJoin } from '@/main/io/paths';
import {
  getTask,
  registerOnTaskPreDelete,
  updateTask,
} from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import type { Attachment, Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Constants & errors                                                        */
/* -------------------------------------------------------------------------- */

/** Context key on a task where the attachments array lives. */
export const ATTACHMENTS_CONTEXT_KEY = 'attachments';

const FILENAME_REGEX = /^[A-Za-z0-9._-]+$/;
const FILENAME_MAX_LEN = 200;

export class AttachmentError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sanitize an upload filename. Keeps `[A-Za-z0-9._-]`, replaces everything
 * else with `_`. Strips a leading dot so we never write a hidden file. Caps
 * at 200 chars; if truncation collapses the entire name, returns `file`.
 *
 * Symmetrical with `attachmentFilenameSchema` in `@/shared/io-schemas`.
 */
export function sanitizeAttachmentFilename(input: string): string {
  let name = String(input ?? '').trim();
  if (name.length === 0) return 'file';
  // Strip directory prefixes — clients sometimes send `subdir/foo.png`.
  name = name.replace(/^.*[\\/]/, '');
  // Replace disallowed characters with `_`.
  name = name.replace(/[^A-Za-z0-9._-]/g, '_');
  // No leading dot (avoid dotfiles).
  name = name.replace(/^\.+/, '_');
  // Collapse repeated underscores to keep names readable.
  name = name.replace(/_+/g, '_');
  if (name.length > FILENAME_MAX_LEN) {
    const ext = path.extname(name).slice(0, 16);
    const stem = name.slice(0, FILENAME_MAX_LEN - ext.length);
    name = `${stem}${ext}`;
  }
  if (name.length === 0 || name === '_' || name === '.') return 'file';
  return name;
}

/**
 * Per-task attachments directory. Created lazily — callers should
 * `fs.mkdir(..., { recursive: true })` before writing.
 */
export function attachmentsDirForTask(taskId: string): string {
  if (!isValidTaskId(taskId)) {
    throw new AttachmentError(
      'invalid_task_id',
      `Invalid task id: ${JSON.stringify(taskId)}`,
    );
  }
  return safeJoin(ATTACHMENTS_DIR, taskId);
}

/**
 * Absolute path to a specific attachment file. Validates both the task id
 * and the filename through `safeJoin`, so a payload like
 * `{ filename: '../../tokens' }` throws rather than silently escaping.
 */
export function attachmentPath(taskId: string, filename: string): string {
  if (!FILENAME_REGEX.test(filename)) {
    throw new AttachmentError(
      'invalid_filename',
      `Invalid attachment filename: ${JSON.stringify(filename)}`,
    );
  }
  if (filename.length > FILENAME_MAX_LEN) {
    throw new AttachmentError(
      'invalid_filename',
      `Attachment filename too long`,
    );
  }
  return safeJoin(attachmentsDirForTask(taskId), filename);
}

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

function readNumericSetting(key: string, fallback: number): number {
  try {
    const raw = settingsRepository.get(key);
    if (raw === null || raw === undefined) return fallback;
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
    return fallback;
  } catch {
    return fallback;
  }
}

export interface AttachmentLimits {
  maxFileBytes: number;
  maxTaskBytes: number;
}

export function readAttachmentLimits(): AttachmentLimits {
  return {
    maxFileBytes: readNumericSetting(
      'attachment_max_file_bytes',
      DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
    ),
    maxTaskBytes: readNumericSetting(
      'attachment_max_task_bytes',
      DEFAULT_ATTACHMENT_MAX_TASK_BYTES,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/*  Metadata helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read the attachments array off a task. Returns `[]` when the task has
 * none, when the context isn't a plain object, or when the stored value
 * doesn't validate as an array of attachment objects.
 */
export function readTaskAttachments(task: Task | null): Attachment[] {
  if (!task || !task.context || typeof task.context !== 'object') return [];
  const raw = (task.context as Record<string, unknown>)[ATTACHMENTS_CONTEXT_KEY];
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const filename = typeof obj.filename === 'string' ? obj.filename : '';
    if (!filename || !FILENAME_REGEX.test(filename)) continue;
    const size = typeof obj.size_bytes === 'number' ? obj.size_bytes : 0;
    const content_type =
      typeof obj.content_type === 'string'
        ? obj.content_type
        : 'application/octet-stream';
    const added_at =
      typeof obj.added_at === 'string' ? obj.added_at : new Date().toISOString();
    out.push({
      filename,
      size_bytes: Math.max(0, Math.floor(size)),
      content_type,
      added_at,
    });
  }
  return out;
}

/**
 * Write the attachments array back onto a task. Strips the key entirely when
 * the list is empty so the context JSON stays tidy.
 */
function writeTaskAttachments(taskId: string, attachments: Attachment[]): void {
  const task = getTask(taskId);
  if (!task) {
    throw new AttachmentError('not_found', `Task ${taskId} not found`);
  }
  const ctx =
    task.context && typeof task.context === 'object'
      ? { ...(task.context as Record<string, unknown>) }
      : {};
  if (attachments.length === 0) {
    delete ctx[ATTACHMENTS_CONTEXT_KEY];
  } else {
    ctx[ATTACHMENTS_CONTEXT_KEY] = attachments;
  }
  const next = Object.keys(ctx).length === 0 ? null : ctx;
  updateTask(taskId, { context: next });
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export interface SaveAttachmentInput {
  taskId: string;
  /** Raw upload filename — sanitized before use. */
  filename: string;
  /** UTF-8 / binary bytes. */
  data: Buffer;
  /** MIME from the client; falls back to `application/octet-stream`. */
  contentType?: string;
}

export interface SavedAttachment extends Attachment {
  /** Absolute path of the saved file. */
  path: string;
}

/**
 * Persist an uploaded file. Enforces per-file and per-task size limits read
 * from settings (or the defaults). Replaces an existing file with the same
 * sanitized name — callers wanting versioning should de-dupe upstream.
 *
 * Returns the persisted metadata + absolute path.
 */
export async function saveAttachment(
  input: SaveAttachmentInput,
): Promise<SavedAttachment> {
  const { taskId } = input;
  const task = getTask(taskId);
  if (!task) {
    throw new AttachmentError('not_found', `Task ${taskId} not found`);
  }

  const limits = readAttachmentLimits();
  const size = input.data.byteLength;
  if (size > limits.maxFileBytes) {
    throw new AttachmentError(
      'file_too_large',
      `File exceeds per-file limit (${limits.maxFileBytes} bytes)`,
    );
  }

  const existing = readTaskAttachments(task);
  const replacingName = sanitizeAttachmentFilename(input.filename);
  const totalAfter =
    existing
      .filter((a) => a.filename !== replacingName)
      .reduce((acc, a) => acc + a.size_bytes, 0) + size;
  if (totalAfter > limits.maxTaskBytes) {
    throw new AttachmentError(
      'task_quota_exceeded',
      `Per-task attachment quota would be exceeded (${limits.maxTaskBytes} bytes)`,
    );
  }

  const dir = attachmentsDirForTask(taskId);
  await fs.mkdir(dir, { recursive: true });
  const dest = attachmentPath(taskId, replacingName);
  // Atomic-ish write: tmp → rename. Same approach as the JSON writers.
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, input.data);
  await fs.rename(tmp, dest);

  const metadata: Attachment = {
    filename: replacingName,
    size_bytes: size,
    content_type:
      input.contentType && input.contentType.trim().length > 0
        ? input.contentType.trim()
        : 'application/octet-stream',
    added_at: new Date().toISOString(),
  };

  const next = [
    ...existing.filter((a) => a.filename !== replacingName),
    metadata,
  ];
  writeTaskAttachments(taskId, next);

  // Fire-and-forget: extract text content so derive/execute/search can use it.
  // Tracked in `inFlightExtractions` so tests (and future shutdown code) can
  // await pending extractions — without that, the promise can outlive the
  // current test and write into a directory the next beforeEach just wiped.
  // Dynamic imports keep this module free of search/extract deps at load time
  // and dodge the circular ref with extract.ts.
  const extractionPromise = (async (): Promise<void> => {
    try {
      const { extractAndCache } = await import('./extract');
      const result = await extractAndCache(taskId, replacingName);
      if (result.ok) {
        const { indexTask } = await import('@/main/search/indexer');
        indexTask(taskId);
      } else if (result.format !== 'unsupported') {
        // Real extraction failure (parser crash, AV file lock, etc) on a
        // format we DO try to handle. Surface to the log so the search-miss
        // is debuggable; 'unsupported' files (e.g. .bin) are expected and
        // would be log noise.
        // eslint-disable-next-line no-console
        console.log(
          `[taskpilot:attachments] extraction failed for ${taskId}/${replacingName}: ${result.reason ?? 'unknown'}`,
        );
      }
    } catch (err) {
      // extraction is best-effort — never break the save path, but do log.
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:attachments] extraction threw for ${taskId}/${replacingName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  trackExtraction(extractionPromise);

  return { ...metadata, path: dest };
}

/* -------------------------------------------------------------------------- */
/*  In-flight extraction registry                                              */
/* -------------------------------------------------------------------------- */

const inFlightExtractions = new Set<Promise<void>>();

function trackExtraction(p: Promise<void>): void {
  inFlightExtractions.add(p);
  void p.finally(() => {
    inFlightExtractions.delete(p);
  });
}

/**
 * Wait for every background extraction kicked off by `saveAttachment` to
 * settle. Used by tests (so a teardown that wipes the attachments dir doesn't
 * race a still-running extraction) and available for any future shutdown
 * path that wants to drain cleanly. Resolves immediately when no extractions
 * are pending.
 */
export function flushExtractionQueue(): Promise<void> {
  if (inFlightExtractions.size === 0) return Promise.resolve();
  return Promise.allSettled([...inFlightExtractions]).then(() => undefined);
}

/**
 * Return the metadata array for a task. Pulled from the DB (the on-disk
 * directory is treated as a cache — DB wins).
 */
export function listAttachments(taskId: string): Attachment[] {
  const task = getTask(taskId);
  if (!task) {
    throw new AttachmentError('not_found', `Task ${taskId} not found`);
  }
  return readTaskAttachments(task);
}

/**
 * Read a single attachment's bytes. Validates filename through `safeJoin`.
 */
export async function readAttachmentBytes(
  taskId: string,
  filename: string,
): Promise<{ data: Buffer; meta: Attachment }> {
  const list = listAttachments(taskId);
  const meta = list.find((a) => a.filename === filename);
  if (!meta) {
    throw new AttachmentError(
      'not_found',
      `Attachment ${filename} not found on task ${taskId}`,
    );
  }
  const data = await fs.readFile(attachmentPath(taskId, filename));
  return { data, meta };
}

/**
 * Remove an attachment (bytes + metadata). Best-effort on the disk side —
 * a missing file is fine (the metadata entry still gets stripped).
 */
export async function deleteAttachment(
  taskId: string,
  filename: string,
): Promise<void> {
  const list = listAttachments(taskId);
  if (!list.some((a) => a.filename === filename)) {
    throw new AttachmentError(
      'not_found',
      `Attachment ${filename} not found on task ${taskId}`,
    );
  }
  const target = attachmentPath(taskId, filename);
  try {
    await fs.unlink(target);
  } catch (err: unknown) {
    if (
      !err ||
      typeof err !== 'object' ||
      (err as { code?: string }).code !== 'ENOENT'
    ) {
      throw err;
    }
  }
  const next = list.filter((a) => a.filename !== filename);
  writeTaskAttachments(taskId, next);
}

/**
 * Wipe every attachment for a task (bytes + the entire directory). Used by
 * the pre-delete hook. The DB row is about to be removed by the caller, so
 * we DO NOT touch `task.context.attachments` here.
 */
export async function deleteAttachmentsForTask(taskId: string): Promise<void> {
  if (!isValidTaskId(taskId)) return;
  const dir = path.resolve(ATTACHMENTS_DIR, taskId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/* -------------------------------------------------------------------------- */
/*  Pre-delete hook (side-effect)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Register a pre-delete cleanup so a deleted task takes its on-disk
 * attachment directory with it. Idempotent at module scope — the tasks
 * repo now supports a list of hooks, so we don't have to coordinate with
 * any other registrants (e.g. `@/main/links`).
 *
 * Fire-and-forget — the row delete is synchronous and we don't want to
 * block it on filesystem IO. The dir wipe is idempotent so a delayed run
 * is harmless.
 */
let attachmentsHookInstalled = false;
export function ensureAttachmentsPreDeleteHook(): void {
  if (attachmentsHookInstalled) return;
  attachmentsHookInstalled = true;
  registerOnTaskPreDelete((deletedId) => {
    void deleteAttachmentsForTask(deletedId);
  });
}

// Self-install on module load. Importing `@/main/attachments` anywhere
// (routes, IPC, tests) wires the hook.
ensureAttachmentsPreDeleteHook();
