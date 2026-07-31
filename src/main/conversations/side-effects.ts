/**
 * Side effects that fire after a conversation is linked to a task.
 *
 *   - Decisions: each `key_decisions` line is appended to the task's
 *     decision log (category='decision', author='claude'). Deduplicated by
 *     existing decision text on that task so re-ingesting the same JSONL
 *     doesn't spam new rows.
 *   - References: short code blocks (< 1KB) and the first ~10 files touched
 *     are appended as `category='reference'` decisions with the conversation
 *     id in the `link` column so the UI can deep-link back to the catalogue.
 *
 * All side effects are best-effort. Failures log and continue — they must
 * never block ingestion.
 */

import { recordDecision } from '@/main/decisions';
import { listDecisionsForTask } from '@/main/decisions';
import type { Conversation } from '@/shared/types';

const warn = (msg: string, ...rest: unknown[]) =>
  // eslint-disable-next-line no-console
  console.warn(`[conversations:side-effects] ${msg}`, ...rest);

const MAX_DECISIONS_PER_TASK = 12;
const MAX_REFERENCE_FILES = 8;
const MAX_REFERENCE_CODE_BLOCKS = 4;
const MAX_CODE_BLOCK_BYTES = 1_024;

/**
 * Propagate the conversation's key decisions + small code references into the
 * decision logs of the linked tasks. Idempotent: re-running for the same
 * conversation skips entries whose text is already present on the task.
 */
export function propagateToTask(
  conversation: Conversation,
  taskId: string,
  smallCodeBlocks: string[] = [],
): void {
  try {
    const existing = listDecisionsForTask(taskId, 500);
    const seenTexts = new Set(existing.map((d) => d.text));
    const link = `taskpilot://conversation/${conversation.id}`;
    let written = 0;

    for (const dec of conversation.key_decisions) {
      if (written >= MAX_DECISIONS_PER_TASK) break;
      const text = dec.trim();
      if (text.length < 12) continue;
      if (seenTexts.has(text)) continue;
      try {
        recordDecision({
          task_id: taskId,
          text,
          category: 'decision',
          author: 'claude',
          link,
        });
        seenTexts.add(text);
        written += 1;
      } catch (err) {
        warn(`failed to record decision for task ${taskId}`, err);
      }
    }

    // Files touched as a single reference — collapse the whole list into one
    // decision row so a session that touched 8 files linked to 5 tasks doesn't
    // blow up the decisions table with 40 individual entries.
    const fileRefs = conversation.files_touched.slice(0, MAX_REFERENCE_FILES);
    if (fileRefs.length > 0) {
      const truncated =
        conversation.files_touched.length > MAX_REFERENCE_FILES
          ? ` (+ ${conversation.files_touched.length - MAX_REFERENCE_FILES} more)`
          : '';
      const text = `Touched ${conversation.files_touched.length} file${
        conversation.files_touched.length === 1 ? '' : 's'
      }: ${fileRefs.join(', ')}${truncated}`;
      if (!seenTexts.has(text)) {
        try {
          recordDecision({
            task_id: taskId,
            text,
            category: 'reference',
            author: 'claude',
            link,
          });
          seenTexts.add(text);
        } catch (err) {
          warn(`failed to record files reference for task ${taskId}`, err);
        }
      }
    }

    // Code blocks → small references. Skip anything over the byte cap; that
    // belongs in `outputs/` collected from a real result file, not here.
    const blocks = smallCodeBlocks
      .filter((b) => b.length > 0 && b.length <= MAX_CODE_BLOCK_BYTES)
      .slice(0, MAX_REFERENCE_CODE_BLOCKS);
    for (const block of blocks) {
      const text = `Code snippet:\n${block}`;
      if (seenTexts.has(text)) continue;
      try {
        recordDecision({
          task_id: taskId,
          text,
          category: 'reference',
          author: 'claude',
          link,
        });
        seenTexts.add(text);
      } catch (err) {
        warn(`failed to record code reference for task ${taskId}`, err);
      }
    }
  } catch (err) {
    warn(`propagateToTask failed for ${taskId}`, err);
  }
}
