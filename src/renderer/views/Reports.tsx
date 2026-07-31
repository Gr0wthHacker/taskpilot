/**
 * Reports view.
 *
 * Pulls everything through `useReportsBundle` so the whole page renders from
 * a single round-trip. The window picker (7d/30d/90d/All) updates the
 * shared query key — React Query handles caching per window.
 *
 * Layout (responsive grid):
 *   Row 1: stat cards (closed last 7d, agent success rate, median TTD)
 *   Row 2: Throughput bar chart + review queue trend line, side by side
 *   Row 3: Tag heat map + Time-to-done by priority
 *   Row 4: Recent failures list
 *
 * No mutations live here — the page is purely a read-only dashboard.
 */

import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';

import StatusReportCard from '@/renderer/components/StatusReportCard';
import CostBreakdown from '@/renderer/components/reports/CostBreakdown';
import RecentFailuresList from '@/renderer/components/reports/RecentFailuresList';
import SuccessRateCard from '@/renderer/components/reports/SuccessRateCard';
import TagHeatMap from '@/renderer/components/reports/TagHeatMap';
import ThroughputChart from '@/renderer/components/reports/ThroughputChart';
import TimeToDoneChart from '@/renderer/components/reports/TimeToDoneChart';
import {
  formatDateLabel,
  formatHours,
  formatNumber,
  niceMax,
  pickTicks,
  polylinePoints,
  scaleLinear,
} from '@/renderer/components/reports/chart-utils';
import {
  reportsWindowToDays,
  useReportsBundle,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  ReportWindow,
  ReviewQueueTrendPoint,
  TimeToDoneByPriority,
} from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  Window picker                                                             */
/* -------------------------------------------------------------------------- */

const WINDOWS: ReportWindow[] = ['7d', '30d', '90d', 'all'];
const WINDOW_LABELS: Record<ReportWindow, string> = {
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'All',
};

interface WindowPickerProps {
  value: ReportWindow;
  onChange: (next: ReportWindow) => void;
}

