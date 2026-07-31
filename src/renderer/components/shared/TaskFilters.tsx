/**
 * Filter bar bound to the global UI store. Drop into any task list view to
 * give the user search/status/priority/agent-only controls.
 */

import { Search, X } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { cn } from '@/renderer/lib/utils';
import { useUiStore, type TaskViewFilters } from '@/renderer/store/ui';
import type { ListTasksQuery } from '@/shared/api-contract';
import type { Task, TaskPriority, TaskStatus } from '@/shared/types';

const STATUS_OPTIONS: Array<{ value: TaskStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'queued', label: 'Queued' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
];

const PRIORITY_OPTIONS: Array<{ value: TaskPriority | 'all'; label: string }> = [
  { value: 'all', label: 'Any priority' },
  { value: 'p0', label: 'P0' },
  { value: 'p1', label: 'P1' },
  { value: 'p2', label: 'P2' },
  { value: 'p3', label: 'P3' },
];

interface TaskFiltersProps {
  className?: string;
  /** Hide the status filter when the view fixes status itself (e.g. Inbox). */
  hideStatus?: boolean;
}

export function TaskFilters({
  className,
  hideStatus,
}: TaskFiltersProps): JSX.Element {
  const filters = useUiStore((s) => s.filters);
  const setFilter = useUiStore((s) => s.setFilter);
  const resetFilters = useUiStore((s) => s.resetFilters);

  const hasFilters = useMemo(() => {
    return (
      filters.status !== 'all' ||
      filters.priority !== 'all' ||
      filters.agentOnly ||
      filters.search.length > 0 ||
      filters.tag !== null
    );
  }, [filters]);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border bg-card/40 p-2',
        className,
      )}
      aria-label="task-filters"
    >
      <div className="relative min-w-[180px] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
          placeholder="Search tasks…"
          className="h-8 pl-7 text-sm"
          aria-label="task-filter-search"
        />
      </div>

      {!hideStatus && (
        <Select
          value={filters.status}
          onValueChange={(v) => setFilter('status', v as TaskStatus | 'all')}
        >
          <SelectTrigger
            className="h-8 w-[140px] text-xs"
            aria-label="task-filter-status"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select
        value={filters.priority}
        onValueChange={(v) => setFilter('priority', v as TaskPriority | 'all')}
      >
        <SelectTrigger
          className="h-8 w-[130px] text-xs"
          aria-label="task-filter-priority"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRIORITY_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="button"
        size="sm"
        variant={filters.agentOnly ? 'default' : 'outline'}
        className="h-8 text-xs"
        onClick={() => setFilter('agentOnly', !filters.agentOnly)}
        aria-label="task-filter-agent-only"
        aria-pressed={filters.agentOnly}
      >
        Agent-executable
      </Button>

      {filters.tag !== null && (
        <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground">
          #{filters.tag}
          <button
            type="button"
            onClick={() => setFilter('tag', null)}
            className="rounded-sm hover:bg-secondary-foreground/10"
            aria-label="task-filter-tag-clear"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}

      {hasFilters && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={resetFilters}
          className="h-8 text-xs"
          aria-label="task-filter-reset"
        >
          Clear
        </Button>
      )}
    </div>
  );
}

/* Helper consumed by views — converts the UI store filters into the API
 * query shape expected by `useTasksList`, plus an in-memory predicate that
 * applies the search/tag locally since the API doesn't accept those. */

export function deriveTasksQuery(
  filters: TaskViewFilters,
  override?: Partial<ListTasksQuery>,
): ListTasksQuery {
  const out: ListTasksQuery = { ...(override ?? {}) };
  if (filters.status !== 'all' && out.status === undefined) {
    out.status = filters.status;
  }
  if (filters.priority !== 'all' && out.priority === undefined) {
    out.priority = filters.priority;
  }
  if (filters.agentOnly && out.agent_only === undefined) {
    out.agent_only = true;
  }
  return out;
}

export function applyClientFilters(
  tasks: Task[],
  filters: TaskViewFilters,
): Task[] {
  const needle = filters.search.trim().toLowerCase();
  const tag = filters.tag;
  if (needle.length === 0 && tag === null) return tasks;
  return tasks.filter((t) => {
    if (tag !== null && !t.tags.includes(tag)) return false;
    if (needle.length === 0) return true;
    if (t.title.toLowerCase().includes(needle)) return true;
    if (t.description && t.description.toLowerCase().includes(needle))
      return true;
    if (t.tags.some((tg) => tg.toLowerCase().includes(needle))) return true;
    return false;
  });
}
