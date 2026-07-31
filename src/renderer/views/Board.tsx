/**
 * Board view — Kanban-style columns over the full task list. Columns are
 * derived from a single `useTasksList()` call so we can avoid N round trips.
 *
 * Mapping (PRD §9.2):
 *  - Inbox: status='inbox' AND agent_status NOT IN ('assigned','running')
 *  - Awaiting Derivation: status='inbox' AND agent_status IN ('assigned','pending')
 *                         AND parent_id IS NULL — i.e. derive request fired
 *  - Awaiting Execution: status='queued'
 *  - In Progress: status='in_progress'
 *  - Done: status='done'
 *  - Failed: status='failed'
 *
 * Cross-column drag is intentionally out of scope (no @dnd-kit). Within a
 * column the user can bump priority up/down with arrow buttons; the board
 * re-sorts on the next fetch.
 */

import { Bot, ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { useToast } from '@/renderer/components/ui/use-toast';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import { VirtualList } from '@/renderer/components/shared/VirtualList';
import {
  TaskFilters,
  applyClientFilters,
} from '@/renderer/components/shared/TaskFilters';
import {
  usePipelines,
  useTasksList,
  useUpdateTask,
} from '@/renderer/lib/query';
import { PRIORITY_ORDER, sortByPriority } from '@/renderer/lib/task-sort';
import { cn } from '@/renderer/lib/utils';
import { useUiStore } from '@/renderer/store/ui';
import {
  applyWorkspaceFilter,
  useActiveWorkspace,
} from '@/renderer/store/workspace';
import type { Pipeline, Task, TaskPriority } from '@/shared/types';

interface Column {
  id: string;
  title: string;
  description?: string;
  match: (task: Task) => boolean;
}

const COLUMNS: Column[] = [
  {
    id: 'inbox',
    title: 'Inbox',
    description: 'Awaiting triage',
    match: (t) =>
      t.status === 'inbox' &&
      t.agent_status !== 'assigned' &&
      t.agent_status !== 'running',
  },
  {
    id: 'awaiting-derivation',
    title: 'Awaiting Derivation',
    description: 'Derive request out, awaiting Claude',
    match: (t) =>
      t.status === 'inbox' &&
      t.parent_id === null &&
      t.agent_method !== 'human_only' &&
      // Once the app writes a derive request the agent_status flips to
      // `assigned`. Including `running` covers in-flight derive jobs that
      // some backends mark explicitly.
      (t.agent_status === 'assigned' || t.agent_status === 'running'),
  },
  {
    id: 'awaiting-execution',
    title: 'Awaiting Execution',
    description: 'Queued for an agent',
    match: (t) => t.status === 'queued',
  },
  {
    id: 'in-progress',
    title: 'In Progress',
    match: (t) => t.status === 'in_progress',
  },
  {
    id: 'done',
    title: 'Done',
    match: (t) => t.status === 'done',
  },
  {
    id: 'failed',
    title: 'Failed',
    match: (t) => t.status === 'failed',
  },
];

// Board's columns keep oldest-first as the final tiebreak (recent:false) so
// long-lived items don't churn position as newer tasks arrive.
function sortColumn(tasks: Task[]): Task[] {
  return sortByPriority(tasks, { recent: false });
}

function adjacentPriority(current: TaskPriority, direction: 1 | -1): TaskPriority | null {
  const idx = PRIORITY_ORDER.indexOf(current);
  // direction === -1 means "move up" (toward p0 = higher priority).
  const next = idx + direction;
  if (next < 0 || next >= PRIORITY_ORDER.length) return null;
  return PRIORITY_ORDER[next] ?? null;
}

type GroupBy = 'status' | 'phase';

/**
 * Pick the pipeline most frequently used across the visible tasks. Mirrors
 * the server-side resolver but operates on the rendered subset so the
 * "Group by phase" view stays coherent with whatever filter the user has
 * applied. Falls back to the default pipeline.
 */
function pickActivePipeline(
  pipelines: Pipeline[],
  tasks: Task[],
): Pipeline | null {
  if (pipelines.length === 0) return null;
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const ctx = task.context as Record<string, unknown> | null;
    const explicit = typeof ctx?.pipeline_id === 'string' ? ctx.pipeline_id : null;
    if (explicit) {
      counts.set(explicit, (counts.get(explicit) ?? 0) + 1);
      continue;
    }
    for (const pipeline of pipelines) {
      const wantTags = pipeline.applies_to?.tags;
      if (!wantTags || wantTags.length === 0) continue;
      if (wantTags.some((t) => task.tags.includes(t))) {
        counts.set(pipeline.id, (counts.get(pipeline.id) ?? 0) + 1);
        break;
      }
    }
  }
  let bestId: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      bestId = id;
    }
  }
  if (bestId) {
    const found = pipelines.find((p) => p.id === bestId);
    if (found) return found;
  }
  return pipelines.find((p) => p.default) ?? pipelines[0] ?? null;
}

