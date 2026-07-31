import fs from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import { resolveBusinessDefaults } from '@/main/businesses';
import { recordCost } from '@/main/cost-tracking';
import { deriveAutoEnergy } from '@/shared/quick-wins';
import {
  getConfidenceThreshold,
  isBelowThreshold,
} from '@/main/confidence';
import { executionLogsRepository } from '@/main/db/repositories/execution-logs';
import { settingsRepository } from '@/main/db/repositories/settings';
import { tasksRepository } from '@/main/db/repositories/tasks';
import { recordLowConfidence } from '@/main/feedback';
import type {
  DerivationResponse,
  ExecutionResult,
  Task,
} from '@/shared/types';

import { ioEvents, type ReviewReason } from './events';
import { ensureIoDirs, reviewPath } from './paths';
import { cleanup, moveToReview } from './protocol';

/**
 * Coerce a setting that may be stored as a real boolean, the string
 * "true"/"false", or a numeric 0/1 into a typed boolean. Missing → default.
 *
 * Used here to gate the trust-by-default auto-approval flow (Wave 12 follow-up):
 * `auto_approve_derivations` and `auto_approve_results` both default to TRUE
 * — the friction of approving every routine step at /review was wrong for
 * normal use. Risky work (review_required flag from Claude, failed status,
 * destructive heuristics) still surfaces to the queue.
 */
