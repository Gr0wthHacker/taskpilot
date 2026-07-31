/**
 * GitHub Issues ↔ TaskPilot Tasks two-way sync.
 *
 * The inbound side runs from the webhook receiver in
 * `server/routes/webhooks.ts` → `webhook-handlers.ts#handleIssuesEvent`:
 *
 *   - `opened`   → create a task (or reuse an existing dedupe row)
 *                  with `context.github_issue = {owner, repo, number, ...}`
 *                  tagged `["github","issue"]`
 *   - `closed`   → task → `done`
 *   - `reopened` → task → `queued`
 *   - `edited`   → sync title / body
 *
 * Dedupe keys on `(owner, repo, number)` — repeated `opened` deliveries
 * (or the same issue replayed after server restart) find the existing
 * task instead of double-creating.
 *
 * The outbound side is opt-in via the `github_issues_sync_back` setting.
 * When a task with `context.github_issue` flips status, we patch the
 * issue (close on done, reopen on requeue) and best-effort push title /
 * body edits. Failures are swallowed with a warning so a network blip
 * never blocks the user's update flow.
 *
 * No DB schema is added — the link is stored entirely inside the
 * existing `task.context` JSON column. The owner/repo/number triple
 * is the source of truth for dedupe.
 */

import { settingsRepository } from '@/main/db/repositories/settings';
import {
  addOnTaskCompleted,
  createTask,
  getTask,
  listTasks,
  updateTask,
} from '@/main/db/repositories/tasks';
import { ioEvents } from '@/main/io/events';
import type { Task } from '@/shared/types';

import {
  GitHubApiError,
  GitHubAuthError,
  GitHubNotConfiguredError,
} from './index';
import { updateIssue } from './operations';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The shape we persist on `task.context.github_issue` for every task
 * that was either captured from an inbound issue webhook OR manually
 * linked. Keeping it small and stable so renderer code can rely on
 * the fields.
 */
export interface GithubIssueLink {
  owner: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  labels?: string[];
}

/**
 * Minimal subset of the GitHub `issues` webhook payload — only fields
 * the sync actually touches. Mirrors the type in `webhook-handlers.ts`
 * but tightened so the issue body is guaranteed present.
 */
export interface IssueWebhookPayload {
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
    name?: string;
    owner?: { login?: string };
  };
}

export interface IssueSyncResult {
  ok: boolean;
  task_id?: string;
  action: string;
  note?: string;
}

/* -------------------------------------------------------------------------- */
/*  Settings helpers                                                          */
/* -------------------------------------------------------------------------- */

const SYNC_BACK_KEY = 'github_issues_sync_back';

