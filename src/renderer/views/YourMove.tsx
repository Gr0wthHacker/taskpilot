/**
 * "Your move" — one list of everything that needs *you*, separated from what
 * the agents own. Aggregates three human-action buckets:
 *   - Needs review  (the review queue: sign-offs, flagged results, failures)
 *   - Overdue       (due date passed, not yet done)
 *   - Blocked       (status = blocked, waiting on a human unblock)
 *
 * Snoozed tasks are deliberately excluded — the point of snoozing is to get
 * something off your plate until later. Respects the active workspace lens.
 */

import { AlertCircle, CalendarX, Eye, ListChecks, Timer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import { useReviewQueue, useTasksList } from '@/renderer/lib/query';
import { isSnoozed } from '@/renderer/lib/snooze';
import {
  applyWorkspaceFilter,
  useActiveWorkspace,
} from '@/renderer/store/workspace';
import { pickQuickWins } from '@/shared/quick-wins';
import type { Task } from '@/shared/types';

function overdue(task: Task, now: number): boolean {
  if (task.status === 'done' || task.status === 'failed') return false;
  if (!task.due) return false;
  const ms = Date.parse(task.due);
  return !Number.isNaN(ms) && ms < now;
}

interface SectionProps {
  title: string;
  icon: typeof Eye;
  tone: string;
  tasks: Task[];
  emptyText: string;
  onOpen: (id: string) => void;
  action?: { label: string; onClick: () => void };
}

function Section({
  title,
  icon: Icon,
  tone,
  tasks,
  emptyText,
  onOpen,
  action,
}: SectionProps): JSX.Element {
  return (
    <section aria-label={`yourmove-section-${title}`} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className={`h-4 w-4 ${tone}`} />
          {title}
          <span className="rounded bg-secondary px-1.5 text-[10px] text-secondary-foreground">
            {tasks.length}
          </span>
        </h2>
        {action && tasks.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={action.onClick}
            aria-label={`yourmove-action-${title}`}
          >
            {action.label}
          </Button>
        )}
      </div>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskCard task={task} compact onClick={() => onOpen(task.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function YourMove(): JSX.Element {
  const navigate = useNavigate();
  const activeWorkspace = useActiveWorkspace();

  const tasksQ = useTasksList();
  const reviewQ = useReviewQueue('all');

  const tasks = useMemo(
    () =>
      applyWorkspaceFilter(tasksQ.data?.tasks ?? [], activeWorkspace).filter(
        (t) => !isSnoozed(t),
      ),
    [tasksQ.data, activeWorkspace],
  );

  const reviewTasks = useMemo(
    () =>
      (reviewQ.data?.items ?? [])
        .map((i) => i.task)
        .filter((t) => !isSnoozed(t)),
    [reviewQ.data],
  );

  const overdueTasks = useMemo(() => {
    const now = Date.now();
    return tasks.filter((t) => overdue(t, now));
  }, [tasks]);

  const blockedTasks = useMemo(
    () => tasks.filter((t) => t.status === 'blocked'),
    [tasks],
  );

  // "Found a moment" mode — toggleable presets so the user can pick what
  // time slot they have. The dropdown state lives only in this view; the
  // filter logic is shared with tests via @/shared/quick-wins.
  const [quickMinutes, setQuickMinutes] = useState<number | null>(null);
  const quickWins = useMemo(() => {
    if (quickMinutes === null) return [];
    return pickQuickWins(tasks, { minutes: quickMinutes }).slice(0, 8);
  }, [tasks, quickMinutes]);

  const total =
    reviewTasks.length + overdueTasks.length + blockedTasks.length;

  const open = (id: string): void => navigate(`/task/${id}`);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-your-move">
      <ViewHeader
        title="Your move"
        icon={ListChecks}
        subtitle={
          total === 0
            ? 'Nothing needs you right now. The agents have it.'
            : `${total} item${total === 1 ? '' : 's'} waiting on you — separate from agent-owned work.`
        }
      />

      <div className="flex-1 space-y-6 overflow-auto p-6">
        {/* Found a moment — chip strip is always visible so the user can
            opt in regardless of whether anything else is on the page. */}
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="yourmove-quickwins-chips"
        >
          <Timer className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Got a moment?</span>
          {[5, 10, 15, 30].map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={quickMinutes === n ? 'default' : 'outline'}
              className="h-7 px-2 text-xs"
              onClick={() =>
                setQuickMinutes((cur) => (cur === n ? null : n))
              }
              aria-label={`quickwins-${n}min`}
              aria-pressed={quickMinutes === n}
            >
              {n} min
            </Button>
          ))}
          {quickMinutes !== null && (
            <span className="ml-2 text-[11px] text-muted-foreground">
              {quickWins.length} candidate{quickWins.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {quickMinutes !== null && (
          <Section
            title={`Quick wins (≤${quickMinutes}m)`}
            icon={Timer}
            tone="text-emerald-500"
            tasks={quickWins}
            emptyText="Nothing fits this slot. Try a longer chip or tag a task with an estimate."
            onOpen={open}
          />
        )}

        {total === 0 && !tasksQ.isLoading && quickMinutes === null ? (
          <EmptyState
            icon={ListChecks}
            tone="positive"
            title="You're clear."
            description="Nothing overdue, blocked, or awaiting your review."
            ariaLabel="yourmove-empty"
          />
        ) : (
          <>
            <Section
              title="Needs review"
              icon={Eye}
              tone="text-amber-500"
              tasks={reviewTasks}
              emptyText="Nothing awaiting your sign-off."
              onOpen={open}
              action={{
                label: 'Open review',
                onClick: () => navigate('/review'),
              }}
            />
            <Section
              title="Overdue"
              icon={CalendarX}
              tone="text-red-500"
              tasks={overdueTasks}
              emptyText="Nothing past due."
              onOpen={open}
            />
            <Section
              title="Blocked"
              icon={AlertCircle}
              tone="text-orange-500"
              tasks={blockedTasks}
              emptyText="Nothing blocked."
              onOpen={open}
            />
          </>
        )}
      </div>
    </div>
  );
}
