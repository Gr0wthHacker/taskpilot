/**
 * Decision log (Wave 16).
 *
 * Append-only categorized notes tied to a task. Two writers:
 *   - Claude, during execute — captures the choices it made, the context it
 *     leaned on, references it pulled, the rationale behind a path, and any
 *     risks it spotted. These land via the MCP surface / direct repo call.
 *   - The user, on TaskDetail — adds their own notes via the DecisionLog UI.
 *
 * This module is the domain wrapper around `repositories/decisions.ts`. The
 * route layer and any agent-facing surface go through here rather than the
 * repo directly so we have a single place to normalize input (trim text,
 * default category/author).
 */

import { decisionsRepository } from '@/main/db/repositories/decisions';
import type { DecisionCategory, DecisionEntry } from '@/shared/types';

/** Hard cap on a single entry's text length. Mirrors the zod schema. */
const MAX_TEXT_CHARS = 10_000;

/**
 * The set of valid categories. Exported so callers (route validation, the
 * MCP surface, tests) can reference one canonical list.
 */
export const DECISION_CATEGORIES: readonly DecisionCategory[] = [
  'decision',
  'context',
  'reference',
  'rationale',
  'risk',
  'note',
];

function isDecisionCategory(v: unknown): v is DecisionCategory {
  return (
    typeof v === 'string' &&
    (DECISION_CATEGORIES as readonly string[]).includes(v)
  );
}

export interface RecordDecisionInput {
  task_id: string;
  text: string;
  /** Defaults to `note` when omitted or unrecognized. */
  category?: DecisionCategory | string;
  /** Defaults to `user`. Claude writes `claude`. */
  author?: string | null;
  link?: string | null;
}

/**
 * Append a decision-log entry. Trims `text`, defaults `category` to `note`
 * (coercing an unknown string), and `author` to `user`. Throws when `text`
 * is empty after trimming.
 */
export function recordDecision(input: RecordDecisionInput): DecisionEntry {
  const text = (input.text ?? '').trim();
  if (text.length === 0) {
    throw new Error('Decision text is required');
  }
  const category: DecisionCategory = isDecisionCategory(input.category)
    ? input.category
    : 'note';
  const author = (input.author ?? '').trim() || 'user';
  const link = input.link && input.link.trim().length > 0 ? input.link.trim() : null;
  return decisionsRepository.create({
    task_id: input.task_id,
    text: text.slice(0, MAX_TEXT_CHARS),
    category,
    author,
    link,
  });
}

/**
 * List a task's decision log, newest-first. `limit` defaults to a generous
 * cap so the full log renders without paging in the common case.
 */
export function listDecisionsForTask(
  taskId: string,
  limit = 500,
): DecisionEntry[] {
  return decisionsRepository.list({ task_id: taskId, limit });
}

/**
 * Delete a single decision entry. Returns true when a row was removed.
 */
export function deleteDecision(id: string): boolean {
  return decisionsRepository.delete(id);
}

export { decisionsRepository };
