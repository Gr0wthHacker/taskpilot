/**
 * Task journal aggregator (Wave 15A).
 *
 * Pulls every event that has ever touched a task — from multiple DB tables,
 * the task's `context` blob, and the on-disk derived JSON — and merges them
 * into one chronological narrative.
 *
 * The data already exists; nothing here writes. This module is the "view"
 * that walks the sources, normalizes each into a `JournalEvent`, and returns
 * them ordered newest-first.
 *
 * Sources walked (in order of richness):
 *   1. The task row itself          → created / edited / status_changed
 *   2. execution_logs               → execution_started / execution_completed
 *   3. result.json on disk          → result_ingested
 *   4. derived/<id>.json on disk    → derived (parent side)
 *   5. children with this parent_id → derived (child side) / child_completed
 *   6. feedback table               → feedback rows (rejection / low_conf / note)
 *   7. cost_events table            → cost rows
 *   8. context.attachments[]        → attachment_added
 *   9. context.notes[]              → pr_event / issue_event / webhook notes
 *  10. context.notion_*             → notion_synced
 *  11. context.slack_*              → slack_linked
 *  12. context.gmail_*              → gmail_linked
 *  13. context.github_issue         → issue_event (linked)
 *  14. calendar_event_id            → calendar_linked
 *
 * Each individual source-walker is best-effort: a missing file, a malformed
 * context blob, or a repository miss never throws — it logs and continues so
 * one bad input can't blank the timeline.
 */

import fs from 'node:fs/promises';

import { costEventsRepository } from '@/main/db/repositories/cost-events';
import { decisionsRepository } from '@/main/db/repositories/decisions';
import { executionLogsRepository } from '@/main/db/repositories/execution-logs';
import { feedbackRepository } from '@/main/db/repositories/feedback';
import { getChildren, getTask } from '@/main/db/repositories/tasks';
import { derivedPath, isValidTaskId, resultPath } from '@/main/io/paths';
import type {
  CostEvent,
  DecisionEntry,
  DerivationResponse,
  ExecutionLog,
  ExecutionResult,
  FeedbackEntry,
  Task,
} from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Single event in a task's journal. Stable wire format — the HTTP route hands
 * these straight to the renderer and the renderer's icon/label mapping keys
 * off `kind`. Add new kinds at the end; never repurpose an existing one.
 */
export type JournalEventKind =
  | 'created'
  | 'edited'
  | 'status_changed'
  | 'agent_status_changed'
  | 'derived'
  | 'execution_started'
  | 'execution_completed'
  | 'result_ingested'
  | 'attachment_added'
  | 'attachment_removed'
  | 'feedback'
  | 'cost'
  | 'pr_event'
  | 'issue_event'
  | 'calendar_linked'
  | 'notion_synced'
  | 'slack_linked'
  | 'gmail_linked'
  | 'child_completed'
  | 'archived'
  | 'unarchived'
  | 'scheduled'
  | 'decision';

export interface JournalEventLink {
  kind: 'task' | 'pr' | 'event' | 'page' | 'thread' | 'file';
  url?: string;
  ref?: string;
}

export interface JournalEvent {
  at: string; // ISO 8601
  kind: JournalEventKind;
  title: string;
  details?: Record<string, unknown>;
  actor?: 'user' | 'claude' | 'system';
  link?: JournalEventLink;
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pull `task.context` as a plain object — TS knows it's `Record<string, unknown> | null`
 * but every site that walks it needs the same null/non-object guard.
 */
function readContext(task: Task): Record<string, unknown> {
  if (!task.context || typeof task.context !== 'object') return {};
  return task.context as Record<string, unknown>;
}

/**
 * Try to parse an ISO timestamp; return null when malformed. Used to guard
 * sorts so a bad upstream string can't make the timeline collapse.
 */
function isValidIso(iso: unknown): iso is string {
  if (typeof iso !== 'string') return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms);
}

