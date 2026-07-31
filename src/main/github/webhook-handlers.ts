/**
 * Domain logic for handling GitHub webhook payloads.
 *
 * The HTTP layer (`server/routes/webhooks.ts`) is responsible for HMAC
 * verification and idempotency tracking. By the time a payload lands here we
 * know:
 *   - the signature checked out against the stored secret
 *   - the delivery id hasn't been seen before
 *
 * Each handler reduces a raw GitHub payload down to TaskPilot state changes:
 *   - find a linked task (currently via `agent/<task_id>` branch convention)
 *   - update its `status` / `agent_status`
 *   - walk the parent chain to auto-approve any pending result review
 *   - emit `pipeline_changed` so the renderer refreshes
 *
 * No raw Octokit calls are made here — webhooks are inbound only.
 */

import { ioEvents } from '@/main/io/events';
import {
  getTask,
  updateTask,
} from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Payload shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal subset of the GitHub `pull_request` webhook payload TaskPilot reads.
 * The full payload has dozens of fields — we deliberately type only what we
 * touch so future GitHub schema drift doesn't break us.
 */
export interface PRPayload {
  action: string;
  number?: number;
  pull_request?: {
    number?: number;
    state?: string;
    merged?: boolean;
    title?: string;
    html_url?: string;
    head?: { ref?: string };
    base?: { ref?: string };
  };
  repository?: {
    full_name?: string;
  };
}

/**
 * Minimal subset of the GitHub `issues` webhook payload. Issue→task linkage
 * is best-effort: we look for `taskpilot_task_id: <id>` somewhere in the body
 * or for a `taskpilot:<id>` label.
 */
export interface IssuePayload {
  action: string;
  issue?: {
    number?: number;
    state?: string;
    title?: string;
    body?: string | null;
    html_url?: string;
    labels?: Array<{ name?: string } | string>;
  };
  repository?: {
    full_name?: string;
  };
}

