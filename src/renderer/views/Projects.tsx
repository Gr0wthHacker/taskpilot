/**
 * Projects view.
 *
 * Treats each distinct tag across all non-archived tasks as a first-class
 * "project". Renders a grid of project cards with status counts so the user
 * can see at a glance where work is piling up.
 *
 * Clicking a card sets the global tag filter and navigates to the Inbox,
 * which already knows how to render a tag-filtered task list (see the
 * `tag` field on the UI store's `filters` slice and `TaskFilters` chip).
 *
 * This view is purely client-side: it reuses `useTasksList({})` and
 * aggregates in-memory, so no new backend endpoint is required. Aggregation
 * is memoized — even a few thousand tasks fit comfortably in a render.
 */

import { Folder } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import { cn } from '@/renderer/lib/utils';
import { useTasksList } from '@/renderer/lib/query';
import { useUiStore } from '@/renderer/store/ui';
import type { Task, TaskStatus } from '@/shared/types';

interface ProjectSummary {
  tag: string;
  total: number;
  open: number;
  inProgress: number;
  done: number;
}

/**
 * Statuses we count as "open" (work not yet started). The Inbox and Queued
 * buckets — `blocked` is its own special case and `failed`/`done` are
 * terminal, so they aren't counted as open.
 */
const OPEN_STATUSES = new Set<TaskStatus>(['inbox', 'queued', 'blocked']);

function aggregateProjects(tasks: Task[]): ProjectSummary[] {
  const map = new Map<string, ProjectSummary>();

  for (const task of tasks) {
    if (!task.tags || task.tags.length === 0) continue;
    for (const tag of task.tags) {
      let summary = map.get(tag);
      if (!summary) {
        summary = {
          tag,
          total: 0,
          open: 0,
          inProgress: 0,
          done: 0,
        };
        map.set(tag, summary);
      }
      summary.total += 1;
      if (task.status === 'in_progress') summary.inProgress += 1;
      else if (task.status === 'done') summary.done += 1;
      else if (OPEN_STATUSES.has(task.status)) summary.open += 1;
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.tag.localeCompare(b.tag);
  });
}

interface ProjectCardProps {
  project: ProjectSummary;
  onClick: (tag: string) => void;
}

function ProjectCard({ project, onClick }: ProjectCardProps): JSX.Element {
  const completionPct =
    project.total === 0
      ? 0
      : Math.round((project.done / project.total) * 100);

  return (
    <button
      type="button"
      onClick={() => onClick(project.tag)}
      className={cn(
        'group flex flex-col items-stretch gap-3 rounded-lg border border-border bg-card p-4 text-left',
        'transition-colors hover:border-primary/40 hover:bg-accent/40',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      aria-label={`project-card-${project.tag}`}
    >
      <div className="flex items-center gap-2">
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-semibold tracking-tight">
          #{project.tag}
        </span>
        <span className="ml-auto inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
          {project.total}
        </span>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded bg-muted/50 px-2 py-1">
          <dt className="text-muted-foreground">Open</dt>
          <dd className="font-semibold tabular-nums">{project.open}</dd>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1">
          <dt className="text-muted-foreground">Active</dt>
          <dd className="font-semibold tabular-nums">{project.inProgress}</dd>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1">
          <dt className="text-muted-foreground">Done</dt>
          <dd className="font-semibold tabular-nums">{project.done}</dd>
        </div>
      </dl>

      <div className="flex items-center gap-2">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          aria-hidden="true"
        >
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${completionPct}%` }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {completionPct}%
        </span>
      </div>
    </button>
  );
}

export default function Projects(): JSX.Element {
  const navigate = useNavigate();
  const setFilter = useUiStore((s) => s.setFilter);
  const tasksQ = useTasksList({});

  const projects = useMemo(() => {
    const list = tasksQ.data?.tasks ?? [];
    // We treat "non-archived" loosely — the schema doesn't have an
    // `archived` flag yet, but Done tasks are still meaningful project
    // members (the completion percentage relies on them). Anything that
    // got hard-deleted is already absent from this list.
    return aggregateProjects(list);
  }, [tasksQ.data]);

  const openProject = (tag: string): void => {
    setFilter('tag', tag);
    // Inbox view honors the global UI store's tag filter and renders only
    // matching tasks. The chip on the filter strip lets the user clear it.
    navigate('/inbox');
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-label="view-projects"
    >
      <ViewHeader
        title="Projects"
        subtitle="One card per tag. Click to filter the inbox by that tag."
        actions={
          <span
            className="text-[10px] uppercase tracking-wide text-muted-foreground"
            aria-label="projects-total-count"
          >
            {projects.length} project{projects.length === 1 ? '' : 's'}
          </span>
        }
      />

      <div className="flex-1 overflow-auto px-6 py-4">
        {tasksQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading projects…</div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={Folder}
            title="No projects yet"
            description="Add tags to your tasks to see them as projects here. Tags are free-form labels — anything you type in a task's tag input becomes a project automatically."
            ariaLabel="projects-empty"
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projects.map((project) => (
              <ProjectCard
                key={project.tag}
                project={project}
                onClick={openProject}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
