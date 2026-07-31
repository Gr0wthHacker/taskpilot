/**
 * Tag heat map — one cell per tag, sized to the same square, colored by
 * volume relative to the busiest tag in the window.
 *
 * Hovering a cell reveals a status-breakdown tooltip via the native `title`
 * attribute. We avoid a custom popover for now — `title` is keyboard-
 * accessible and zero extra code.
 */

import { useMemo } from 'react';

import { heatColor, heatTextColor } from './chart-utils';
import type { TagHeatMapRow } from '@/shared/api-contract';

interface TagHeatMapProps {
  rows: TagHeatMapRow[];
  isLoading?: boolean;
}

export default function TagHeatMap({
  rows,
  isLoading = false,
}: TagHeatMapProps): JSX.Element {
  const max = useMemo(
    () => (rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.total))),
    [rows],
  );

  if (isLoading) {
    return (
      <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
        Loading tags…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className="flex h-[180px] items-center justify-center text-xs text-muted-foreground"
        aria-label="tag-heatmap-empty"
      >
        No tagged tasks in this window.
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5"
      aria-label="chart-tag-heatmap"
    >
      {rows.map((row) => {
        const intensity = max === 0 ? 0 : row.total / max;
        const bg = heatColor(intensity);
        const text = heatTextColor(intensity);
        const title = [
          `#${row.tag}: ${row.total} task${row.total === 1 ? '' : 's'}`,
          ...Object.entries(row.by_status)
            .filter(([, n]) => n > 0)
            .map(([status, n]) => `${status}: ${n}`),
        ].join('\n');
        return (
          <div
            key={row.tag}
            className={`flex flex-col items-stretch gap-0.5 rounded border border-border/40 px-2 py-1.5 ${bg} ${text}`}
            title={title}
            aria-label={`tag-cell-${row.tag}`}
          >
            <div className="truncate text-[11px] font-medium">
              #{row.tag}
            </div>
            <div className="text-[10px] tabular-nums opacity-80">
              {row.total}
            </div>
          </div>
        );
      })}
    </div>
  );
}