function readBoolSetting(key: string, defaultValue: boolean): boolean {
  try {
    const raw = settingsRepository.get(key);
    if (raw === null || raw === undefined) return defaultValue;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
    }
    if (typeof raw === 'number') return raw !== 0;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Heuristic for "looks risky enough to route to /review even though the
 * result wasn't explicitly flagged." We err on the side of trust — Claude
 * is supposed to set `review_required: true` on the proposal when work is
 * destructive. This catches the gaps: actions that produced an error
 * message, or instructions that name a non-reversible verb.
 */
const DESTRUCTIVE_INSTRUCTION_RX =
  /\b(send|publish|deploy|delete|drop|email|sms|charge|invoice|pay|transfer|wire|merge to main|push to main|force.?push)\b/i;
function looksRisky(taskInstructions: string | null, resultSummary: string): boolean {
  if (DESTRUCTIVE_INSTRUCTION_RX.test(resultSummary)) return true;
  if (taskInstructions && DESTRUCTIVE_INSTRUCTION_RX.test(taskInstructions)) {
    return true;
  }
  return false;
}

/**
 * Write a small per-task marker file under `IO_REVIEW/<taskId>.json` so the
 * file-based mirror of the review queue stays in sync with the DB. Failures
 * are non-fatal — the DB is the source of truth.
 */
async function writeReviewMarker(
  taskId: string,
  reason: ReviewReason,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await ensureIoDirs();
    const dest = reviewPath(taskId);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const body = {
      task_id: taskId,
      reason,
      added_at: new Date().toISOString(),
      ...payload,
    };
    await fs.writeFile(dest, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  } catch {
    /* non-fatal */
  }
}

/**
 * Convert a derivation response into N child tasks and persist them.
 *
 * After ingestion the parent task's `agent_status` is set to
 * `'needs_review'` — humans approve derivatives before they execute.
 *
 * @returns The list of newly created child task ids.
 */
export async function ingestDerived(
  taskId: string,
  response: DerivationResponse,
): Promise<string[]> {
  const parent = await tasksRepository.findById(taskId);
  if (!parent) {
    ioEvents.emit('io_error', {
      scope: 'derived',
      message: `parent task ${taskId} not found; dropping derivation response`,
    });
    return [];
  }

  // First pass: create children without `depends_on` translations so each
  // child has an id. Second pass: rewrite `depends_on` strings (which Claude
  // emits as titles or temporary indices) into real ids.
  const proposalIds: string[] = [];
  const indexById = new Map<string, number>();

  for (let i = 0; i < response.derivatives.length; i += 1) {
    const proposal = response.derivatives[i];
    if (!proposal) continue;
    const id = nanoid();
    proposalIds.push(id);
    indexById.set(id, i);
  }

  const titleToId = new Map<string, string>();
  for (let i = 0; i < response.derivatives.length; i += 1) {
    const proposal = response.derivatives[i];
    const id = proposalIds[i];
    if (!proposal || !id) continue;
    titleToId.set(proposal.title.toLowerCase(), id);
  }

  for (let i = 0; i < response.derivatives.length; i += 1) {
    const proposal = response.derivatives[i];
    const id = proposalIds[i];
    if (!proposal || !id) continue;

    const dependsOnIds = proposal.depends_on
      .map((ref) => resolveDependency(ref, titleToId, proposalIds))
      .filter((v): v is string => v !== null);

    const now = new Date().toISOString();
    // Per-business defaults — pull the permission profile + branch policy off
    // projects.json when any parent tag matches a configured business. The
    // resolver returns nulls when no business matches, so a task with no
    // business tag stays exactly as it was before this layer landed.
    const defaults = resolveBusinessDefaults(parent.tags, id);
    const childContext: Record<string, unknown> = {
      estimated_minutes: proposal.estimated_minutes,
      review_required: proposal.review_required,
      depends_on: dependsOnIds,
    };
    // Auto-tag energy from the estimate so the "Got N min" surface has
    // populated data without waiting for manual labeling. The producer can
    // still override by sending its own `energy` field in the proposal.
    const autoEnergy = deriveAutoEnergy(proposal.estimated_minutes);
    if (autoEnergy) {
      childContext.energy = autoEnergy;
    }
    if (defaults.permissions) {
      childContext.permissions = defaults.permissions;
    }
    if (defaults.branch_policy) {
      childContext.branch_policy = defaults.branch_policy;
    }
    if (defaults.business) {
      childContext.business = defaults.business.tag;
    }
    const child: Task = {
      id,
      title: proposal.title,
      description: null,
      status: 'queued',
      priority: parent.priority,
      due: null,
      calendar_event_id: null,
      parent_id: parent.id,
      agent_executable: proposal.agent_executable,
      agent_method: proposal.agent_method,
      agent_instructions: proposal.agent_instructions,
      agent_status: 'pending',
      context: childContext,
      tags: parent.tags,
      created_at: now,
      updated_at: now,
    };
    await tasksRepository.create(child);
  }

  // Trust-by-default routing. Most users want low-friction agent work; the
  // setting `auto_approve_derivations` (default `true`) makes the system flip
  // straight to `succeeded` instead of forcing a /review stop. We do still
  // route to review when ANY proposed child carries `review_required` — that
  // flag is Claude's signal that this specific work needs human eyes.
  const autoApproveDerivations = readBoolSetting(
    'auto_approve_derivations',
    true,
  );
  const anyChildNeedsReview = response.derivatives.some(
    (d) => d.review_required === true,
  );
  const shouldAutoApprove = autoApproveDerivations && !anyChildNeedsReview;

  await tasksRepository.update(parent.id, {
    agent_status: shouldAutoApprove ? 'succeeded' : 'needs_review',
  });

  // Best-effort cleanup of the request file so the watcher won't replay.
  await cleanup(taskId).catch(() => {
    /* non-fatal */
  });

  // Always mirror to review/ so the on-disk pipeline matches DB state — the
  // reviewer can still open it manually even if it's auto-approved. We just
  // don't emit `review_added` (no inbox-pile-up) when auto-approving.
  await writeReviewMarker(parent.id, 'derivation', {
    derivative_count: proposalIds.length,
    child_ids: proposalIds,
    derivatives: response.derivatives,
    auto_approved: shouldAutoApprove,
  });

  // Wave 17: index the newly created child tasks + re-index the parent (its
  // agent_status changed). Best-effort.
  void updateSearchIndexForTask(parent.id);
  for (const childId of proposalIds) {
    void updateSearchIndexForTask(childId);
  }

  ioEvents.emit('derived_ingested', {
    taskId,
    response,
    childIds: proposalIds,
  });
  if (!shouldAutoApprove) {
    ioEvents.emit('review_added', [{ taskId: parent.id, reason: 'derivation' }]);
  }
  ioEvents.emit('pipeline_changed', { reason: 'derived_ingested' });

  return proposalIds;
}

/**
 * Persist an execution result and update the task lifecycle.
 *
 * The terminal status follows this table:
 *
 * | `result.status`  | `review_required` (from context) | next `status`     |
 * |------------------|----------------------------------|-------------------|
 * | `succeeded`      | `true`                           | `blocked`         |
 * | `succeeded`      | `false`                          | `done`            |
 * | `failed`         | any                              | `failed`          |
 * | `needs_review`   | any                              | `blocked`         |
 *
 * `agent_status` mirrors `result.status` directly.
 */
export async function ingestResult(
  taskId: string,
  result: ExecutionResult,
  outputFiles: string[],
): Promise<void> {
  const task = await tasksRepository.findById(taskId);
  if (!task) {
    ioEvents.emit('io_error', {
      scope: 'result',
      message: `task ${taskId} not found; dropping execution result`,
    });
    return;
  }

  const explicitReviewRequired = isReviewRequired(task);
  const autoApproveResults = readBoolSetting('auto_approve_results', true);
  const risky = looksRisky(task.agent_instructions, result.summary);

  // Wave 13: confidence gate. When Claude self-reports a confidence value
  // below the configured threshold (default 0.7), route to /review even
  // though `review_required` is false. This layers ON TOP of the
  // trust-by-default flow — confidence is a NEW gate, not a replacement.
  //
  // Per-task override: a task can carry `context.confidence_threshold` to
  // raise the bar (boot tasks do this — drain-updates-drafts uses 0.85).
  // The per-task value wins when present and within [0, 1].
  const perTaskThreshold = readPerTaskThreshold(task);
  const threshold = perTaskThreshold ?? getConfidenceThreshold();
  const lowConfidence = isBelowThreshold(result.confidence, threshold);

  // Trust-by-default: if the user is opted in AND the task didn't declare
  // review_required AND the instructions/summary don't look destructive
  // AND Claude didn't self-flag low confidence, skip the /review stop and
  // mark done directly.
  const reviewRequired =
    explicitReviewRequired || !autoApproveResults || risky || lowConfidence;
  const nextStatus = resolveNextStatus(result.status, reviewRequired);

  // Wave 13: persist the latest confidence value on `task.context` so the
  // renderer can render a badge without hitting the result file. We only
  // touch the field when Claude reported a value — missing data leaves
  // any prior `last_confidence` in place (still useful for retry history).
  const nextContextPatch =
    typeof result.confidence === 'number'
      ? mergeContext(task.context, {
          last_confidence: result.confidence,
          last_confidence_at: result.completed_at,
        })
      : undefined;

  await tasksRepository.update(taskId, {
    status: nextStatus,
    agent_status: result.status,
    ...(nextContextPatch !== undefined ? { context: nextContextPatch } : {}),
  });

  await executionLogsRepository.create({
    id: nanoid(),
    task_id: taskId,
    started_at: result.completed_at,
    completed_at: result.completed_at,
    method: task.agent_method === 'cli' ? 'cli' : 'cowork',
    status: result.status,
    output: result.summary,
    error: result.error ?? null,
    log_path: null,
  });

  // Wave 13: record cost (if Claude reported tokens) and a feedback row when
  // the confidence gate fires. Both are best-effort — failures here MUST NOT
  // block result ingestion.
  if (result.cost_tokens) {
    try {
      recordCost({
        task_id: taskId,
        tokens: result.cost_tokens,
        source: 'execution',
        at: result.completed_at,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:io] cost record failed for ${taskId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (lowConfidence && typeof result.confidence === 'number') {
    try {
      recordLowConfidence({
        task_id: taskId,
        confidence: result.confidence,
        threshold,
        summary: result.summary,
      });
    } catch {
      /* non-fatal */
    }
  }

  // Classify why (if at all) this task needs review and update on-disk mirror.
  const reviewReason: ReviewReason | null =
    result.status === 'failed'
      ? 'failed'
      : result.status === 'needs_review' || reviewRequired
        ? 'result'
        : null;

  if (reviewReason !== null) {
    await moveToReview(taskId).catch(() => {
      /* non-fatal — review/ mirror is a convenience */
    });
    await writeReviewMarker(taskId, reviewReason, {
      result_status: result.status,
      summary: result.summary,
      error: result.error ?? null,
      output_files: outputFiles,
      ...(typeof result.confidence === 'number'
        ? { confidence: result.confidence, low_confidence: lowConfidence }
        : {}),
    });
  }

  // Wave 17: keep the full-text search index fresh. A result ingestion both
  // appends an execution-log row (the result summary) AND may have mutated
  // the task's context/instructions, so re-index both the task and its
  // execution outputs. Best-effort and fully defensive — indexing failures
  // MUST NOT block or fail result ingestion.
  void updateSearchIndexForTask(taskId);

  ioEvents.emit('result_ingested', { taskId, result, outputFiles });
  if (reviewReason !== null) {
    ioEvents.emit('review_added', [{ taskId, reason: reviewReason }]);
  }
  ioEvents.emit('pipeline_changed', { reason: 'result_ingested' });

  // Wave 16: when this result took the task all the way to `done`, generate
  // and store a heuristic one-liner completion summary onto
  // `task.context.completion_summary`. Best-effort and fire-and-forget — it
  // must NEVER block or fail result ingestion. The generator does its own
  // defensive collection + DB write.
  if (nextStatus === 'done') {
    void generateCompletionSummary(taskId);
  }
}

/**
 * Lazily import + invoke the auto-summary generator so a partial build (or a
 * future module move) can't break ingestion at import time. Swallows every
 * error — this is purely advisory UI sugar.
 */
async function generateCompletionSummary(taskId: string): Promise<void> {
  try {
    const mod = await import('@/main/auto-summary');
    await mod.generateAndStoreCompletionSummary(taskId);
  } catch {
    /* non-fatal — completion summary is best-effort */
  }
}

/**
 * Persist a task that arrived via `IO_INBOX/<id>.json`. If the task already
 * exists in the DB the inbox file is treated as a no-op.
 *
 * Per-business defaults are applied here too: when the inbox task carries a
 * tag that matches a configured business in `projects.json` AND no
 * `context.permissions` was set by the producer, the business's
 * `default_permission_profile` + `branch_policy` get spliced into the
 * task's context. An explicit `context.permissions` always wins.
 */
export async function ingestInbox(taskId: string, task: Task): Promise<void> {
  const existing = await tasksRepository.findById(taskId);
  if (existing) {
    ioEvents.emit('inbox_ingested', { taskId, task: existing });
    return;
  }
  const enriched = applyBusinessDefaults(task);
  await tasksRepository.create(enriched);
  // Wave 17: index the freshly ingested inbox task. Best-effort.
  void updateSearchIndexForTask(taskId);
  ioEvents.emit('inbox_ingested', { taskId, task: enriched });
  ioEvents.emit('pipeline_changed', { reason: 'inbox_ingested' });
}

/**
 * Splice per-business defaults from `projects.json` onto a fresh task. Only
 * fills fields the caller didn't already set. Returns the task untouched
 * when no business tag matches or every default is already present.
 */
function applyBusinessDefaults(task: Task): Task {
  if (!task.tags || task.tags.length === 0) return task;
  const defaults = resolveBusinessDefaults(task.tags, task.id);
  if (!defaults.business) return task;
  const baseCtx =
    task.context && typeof task.context === 'object'
      ? { ...(task.context as Record<string, unknown>) }
      : {};
  let touched = false;
  if (defaults.permissions && baseCtx['permissions'] === undefined) {
    baseCtx['permissions'] = defaults.permissions;
    touched = true;
  }
  if (defaults.branch_policy && baseCtx['branch_policy'] === undefined) {
    baseCtx['branch_policy'] = defaults.branch_policy;
    touched = true;
  }
  if (baseCtx['business'] === undefined) {
    baseCtx['business'] = defaults.business.tag;
    touched = true;
  }
  if (!touched) return task;
  return { ...task, context: baseCtx };
}

/**
 * Lazily import + invoke the search indexer for one task so a partial build
 * (or a future module move) can't break ingestion at import time. Re-indexes
 * the task row (title/description/instructions/attachments) AND its execution
 * outputs. Swallows every error — the search index is derived data that must
 * never block or fail ingestion. When FTS5 isn't available the indexer is a
 * no-op (the query side falls back to a LIKE scan).
 */
async function updateSearchIndexForTask(taskId: string): Promise<void> {
  try {
    const mod = await import('@/main/search/indexer');
    mod.indexTask(taskId);
    mod.indexExecutionsForTask(taskId);
  } catch {
    /* non-fatal — search index is best-effort */
  }
}

function isReviewRequired(task: Task): boolean {
  if (task.context && typeof task.context === 'object') {
    const v = (task.context as Record<string, unknown>)['review_required'];
    if (typeof v === 'boolean') return v;
  }
  return false;
}

/**
 * Pull a per-task confidence threshold off `context.confidence_threshold`.
 * Returns `null` when absent or out-of-range; the caller falls back to the
 * global threshold. Used by boot tasks to raise the auto-apply bar.
 */
function readPerTaskThreshold(task: Task): number | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)['confidence_threshold'];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 1) return null;
  return raw;
}

function resolveNextStatus(
  resultStatus: ExecutionResult['status'],
  reviewRequired: boolean,
): Task['status'] {
  if (resultStatus === 'failed') return 'failed';
  if (resultStatus === 'needs_review') return 'blocked';
  return reviewRequired ? 'blocked' : 'done';
}

function resolveDependency(
  ref: string,
  titleToId: Map<string, string>,
  proposalIds: string[],
): string | null {
  // 1. Already a task id (UUID/nanoid-ish): return as-is.
  if (looksLikeId(ref)) return ref;

  // 2. Numeric index into the proposals array: `"0"`, `"#1"`, etc.
  const idx = parseIndex(ref);
  if (idx !== null && idx >= 0 && idx < proposalIds.length) {
    return proposalIds[idx] ?? null;
  }

  // 3. Title match (case-insensitive).
  const fromTitle = titleToId.get(ref.toLowerCase());
  if (fromTitle) return fromTitle;

  return null;
}

function looksLikeId(s: string): boolean {
  // nanoid default alphabet is `A-Za-z0-9_-`, 21 chars. Loosen to >= 10 to
  // accept UUIDs and custom ids too.
  return /^[A-Za-z0-9_-]{10,}$/.test(s);
}

function parseIndex(s: string): number | null {
  const m = /^#?(\d+)$/.exec(s.trim());
  if (!m || !m[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Merge `patch` into `base` context, returning a new object. Handles the
 * `null` base case (initial context creation). Used by the confidence
 * persister so callers don't have to worry about clobbering unrelated keys.
 */
function mergeContext(
  base: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!base || typeof base !== 'object') return { ...patch };
  return { ...base, ...patch };
}