/**
 * Safely read + JSON-parse a file. Returns null on any failure — missing
 * files are the common case (no result yet, no derived yet) and shouldn't
 * blow up the aggregator.
 */
async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Truncate a long string for display in the journal title. Keeps the
 * narrative compact; full payload still goes into `details`.
 */
function clamp(s: string, n: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= n) return trimmed;
  return `${trimmed.slice(0, n - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/*  Source walkers                                                            */
/* -------------------------------------------------------------------------- */

function emitTaskLifecycle(task: Task, out: JournalEvent[]): void {
  out.push({
    at: task.created_at,
    kind: 'created',
    title: `Task created — "${clamp(task.title, 80)}"`,
    actor: 'user',
    details: {
      priority: task.priority,
      agent_method: task.agent_method,
      tags: task.tags,
    },
  });

  // "Edited" — best-effort. We only know `created_at` and `updated_at`; if
  // they differ we synthesize a single edit event. The renderer can show "1+
  // edits" without us claiming we have a full diff history.
  if (task.updated_at && task.updated_at !== task.created_at) {
    out.push({
      at: task.updated_at,
      kind: 'edited',
      title: 'Task edited',
      actor: 'user',
      details: { updated_at: task.updated_at },
    });
  }

  // Status-derived markers — synthesized from the CURRENT state because we
  // don't have a transitions table. Stamp them at `updated_at` so they sit
  // near the most recent edit on the timeline.
  if (task.status === 'archived') {
    out.push({
      at: task.updated_at,
      kind: 'archived',
      title: 'Task archived',
      actor: 'user',
    });
  }

  if (task.calendar_event_id) {
    out.push({
      at: task.updated_at,
      kind: 'scheduled',
      title: 'Scheduled on calendar',
      actor: 'user',
      link: { kind: 'event', ref: task.calendar_event_id },
      details: { calendar_event_id: task.calendar_event_id },
    });
    out.push({
      at: task.updated_at,
      kind: 'calendar_linked',
      title: `Calendar event linked (${task.calendar_event_id})`,
      actor: 'system',
      link: { kind: 'event', ref: task.calendar_event_id },
    });
  }
}

function emitExecutionLogs(logs: ExecutionLog[], out: JournalEvent[]): void {
  for (const log of logs) {
    if (!isValidIso(log.started_at)) continue;
    out.push({
      at: log.started_at,
      kind: 'execution_started',
      title: `Execution started (${log.method})`,
      actor: 'claude',
      details: { log_id: log.id, method: log.method },
    });
    if (log.completed_at && isValidIso(log.completed_at)) {
      const summary = clamp(log.output ?? log.error ?? '', 120);
      out.push({
        at: log.completed_at,
        kind: 'execution_completed',
        title:
          log.status === 'succeeded'
            ? `Execution succeeded${summary ? ` — ${summary}` : ''}`
            : log.status === 'failed'
              ? `Execution failed${summary ? ` — ${summary}` : ''}`
              : `Execution needs review${summary ? ` — ${summary}` : ''}`,
        actor: 'claude',
        details: {
          log_id: log.id,
          status: log.status,
          method: log.method,
          output: log.output,
          error: log.error,
          log_path: log.log_path,
        },
      });
    }
  }
}

async function emitResultIngestion(taskId: string, out: JournalEvent[]): Promise<void> {
  if (!isValidTaskId(taskId)) return;
  let path: string;
  try {
    path = resultPath(taskId);
  } catch {
    return;
  }
  const result = await readJsonOrNull<ExecutionResult>(path);
  if (!result) return;
  if (!isValidIso(result.completed_at)) return;
  out.push({
    at: result.completed_at,
    kind: 'result_ingested',
    title: `Result ingested — ${result.status} (${result.output_files?.length ?? 0} file${
      (result.output_files?.length ?? 0) === 1 ? '' : 's'
    })`,
    actor: 'claude',
    details: {
      status: result.status,
      summary: result.summary,
      output_files: result.output_files,
      notes: result.notes,
      error: result.error,
      confidence: result.confidence,
    },
    link: { kind: 'file', ref: path },
  });
}

async function emitDerivationParent(taskId: string, out: JournalEvent[]): Promise<void> {
  if (!isValidTaskId(taskId)) return;
  let path: string;
  try {
    path = derivedPath(taskId);
  } catch {
    return;
  }
  const derived = await readJsonOrNull<DerivationResponse>(path);
  if (!derived) return;
  if (!isValidIso(derived.derived_at)) return;
  const count = Array.isArray(derived.derivatives) ? derived.derivatives.length : 0;
  out.push({
    at: derived.derived_at,
    kind: 'derived',
    title: `Proposed ${count} sub-task${count === 1 ? '' : 's'}`,
    actor: 'claude',
    details: {
      count,
      titles: Array.isArray(derived.derivatives)
        ? derived.derivatives.map((d) => d.title).slice(0, 10)
        : [],
    },
    link: { kind: 'file', ref: path },
  });
}

function emitChildren(task: Task, children: Task[], out: JournalEvent[]): void {
  void task;
  for (const child of children) {
    out.push({
      at: child.created_at,
      kind: 'derived',
      title: `Sub-task created — "${clamp(child.title, 80)}"`,
      actor: 'claude',
      details: {
        child_id: child.id,
        agent_method: child.agent_method,
        priority: child.priority,
      },
      link: { kind: 'task', ref: child.id },
    });
    // Treat any sub-task whose status is `done` as a "child_completed" event,
    // stamped at the child's `updated_at` (best approximation — see header).
    if (child.status === 'done') {
      out.push({
        at: child.updated_at,
        kind: 'child_completed',
        title: `Sub-task completed — "${clamp(child.title, 80)}"`,
        actor: 'claude',
        details: { child_id: child.id, status: child.status },
        link: { kind: 'task', ref: child.id },
      });
    }
  }
}

function emitFeedback(rows: FeedbackEntry[], out: JournalEvent[]): void {
  for (const row of rows) {
    if (!isValidIso(row.at)) continue;
    const reason = (row.reason ?? '').trim();
    let title: string;
    switch (row.kind) {
      case 'rejection_derivation':
        title = `Derivation rejected${reason ? ` — ${clamp(reason, 100)}` : ''}`;
        break;
      case 'rejection_result':
        title = `Result rejected${reason ? ` — ${clamp(reason, 100)}` : ''}`;
        break;
      case 'low_confidence':
        title = `Low confidence${reason ? ` — ${clamp(reason, 100)}` : ''}`;
        break;
      case 'edit_after_run':
        title = `Edited after run${reason ? ` — ${clamp(reason, 100)}` : ''}`;
        break;
      case 'note':
      default:
        title = `Note${reason ? ` — ${clamp(reason, 100)}` : ''}`;
    }
    out.push({
      at: row.at,
      kind: 'feedback',
      title,
      actor:
        row.kind === 'low_confidence'
          ? 'system'
          : row.kind === 'note'
            ? 'user'
            : 'user',
      details: {
        feedback_kind: row.kind,
        reason: row.reason,
        details: row.details,
      },
    });
  }
}

/**
 * Decision-log rows (Wave 16). Each append-only entry becomes a `decision`
 * event stamped at its `created_at`. The category is folded into the title so
 * the timeline reads naturally ("Decision — went with X"). `author` maps to
 * the journal actor: `claude` → claude, anything else → user.
 */
function emitDecisions(rows: DecisionEntry[], out: JournalEvent[]): void {
  for (const row of rows) {
    if (!isValidIso(row.created_at)) continue;
    const label =
      row.category.charAt(0).toUpperCase() + row.category.slice(1);
    const text = (row.text ?? '').trim();
    out.push({
      at: row.created_at,
      kind: 'decision',
      title: `${label}${text ? ` — ${clamp(text, 120)}` : ''}`,
      actor: row.author === 'claude' ? 'claude' : 'user',
      details: {
        category: row.category,
        text: row.text,
        author: row.author,
        link: row.link,
      },
      ...(row.link
        ? { link: { kind: 'file' as const, url: row.link, ref: row.link } }
        : {}),
    });
  }
}

function emitCostEvents(events: CostEvent[], out: JournalEvent[]): void {
  for (const ev of events) {
    if (!isValidIso(ev.at)) continue;
    const usd = ev.cost_usd ?? ev.third_party_cost_usd ?? null;
    const labelBits: string[] = [];
    if (ev.model) labelBits.push(ev.model);
    if (ev.third_party_label) labelBits.push(ev.third_party_label);
    if (typeof ev.input_tokens === 'number' || typeof ev.output_tokens === 'number') {
      const inT = ev.input_tokens ?? 0;
      const outT = ev.output_tokens ?? 0;
      labelBits.push(`${inT}in/${outT}out`);
    }
    const tail = labelBits.length > 0 ? ` (${labelBits.join(' · ')})` : '';
    const title =
      usd !== null && Number.isFinite(usd)
        ? `Cost $${usd.toFixed(4)}${tail}`
        : `Cost recorded${tail}`;
    out.push({
      at: ev.at,
      kind: 'cost',
      title,
      actor: 'system',
      details: {
        model: ev.model,
        input_tokens: ev.input_tokens,
        output_tokens: ev.output_tokens,
        cache_read_tokens: ev.cache_read_tokens,
        cache_creation_tokens: ev.cache_creation_tokens,
        cost_usd: ev.cost_usd,
        source: ev.source,
        third_party_label: ev.third_party_label,
        third_party_cost_usd: ev.third_party_cost_usd,
      },
    });
  }
}

function emitAttachments(task: Task, out: JournalEvent[]): void {
  const ctx = readContext(task);
  const raw = ctx['attachments'];
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const att = entry as Record<string, unknown>;
    const filename = typeof att.filename === 'string' ? att.filename : null;
    const addedAt = typeof att.added_at === 'string' ? att.added_at : null;
    if (!filename || !isValidIso(addedAt)) continue;
    out.push({
      at: addedAt,
      kind: 'attachment_added',
      title: `Attached "${clamp(filename, 80)}"`,
      actor: 'user',
      details: {
        filename,
        size_bytes: att.size_bytes,
        content_type: att.content_type,
      },
      link: { kind: 'file', ref: filename },
    });
  }
}

function emitContextNotes(task: Task, out: JournalEvent[]): void {
  const ctx = readContext(task);
  const raw = ctx['notes'];
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const note = entry as Record<string, unknown>;
    const at = typeof note.at === 'string' ? note.at : null;
    if (!isValidIso(at)) continue;
    const text = typeof note.note === 'string' ? note.note : '';
    const source = typeof note.source === 'string' ? note.source : 'note';
    // Classify into pr/issue/generic.
    const isPr = /\bpr\b|pull request|pull-request/i.test(text);
    const isIssue = /\bissue\b/i.test(text);
    const kind: JournalEventKind = isPr
      ? 'pr_event'
      : isIssue
        ? 'issue_event'
        : 'feedback';
    out.push({
      at,
      kind,
      title:
        kind === 'pr_event'
          ? `PR event — ${clamp(text, 120)}`
          : kind === 'issue_event'
            ? `Issue event — ${clamp(text, 120)}`
            : `Note (${source}) — ${clamp(text, 120)}`,
      actor: source === 'github_webhook' ? 'system' : 'user',
      details: { note: text, source },
      link: kind === 'pr_event' ? { kind: 'pr', ref: text } : undefined,
    });
  }
}

function emitNotionSynced(task: Task, out: JournalEvent[]): void {
  const ctx = readContext(task);
  const pageId = typeof ctx['notion_page_id'] === 'string' ? (ctx['notion_page_id'] as string) : null;
  const syncedAt =
    typeof ctx['notion_last_synced'] === 'string'
      ? (ctx['notion_last_synced'] as string)
      : typeof ctx['notion_synced_at'] === 'string'
        ? (ctx['notion_synced_at'] as string)
        : null;
  if (!pageId) return;
  // Use the synced timestamp when present; otherwise fall back to task
  // updated_at so the row appears somewhere on the timeline.
  const at = isValidIso(syncedAt) ? syncedAt : task.updated_at;
  const url =
    typeof ctx['notion_page_url'] === 'string' ? (ctx['notion_page_url'] as string) : undefined;
  out.push({
    at,
    kind: 'notion_synced',
    title: `Notion page synced${url ? '' : ` (${pageId})`}`,
    actor: 'system',
    details: { page_id: pageId, url },
    link: { kind: 'page', url, ref: pageId },
  });
}

function emitSlackLinked(task: Task, out: JournalEvent[]): void {
  const ctx = readContext(task);
  const permalink = typeof ctx['slack_permalink'] === 'string' ? (ctx['slack_permalink'] as string) : null;
  if (!permalink) return;
  out.push({
    at: task.created_at,
    kind: 'slack_linked',
    title: 'Slack thread linked',
    actor: 'system',
    details: {
      channel: ctx['slack_channel'],
      channel_id: ctx['slack_channel_id'],
      user: ctx['slack_user'],
      thread_ts: ctx['slack_thread_ts'],
      message_ts: ctx['slack_message_ts'],
    },
    link: { kind: 'thread', url: permalink },
  });
}

function emitGmailLinked(task: Task, out: JournalEvent[]): void {
  const ctx = readContext(task);
  const messageId = typeof ctx['gmail_message_id'] === 'string' ? (ctx['gmail_message_id'] as string) : null;
  if (!messageId) return;
  const url =
    typeof ctx['gmail_permalink'] === 'string'
      ? (ctx['gmail_permalink'] as string)
      : `https://mail.google.com/mail/u/0/#inbox/${messageId}`;
  out.push({
    at: task.created_at,
    kind: 'gmail_linked',
    title: `Gmail linked — ${clamp(
      (typeof ctx['gmail_subject'] === 'string' ? (ctx['gmail_subject'] as string) : ''),
      80,
    ) || messageId}`,
    actor: 'system',
    details: {
      message_id: messageId,
      thread_id: ctx['gmail_thread_id'],
      from: ctx['gmail_from'],
      subject: ctx['gmail_subject'],
    },
    link: { kind: 'thread', url, ref: messageId },
  });
}

