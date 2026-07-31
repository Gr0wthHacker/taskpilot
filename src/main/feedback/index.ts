/**
 * Feedback loop.
 *
 * When the user rejects work at /review we record a feedback row. The derive
 * flow then surfaces matching rejections from similar prior tasks as a
 * "Past rejections" block in the derive request so Claude can avoid
 * repeating mistakes.
 *
 * Similarity uses the same scoring as the existing derive-memory module
 * (Jaccard on tags + cosine on title BoW) — we intentionally don't reach
 * into `@/main/derive-memory.ts` directly here, because that module owns
 * the read-only similar-tasks lookup and Wave 12H reserves it. Instead the
 * route layer wires the two together — see `src/main/server/routes/tasks.ts`.
 */

import { feedbackRepository } from '@/main/db/repositories/feedback';
import type { FeedbackEntry, FeedbackKind, Task } from '@/shared/types';

/** Soft cap on the rendered guidance block (chars). */
const MAX_GUIDANCE_CHARS = 1_500;

/** Cap on how many rejection rows we'll surface in the guidance block. */
const MAX_REJECTIONS = 5;

/**
 * Record a rejection. Called from the review router when the user clicks
 * "Reject" on an item in the queue. `details` is free-form JSON-serializable
 * context (e.g. the rejected proposal titles, the result summary).
 */
export function recordRejection(input: {
  task_id: string;
  kind: 'rejection_derivation' | 'rejection_result';
  reason?: string | null;
  details?: unknown;
}): FeedbackEntry {
  return feedbackRepository.create({
    task_id: input.task_id,
    kind: input.kind,
    reason: input.reason ?? null,
    details:
      input.details === undefined || input.details === null
        ? null
        : typeof input.details === 'string'
          ? input.details
          : JSON.stringify(input.details),
  });
}

/**
 * Record a low-confidence routing event. Called by ingestion when a result
 * comes back with `confidence < threshold`. Lets the cost view show how
 * often Claude self-flags below the gate.
 */
export function recordLowConfidence(input: {
  task_id: string;
  confidence: number;
  threshold: number;
  summary?: string | null;
}): FeedbackEntry {
  return feedbackRepository.create({
    task_id: input.task_id,
    kind: 'low_confidence',
    reason: `confidence ${input.confidence.toFixed(2)} < threshold ${input.threshold.toFixed(2)}`,
    details: input.summary ?? null,
  });
}

/**
 * Generic recorder for the API. Used by `POST /api/feedback` so external
 * callers (the renderer, CLI) can drop notes/edits-after-run without
 * understanding the row schema.
 */
export function recordFeedback(input: {
  task_id: string;
  kind: FeedbackKind;
  reason?: string | null;
  details?: string | null;
}): FeedbackEntry {
  return feedbackRepository.create({
    task_id: input.task_id,
    kind: input.kind,
    reason: input.reason ?? null,
    details: input.details ?? null,
  });
}

/**
 * List feedback rows for one task (newest first).
 */
export function listForTask(taskId: string): FeedbackEntry[] {
  return feedbackRepository.list({ task_id: taskId });
}

/**
 * List feedback rows across a set of tasks. Used by
 * {@link summarizeRejections} to fetch the rejection history for tasks the
 * derive-memory layer marked as "similar."
 */
export function listForTasks(taskIds: string[]): FeedbackEntry[] {
  if (taskIds.length === 0) return [];
  return feedbackRepository.list({
    task_ids: taskIds,
    kinds: ['rejection_derivation', 'rejection_result'],
    limit: 200,
  });
}

/**
 * Build the markdown guidance block that gets folded into a derive request's
 * `instructions` string. Empty string when nothing useful surfaces so the
 * caller can skip the section.
 *
 * Format:
 *
 *   ## Past rejections
 *
 *   You proposed similar work before and Jack rejected it. Reasons:
 *   - "Too granular — collapse the dependencies."
 *   - "Don't auto-send emails — only draft them."
 *
 *   When decomposing this task, avoid repeating those mistakes.
 */
export function summarizeRejections(
  similarTasks: ReadonlyArray<Task>,
): string {
  if (similarTasks.length === 0) return '';
  const ids = similarTasks.map((t) => t.id);
  const rows = listForTasks(ids);
  if (rows.length === 0) return '';

  // Prefer reason text; fall back to a short details snippet if reason is
  // empty. De-duplicate identical reasons so a noisy task doesn't dominate.
  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const row of rows) {
    if (bullets.length >= MAX_REJECTIONS) break;
    const reason = (row.reason ?? '').trim();
    const details = (row.details ?? '').trim();
    const text =
      reason.length > 0
        ? reason
        : details.length > 0
          ? details.length > 200
            ? `${details.slice(0, 200)}…`
            : details
          : '';
    if (text.length === 0) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(`- "${text}"`);
  }
  if (bullets.length === 0) return '';

  const lines = [
    '## Past rejections',
    '',
    'You proposed similar work before and Jack rejected it. Reasons:',
    ...bullets,
    '',
    'When decomposing this task, avoid repeating those mistakes.',
  ];
  const block = lines.join('\n');
  if (block.length <= MAX_GUIDANCE_CHARS) return block;
  const truncated = block.slice(0, MAX_GUIDANCE_CHARS);
  const lastNewline = truncated.lastIndexOf('\n');
  return `${lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated}\n…(truncated)`;
}