/** Is task → issue sync-back enabled? Defaults to false. */
export function isSyncBackEnabled(): boolean {
  const raw = settingsRepository.get<unknown>(SYNC_BACK_KEY);
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  if (typeof raw === 'number') return raw === 1;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Dedupe                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Find an existing task whose `context.github_issue` matches `(owner,
 * repo, number)`. Returns `null` if none — the caller is then expected
 * to create one.
 *
 * Implementation note: scoped to the `issue` tag so we don't walk every
 * task in the DB. This is a fast LIKE on the JSON-stringified tags
 * column and stays correct because issue-sourced tasks always get the
 * `issue` tag.
 */
export function findTaskForIssue(
  owner: string,
  repo: string,
  number: number,
): Task | null {
  const candidates = listTasks({ tag: 'issue', include_archived: true });
  for (const task of candidates) {
    const link = readIssueLink(task);
    if (!link) continue;
    if (
      link.owner.toLowerCase() === owner.toLowerCase() &&
      link.repo.toLowerCase() === repo.toLowerCase() &&
      link.number === number
    ) {
      return task;
    }
  }
  return null;
}

/**
 * Read `task.context.github_issue` and type-narrow it. Returns `null`
 * when the field is missing or malformed.
 */
export function readIssueLink(task: Task): GithubIssueLink | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const link = (task.context as Record<string, unknown>)['github_issue'];
  if (!link || typeof link !== 'object') return null;
  const obj = link as Record<string, unknown>;
  const owner = obj['owner'];
  const repo = obj['repo'];
  const number = obj['number'];
  const url = obj['url'];
  const state = obj['state'];
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof number !== 'number' ||
    !Number.isFinite(number)
  ) {
    return null;
  }
  const labels = Array.isArray(obj['labels'])
    ? (obj['labels'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  const result: GithubIssueLink = {
    owner,
    repo,
    number,
    url: typeof url === 'string' ? url : '',
    state: typeof state === 'string' ? state : 'open',
  };
  if (labels) result.labels = labels;
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Payload helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Extract `(owner, repo)` from a webhook payload. Falls back to the
 * `full_name` field when the explicit owner/name nodes are missing.
 */
function parseRepoCoords(payload: IssueWebhookPayload): {
  owner: string;
  repo: string;
} | null {
  const repository = payload.repository;
  if (!repository) return null;
  const ownerLogin = repository.owner?.login;
  const repoName = repository.name;
  if (typeof ownerLogin === 'string' && typeof repoName === 'string') {
    return { owner: ownerLogin, repo: repoName };
  }
  if (typeof repository.full_name === 'string') {
    const slash = repository.full_name.indexOf('/');
    if (slash > 0) {
      return {
        owner: repository.full_name.slice(0, slash),
        repo: repository.full_name.slice(slash + 1),
      };
    }
  }
  return null;
}

function extractLabels(
  issue: IssueWebhookPayload['issue'],
): string[] {
  if (!issue || !Array.isArray(issue.labels)) return [];
  return issue.labels
    .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * Append a `notes` entry to the task context. Used to leave an audit
 * trail of webhook-driven changes without touching the user's
 * `description`.
 */
function appendContextNote(task: Task, note: string): void {
  const baseCtx =
    task.context && typeof task.context === 'object'
      ? { ...(task.context as Record<string, unknown>) }
      : {};
  const existing = baseCtx['notes'];
  const notes = Array.isArray(existing) ? [...existing] : [];
  notes.push({ at: new Date().toISOString(), source: 'github_issue_sync', note });
  baseCtx['notes'] = notes;
  updateTask(task.id, { context: baseCtx });
}

function tagsWithIssueDefaults(existing: string[] | null | undefined): string[] {
  const set = new Set<string>(existing ?? []);
  set.add('github');
  set.add('issue');
  return [...set];
}

/* -------------------------------------------------------------------------- */
/*  Inbound (Issue → Task)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Drive a TaskPilot task state change from an inbound `issues` webhook
 * payload. The HMAC + idempotency checks happen one layer up (the route
 * handler) — by the time we land here we trust the payload.
 *
 * Strategy:
 *  - `opened`:    upsert (dedupe by owner/repo/number).
 *  - `closed`:    task → done (creating one if missing — keeps the
 *                 mirror complete even if the `opened` event was lost).
 *  - `reopened`:  task → queued (creating one if missing).
 *  - `edited`:    sync title / body if a linked task exists.
 *  - default:     200 ack, no state change.
 *
 * Every state change emits `pipeline_changed` so the renderer refreshes
 * its task counters without a manual refetch.
 */
export async function handleIssueWebhook(
  payload: IssueWebhookPayload,
): Promise<IssueSyncResult> {
  const action = String(payload.action ?? 'unknown');
  const issue = payload.issue;
  if (!issue || typeof issue.number !== 'number') {
    return { ok: true, action, note: 'No issue body on payload' };
  }

  const coords = parseRepoCoords(payload);
  if (!coords) {
    return { ok: true, action, note: 'Could not parse repository coords' };
  }

  const link: GithubIssueLink = {
    owner: coords.owner,
    repo: coords.repo,
    number: issue.number,
    url: typeof issue.html_url === 'string' ? issue.html_url : '',
    state: typeof issue.state === 'string' ? issue.state : 'open',
    labels: extractLabels(issue),
  };

  const existing = findTaskForIssue(link.owner, link.repo, link.number);

  if (action === 'opened') {
    if (existing) {
      // Re-open of an `opened` redelivery — refresh link metadata + push
      // back to queued/inbox if it had been closed locally.
      const nextCtx = mergeIssueLink(existing.context, link);
      const patch: Partial<Pick<Task, 'context' | 'status' | 'agent_status' | 'tags'>> = {
        context: nextCtx,
        tags: tagsWithIssueDefaults(existing.tags),
      };
      if (existing.status === 'done' || existing.status === 'failed') {
        patch.status = 'queued';
        patch.agent_status = 'pending';
      }
      updateTask(existing.id, patch);
      ioEvents.emit('pipeline_changed', { reason: 'github_issue_opened' });
      return {
        ok: true,
        task_id: existing.id,
        action,
        note: 'Existing task refreshed from issue',
      };
    }
    const created = createTask({
      title: typeof issue.title === 'string' && issue.title.length > 0
        ? issue.title
        : `Issue #${link.number}`,
      description: typeof issue.body === 'string' ? issue.body : null,
      status: 'inbox',
      tags: tagsWithIssueDefaults([]),
      context: { github_issue: link },
    });
    ioEvents.emit('pipeline_changed', { reason: 'github_issue_opened' });
    return {
      ok: true,
      task_id: created.id,
      action,
      note: 'Task created from issue',
    };
  }

  if (action === 'closed') {
    if (!existing) {
      // The opened event may have been missed (server downtime). Create
      // the task in a done state so the audit trail is complete.
      const created = createTask({
        title: typeof issue.title === 'string' && issue.title.length > 0
          ? issue.title
          : `Issue #${link.number}`,
        description: typeof issue.body === 'string' ? issue.body : null,
        status: 'done',
        agent_status: 'succeeded',
        tags: tagsWithIssueDefaults([]),
        context: { github_issue: { ...link, state: 'closed' } },
      });
      ioEvents.emit('pipeline_changed', { reason: 'github_issue_closed' });
      return {
        ok: true,
        task_id: created.id,
        action,
        note: 'Backfilled closed issue as done task',
      };
    }
    updateTask(existing.id, {
      status: 'done',
      agent_status: 'succeeded',
      context: mergeIssueLink(existing.context, { ...link, state: 'closed' }),
    });
    appendContextNote(
      existing,
      link.url ? `Issue closed: ${link.url}` : 'Issue closed on GitHub',
    );
    ioEvents.emit('pipeline_changed', { reason: 'github_issue_closed' });
    return { ok: true, task_id: existing.id, action, note: 'Task marked done' };
  }

  if (action === 'reopened') {
    if (!existing) {
      const created = createTask({
        title: typeof issue.title === 'string' && issue.title.length > 0
          ? issue.title
          : `Issue #${link.number}`,
        description: typeof issue.body === 'string' ? issue.body : null,
        status: 'queued',
        agent_status: 'pending',
        tags: tagsWithIssueDefaults([]),
        context: { github_issue: { ...link, state: 'open' } },
      });
      ioEvents.emit('pipeline_changed', { reason: 'github_issue_reopened' });
      return {
        ok: true,
        task_id: created.id,
        action,
        note: 'Created task for reopened issue',
      };
    }
    updateTask(existing.id, {
      status: 'queued',
      agent_status: 'pending',
      context: mergeIssueLink(existing.context, { ...link, state: 'open' }),
    });
    appendContextNote(
      existing,
      link.url ? `Issue reopened: ${link.url}` : 'Issue reopened on GitHub',
    );
    ioEvents.emit('pipeline_changed', { reason: 'github_issue_reopened' });
    return { ok: true, task_id: existing.id, action, note: 'Task requeued' };
  }

  if (action === 'edited') {
    if (!existing) {
      return {
        ok: true,
        action,
        note: 'Edit received but no linked task to update',
      };
    }
    const patch: Partial<Pick<Task, 'title' | 'description' | 'context'>> = {
      context: mergeIssueLink(existing.context, link),
    };
    if (typeof issue.title === 'string' && issue.title !== existing.title) {
      patch.title = issue.title;
    }
    if (typeof issue.body === 'string') {
      patch.description = issue.body;
    }
    updateTask(existing.id, patch);
    ioEvents.emit('pipeline_changed', { reason: 'github_issue_edited' });
    return { ok: true, task_id: existing.id, action, note: 'Task synced from edit' };
  }

  return {
    ok: true,
    task_id: existing?.id,
    action,
    note: 'No state change required',
  };
}

/**
 * Merge a fresh issue link into an existing `task.context` blob. Used
 * by inbound webhooks so we don't blow away other context fields when
 * updating the github_issue block.
 */
function mergeIssueLink(
  context: Task['context'],
  link: GithubIssueLink,
): Record<string, unknown> {
  const base = context && typeof context === 'object'
    ? { ...(context as Record<string, unknown>) }
    : {};
  base['github_issue'] = link;
  return base;
}

/* -------------------------------------------------------------------------- */
/*  Outbound (Task → Issue)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Push a TaskPilot task's current state to the linked GitHub issue.
 *
 * - status `done`                 → close the issue
 * - status `queued` / `in_progress` / `inbox` (when issue is closed)
 *                                  → reopen the issue
 * - When the title or description differs from what's on file, push
 *   the update too.
 *
 * No-op when:
 *   - `github_issues_sync_back` setting is false (default)
 *   - the task has no `context.github_issue`
 *   - GitHub is not connected
 *
 * Errors are caught and surfaced via `console.warn` — the caller is
 * usually the task-completion hook and shouldn't get torpedoed by a
 * transient GitHub outage.
 */
export async function syncTaskToIssue(task: Task): Promise<void> {
  if (!isSyncBackEnabled()) return;
  const link = readIssueLink(task);
  if (!link) return;

  // Decide what to send. Closed when local task is done; open otherwise
  // for any non-terminal/non-failed state. We deliberately don't touch
  // the issue when the task is failed or archived — those don't have an
  // obvious mapping and a wrong mirror is worse than a stale one.
  let nextState: 'open' | 'closed' | undefined;
  if (task.status === 'done') {
    nextState = 'closed';
  } else if (
    (task.status === 'queued' || task.status === 'in_progress' || task.status === 'inbox') &&
    link.state === 'closed'
  ) {
    nextState = 'open';
  }

  const patch: {
    owner: string;
    repo: string;
    number: number;
    state?: 'open' | 'closed';
    title?: string;
    body?: string;
  } = {
    owner: link.owner,
    repo: link.repo,
    number: link.number,
  };
  if (nextState) patch.state = nextState;
  // Title / body sync — only push when the task has them. Body is the
  // task description; null means "leave it alone".
  if (typeof task.title === 'string' && task.title.length > 0) {
    patch.title = task.title;
  }
  if (typeof task.description === 'string') {
    patch.body = task.description;
  }

  // Nothing to send beyond identity — bail. Keeps the audit log
  // honest: we don't poke GitHub on every completion-hook tick.
  if (!patch.state && patch.title === undefined && patch.body === undefined) {
    return;
  }

  try {
    const updated = await updateIssue(patch);
    // Persist the latest state mirror onto the task so the next call
    // doesn't redundantly POST.
    const refreshedLink: GithubIssueLink = {
      ...link,
      state: updated.state,
      url: updated.html_url || link.url,
    };
    const nextCtx =
      task.context && typeof task.context === 'object'
        ? { ...(task.context as Record<string, unknown>) }
        : {};
    nextCtx['github_issue'] = refreshedLink;
    updateTask(task.id, { context: nextCtx });
  } catch (err) {
    if (
      err instanceof GitHubNotConfiguredError ||
      err instanceof GitHubAuthError
    ) {
      // No PAT or stale PAT — surface once and keep going. Re-throw
      // would block the user's `mark done` click.
      // eslint-disable-next-line no-console
      console.warn(
        '[github/issues-sync] sync-back skipped: GitHub not connected.',
      );
      return;
    }
    if (err instanceof GitHubApiError) {
      // eslint-disable-next-line no-console
      console.warn(
        `[github/issues-sync] updateIssue failed (${err.status}): ${err.message}`,
      );
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[github/issues-sync] unexpected sync-back failure:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Completion-hook installation                                              */
/* -------------------------------------------------------------------------- */

/**
 * Register a fan-out listener on the tasks repository so every
 * task-completion event triggers a sync-back attempt. Returns an
 * unsubscribe function so the server can detach on shutdown.
 *
 * Idempotent in spirit but NOT a singleton: callers should track the
 * returned unsubscribe handle and only install once at server boot. The
 * hook itself is best-effort — `syncTaskToIssue` swallows network /
 * auth errors so it can't torpedo a recurrence callback running on the
 * same `addOnTaskCompleted` queue.
 */
export function installCompletionHook(): () => void {
  return addOnTaskCompleted((taskId: string) => {
    const task = getTask(taskId);
    if (!task) return;
    // Don't await — fan-out hooks are fire-and-forget by contract.
    void syncTaskToIssue(task).catch(() => {
      /* already logged inside syncTaskToIssue */
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Re-exports for tests                                                      */
/* -------------------------------------------------------------------------- */

export const __internals = {
  parseRepoCoords,
  extractLabels,
  mergeIssueLink,
  tagsWithIssueDefaults,
};
