/**
 * `/api/review/...` routes.
 *
 * A task is "in review" when it satisfies any of:
 *   - it's a parent waiting on a derivation decision (children exist in
 *     `queued`/`pending` and the parent's `agent_status === 'needs_review'`)
 *   - it carries a result the user needs to accept (`agent_status ===
 *     'needs_review'` after execution) — usually surfaces with
 *     `status === 'blocked'`
 *   - it failed and the user hasn't triaged it yet (`status === 'failed'`)
 *
 * The "reason" classification is computed server-side so the renderer can
 * just render — no business logic in the UI. Source snippets (proposal
 * preview, result summary, failure error) are read from the on-disk review
 * marker when available, with a DB-derived fallback so the view stays useful
 * even when the marker is missing.
 */

import fs from 'node:fs/promises';

import { Router } from 'express';
import { z } from 'zod';

import {
  deleteTask,
  getChildren,
  getTask,
  listTasks,
  updateTask,
} from '@/main/db/repositories/tasks';
import { getConfidenceThreshold } from '@/main/confidence';
import { executionLogsRepository } from '@/main/db/repositories/execution-logs';
import { recordRejection } from '@/main/feedback';
import { reviewPath } from '@/main/io/paths';
import type {
  ApproveTaskResponse,
  RejectTaskResponse,
} from '@/shared/api-contract';
import type { AgentMethod, Task } from '@/shared/types';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Shape                                                                     */
/* -------------------------------------------------------------------------- */

export type ReviewReason = 'derivation' | 'result' | 'failed';

export interface ReviewItem {
  task: Task;
  reason: ReviewReason;
  parent: { id: string; title: string } | null;
  source_preview: string;
  /** ISO timestamp of when this task entered review (best-effort). */
  added_at: string;
  /** Claude's self-reported confidence on the result, when available. */
  confidence: number | null;
  /** The configured threshold below which results auto-route to review. */
  confidence_threshold: number;
  /** True when confidence fell below the threshold (the automated gate). */
  low_confidence: boolean;
  /** Short human-readable "why is this here" beyond the stage chip. */
  flag_label: string | null;
  /**
   * For derivation reviews: the proposed sub-tasks that will be created on
   * approval, so the reviewer can sign off on the exact breakdown inline.
   * Null for result/failed reviews (their full content is in source_preview).
   */
  derivatives: Array<{ title: string; agent_method: AgentMethod }> | null;
}

