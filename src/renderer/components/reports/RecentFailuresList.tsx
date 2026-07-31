/**
 * Recent failures list — flat rows with task title, time-ago timestamp,
 * priority badge, and a truncated error preview. Clicking a row jumps to
 * the task detail view so the user can dig into the full log.
 */

import { AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/renderer/lib/utils';
import type { RecentFailureRow } from '@/shared/api-contract';
import type { TaskPriority } from '@/shared/types';

interface RecentFailuresListProps {
  failures: RecentFailureRow[];
  isLoading?: boolean;
}

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  p0: 'bg-red-200 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  p1: 'bg-orange-200 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200',
  p2: 'bg-blue-200 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200',
  p3: 'bg-muted text-muted-foreground',
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  // For older entries fall back to YYYY-MM-DD.
  return iso.slice(0, 10);
}

export default function RecentFailuresList({
  failures,
  isLoading = false,
}: RecentFailuresListProps): JSX.Element {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
        Loading recent failures…
      </div>
    );
  }

  if (failures.length === 0) {
    return (
      <div
        className="flex h-[120px] items-center justify-center gap-2 text-xs text-muted-foreground"
        aria-label="failures-empty"
      >
        <AlertTriangle className="h-4 w-4" />
        No failed tasks. Nice.
      </div>
    );
  }

  return (
    <ul
      className="flex flex-col divide-y divide-border/60"
      aria-label="chart-recent-failures"
    >
      {failures.map((f) => (
        <li key={f.task_id}>
          <button
            type="button"
            onClick={() => navigate(`/task/${encodeURIComponent(f.task_id)}`)}
            className={cn(
              'group flex w-full items-start gap-3 px-3 py-2 text-left',
              'transition-colors hover:bg-accent/40',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
            aria-label={`failure-row-${f.task_id}`}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {f.title}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                    PRIORITY_COLOR[f.priority],
                  )}
                >
                  {f.priority}
                </span>
              </div>
              {f.error && (
                <div className="line-clamp-1 text-[11px] text-muted-foreground">
                  {f.error}
                </div>
              )}
            </div>
            <div className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {relativeTime(f.failed_at)}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
