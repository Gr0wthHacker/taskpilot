/**
 * Time-to-done by priority — horizontal bars (one per priority bucket) with
 * the median hours value labeled at the end of each bar.
 *
 * Horizontal layout reads better at small widths than four side-by-side
 * vertical bars, and the priority order (p0 → p3) reads top-down the same
 * way users think about it.
 *
 * When a priority bucket has zero closed tasks, the row still renders so
 * the chart's structure stays stable across window changes — the bar just
 * collapses to zero width.
 */

import { useMemo } from 'react';

import { formatHours, niceMax, scaleLinear } from './chart-utils';
import type { TimeToDoneByPriority } from '@/shared/api-contract';

interface TimeToDoneChartProps {
  byPriority: TimeToDoneByPriority;
  isLoading?: boolean;
}

const PRIORITIES: Array<keyof TimeToDoneByPriority> = ['p0', 'p1', 'p2', 'p3'];
const PRIORITY_LABELS: Record<keyof TimeToDoneByPriority, string> = {
  p0: 'P0 — Urgent',
  p1: 'P1 — High',
  p2: 'P2 — Normal',
  p3: 'P3 — Low',
};

export default function TimeToDoneChart({
  byPriority,
  isLoading = false,
}: TimeToDoneChartProps): JSX.Element {
  const xMax = useMemo(() => {
    const values = PRIORITIES.map((p) => byPriority[p].median_hours ?? 0);
    const maxVal = Math.max(0, ...values);
    return niceMax(maxVal);
  }, [byPriority]);

  if (isLoading) {
    return (
      <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
        Loading time-to-done…
      </div>
    );
  }

  const hasData = PRIORITIES.some((p) => byPriority[p].count > 0);
  if (!hasData) {
    return (
      <div
        className="flex h-[180px] items-center justify-center text-xs text-muted-foreground"
        aria-label="time-to-done-empty"
      >
        No closed tasks in this window yet.
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 py-1"
      aria-label="chart-time-to-done"
    >
      {PRIORITIES.map((p) => {
        const bucket = byPriority[p];
        const hours = bucket.median_hours;
        const widthPct =
          hours === null ? 0 : (scaleLinear(hours, 0, xMax, 100) / 100) * 100;
        return (
          <div
            key={p}
            className="grid grid-cols-[80px_1fr_60px] items-center gap-2"
            aria-label={`time-to-done-row-${p}`}
          >
            <div className="text-[11px] font-medium text-muted-foreground">
              {PRIORITY_LABELS[p]}
            </div>
            <div className="relative h-5 overflow-hidden rounded bg-muted/40">
              <div
                className="absolute inset-y-0 left-0 bg-primary/70 transition-[width]"
                style={{ width: `${widthPct}%` }}
                title={`${formatHours(hours)} median over ${bucket.count} task${bucket.count === 1 ? '' : 's'}`}
              />
            </div>
            <div className="text-right text-[11px] tabular-nums">
              <span className="font-semibold">{formatHours(hours)}</span>
              <span className="ml-1 text-muted-foreground">
                ({bucket.count})
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