function WindowPicker({ value, onChange }: WindowPickerProps): JSX.Element {
  return (
    <div
      className="inline-flex rounded-md border border-border bg-card p-0.5"
      role="tablist"
      aria-label="reports-window-picker"
    >
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          role="tab"
          aria-selected={value === w}
          aria-label={`window-${w}`}
          onClick={() => onChange(w)}
          className={cn(
            'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
            value === w
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {WINDOW_LABELS[w]}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Stat card                                                                 */
/* -------------------------------------------------------------------------- */

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  ariaLabel?: string;
}

function StatCard({ label, value, hint, ariaLabel }: StatCardProps): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4"
      aria-label={ariaLabel}
    >
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint && (
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Review queue trend (small inline line chart)                              */
/* -------------------------------------------------------------------------- */

interface ReviewTrendChartProps {
  points: ReviewQueueTrendPoint[];
  isLoading?: boolean;
}

const TREND_WIDTH = 100;
const TREND_HEIGHT = 180;

function ReviewTrendChart({
  points,
  isLoading = false,
}: ReviewTrendChartProps): JSX.Element {
  const { yMax, ticks, polyline } = useMemo(() => {
    if (points.length === 0) {
      return { yMax: 1, ticks: [0, 1], polyline: '' };
    }
    const maxCount = Math.max(1, ...points.map((p) => p.count));
    const niceY = niceMax(maxCount);
    const stepX = points.length > 1 ? TREND_WIDTH / (points.length - 1) : 0;
    const pts = points.map((p, i) => ({
      x: i * stepX,
      y: TREND_HEIGHT - scaleLinear(p.count, 0, niceY, TREND_HEIGHT),
    }));
    return {
      yMax: niceY,
      ticks: pickTicks(niceY, 4),
      polyline: polylinePoints(pts),
    };
  }, [points]);

  if (isLoading) {
    return (
      <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
        Loading review trend…
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div
        className="flex h-[180px] items-center justify-center text-xs text-muted-foreground"
        aria-label="review-trend-empty"
      >
        No review activity in this window.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1" aria-label="chart-review-trend">
      <div className="flex h-[180px] gap-2">
        <div
          className="flex flex-col justify-between text-[10px] tabular-nums text-muted-foreground"
          style={{ width: 28 }}
          aria-hidden="true"
        >
          {[...ticks].reverse().map((tick, i) => (
            <span key={i} className="leading-none">
              {formatNumber(tick)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((tick, i) => {
            const y =
              TREND_HEIGHT - scaleLinear(tick, 0, yMax, TREND_HEIGHT);
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
            viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
            preserveAspectRatio="none"
            className="h-full w-full text-primary"
            role="img"
            aria-label={`Review queue trend over ${points.length} days`}
          >
            <polyline
              points={polyline}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      </div>
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

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Median across the four priority buckets, weighted by count. Used for the
 * top-row "median time-to-done" stat — it answers "across all closed work,
 * roughly how long did it take?" without needing a separate endpoint.
 */
function overallMedianHours(byPriority: TimeToDoneByPriority): number | null {
  let weightedSum = 0;
  let totalCount = 0;
  for (const key of ['p0', 'p1', 'p2', 'p3'] as const) {
    const bucket = byPriority[key];
    if (bucket.median_hours !== null && bucket.count > 0) {
      weightedSum += bucket.median_hours * bucket.count;
      totalCount += bucket.count;
    }
  }
  if (totalCount === 0) return null;
  return weightedSum / totalCount;
}

/**
 * Sum of `closed` over the last 7 entries of a throughput series. Used by
 * the "closed last 7d" stat card. We slice the tail of whatever window is
 * active so the number stays stable across window changes.
 */
function lastNDayClosed(
  points: { date: string; closed: number }[],
  n: number,
): number {
  return points
    .slice(-n)
    .reduce((sum, p) => sum + p.closed, 0);
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function Reports(): JSX.Element {
  const [window, setWindow] = useState<ReportWindow>('30d');
  const days = reportsWindowToDays(window);
  const bundleQ = useReportsBundle(window, days);
  const bundle = bundleQ.data;
  const isLoading = bundleQ.isLoading;

  const closedLast7 = useMemo(
    () => (bundle ? lastNDayClosed(bundle.throughput, 7) : 0),
    [bundle],
  );

  const overallMedian = useMemo(
    () =>
      bundle ? overallMedianHours(bundle.time_to_done_priority) : null,
    [bundle],
  );

  const successPct = useMemo(() => {
    if (!bundle || bundle.success_rate.total === 0) return null;
    return Math.round(
      (bundle.success_rate.succeeded / bundle.success_rate.total) * 100,
    );
  }, [bundle]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-label="view-reports"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
            <p className="text-xs text-muted-foreground">
              TaskPilot velocity, agent quality, and where work is piling up.
            </p>
          </div>
        </div>
        <WindowPicker value={window} onChange={setWindow} />
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {bundleQ.isError ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive"
            aria-label="reports-error"
          >
            Couldn't load reports. The API may be offline.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Weekly status report (Wave 16E) — at-a-glance + generate */}
            <StatusReportCard />

            {/* Top stat row */}
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              aria-label="reports-stat-row"
            >
              <StatCard
                label="Closed last 7 days"
                value={formatNumber(closedLast7)}
                hint="Trailing 7-day total"
                ariaLabel="stat-closed-7d"
              />
              <StatCard
                label="Agent success rate"
                value={successPct === null ? '–' : `${successPct}%`}
                hint={
                  bundle
                    ? `${formatNumber(bundle.success_rate.total)} agent runs`
                    : ' '
                }
                ariaLabel="stat-success-rate"
              />
              <StatCard
                label="Median time-to-done"
                value={formatHours(overallMedian)}
                hint="Weighted across priorities"
                ariaLabel="stat-median-ttd"
              />
            </div>

            {/* Throughput + review trend */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <section
                className="rounded-lg border border-border bg-card p-4"
                aria-label="card-throughput"
              >
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">Throughput</h2>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Tasks closed per day
                  </span>
                </div>
                <ThroughputChart
                  points={bundle?.throughput ?? []}
                  isLoading={isLoading}
                />
              </section>
              <section
                className="rounded-lg border border-border bg-card p-4"
                aria-label="card-review-trend"
              >
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">Review queue trend</h2>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Daily snapshot
                  </span>
                </div>
                <ReviewTrendChart
                  points={bundle?.review_queue_trend ?? []}
                  isLoading={isLoading}
                />
              </section>
            </div>

            {/* Heat map + time-to-done by priority */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <section
                className="rounded-lg border border-border bg-card p-4"
                aria-label="card-tag-heatmap"
              >
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">Tag heat map</h2>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Volume by tag
                  </span>
                </div>
                <TagHeatMap
                  rows={bundle?.tag_heat_map ?? []}
                  isLoading={isLoading}
                />
              </section>
              <section
                className="rounded-lg border border-border bg-card p-4"
                aria-label="card-time-to-done"
              >
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">
                    Time-to-done by priority
                  </h2>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Median hours
                  </span>
                </div>
                <TimeToDoneChart
                  byPriority={
                    bundle?.time_to_done_priority ?? {
                      p0: { median_hours: null, count: 0 },
                      p1: { median_hours: null, count: 0 },
                      p2: { median_hours: null, count: 0 },
                      p3: { median_hours: null, count: 0 },
                    }
                  }
                  isLoading={isLoading}
                />
              </section>
            </div>

            {/* Success rate detail (lives below since it's a denser stat) */}
            <section
              className="rounded-lg border border-border bg-card p-4"
              aria-label="card-success-rate-detail"
            >
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">Agent execution mix</h2>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Last {WINDOW_LABELS[window]}
                </span>
              </div>
              <SuccessRateCard
                rate={
                  bundle?.success_rate ?? {
                    succeeded: 0,
                    failed: 0,
                    needs_review: 0,
                    total: 0,
                  }
                }
                isLoading={isLoading}
              />
            </section>

            {/* Recent failures */}
            <section
              className="rounded-lg border border-border bg-card"
              aria-label="card-recent-failures"
            >
              <div className="flex items-baseline justify-between border-b border-border/60 px-4 py-3">
                <h2 className="text-sm font-semibold">Recent failures</h2>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Last 10
                </span>
              </div>
              <RecentFailuresList
                failures={bundle?.recent_failures ?? []}
                isLoading={isLoading}
              />
            </section>

            {/* Cost breakdown — Wave 13 */}
            <CostBreakdown window={window} />
          </div>
        )}
      </div>
    </div>
  );
}
