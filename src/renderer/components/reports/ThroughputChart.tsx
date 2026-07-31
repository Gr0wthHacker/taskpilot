/**
 * Throughput chart — daily bars for "tasks closed" over the selected window.
 *
 * Inline SVG, no chart library. Bars share a 100% width container; the
 * SVG uses `viewBox` + `preserveAspectRatio="none"` for the rect layer
 * (so widths scale with the container) and a separate fixed-size group
 * for the x/y axis labels (so text stays readable at any container width).
 */

import { useMemo } from 'react';

import {
  formatDateLabel,
  formatNumber,
  niceMax,
  pickTicks,
  scaleLinear,
} from './chart-utils';
import type { ThroughputPoint } from '@/shared/api-contract';

interface ThroughputChartProps {
  points: ThroughputPoint[];
  isLoading?: boolean;
}

const CHART_HEIGHT = 180;
const AXIS_GUTTER = 28; // px reserved on the left for y-axis labels.
const BAR_GAP = 2;

export default function ThroughputChart({
  points,
  isLoading = false,
}: ThroughputChartProps): JSX.Element {
  const { yMax, ticks, total } = useMemo(() => {
    if (points.length === 0) return { yMax: 1, ticks: [0, 1], total: 0 };
    const maxClosed = Math.max(...points.map((p) => p.closed));
    const niceY = niceMax(maxClosed);
    return {
      yMax: niceY,
      ticks: pickTicks(niceY, 4),
      total: points.reduce((sum, p) => sum + p.closed, 0),
    };
  }, [points]);

  if (isLoading) {
    return (
      <div
        className="flex h-[180px] items-center justify-center text-xs text-muted-foreground"
        aria-label="throughput-loading"
      >
        Loading throughput…
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div
        className="flex h-[180px] items-center justify-center text-xs text-muted-foreground"
        aria-label="throughput-empty"
      >
        No closed tasks in this window yet.
      </div>
    );
  }

  // Bars are rendered via percentage widths so the chart fills the
  // container at any width without remeasuring.
  const barWidthPct = 100 / points.length;

  return (
    <div className="flex flex-col gap-1" aria-label="chart-throughput">
      <div className="flex h-[180px] gap-2">
        {/* y-axis labels */}
        <div
          className="flex flex-col justify-between text-[10px] tabular-nums text-muted-foreground"
          style={{ width: AXIS_GUTTER }}
          aria-hidden="true"
        >
          {[...ticks].reverse().map((tick, i) => (
            <span key={i} className="leading-none">
              {formatNumber(tick)}
            </span>
          ))}
        </div>
        {/* bars */}
        <div className="relative flex-1">
          {/* horizontal grid lines */}
          {ticks.map((tick, i) => {
            const y =
              CHART_HEIGHT - scaleLinear(tick, 0, yMax, CHART_HEIGHT);
            return (
              <div
                key={i}
                className="pointer-events-none absolute left-0 right-0 border-t border-border/40"
                style={{ top: y }}
                aria-hidden="true"
              />
            );
          })}
          <svg
            viewBox={`0 0 100 ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            className="h-full w-full text-primary"
            role="img"
            aria-label={`Throughput over ${points.length} days, ${total} tasks closed`}
          >
            {points.map((p, i) => {
              const h = scaleLinear(p.closed, 0, yMax, CHART_HEIGHT);
              const x = i * barWidthPct;
              return (
                <rect
                  key={p.date}
                  x={x + BAR_GAP / 2}
                  y={CHART_HEIGHT - h}
                  width={Math.max(0, barWidthPct - BAR_GAP)}
                  height={h}
                  fill="currentColor"
                  opacity={p.closed === 0 ? 0.15 : 0.85}
                >
                  <title>
                    {p.date}: {p.closed} closed
                  </title>
                </rect>
              );
            })}
          </svg>
        </div>
      </div>
      {/* x-axis labels: only show first, middle, last to avoid crowding */}
      <div
        className="flex justify-between pl-[28px] text-[10px] tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        <span>{formatDateLabel(points[0]?.date ?? '')}</span>
        {points.length > 2 && (
          <span>
            {formatDateLabel(points[Math.floor(points.length / 2)]?.date ?? '')}
          </span>
        )}
        <span>{formatDateLabel(points[points.length - 1]?.date ?? '')}</span>
      </div>
    </div>
  );
}