export interface ReviewQueueResponse {
  items: ReviewItem[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function requireTask(id: string): Task {
  const task = getTask(id);
  if (!task) {
    throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
  }
  return task;
}

/**
 * Resolve a task's reason for being in the review queue. Returns `null` when
 * the task does not belong in review at all.
 */
function classifyReason(task: Task): ReviewReason | null {
  if (task.agent_status === 'needs_review') {
    // If children exist this is a derivation review; otherwise a result
    // review awaiting human acceptance.
    const children = getChildren(task.id);
    return children.length > 0 ? 'derivation' : 'result';
  }
  if (task.status === 'failed') return 'failed';
  return null;
}

interface ReviewMarker {
  reason?: string;
  added_at?: string;
  summary?: string;
  error?: string | null;
  derivative_count?: number;
  derivatives?: Array<{ title?: string }>;
  confidence?: number;
  low_confidence?: boolean;
  result_status?: string;
}

function readContextNumber(task: Task, key: string): number | null {
  const ctx = task.context;
  if (ctx && typeof ctx === 'object') {
    const raw = (ctx as Record<string, unknown>)[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return null;
}

async function readMarker(taskId: string): Promise<ReviewMarker | null> {
  try {
    const raw = await fs.readFile(reviewPath(taskId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as ReviewMarker;
    }
  } catch {
    /* missing or invalid — fall back to DB-derived preview */
  }
  return null;
}

/**
 * Build a one-line preview describing why the task is in review. Used by the
 * row UI; long content is truncated client-side.
 */
function buildPreview(
  task: Task,
  reason: ReviewReason,
  marker: ReviewMarker | null,
): string {
  if (reason === 'derivation') {
    if (marker?.derivatives && marker.derivatives.length > 0) {
      const titles = marker.derivatives
        .map((d) => (typeof d.title === 'string' ? d.title : ''))
        .filter((t) => t.length > 0);
      if (titles.length > 0) {
        const head = titles.slice(0, 3).join(', ');
        const extra = titles.length > 3 ? ` (+${titles.length - 3} more)` : '';
        return `${titles.length} derivative${titles.length === 1 ? '' : 's'}: ${head}${extra}`;
      }
    }
    const children = getChildren(task.id);
    if (children.length > 0) {
      const titles = children.map((c) => c.title).slice(0, 3).join(', ');
      const extra =
        children.length > 3 ? ` (+${children.length - 3} more)` : '';
      return `${children.length} derivative${children.length === 1 ? '' : 's'}: ${titles}${extra}`;
    }
    return 'Derivation proposal awaiting approval.';
  }

  if (reason === 'result') {
    if (marker?.summary) return marker.summary;
    // Fall back to the latest execution log's output summary.
    const logs = executionLogsRepository.getForTask(task.id);
    const latest = logs[0];
    if (latest?.output) return latest.output;
    return 'Execution result awaiting approval.';
  }

  // failed
  if (marker?.error) return marker.error;
  const logs = executionLogsRepository.getForTask(task.id);
  const latest = logs[0];
  if (latest?.error) return latest.error;
  if (latest?.output) return latest.output;
  return 'Task failed. Triage and decide whether to retry.';
}

async function buildItem(task: Task): Promise<ReviewItem | null> {
  const reason = classifyReason(task);
  if (reason === null) return null;
  const marker = await readMarker(task.id);
  const preview = buildPreview(task, reason, marker);

  let parent: ReviewItem['parent'] = null;
  if (task.parent_id) {
    const p = getTask(task.parent_id);
    if (p) parent = { id: p.id, title: p.title };
  }

  const addedAt =
    typeof marker?.added_at === 'string' && marker.added_at.length > 0
      ? marker.added_at
      : task.updated_at;

  const threshold = getConfidenceThreshold();
  const confidence =
    typeof marker?.confidence === 'number' && Number.isFinite(marker.confidence)
      ? marker.confidence
      : readContextNumber(task, 'last_confidence');
  const lowConfidence =
    marker?.low_confidence === true ||
    (confidence !== null && confidence < threshold);

  // The stage chip already says derivation/result/failed. This adds the
  // *why it stopped here* signal the reviewer actually wants.
  const flagLabel: string | null =
    reason === 'failed'
      ? 'Failed — needs triage'
      : reason === 'derivation'
        ? null
        : lowConfidence
          ? 'Low confidence'
          : 'Needs your sign-off';

  // For derivation reviews, surface the actual proposed sub-tasks so the
  // reviewer can sign off on the breakdown without opening the task.
  const derivatives =
    reason === 'derivation'
      ? getChildren(task.id).map((c) => ({
          title: c.title,
          agent_method: c.agent_method,
        }))
      : null;

  return {
    task,
    reason,
    parent,
    source_preview: preview,
    added_at: addedAt,
    confidence,
    confidence_threshold: threshold,
    low_confidence: lowConfidence,
    flag_label: flagLabel,
    derivatives,
  };
}

/**
 * Best-effort removal of the per-task review marker file. Non-fatal — the
 * DB is the source of truth.
 */
async function clearReviewMarker(taskId: string): Promise<void> {
  try {
    await fs.unlink(reviewPath(taskId));
  } catch {
    /* missing is fine */
  }
}

/* -------------------------------------------------------------------------- */
/*  Approve / reject helpers (mirror tasks.ts but reason-aware)               */
/* -------------------------------------------------------------------------- */

function approveDerivation(task: Task): Task {
  const children = getChildren(task.id);
  for (const child of children) {
    if (
      child.status === 'inbox' ||
      child.status === 'queued' ||
      child.status === 'blocked'
    ) {
      updateTask(child.id, { status: 'queued' });
    }
  }
  const updated = updateTask(task.id, { agent_status: 'succeeded' });
  return updated ?? task;
}

function approveResultOrFailure(task: Task): Task {
  const updated = updateTask(task.id, {
    status: 'done',
    agent_status: 'succeeded',
  });
  return updated ?? task;
}

function rejectDerivation(task: Task): Task {
  const children = getChildren(task.id);
  for (const child of children) {
    deleteTask(child.id);
  }
  const updated = updateTask(task.id, {
    status: 'inbox',
    agent_status: 'pending',
  });
  return updated ?? task;
}

function rejectResult(task: Task): Task {
  // Rejecting a result is the user saying "this work product is wrong, walk
  // away." Move to `cancelled` so the row drops out of the review queue
  // (which also indexes `status='failed'`) and stays hidden from list views
  // by default. agent_status reflects the underlying outcome.
  const updated = updateTask(task.id, {
    status: 'cancelled',
    agent_status: 'failed',
  });
  return updated ?? task;
}

function rejectFailed(task: Task): Task {
  // A failed task that's been triaged-and-dismissed. Move to `cancelled` so
  // it stops dominating the review queue every render. The execution log
  // history is preserved; the user can still find it via search or the
  // archive view (when filtering for cancelled).
  const updated = updateTask(task.id, {
    status: 'cancelled',
  });
  return updated ?? task;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

const reasonFilterSchema = z.object({
  reason: z.enum(['derivation', 'result', 'failed']).optional(),
});

const reviewActionBodySchema = z
  .object({
    /** Filter — accept only the action matching this review reason. */
    reason: z.enum(['derivation', 'result', 'failed']).optional(),
    /** Free-form rejection note recorded in the feedback table. */
    note: z.string().max(2_000).optional(),
  })
  .partial();

export function reviewRouter(): Router {
  const router = Router();

  // GET /api/review/queue --------------------------------------------------
  router.get(
    '/queue',
    asyncHandler(async (req, res) => {
      const parsed = reasonFilterSchema.safeParse(req.query);
      const filterReason = parsed.success ? parsed.data.reason : undefined;

      // Pull a single broad list and filter — review queues are small.
      const candidates: Task[] = [];
      // tasks whose agent_status === 'needs_review'
      for (const task of listTasks({ limit: 500 })) {
        if (task.agent_status === 'needs_review' || task.status === 'failed') {
          candidates.push(task);
        }
      }

      const items: ReviewItem[] = [];
      for (const task of candidates) {
        const item = await buildItem(task);
        if (item === null) continue;
        if (filterReason && item.reason !== filterReason) continue;
        items.push(item);
      }

      // Newest first by `added_at` so freshly-reviewable work tops the list.
      items.sort((a, b) => b.added_at.localeCompare(a.added_at));

      const body: ReviewQueueResponse = { items };
      res.json(body);
    }),
  );

  // POST /api/review/:id/approve ------------------------------------------
  router.post(
    '/:id/approve',
    asyncHandler(async (req, res) => {
      const task = requireTask(String(req.params.id));
      const reason = classifyReason(task);
      if (reason === null) {
        throw new ApiHttpError(
          409,
          'not_in_review',
          `Task ${task.id} is not currently in review`,
        );
      }
      const updated =
        reason === 'derivation'
          ? approveDerivation(task)
          : approveResultOrFailure(task);
      await clearReviewMarker(task.id);
      const body: ApproveTaskResponse = { ok: true, task: updated };
      res.json(body);
    }),
  );

  // POST /api/review/:id/reject -------------------------------------------
  router.post(
    '/:id/reject',
    validateBody(reviewActionBodySchema),
    asyncHandler(async (req, res) => {
      const task = requireTask(String(req.params.id));
      const reason = classifyReason(task);
      if (reason === null) {
        throw new ApiHttpError(
          409,
          'not_in_review',
          `Task ${task.id} is not currently in review`,
        );
      }
      const payload = req.body as z.infer<typeof reviewActionBodySchema>;
      let updated: Task;
      if (reason === 'derivation') {
        updated = rejectDerivation(task);
      } else if (reason === 'result') {
        updated = rejectResult(task);
      } else {
        updated = rejectFailed(task);
      }

      // Wave 13: record the rejection so future derivations of similar
      // tasks can surface "Past rejections" guidance. We only record on
      // derivation/result rejections — a triaged failure isn't a Claude
      // signal so much as a status acknowledgment.
      if (reason !== 'failed') {
        try {
          recordRejection({
            task_id: task.id,
            kind:
              reason === 'derivation'
                ? 'rejection_derivation'
                : 'rejection_result',
            reason: payload.note ?? null,
            details: {
              task_title: task.title,
              tags: task.tags,
              ...(reason === 'derivation'
                ? {
                    child_titles: getChildren(task.id).map((c) => c.title),
                  }
                : {}),
            },
          });
        } catch {
          /* non-fatal — feedback is a learning signal, not a correctness gate */
        }
      }

      await clearReviewMarker(task.id);
      const body: RejectTaskResponse = { ok: true, task: updated };
      res.json(body);
    }),
  );

  return router;
}

// Re-exports for the test harness / CLI bindings.
export { classifyReason };
