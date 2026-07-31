import fs from 'node:fs/promises';
import path from 'node:path';

import { ATTACHMENTS_DIR } from '@/shared/constants';
import {
  DerivationRequestSchema,
  DerivationResponseSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
} from '@/shared/io-schemas';
import type {
  Attachment,
  DerivationRequest,
  DerivationResponse,
  ExecutionRequest,
  ExecutionResult,
  Task,
} from '@/shared/types';

import {
  derivePath,
  derivedPath,
  ensureIoDirs,
  executePath,
  inboxPath,
  outputDir,
  resultPath,
  resultsDir,
  reviewPath,
  safeJoin,
} from './paths';
import { resolveKnowledgePaths } from '@/main/knowledge/sync';

/**
 * Context payload passed to {@link writeDeriveRequest}. The caller assembles
 * this from the DB + calendar snapshot before handing it off.
 */
export interface DeriveContext {
  calendar_snapshot: string;
  related_tasks: string[];
  available_tools: string[];
  execution_modes: ('cowork' | 'cli')[];
  instructions?: string;
}

/**
 * Result of {@link readExecutionResult}. Bundles the parsed `result.json`
 * payload with the list of files inside the per-task `output/` directory.
 */
export interface ExecutionResultBundle {
  result: ExecutionResult;
  outputFiles: string[];
}

const DEFAULT_DERIVE_INSTRUCTIONS = [
  'Propose 1-7 derivative tasks that decompose this task into actionable steps.',
  'For each, decide whether it is agent-executable, by which method, and whether human review is required.',
  'Return strictly the DerivationResponse JSON schema.',
].join(' ');

const DEFAULT_EXECUTE_INSTRUCTIONS = [
  'Execute this task end-to-end.',
  'Write any generated artifacts under the output/ directory.',
  'Return strictly the ExecutionResult JSON schema, summarizing what you did.',
].join(' ');

/**
 * Atomic JSON write: serialise → write `.tmp` sibling → fsync → rename.
 *
 * On POSIX a rename within the same filesystem is atomic; on Windows
 * `fs.rename` replaces the destination atomically as well, provided no
 * other handle holds it open.
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

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a derivation request for `task` to `io/derive/<id>.json`.
 *
 * The payload is validated against {@link DerivationRequestSchema} before it
 * touches the disk so we never publish a malformed request for Claude.
 *
 * @returns The absolute path of the written file.
 */
export async function writeDeriveRequest(
  task: Task,
  context: DeriveContext,
): Promise<string> {
  await ensureIoDirs();
  const { instructions, ...ctx } = context;
  const request: DerivationRequest = {
    request_type: 'derive',
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      due: task.due,
      tags: task.tags,
    },
    context: ctx,
    instructions: instructions ?? DEFAULT_DERIVE_INSTRUCTIONS,
  };
  const parsed = DerivationRequestSchema.parse(request);
  const dest = derivePath(task.id);
  await writeJsonAtomic(dest, parsed);
  return dest;
}

/**
 * Read and validate the derivation response for `taskId`, if Claude has
 * written one. Returns `null` if the file does not exist. Throws if the file
 * exists but fails schema validation.
 */
export async function readDerivedResponse(
  taskId: string,
): Promise<DerivationResponse | null> {
  const raw = await readJson<unknown>(derivedPath(taskId));
  if (raw === null) return null;
  return DerivationResponseSchema.parse(raw);
}

/**
 * Read the `attachments` array off a task's context, returning the metadata
 * untouched. Used by {@link writeExecuteRequest} to enrich the request
 * payload with both the metadata and the resolved absolute paths so Claude
 * can locate uploaded files without re-reading the DB.
 */
function readAttachmentsFromContext(task: Task): Attachment[] {
  if (!task.context || typeof task.context !== 'object') return [];
  const raw = (task.context as Record<string, unknown>)['attachments'];
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const filename = typeof obj.filename === 'string' ? obj.filename : '';
    if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.length > 200) continue;
    const size_bytes = typeof obj.size_bytes === 'number' ? obj.size_bytes : 0;
    const content_type =
      typeof obj.content_type === 'string'
        ? obj.content_type
        : 'application/octet-stream';
    const added_at =
      typeof obj.added_at === 'string' ? obj.added_at : new Date().toISOString();
    out.push({ filename, size_bytes, content_type, added_at });
  }
  return out;
}

/**
 * Build the `attachment_paths` block injected into an execute request's
 * context. Returns an array of `{filename, path, size_bytes, content_type}`
 * objects where `path` is the absolute on-disk location Claude can read.
 */
