/**
 * TriageProgress — the slim header bar shown during a triage session.
 *
 * Renders a "k of N" counter, a live elapsed-time clock, and a thin progress
 * bar. Purely presentational: the parent passes resolved numbers so this
 * component stays trivially testable and re-renders cheaply on the 1s tick.
 */

import type { ReactNode } from 'react';

import { cn } from '@/renderer/lib/utils';

interface TriageProgressProps {
  /** 1-based position of the current task. */
  position: number;
  /** Total tasks in the frozen queue. */
  total: number;
  /** How many tasks have been reviewed (advanced past). */
  reviewed: number;
  /**
   * Elapsed clock. Usually a self-updating `<TriageElapsed>` leaf so the tick
   * doesn't re-render the parent view; a plain string also works.
   */
  elapsed: ReactNode;
}

export function TriageProgress({
  position,
  total,
  reviewed,
  elapsed,
}: TriageProgressProps): JSX.Element {
  const pct = total === 0 ? 0 : Math.round((reviewed / total) * 100);
  return (
    <div
      className="flex flex-col gap-2"
      aria-label="triage-progress"
      data-position={position}
      data-total={total}
      data-reviewed={reviewed}
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium tabular-nums">
          {total === 0 ? '0 of 0' : `${Math.min(position, total)} of ${total}`}
        </span>
        <span className="tabular-nums" aria-label="triage-elapsed">
          {elapsed}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={reviewed}
      >
        <div
          className={cn('h-full rounded-full bg-primary transition-all')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default TriageProgress;
