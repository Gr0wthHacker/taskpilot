/**
 * Cowork queue view (Wave 13).
 *
 * Surfaces tasks that need a human at the desk to drive the GUI alongside
 * Claude. The queue includes any task whose `agent_method` is `'cowork'` or
 * `'either'` — `cli`-only tasks fire autonomously so they don't show up
 * here, and `human_only` is out-of-scope (no Cowork agent involvement).
 *
 * Each row carries a "Start cowork session" button that navigates to
 * `/execute/:id`, the per-task execution workspace. The view doesn't
 * mutate tasks itself — it's a focused triage surface.
 */

import { PlayCircle, Sparkles, UserSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AgentsTabs } from '@/renderer/components/AgentsTabs';
import { Button } from '@/renderer/components/ui/button';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import { useCoworkQueue } from '@/renderer/lib/query';
import { sortByPriority } from '@/renderer/lib/task-sort';
import { cn } from '@/renderer/lib/utils';

type StatusFilter = 'all' | 'inbox' | 'queued' | 'in_progress';

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'queued', label: 'Queued' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'all', label: 'All' },
];

export default function CoworkQueue(): JSX.Element {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<StatusFilter>('queued');
  const queue = useCoworkQueue({ status: filter });

  const sorted = useMemo(
    () => sortByPriority(queue.items.map((i) => i.task)),
    [queue.items],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentsTabs />
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 p-6"
        aria-label="view-cowork-queue"
      >
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <UserSquare className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">
              Cowork queue
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Tasks that need you at the desk. Cowork and Either-mode tasks
            surface here so you can drive the GUI alongside Claude.
          </p>
        </div>
        <div
          className="text-right text-sm text-muted-foreground"
          aria-label="cowork-queue-count"
        >
          <div className="text-2xl font-semibold text-foreground">
            {queue.count}
          </div>
          <div className="text-xs">waiting</div>
        </div>
      </header>

      <div
        className="flex flex-wrap gap-1 rounded-md border border-border bg-card p-1"
        aria-label="cowork-queue-filters"
      >
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            aria-label={`cowork-queue-filter-${f.value}`}
            aria-pressed={filter === f.value}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              filter === f.value
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {queue.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <ul className="flex flex-col gap-2" aria-label="cowork-queue-list">
            {sorted.map((task) => (
              <li
                key={task.id}
                aria-label={`cowork-queue-row-${task.id}`}
                className="flex items-stretch gap-2"
              >
                <TaskCard
                  task={task}
                  className="flex-1"
                  showCost
                  onClick={() => navigate(`/task/${task.id}`)}
                />
                <div className="flex flex-col items-stretch justify-center">
                  <Button
                    type="button"
                    onClick={() => navigate(`/execute/${task.id}`)}
                    aria-label={`cowork-start-${task.id}`}
                    className="h-full whitespace-nowrap"
                  >
                    <PlayCircle className="mr-1.5 h-4 w-4" />
                    Start cowork session
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>
    </div>
  );
}

function EmptyState({ filter }: { filter: StatusFilter }): JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border py-12 text-center"
      aria-label="cowork-queue-empty"
    >
      <Sparkles className="h-6 w-6 text-muted-foreground" />
      <div className="text-sm font-medium">No Cowork tasks waiting.</div>
      <div className="max-w-md text-xs text-muted-foreground">
        {filter === 'all'
          ? "When a task's agent method is set to Cowork or Either, it shows up here so you can drive the GUI alongside Claude."
          : `Switch the filter to "All" to see Cowork tasks across every status.`}
      </div>
    </div>
  );
}

/**
 * Status type re-export so callers (router test harness) can construct
 * synthetic filter values without pulling them from the union.
 */
export type CoworkQueueStatusFilter = StatusFilter;
