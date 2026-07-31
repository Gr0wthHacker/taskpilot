/**
 * GoalProgressBar — a rolled-up progress bar for a goal.
 *
 * Renders `done / total` as a filled track plus a small legend (in-progress,
 * blocked, overdue). The fill color stays green; the surrounding counts carry
 * the warning colors so the bar reads cleanly at a glance. Used on the Goals
 * card grid (compact) and the GoalDetail header (large).
 *
 * Also exports {@link GoalStatusBadge} so the same status → color mapping is
 * shared by both the card grid and the detail header.
 */

import { cn } from '@/renderer/lib/utils';
import type { GoalProgress, GoalStatus } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Status badge                                                              */
/* -------------------------------------------------------------------------- */

const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: 'Active',
  achieved: 'Achieved',
  abandoned: 'Abandoned',
  on_hold: 'On hold',
};

const GOAL_STATUS_CLASS: Record<GoalStatus, string> = {
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  achieved:
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  abandoned: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  on_hold:
    'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
};

export function GoalStatusBadge({
  status,
  className,
}: {
  status: GoalStatus;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        GOAL_STATUS_CLASS[status],
        className,
      )}
      aria-label={`goal-status-${status}`}
    >
      {GOAL_STATUS_LABELS[status]}
    </span>
  );
}

export { GOAL_STATUS_LABELS };

/* -------------------------------------------------------------------------- */
/*  Progress bar                                                              */
/* -------------------------------------------------------------------------- */

interface GoalProgressBarProps {
  progress: GoalProgress;
  /** `large` bumps the track height + shows the legend row. */
  size?: 'compact' | 'large';
  className?: string;
}

export function GoalProgressBar({
  progress,
  size = 'compact',
  className,
}: GoalProgressBarProps): JSX.Element {
  const { total, done, in_progress, blocked, percent, overdue_tasks } =
    progress;
  const large = size === 'large';

  return (
    <div
      className={cn('flex flex-col gap-1.5', className)}
      aria-label="goal-progress"
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex-1 overflow-hidden rounded-full bg-muted',
            large ? 'h-2.5' : 'h-1.5',
          )}
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span
          className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground"
          aria-label="goal-progress-percent"
        >
          {percent}%
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span aria-label="goal-progress-count">
          <span className="font-semibold tabular-nums text-foreground">
            {done}
          </span>{' '}
          / {total} done
        </span>
        {large && in_progress > 0 && (
          <span className="text-amber-700 dark:text-amber-300">
            {in_progress} in progress
          </span>
        )}
        {large && blocked > 0 && (
          <span className="text-orange-700 dark:text-orange-300">
            {blocked} blocked
          </span>
        )}
        {overdue_tasks > 0 && (
          <span
            className="font-medium text-red-700 dark:text-red-300"
            aria-label="goal-progress-overdue"
          >
            {overdue_tasks} overdue
          </span>
        )}
      </div>
    </div>
  );
}
