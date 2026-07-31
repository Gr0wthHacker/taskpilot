/**
 * Outputs collector (Wave 15).
 *
 * Pure aggregation. Given a task id, walks every source of "things this task
 * produced" — Claude-authored output files, the latest `result.json`,
 * user-uploaded attachments, external integration artifacts (PR / event /
 * page / thread / draft), execution metrics — and returns a single
 * {@link OutputBundle}.
 *
 * Defensive on every source: a missing dir, malformed JSON, or absent
 * integration field is treated as "no data for that input" rather than an
 * error. The whole point of this module is to give the renderer a single
 * uniform shape; it should never throw on a task that's only partially
 * populated.
 *
 * Wave 15A (Journal) owns the execution-narrative side; this module
 * deliberately stays out of `src/main/journal/`. Higher layers (the
 * briefing-pack zipper) may merge a journal in if it exists, via a
 * defensive dynamic import.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { listAttachments, attachmentPath } from '@/main/attachments';
import { costEventsRepository } from '@/main/db/repositories/cost-events';
import { executionLogsRepository } from '@/main/db/repositories/execution-logs';
import { tasksRepository } from '@/main/db/repositories/tasks';
import { outputDir, resultPath } from '@/main/io/paths';
import type {
  ExecutionResult,
  OutputArtifact,
  OutputBundle,
  OutputFile,
  OutputFileContent,
  Task,
} from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export class OutputsError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OutputsError';
    this.code = code;
  }
}

/**
 * Build the {@link OutputBundle} for a task. Throws `OutputsError('not_found')`
 * when the task id is unknown; every other source-level error is swallowed
 * and reported as an empty list (the bundle is a best-effort snapshot).
 */
export async function collectOutputs(taskId: string): Promise<OutputBundle> {
  const task = tasksRepository.findById(taskId);
  if (!task) {
    throw new OutputsError('not_found', `Task ${taskId} not found`);
  }

  const [files, summary, attachments] = await Promise.all([
    readOutputFiles(taskId),
    readResultSummary(taskId),
    readUserAttachments(taskId),
  ]);

  const artifacts = readArtifacts(task);
  const metrics = readMetrics(taskId, task);

  return {
    task_id: taskId,
    generated_at: new Date().toISOString(),
    summary,
    files,
    artifacts,
    attachments,
    metrics,
  };
}

/* -------------------------------------------------------------------------- */
/*  Files — Claude-authored output/                                            */
/* -------------------------------------------------------------------------- */

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.log',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.css',
  '.scss',
  '.svg',
  '.diff',
  '.patch',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.log': 'text/plain',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  '.sql': 'application/sql',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.svg': 'image/svg+xml',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Best-effort MIME type from a filename. Falls back to
 * `application/octet-stream` for anything unknown. Public so the briefing
 * pack zipper can stamp the same labels on README references.
 */
export function sniffContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

