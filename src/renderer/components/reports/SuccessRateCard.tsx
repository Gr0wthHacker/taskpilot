/**
 * Agent success rate — a stat card with a donut chart and a three-number
 * breakdown (succeeded / failed / needs review).
 *
 * Pure inline SVG. The donut is built from two arcs:
 *   - background ring (muted)
 *   - foreground arc whose length scales with the success rate
 *
 * When `total === 0` we skip the donut and show an "n/a" pill so the empty
 * state stays calm instead of rendering a misleading zero ring.
 */

import { formatNumber } from './chart-utils';
import type { AgentSuccessRate } from '@/shared/api-contract';

interface SuccessRateCardProps {
  rate: AgentSuccessRate;
  isLoading?: boolean;
}

const SIZE = 96;
const STROKE = 12;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function SuccessRateCard({
  rate,
  isLoading = false,
}: SuccessRateCardProps): JSX.Element {
  const pct = rate.total === 0 ? 0 : rate.succeeded / rate.total;
  const dash = CIRCUMFERENCE * pct;
  const remaining = CIRCUMFERENCE - dash;
  const pctLabel = rate.total === 0 ? '–' : `${Math.round(pct * 100)}%`;

  if (isLoading) {
    return (
      <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
        Loading success rate…
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-4"
      aria-label="chart-success-rate"
    >
      <svg
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={`Agent success rate: ${pctLabel}, ${rate.succeeded} succeeded of ${rate.total} runs`}
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.12}
          strokeWidth={STROKE}
        />
        {rate.total > 0 && (
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${remaining}`}
            // Rotate so the arc starts at 12 o'clock.
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            className="text-primary"
          />
        )}
        <text
          x={SIZE / 2}
          y={SIZE / 2}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-current text-base font-semibold tabular-nums"
        >
          {pctLabel}
        </text>
      </svg>
      <dl className="grid flex-1 grid-cols-3 gap-3 text-[11px]">
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <dt className="text-muted-foreground">Succeeded</dt>
          <dd className="font-semibold tabular-nums">
            {formatNumber(rate.succeeded)}
          </dd>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <dt className="text-muted-foreground">Failed</dt>
          <dd className="font-semibold tabular-nums">
            {formatNumber(rate.failed)}
          </dd>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <dt className="text-muted-foreground">Review</dt>
          <dd className="font-semibold tabular-nums">
            {formatNumber(rate.needs_review)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