function emitGithubIssue(task: Task, out: JournalEvent[]): void {
  const ctx = readContext(task);
  const raw = ctx['github_issue'];
  if (!raw || typeof raw !== 'object') return;
  const issue = raw as Record<string, unknown>;
  const owner = typeof issue.owner === 'string' ? issue.owner : null;
  const repo = typeof issue.repo === 'string' ? issue.repo : null;
  const number = typeof issue.number === 'number' ? issue.number : null;
  if (!owner || !repo || number === null) return;
  const url =
    typeof issue.url === 'string'
      ? (issue.url as string)
      : `https://github.com/${owner}/${repo}/issues/${number}`;
  out.push({
    at: task.created_at,
    kind: 'issue_event',
    title: `GitHub issue linked — ${owner}/${repo}#${number}`,
    actor: 'system',
    details: {
      owner,
      repo,
      number,
      state: issue.state,
      labels: issue.labels,
    },
    link: { kind: 'pr', url, ref: `${owner}/${repo}#${number}` },
  });
}

/* -------------------------------------------------------------------------- */
/*  Sort                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Compare two events by their ISO timestamps. Returns a negative number when
 * `a` is newer, positive when `b` is newer, zero otherwise.
 *
 * Newest-first is the default — the renderer's "load more" pager expects it.
 */