export interface WebhookResult {
  ok: boolean;
  task_id?: string;
  action: string;
  /** Optional human-readable note explaining what was (or wasn't) done. */
  note?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Match an `agent/<task_id>` branch name and pull out the task id. Mirrors
 * the canonical task-id alphabet from `io-schemas.ts#taskIdSchema`.
 */
const AGENT_BRANCH_REGEX = /^agent\/([A-Za-z0-9_-]{1,64})$/;

export function taskIdFromBranch(ref: string | undefined | null): string | null {
  if (!ref || typeof ref !== 'string') return null;
  const match = AGENT_BRANCH_REGEX.exec(ref);
  return match ? (match[1] ?? null) : null;
}

/**
 * Best-effort extraction of a TaskPilot task id from an issue body or labels.
 * Format conventions:
 *   - body line: `taskpilot_task_id: abc12345`
 *   - label:     `taskpilot:abc12345`
 */
const ISSUE_BODY_REGEX = /taskpilot_task_id\s*[:=]\s*([A-Za-z0-9_-]{1,64})/i;
const ISSUE_LABEL_REGEX = /^taskpilot:([A-Za-z0-9_-]{1,64})$/;

export function taskIdFromIssue(payload: IssuePayload): string | null {
  const issue = payload.issue;
  if (!issue) return null;

  if (typeof issue.body === 'string') {
    const m = ISSUE_BODY_REGEX.exec(issue.body);
    if (m && m[1]) return m[1];
  }

  if (Array.isArray(issue.labels)) {
    for (const label of issue.labels) {
      const name =
        typeof label === 'string'
          ? label
          : (label?.name ?? '');
      if (typeof name !== 'string') continue;
      const m = ISSUE_LABEL_REGEX.exec(name);
      if (m && m[1]) return m[1];
    }
  }

  return null;
}

/**
 * Append a free-form note to the task's `context.notes` array. Used to keep a
 * trail of webhook-driven changes (e.g. "PR closed without merge") without
 * touching `description` (which the user owns).
 */
function appendContextNote(task: Task, note: string): void {
  const baseCtx =
    task.context && typeof task.context === 'object'
      ? { ...(task.context as Record<string, unknown>) }
      : {};
  const existing = baseCtx['notes'];
  const notes = Array.isArray(existing) ? [...existing] : [];
  notes.push({ at: new Date().toISOString(), source: 'github_webhook', note });
  baseCtx['notes'] = notes;
  updateTask(task.id, { context: baseCtx });
}

/**
 * Walk up the parent chain and clear any pending result-review on the parent
 * that's tied to this task. We don't have a fine-grained "review of child X"
 * marker — the heuristic is: if the parent's `agent_status === 'needs_review'`
 * AND `status === 'in_progress'` (i.e. an execution result is awaiting human
 * sign-off), auto-approve it. This mirrors what the user would have done
 * manually after seeing the PR merge.
 */
function maybeAutoApproveParent(task: Task): void {
  if (!task.parent_id) return;
  const parent = getTask(task.parent_id);
  if (!parent) return;
  if (parent.agent_status !== 'needs_review') return;
  // Only auto-approve result reviews. Derivation reviews need a deliberate
  // human decision because they create children downstream.
  if (parent.status !== 'in_progress') return;
  updateTask(parent.id, { status: 'done', agent_status: 'succeeded' });
}

/* -------------------------------------------------------------------------- */
/*  Pull request handler                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Handle a `pull_request` webhook event.
 *
 * Returns a summary even when no task is linked — the caller wants a 200
 * either way so GitHub doesn't redeliver. The `note` field documents the
 * reason the payload was a no-op so logs are useful.
 */
export async function handlePullRequestEvent(
  payload: PRPayload,
): Promise<WebhookResult> {
  const action = String(payload.action ?? 'unknown');
  const pr = payload.pull_request;
  if (!pr) {
    return { ok: true, action, note: 'No pull_request body on payload' };
  }

  const branch = pr.head?.ref;
  const taskId = taskIdFromBranch(branch);
  if (!taskId) {
    return {
      ok: true,
      action,
      note: `Branch "${branch ?? '(none)'}" does not match agent/<task_id>`,
    };
  }

  const task = getTask(taskId);
  if (!task) {
    return {
      ok: true,
      action,
      note: `Branch matched but task ${taskId} is unknown locally`,
    };
  }

  // We only act on `closed`. Other actions (opened, synchronize, reopened,
  // edited) are no-ops for the current feedback loop. They're still ack'd
  // 200 so GitHub doesn't retry.
  if (action !== 'closed') {
    return {
      ok: true,
      task_id: taskId,
      action,
      note: 'Action not actionable; ignoring',
    };
  }

  const merged = pr.merged === true;
  if (merged) {
    updateTask(task.id, { status: 'done', agent_status: 'succeeded' });
    const prUrl = pr.html_url ?? '';
    const noteText = prUrl
      ? `PR merged: ${prUrl}`
      : 'PR merged via GitHub webhook.';
    const refreshed = getTask(task.id);
    if (refreshed) appendContextNote(refreshed, noteText);
    // Walk the parent chain in case the parent is sitting on a result review
    // waiting on this child.
    if (refreshed) maybeAutoApproveParent(refreshed);
    ioEvents.emit('pipeline_changed', { reason: 'github_pr_merged' });
    return {
      ok: true,
      task_id: taskId,
      action,
      note: 'Task marked done',
    };
  }

  // PR closed without merge → task is treated as failed.
  updateTask(task.id, { status: 'failed', agent_status: 'failed' });
  const refreshed = getTask(task.id);
  if (refreshed) {
    appendContextNote(refreshed, 'PR closed without merge.');
  }
  ioEvents.emit('pipeline_changed', { reason: 'github_pr_closed' });
  return {
    ok: true,
    task_id: taskId,
    action,
    note: 'Task marked failed (PR closed without merge)',
  };
}

/* -------------------------------------------------------------------------- */
/*  Issues handler                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Handle an `issues` webhook event.
 *
 * The Wave 13 two-way sync moved the heavy lifting into
 * `issues-sync.ts` — we delegate there so the inbound mirror (issue →
 * task) stays consistent with the dedupe key (`owner/repo/number`) used
 * by the outbound sync-back.
 *
 * Legacy explicit links (`taskpilot_task_id: <id>` in the body or
 * `taskpilot:<id>` label) are still honored for back-compat. When such
 * a link is found AND no task currently mirrors the issue, we route
 * the action through the legacy path. Otherwise we always defer to the
 * new sync module.
 */
export async function handleIssuesEvent(
  payload: IssuePayload,
): Promise<WebhookResult> {
  const { handleIssueWebhook } = await import('./issues-sync');
  // The new sync handles dedupe, create, edit, close, reopen — and is
  // the canonical path for any issue payload that carries a repository
  // block. Legacy explicit links are a strict subset (a payload that
  // matches both will still find the same task via dedupe once we've
  // created it).
  const result = await handleIssueWebhook(
    payload as unknown as import('./issues-sync').IssueWebhookPayload,
  );
  return {
    ok: result.ok,
    action: result.action,
    ...(result.task_id ? { task_id: result.task_id } : {}),
    ...(result.note ? { note: result.note } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Re-exports for tests                                                      */
/* -------------------------------------------------------------------------- */

export const __internals = {
  taskIdFromBranch,
  taskIdFromIssue,
};