function isLikelyText(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Read the first ~200 chars of a text file as a preview. Returns
 * `undefined` for binary files or on read failure. The preview is purely
 * cosmetic — it never gates the file's inclusion in the bundle.
 */
async function readPreview(filePath: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buf, 0, 256, 0);
      const text = buf.slice(0, bytesRead).toString('utf8');
      // Strip any partial trailing utf-8 sequence to keep the preview clean.
      return text.replace(/�/g, '').slice(0, 200);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Walk `~/.taskpilot/io/results/<task-id>/output/` and produce an
 * {@link OutputFile} entry per regular file. Returns `[]` when the directory
 * doesn't exist or can't be read.
 */
export async function readOutputFiles(taskId: string): Promise<OutputFile[]> {
  let dir: string;
  try {
    dir = outputDir(taskId);
  } catch {
    return [];
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: OutputFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    const file: OutputFile = {
      path: full,
      size_bytes: stat.size,
      content_type: sniffContentType(entry.name),
      added_at: stat.mtime.toISOString(),
    };
    if (isLikelyText(entry.name) && stat.size > 0) {
      const preview = await readPreview(full);
      if (preview) file.preview = preview;
    }
    out.push(file);
  }
  // Stable ordering — newest first feels right for "what did this task
  // produce most recently". Falls back to alphabetical when timestamps tie.
  out.sort((a, b) => {
    if (b.added_at !== a.added_at) return b.added_at.localeCompare(a.added_at);
    return a.path.localeCompare(b.path);
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Single-file content (in-app viewer)                                        */
/* -------------------------------------------------------------------------- */

/** Hard cap on how much of a file we'll send to the in-app viewer. */
const MAX_VIEWER_BYTES = 512 * 1024;

/**
 * Read one output (or attachment) file's content for the in-app viewer.
 *
 * Security: `requestedPath` MUST resolve inside the task's own output
 * directory, or exactly match one of its registered attachment files.
 * Anything else throws `OutputsError('forbidden')` so a crafted `?path=`
 * can't be coerced into reading arbitrary disk locations.
 */
export async function readOutputFileContent(
  taskId: string,
  requestedPath: string,
): Promise<OutputFileContent> {
  const task = tasksRepository.findById(taskId);
  if (!task) {
    throw new OutputsError('not_found', `Task ${taskId} not found`);
  }

  const resolved = path.resolve(requestedPath);

  // Allowlist 1 — anything under the task's own output directory.
  let insideOutputDir = false;
  try {
    const root = path.resolve(outputDir(taskId));
    const rel = path.relative(root, resolved);
    insideOutputDir =
      rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    /* outputDir unavailable — fall through to the attachment check */
  }

  // Allowlist 2 — an exact registered attachment path for this task.
  let isAttachment = false;
  if (!insideOutputDir) {
    try {
      for (const att of listAttachments(taskId)) {
        try {
          if (
            path.resolve(attachmentPath(taskId, att.filename)) === resolved
          ) {
            isAttachment = true;
            break;
          }
        } catch {
          /* skip a malformed attachment entry */
        }
      }
    } catch {
      /* no attachments */
    }
  }

  if (!insideOutputDir && !isAttachment) {
    throw new OutputsError(
      'forbidden',
      'Requested path is not within this task’s outputs',
    );
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new OutputsError('not_found', 'File not found');
  }
  if (!stat.isFile()) {
    throw new OutputsError('not_found', 'Not a regular file');
  }

  const filename = path.basename(resolved);
  const content_type = sniffContentType(filename);
  const is_text = isLikelyText(filename);

  if (!is_text) {
    return {
      path: resolved,
      content_type,
      size_bytes: stat.size,
      content: '',
      truncated: false,
      is_text: false,
    };
  }

  const cap = Math.min(stat.size, MAX_VIEWER_BYTES);
  const handle = await fs.open(resolved, 'r');
  try {
    const buf = Buffer.alloc(cap);
    const { bytesRead } = cap > 0
      ? await handle.read(buf, 0, cap, 0)
      : { bytesRead: 0 };
    return {
      path: resolved,
      content_type,
      size_bytes: stat.size,
      content: buf.slice(0, bytesRead).toString('utf8'),
      truncated: stat.size > MAX_VIEWER_BYTES,
      is_text: true,
    };
  } finally {
    await handle.close();
  }
}

/* -------------------------------------------------------------------------- */
/*  Result summary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read the `summary` string off the persisted `result.json` for a task.
 * Returns `null` when the file is missing, unreadable, or malformed.
 */
export async function readResultSummary(taskId: string): Promise<string | null> {
  const result = await readResult(taskId);
  if (!result) return null;
  return typeof result.summary === 'string' ? result.summary : null;
}

/**
 * Read the full `result.json` for a task. Returns null on any failure —
 * the bundle still surfaces output files independently.
 */
export async function readResult(
  taskId: string,
): Promise<ExecutionResult | null> {
  let p: string;
  try {
    p = resultPath(taskId);
  } catch {
    return null;
  }
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ExecutionResult;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  User attachments                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Map user-uploaded attachments into {@link OutputFile} entries so the
 * renderer can render them with the same card component as Claude's outputs.
 */
export async function readUserAttachments(
  taskId: string,
): Promise<OutputFile[]> {
  let attachments;
  try {
    attachments = listAttachments(taskId);
  } catch {
    return [];
  }
  const out: OutputFile[] = [];
  for (const att of attachments) {
    let full: string;
    try {
      full = attachmentPath(taskId, att.filename);
    } catch {
      continue;
    }
    const file: OutputFile = {
      path: full,
      size_bytes: att.size_bytes,
      content_type: att.content_type || sniffContentType(att.filename),
      added_at: att.added_at,
    };
    if (isLikelyText(att.filename) && att.size_bytes > 0) {
      const preview = await readPreview(full);
      if (preview) file.preview = preview;
    }
    out.push(file);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  External artifacts (from task.context)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read the integration-linked artifacts off `task.context`. Mirrors the
 * field names used by:
 *   - `@/main/github/issues-sync` → `context.github_issue`
 *   - `@/main/github/webhook-handlers` → PR linkage (we surface
 *      `context.github_pr` when set; the webhook handler currently writes
 *      a note rather than a structured ref, so we read both shapes)
 *   - `@/main/notion/sync` → `context.notion_page_id` / `notion_page_url`
 *   - `@/main/slack/capture` → `context.slack_permalink` / `slack_channel`
 *   - `@/main/gmail/capture` → `context.gmail_*`
 *   - `Task.calendar_event_id` (top-level column, not under context)
 */
export function readArtifacts(task: Task): OutputArtifact[] {
  const out: OutputArtifact[] = [];
  const ctx =
    task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : {};

  // GitHub issue ---------------------------------------------------------
  const issue = ctx['github_issue'];
  if (issue && typeof issue === 'object') {
    const obj = issue as Record<string, unknown>;
    const number = obj['number'];
    const url = obj['url'];
    const state = obj['state'];
    if (typeof number === 'number' && typeof url === 'string') {
      out.push({
        kind: 'github_issue',
        url,
        number,
        state: typeof state === 'string' ? state : 'open',
      });
    }
  }

  // GitHub PR — structured form first, then a few legacy aliases.
  for (const key of ['github_pr', 'github_pull_request', 'pr'] as const) {
    const raw = ctx[key];
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const number = obj['number'];
      const url = obj['url'] ?? obj['html_url'];
      const state = obj['state'];
      if (typeof number === 'number' && typeof url === 'string') {
        out.push({
          kind: 'github_pr',
          url,
          number,
          state: typeof state === 'string' ? state : 'open',
        });
        break;
      }
    }
  }

  // Calendar event — the top-level column is the canonical home.
  if (typeof task.calendar_event_id === 'string' && task.calendar_event_id.length > 0) {
    const summary = typeof ctx['calendar_event_summary'] === 'string'
      ? (ctx['calendar_event_summary'] as string)
      : undefined;
    out.push({
      kind: 'calendar_event',
      event_id: task.calendar_event_id,
      ...(summary !== undefined ? { summary } : {}),
    });
  }

  // Notion page ----------------------------------------------------------
  const notionPageId = ctx['notion_page_id'];
  if (typeof notionPageId === 'string' && notionPageId.length > 0) {
    const url = ctx['notion_page_url'];
    const synced = ctx['notion_synced_at'];
    out.push({
      kind: 'notion_page',
      page_id: notionPageId,
      ...(typeof url === 'string' ? { url } : {}),
      ...(typeof synced === 'string' ? { last_synced: synced } : {}),
    });
  }

  // Slack thread ---------------------------------------------------------
  const slackPermalink = ctx['slack_permalink'];
  if (typeof slackPermalink === 'string' && slackPermalink.length > 0) {
    const channel = ctx['slack_channel'];
    const threadTs = ctx['slack_thread_ts'] ?? ctx['slack_message_ts'];
    out.push({
      kind: 'slack_thread',
      permalink: slackPermalink,
      ...(typeof channel === 'string' ? { channel } : {}),
      ...(typeof threadTs === 'string' ? { thread_ts: threadTs } : {}),
    });
  }

  // Gmail draft — a draft id is the most actionable artifact; otherwise
  // fall back to the message id from the capture loop.
  const gmailDraftId = ctx['gmail_draft_id'];
  const gmailMessageId = ctx['gmail_message_id'];
  const draftIdString =
    typeof gmailDraftId === 'string' && gmailDraftId.length > 0
      ? gmailDraftId
      : typeof gmailMessageId === 'string' && gmailMessageId.length > 0
        ? gmailMessageId
        : null;
  if (draftIdString) {
    const threadId = ctx['gmail_thread_id'];
    const subject = ctx['gmail_subject'];
    out.push({
      kind: 'gmail_draft',
      message_id: draftIdString,
      ...(typeof threadId === 'string' ? { thread_id: threadId } : {}),
      ...(typeof subject === 'string' ? { subject } : {}),
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Metrics                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Roll up cost-event totals, time-to-done, and the latest confidence reading
 * for a task. Every value defaults to 0 / null on missing data so the
 * renderer can render without conditionals.
 */
export function readMetrics(
  taskId: string,
  task: Task,
): OutputBundle['metrics'] {
  // Cost rollup — sum across every recorded cost event.
  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const events = costEventsRepository.list({ task_id: taskId, limit: 10_000 });
    for (const evt of events) {
      totalUsd += evt.cost_usd ?? 0;
      inputTokens += evt.input_tokens ?? 0;
      outputTokens += evt.output_tokens ?? 0;
    }
  } catch {
    /* missing table / db error — fall back to zeros */
  }
  // Round so the renderer doesn't see floating-point noise.
  totalUsd = Math.round(totalUsd * 1_000_000) / 1_000_000;

  // Time to done — created_at → earliest "done" execution log. We use the
  // log timestamp rather than task.updated_at because the task row gets
  // edited for many reasons (status flip, re-derive, etc).
  let timeToDoneHours: number | null = null;
  try {
    const logs = executionLogsRepository.getForTask(taskId);
    // Logs are ordered newest first; walk to find the most recent
    // succeeded run with a completed_at timestamp.
    const doneLog = logs.find(
      (l) => l.status === 'succeeded' && l.completed_at,
    );
    if (doneLog && doneLog.completed_at && task.created_at) {
      const start = Date.parse(task.created_at);
      const end = Date.parse(doneLog.completed_at);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        timeToDoneHours = (end - start) / 3_600_000;
        // Round to two decimals; "12.7 hours" is plenty of precision.
        timeToDoneHours = Math.round(timeToDoneHours * 100) / 100;
      }
    }
  } catch {
    /* fall back to null */
  }

  // Latest confidence — ingestion writes this onto context whenever Claude
  // self-reports a value.
  let lastConfidence: number | null = null;
  if (task.context && typeof task.context === 'object') {
    const raw = (task.context as Record<string, unknown>)['last_confidence'];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      lastConfidence = raw;
    }
  }

  // Execution count — how many logs the task accumulated, including
  // failures + retries (useful signal for "this was hard").
  let executionCount = 0;
  try {
    executionCount = executionLogsRepository.getForTask(taskId).length;
  } catch {
    /* zero */
  }

  return {
    total_cost_usd: totalUsd,
    total_input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    time_to_done_hours: timeToDoneHours,
    last_confidence: lastConfidence,
    execution_count: executionCount,
  };
}