function resolveAttachmentPaths(
  task: Task,
): Array<Attachment & { path: string }> {
  const attachments = readAttachmentsFromContext(task);
  const out: Array<Attachment & { path: string }> = [];
  for (const att of attachments) {
    try {
      // `att.filename` is constrained by the regex above; the safeJoin
      // double-check guards against any future loosening of that regex.
      const absolute = safeJoin(ATTACHMENTS_DIR, task.id, att.filename);
      out.push({ ...att, path: absolute });
    } catch {
      /* skip — sanitized filename failed safeJoin (shouldn't happen) */
    }
  }
  return out;
}

/**
 * Write an execution request for `task` to `io/execute/<id>.json`.
 *
 * `parentOutputs` maps parent task ids to the absolute paths of files those
 * parents produced — Claude uses this so dependent tasks can read upstream
 * artifacts without rummaging through the DB.
 *
 * Side note: when `task.context.attachments` is set, the request's
 * `context.attachment_paths` is populated with the resolved absolute paths
 * so Claude can read uploaded files without recomputing the location. The
 * canonical metadata stays inside `task.context.attachments`.
 *
 * @returns The absolute path of the written file.
 */
export async function writeExecuteRequest(
  task: Task,
  parentOutputs: Record<string, string[]>,
  context: Record<string, unknown>,
  instructions?: string,
): Promise<string> {
  await ensureIoDirs();
  // Enrich context with attachment paths when the task has any. Don't
  // overwrite a caller-supplied `attachment_paths` — let upstream win.
  const enriched: Record<string, unknown> = { ...context };
  if (!('attachment_paths' in enriched)) {
    const attachmentPaths = resolveAttachmentPaths(task);
    if (attachmentPaths.length > 0) {
      enriched.attachment_paths = attachmentPaths;
    }
  }
  // Knowledge base: semantically-matched local resources for this task. Same
  // pattern as attachment_paths — absolute sidecar/source paths the agent can
  // read. Don't overwrite a caller-supplied value.
  if (!('knowledge_paths' in enriched)) {
    try {
      const knowledgePaths = resolveKnowledgePaths(task);
      if (knowledgePaths.length > 0) {
        enriched.knowledge_paths = knowledgePaths;
      }
    } catch {
      /* non-fatal — knowledge is best-effort enrichment */
    }
  }

  const request: ExecutionRequest = {
    request_type: 'execute',
    task,
    parent_outputs: parentOutputs,
    context: enriched,
    instructions: instructions ?? DEFAULT_EXECUTE_INSTRUCTIONS,
  };
  const parsed = ExecutionRequestSchema.parse(request);
  const dest = executePath(task.id);
  await writeJsonAtomic(dest, parsed);
  return dest;
}

/**
 * Read and validate the execution result bundle for `taskId`.
 *
 * Returns `null` if `result.json` does not exist. The companion
 * `outputFiles` array lists every file inside the per-task `output/`
 * directory (relative paths are not returned — callers get absolute paths
 * so they can be persisted or shown verbatim).
 */
export async function readExecutionResult(
  taskId: string,
): Promise<ExecutionResultBundle | null> {
  const raw = await readJson<unknown>(resultPath(taskId));
  if (raw === null) return null;
  const result = ExecutionResultSchema.parse(raw);

  const dir = outputDir(taskId);
  let outputFiles: string[] = [];
  if (await pathExists(dir)) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    outputFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name));
  }
  return { result, outputFiles };
}

/**
 * Mirror a task to `io/inbox/<id>.json` so it shows up alongside inbound
 * tasks Claude has dropped into the directory. This is a one-way write —
 * the watcher will pick it up only if it didn't originate from the app.
 */
export async function writeInbox(task: Task): Promise<string> {
  await ensureIoDirs();
  const dest = inboxPath(task.id);
  await writeJsonAtomic(dest, task);
  return dest;
}

/**
 * Copy a task's `result.json` into `io/review/<id>.json` so reviewers have a
 * single place to look. Non-fatal if no result exists — returns `null`.
 */
export async function moveToReview(taskId: string): Promise<string | null> {
  const src = resultPath(taskId);
  if (!(await pathExists(src))) return null;
  const dest = reviewPath(taskId);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  return dest;
}

/**
 * Remove the original request file for a task once its response has been
 * ingested. Both `derive/` and `execute/` are cleaned. Missing files are
 * silently ignored.
 */
export async function cleanup(taskId: string): Promise<void> {
  for (const p of [derivePath(taskId), executePath(taskId)]) {
    try {
      await fs.unlink(p);
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/**
 * Ensure the per-task results directory exists. Called by callers writing
 * out test fixtures or expected outputs.
 */
export async function ensureResultsDir(taskId: string): Promise<string> {
  const dir = resultsDir(taskId);
  await fs.mkdir(path.join(dir, 'output'), { recursive: true });
  return dir;
}