function compareDesc(a: JournalEvent, b: JournalEvent): number {
  const am = Date.parse(a.at);
  const bm = Date.parse(b.at);
  if (Number.isNaN(am) && Number.isNaN(bm)) return 0;
  if (Number.isNaN(am)) return 1;
  if (Number.isNaN(bm)) return -1;
  if (am === bm) {
    // Stable secondary sort by kind so identical timestamps don't flicker
    // between fetches.
    return a.kind.localeCompare(b.kind);
  }
  return bm - am;
}

/* -------------------------------------------------------------------------- */
/*  Public entry                                                              */
/* -------------------------------------------------------------------------- */

export interface GetTaskJournalOptions {
  /** Drop events older than this ISO timestamp. */
  since?: string;
  /** Cap the number of events returned. Defaults to 100. */
  limit?: number;
}

/**
 * Aggregate every known event for a task into a single newest-first list.
 *
 * Returns an empty list when the task doesn't exist — the route layer
 * surfaces 404 separately when the caller wants that distinction.
 */
export async function getTaskJournal(
  taskId: string,
  options: GetTaskJournalOptions = {},
): Promise<JournalEvent[]> {
  if (!isValidTaskId(taskId)) return [];

  const task = getTask(taskId);
  if (!task) return [];

  const events: JournalEvent[] = [];

  // Synchronous walkers first — DB reads via better-sqlite3 are instant.
  try {
    emitTaskLifecycle(task, events);
  } catch {
    /* non-fatal */
  }

  try {
    const logs = executionLogsRepository.list(taskId);
    emitExecutionLogs(logs, events);
  } catch {
    /* non-fatal */
  }

  try {
    const children = getChildren(taskId);
    emitChildren(task, children, events);
  } catch {
    /* non-fatal */
  }

  try {
    const rows = feedbackRepository.list({ task_id: taskId, limit: 500 });
    emitFeedback(rows, events);
  } catch {
    /* non-fatal */
  }

  try {
    const rows = decisionsRepository.list({ task_id: taskId, limit: 500 });
    emitDecisions(rows, events);
  } catch {
    /* non-fatal */
  }

  try {
    const rows = costEventsRepository.list({ task_id: taskId, limit: 500 });
    emitCostEvents(rows, events);
  } catch {
    /* non-fatal */
  }

  try {
    emitAttachments(task, events);
  } catch {
    /* non-fatal */
  }

  try {
    emitContextNotes(task, events);
  } catch {
    /* non-fatal */
  }

  try {
    emitNotionSynced(task, events);
  } catch {
    /* non-fatal */
  }

  try {
    emitSlackLinked(task, events);
  } catch {
    /* non-fatal */
  }

  try {
    emitGmailLinked(task, events);
  } catch {
    /* non-fatal */
  }

  try {
    emitGithubIssue(task, events);
  } catch {
    /* non-fatal */
  }

  // Async walkers — file reads. Run in parallel; each returns null on miss.
  await Promise.all([
    emitResultIngestion(taskId, events).catch(() => undefined),
    emitDerivationParent(taskId, events).catch(() => undefined),
  ]);

  // Sort newest-first.
  events.sort(compareDesc);

  // Apply since / limit.
  let filtered = events;
  if (options.since && isValidIso(options.since)) {
    const cutoff = Date.parse(options.since);
    filtered = filtered.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  const limit =
    options.limit !== undefined && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 100;
  if (filtered.length > limit) filtered = filtered.slice(0, limit);
  return filtered;
}

/* -------------------------------------------------------------------------- */
/*  Re-exports for tests                                                      */
/* -------------------------------------------------------------------------- */

export const __internals = {
  compareDesc,
  clamp,
};
