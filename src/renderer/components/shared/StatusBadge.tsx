/**
 * Colored badge for task/agent state. Renders consistently across views so the
 * user has a single mental model for what each token means.
 */

import { cn } from '@/renderer/lib/utils';
import type {
  AgentMethod,
  AgentStatus,
  TaskStatus,
} from '@/shared/types';

interface BaseProps {
  className?: string;
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  queued: 'Queued',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

const TASK_STATUS_CLASS: Record<TaskStatus, string> = {
  inbox: 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100',
  queued: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  in_progress:
    'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  blocked:
    'bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200',
  done:
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  cancelled:
    'bg-zinc-100 text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400',
  archived:
    'bg-zinc-100 text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400',
};

const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  pending: 'Pending',
  // The app writes an execute request to io/execute/<id>.json and flips the
  // task to `assigned`. Actual work happens in an external runner — Claude
  // Code via `/tp-watch`, or Cowork. The "Waiting on runner" label makes
  // that wait explicit so the user knows nothing is happening locally yet.
  assigned: 'Waiting on runner',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  needs_review: 'Needs Review',
};

const AGENT_STATUS_CLASS: Record<AgentStatus, string> = {
  pending: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  assigned: 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200',
  running:
    'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  succeeded:
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  needs_review:
    'bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-200',
};

const AGENT_METHOD_LABELS: Record<AgentMethod, string> = {
  cowork: 'Cowork',
  cli: 'Claude Code',
  either: 'Either',
  human_only: 'Human',
};

const AGENT_METHOD_CLASS: Record<AgentMethod, string> = {
  cowork:
    'bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200',
  cli: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200',
  either:
    'bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-900/40 dark:text-fuchsia-200',
  human_only:
    'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100',
};

const BASE_CLASS =
  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium';

export function TaskStatusBadge({
  status,
  className,
}: BaseProps & { status: TaskStatus }): JSX.Element {
  return (
    <span
      className={cn(BASE_CLASS, TASK_STATUS_CLASS[status], className)}
      aria-label={`task-status-${status}`}
    >
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

export function AgentStatusBadge({
  status,
  className,
}: BaseProps & { status: AgentStatus }): JSX.Element {
  return (
    <span
      className={cn(BASE_CLASS, AGENT_STATUS_CLASS[status], className)}
      aria-label={`agent-status-${status}`}
    >
      {AGENT_STATUS_LABELS[status]}
    </span>
  );
}

export function AgentMethodBadge({
  method,
  className,
}: BaseProps & { method: AgentMethod }): JSX.Element {
  return (
    <span
      className={cn(BASE_CLASS, AGENT_METHOD_CLASS[method], className)}
      aria-label={`agent-method-${method}`}
    >
      {AGENT_METHOD_LABELS[method]}
    </span>
  );
}

export const statusLabels = {
  task: TASK_STATUS_LABELS,
  agent: AGENT_STATUS_LABELS,
  method: AGENT_METHOD_LABELS,
};
