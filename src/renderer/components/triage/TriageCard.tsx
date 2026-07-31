/**
 * TriageCard — the focused, full-bleed presentation of a single task during a
 * triage session. Larger and airier than the compact list `TaskCard`: big
 * title, rendered markdown body, a metadata row (priority / due / agent
 * method / tags), and the task's sub-task list when present.
 *
 * Purely presentational. The Triage view owns all state and resolves the
 * sub-task list via React Query before handing it down.
 */

import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { Bot, CalendarClock, CheckCircle2, Circle, User } from 'lucide-react';

import {
  PRIORITY_DOT,
  PRIORITY_LABELS,
} from '@/renderer/components/shared/PriorityPicker';
import { MarkdownView } from '@/renderer/components/shared/MarkdownView';
import { cn } from '@/renderer/lib/utils';
import type { AgentMethod, Task } from '@/shared/types';

interface TriageCardProps {
  task: Task;
  /** Resolved child tasks (sub-tasks). Empty array when none / still loading. */
  subTasks?: Task[];
}

function formatDue(due: string | null): { label: string; overdue: boolean } | null {
  if (!due) return null;
  try {
    const parsed = parseISO(due);
    if (Number.isNaN(parsed.getTime())) return { label: due, overdue: false };
    const overdue = parsed.getTime() < Date.now();
    const distance = formatDistanceToNowStrict(parsed, { addSuffix: true });
    return {
      label: overdue ? `due ${distance}` : `in ${distance.replace(/^in /, '')}`,
      overdue,
    };
  } catch {
    return { label: due, overdue: false };
  }
}

function MethodPill({ method }: { method: AgentMethod }): JSX.Element {
  const human = method === 'human_only';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
      aria-label={`triage-agent-${method}`}
    >
      {human ? (
        <User className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className="uppercase tracking-wide">{method.replace('_', ' ')}</span>
    </span>
  );
}

export function TriageCard({ task, subTasks = [] }: TriageCardProps): JSX.Element {
  const due = formatDue(task.due);

  return (
    <article
      aria-label="triage-card"
      data-task-id={task.id}
      className="flex w-full flex-col gap-5 rounded-xl border border-border bg-card p-7 text-card-foreground shadow-sm"
    >
      <header className="flex flex-col gap-3">
        <h2 className="text-2xl font-semibold leading-tight tracking-tight">
          {task.title}
        </h2>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-medium"
            aria-label={`triage-priority-${task.priority}`}
          >
            <span
              className={cn('h-2 w-2 rounded-full', PRIORITY_DOT[task.priority])}
              aria-hidden="true"
            />
            {PRIORITY_LABELS[task.priority]}
          </span>

          {due && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1',
                due.overdue && 'text-red-600 dark:text-red-400',
              )}
              aria-label="triage-due"
            >
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              {due.label}
            </span>
          )}

          <MethodPill method={task.agent_method} />
        </div>
      </header>

      {task.description && task.description.trim().length > 0 ? (
        <div className="max-h-[40vh] overflow-auto pr-1">
          <MarkdownView source={task.description} />
        </div>
      ) : (
        <p className="text-sm italic text-muted-foreground">
          No description.
        </p>
      )}

      {subTasks.length > 0 && (
        <section aria-label="triage-subtasks" className="flex flex-col gap-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Sub-tasks ({subTasks.length})
          </div>
          <ul className="flex flex-col gap-1">
            {subTasks.map((sub) => {
              const complete = sub.status === 'done';
              return (
                <li
                  key={sub.id}
                  className="flex items-center gap-2 text-sm"
                  aria-label={`triage-subtask-${sub.id}`}
                >
                  {complete ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span
                    className={cn(
                      'truncate',
                      complete && 'text-muted-foreground line-through',
                    )}
                  >
                    {sub.title}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="triage-tags">
          {task.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export default TriageCard;