function readTaskPhase(task: Task): string | null {
  const ctx = task.context as Record<string, unknown> | null;
  const raw = ctx?.phase;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export default function Board(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();

  const filters = useUiStore((s) => s.filters);
  const activeWorkspace = useActiveWorkspace();
  const updateTask = useUpdateTask();

  // Pull everything — the board needs cross-status visibility. We rely on the
  // server's defaults; if the dataset grows past a few hundred tasks we'll
  // need server-side pagination per column.
  const tasksQ = useTasksList(undefined);
  const pipelinesQ = usePipelines();

  // Group-by toggle (Wave 15). Default to status so existing muscle memory
  // keeps working; user picks "phase" to flip into pipeline-column mode.
  const [groupBy, setGroupBy] = useState<GroupBy>('status');

  const filtered = useMemo(() => {
    const list = tasksQ.data?.tasks ?? [];
    // Status filter is column-driven, so we ignore the global status filter
    // here but honor priority, agent-only, search, and tag.
    const intermediate = list.filter((t) => {
      if (
        filters.priority !== 'all' &&
        t.priority !== filters.priority
      ) {
        return false;
      }
      if (filters.agentOnly && !t.agent_executable) return false;
      return true;
    });
    return applyWorkspaceFilter(
      applyClientFilters(intermediate, filters),
      activeWorkspace,
    );
  }, [tasksQ.data, filters, activeWorkspace]);

  const activePipeline = useMemo(() => {
    if (groupBy !== 'phase') return null;
    return pickActivePipeline(pipelinesQ.data?.pipelines ?? [], filtered);
  }, [groupBy, pipelinesQ.data, filtered]);

  const columns = useMemo(() => {
    if (groupBy === 'phase' && activePipeline) {
      const phaseCols = activePipeline.phases.map((phase) => ({
        id: `phase-${phase.id}`,
        title: phase.name,
        description: phase.description,
        match: (t: Task) => readTaskPhase(t) === phase.id,
      }));
      // "Unphased" catches anything without a phase assignment.
      phaseCols.push({
        id: 'phase-unphased',
        title: 'Unphased',
        description: 'No phase assigned',
        match: (t: Task) => readTaskPhase(t) === null,
      });
      return phaseCols.map((col) => ({
        ...col,
        tasks: sortColumn(filtered.filter(col.match)),
      }));
    }
    return COLUMNS.map((col) => ({
      ...col,
      tasks: sortColumn(filtered.filter(col.match)),
    }));
  }, [filtered, groupBy, activePipeline]);

  const handleClick = (task: Task): void => {
    navigate(`/task/${task.id}`);
  };

  const bumpPriority = (task: Task, direction: 1 | -1): void => {
    const next = adjacentPriority(task.priority, direction);
    if (!next) return;
    updateTask
      .mutateAsync({ id: task.id, patch: { priority: next } })
      .then(() => {
        toast({
          title: 'Priority updated',
          description: `${task.title} → ${next.toUpperCase()}`,
        });
      })
      .catch((cause) => {
        toast({
          title: 'Update failed',
          description: cause instanceof Error ? cause.message : 'Unknown error',
          variant: 'destructive',
        });
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-board">
      <header className="flex flex-col gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Board</h1>
            <p className="text-xs text-muted-foreground">
              Tasks across the pipeline. Use the arrows on a card to reorder
              priority.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Group by</span>
            <Select
              value={groupBy}
              onValueChange={(v) => setGroupBy(v as GroupBy)}
            >
              <SelectTrigger
                className="h-8 w-[120px] text-xs"
                aria-label="board-group-by"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="status">Status</SelectItem>
                <SelectItem value="phase">Phase</SelectItem>
              </SelectContent>
            </Select>
            {groupBy === 'phase' && activePipeline && (
              <span
                className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
                aria-label="board-active-pipeline"
              >
                {activePipeline.name}
              </span>
            )}
          </div>
        </div>
        <TaskFilters hideStatus />
      </header>

      <div className="flex-1 overflow-auto p-4">
        {tasksQ.isLoading && (
          <div className="text-sm text-muted-foreground">Loading board…</div>
        )}
        {tasksQ.isError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            Couldn’t load tasks.
          </div>
        )}
        {!tasksQ.isLoading && !tasksQ.isError && (
          <div
            className="flex h-full min-h-[400px] gap-3"
            aria-label="board-columns"
          >
            {columns.map((col) => (
              <section
                key={col.id}
                className="flex w-[280px] shrink-0 flex-col rounded-lg border border-border bg-card/40"
                aria-label={`board-column-${col.id}`}
              >
                <header className="flex items-center justify-between border-b border-border px-3 py-2">
                  <div>
                    <div className="text-sm font-medium">{col.title}</div>
                    {col.description && (
                      <div className="text-[10px] text-muted-foreground">
                        {col.description}
                      </div>
                    )}
                  </div>
                  <span
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground"
                    aria-label={`board-column-count-${col.id}`}
                  >
                    {col.tasks.length}
                  </span>
                </header>
                {col.tasks.length === 0 ? (
                  <div className="p-2">
                    <div className="rounded-md border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted-foreground">
                      No tasks.
                    </div>
                  </div>
                ) : (
                  <VirtualList
                    items={col.tasks}
                    className="flex-1 p-2"
                    estimateSize={() => 76}
                    overscan={6}
                    getKey={(task) => task.id}
                    ariaLabel={`board-column-list-${col.id}`}
                    renderRow={(task) => {
                      const canMoveUp = task.priority !== 'p0';
                      const canMoveDown = task.priority !== 'p3';
                      return (
                        <div className="relative pb-2">
                          <TaskCard
                            task={task}
                            compact
                            onClick={handleClick}
                            actions={
                              <div
                                className={cn(
                                  'flex items-center gap-0.5 opacity-0 transition-opacity',
                                  'group-hover:opacity-100 focus-within:opacity-100',
                                )}
                              >
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6"
                                  disabled={!canMoveUp}
                                  onClick={() => bumpPriority(task, -1)}
                                  aria-label={`board-up-${task.id}`}
                                  data-card-action
                                >
                                  <ChevronUp className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6"
                                  disabled={!canMoveDown}
                                  onClick={() => bumpPriority(task, 1)}
                                  aria-label={`board-down-${task.id}`}
                                  data-card-action
                                >
                                  <ChevronDown className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            }
                          />
                          {task.agent_executable && (
                            <div
                              className="pointer-events-none absolute -right-1 -top-1 rounded-full border border-border bg-background p-0.5 shadow-sm"
                              aria-label={`board-agent-flag-${task.id}`}
                            >
                              <Bot className="h-3 w-3 text-primary" />
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
