/**
 * Confidence badge — renders Claude's self-reported confidence on a result.
 *
 * Bands match the main-side `@/main/confidence#confidenceBand` helper so the
 * UI stays in lock-step with the gate threshold logic. Color coding:
 *   - high   (>= 0.85) — emerald
 *   - medium (>= 0.5)  — amber
 *   - low    (<  0.5)  — red
 *   - unknown          — zinc (no value reported)
 */

import { cn } from '@/renderer/lib/utils';

type ConfidenceBand = 'high' | 'medium' | 'low' | 'unknown';

function band(value: number | undefined): ConfidenceBand {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return 'unknown';
  }
  if (value >= 0.85) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}

const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'No confidence',
};

const BAND_CLASS: Record<ConfidenceBand, string> = {
  high: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  medium: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  low: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  unknown: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

interface ConfidenceBadgeProps {
  /** Confidence value in [0, 1]. Missing/undefined renders the "unknown" band. */
  value: number | undefined | null;
  /**
   * When set and `value` falls below it, the badge appends a "below
   * threshold" hint to the tooltip and switches to a destructive border.
   */
  threshold?: number;
  className?: string;
}

export function ConfidenceBadge({
  value,
  threshold,
  className,
}: ConfidenceBadgeProps): JSX.Element {
  const numeric =
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const b = band(numeric);
  const belowThreshold =
    numeric !== undefined &&
    typeof threshold === 'number' &&
    numeric < threshold;
  const pct =
    numeric === undefined ? '—' : `${Math.round(numeric * 100)}%`;
  const title =
    numeric === undefined
      ? BAND_LABEL[b]
      : belowThreshold && typeof threshold === 'number'
        ? `${BAND_LABEL[b]} confidence (${pct}) — below threshold ${Math.round(threshold * 100)}%`
        : `${BAND_LABEL[b]} confidence (${pct})`;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums',
        BAND_CLASS[b],
        belowThreshold && 'ring-1 ring-destructive/40',
        className,
      )}
      title={title}
      aria-label={`confidence-${b}`}
    >
      <span aria-hidden="true">{pct}</span>
      <span className="uppercase tracking-wide">{BAND_LABEL[b]}</span>
    </span>
  );
}

export default ConfidenceBadge;
