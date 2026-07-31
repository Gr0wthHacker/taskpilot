/**
 * Completion summary subtitle (Wave 16).
 *
 * Renders the heuristic one-liner stored at `task.context.completion_summary`
 * (written by `@/main/auto-summary` when a task reaches `done`). Shown as an
 * italic subtitle on the TaskCard for done tasks.
 *
 * Stateless + defensive: returns null when there's no summary so callers can
 * drop it inline without guarding.
 */

import { cn } from '@/renderer/lib/utils';
import type { Task } from '@/shared/types';

/**
 * Pull the stored completion summary off a task's context. Returns null when
 * absent / empty / non-string.
 */
export function readCompletionSummary(task: Task): string | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)['completion_summary'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface CompletionSummaryProps {
  task: Task;
  className?: string;
}

/**
 * The italic subtitle. Renders only for tasks that have a stored summary AND
 * are in a terminal state (`done` / `failed`) — we don't want a stale "Done…"
 * line lingering if the task got requeued.
 */
export function CompletionSummary({
  task,
  className,
}: CompletionSummaryProps): JSX.Element | null {
  if (task.status !== 'done' && task.status !== 'failed') return null;
  const summary = readCompletionSummary(task);
  if (!summary) return null;
  const isFailure = summary.startsWith('Failed');
  return (
    <p
      className={cn(
        'truncate text-[11px] italic leading-snug',
        isFailure ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
        className,
      )}
      title={summary}
      aria-label={`task-completion-summary-${task.id}`}
    >
      {summary}
    </p>
  );
}

export default CompletionSummary;
