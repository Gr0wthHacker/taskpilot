/**
 * Compact task card used across the inbox, board, and derivative trees.
 *
 * Visual contract:
 *  - Left color stripe encodes priority (p0=red, p1=orange, p2=zinc, p3=blue).
 *  - Title truncated to 2 lines; full title in `title` attribute for hover.
 *  - Priority badge, relative due date, agent-method icon, tag chips.
 *  - When `compact` is true the card omits tags and description hints.
 *
 * Every card carries a stable `aria-label` of the form `task-card-${task.id}`
 * so Cowork can target individual cards.
 */

import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { BellOff, Bot, CalendarClock, DollarSign, User } from 'lucide-react';
import { memo } from 'react';
import type { HTMLAttributes, KeyboardEvent, MouseEvent } from 'react';

import {
  PRIORITY_BORDER,
  PriorityBadge,
} from '@/renderer/components/shared/PriorityPicker';
import { PhaseBadge } from '@/renderer/components/shared/PhaseBadge';
import { CompletionSummary } from '@/renderer/components/shared/CompletionSummary';
import { useTaskCost } from '@/renderer/lib/query';
import { getSnoozedUntil, isSnoozed } from '@/renderer/lib/snooze';
import { cn } from '@/renderer/lib/utils';
import type { AgentMethod, Task } from '@/shared/types';

/**
 * Pull the phase id off a task's context if present. Stored at
 * `task.context.phase` by the phase model (Wave 15). We only show the badge
 * by id here — full {@link PhaseDefinition} resolution requires the
 * pipeline catalog and lives in {@link PhasePicker}.
 */
function readPhaseId(task: Task): string | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)['phase'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export interface TaskCardProps {
  task: Task;
  onClick?: (task: Task) => void;
  selected?: boolean;
  compact?: boolean;
  className?: string;
  /**
   * Dropped onto the card so the card itself can be the drag handle in
   * sortable contexts. Kept generic on purpose — `@dnd-kit` isn't an
   * approved dep, so callers spread native pointer handlers here.
   */
  dragHandleProps?: HTMLAttributes<HTMLDivElement>;
  /**
   * Right-side action slot — rendered as a small row at the top right of the
   * card. Use this for hover-only quick actions (derive, reorder).
   */
  actions?: React.ReactNode;
  /**
   * When true, fetch and show the task's accrued cost as a chip. Opt-in so
   * list views don't fire a cost request per card unless they want it — best
   * reserved for bounded, agent-focused lists (cowork queue, agent control).
   */
  showCost?: boolean;
}

function formatCost(total: number): string {
  if (total <= 0) return '';
  if (total < 0.01) return '<$0.01';
  return `$${total.toFixed(2)}`;
}

function formatDue(due: string | null): string | null {
  if (!due) return null;
  try {
    const parsed = parseISO(due);
    if (Number.isNaN(parsed.getTime())) return due;
    const now = Date.now();
    const ts = parsed.getTime();
    const distance = formatDistanceToNowStrict(parsed, { addSuffix: true });
    const overdue = ts < now;
    return overdue ? `due ${distance}` : `in ${distance.replace(/^in /, '')}`;
  } catch {
    return due;
  }
}

function methodIcon(method: AgentMethod): JSX.Element {
  if (method === 'human_only') {
    return <User className="h-3 w-3" aria-label="agent-method-human" />;
  }
  return <Bot className="h-3 w-3" aria-label="agent-method-bot" />;
}

function TaskCardImpl({
  task,
  onClick,
  selected,
  compact,
  className,
  dragHandleProps,
  actions,
  showCost,
}: TaskCardProps): JSX.Element {
  const dueLabel = formatDue(task.due);
  const overdue =
    task.due !== null && new Date(task.due).getTime() < Date.now();
  const costQ = useTaskCost(task.id, Boolean(showCost));
  const costLabel = showCost ? formatCost(costQ.data ?? 0) : '';
  const snoozed = isSnoozed(task);
  const snoozeLabel = snoozed ? formatDue(getSnoozedUntil(task)) : null;

  const handleClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (!onClick) return;
    // Don't trigger when clicking action buttons inside the card.
    const target = e.target as HTMLElement;
    if (target.closest('[data-card-action]')) return;
    onClick(task);
  };

  const handleKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(task);
    }
  };

  return (
    <div
      {...dragHandleProps}
      onClick={handleClick}
      onKeyDown={handleKey}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : -1}
      aria-label={`task-card-${task.id}`}
      title={task.title}
      className={cn(
        'group relative flex w-full items-stretch overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm transition-colors',
        onClick &&
          'cursor-pointer hover:border-primary/40 hover:bg-accent/40 focus:outline-none focus:ring-2 focus:ring-ring',
        selected && 'border-primary ring-1 ring-primary',
        className,
      )}
    >
      <div
        className={cn('w-1 shrink-0', PRIORITY_BORDER[task.priority])}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div
            className={cn(
              'min-w-0 text-sm font-medium leading-snug',
              'line-clamp-2',
            )}
          >
            {task.title}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-1" data-card-action>
              {actions}
            </div>
          )}
        </div>

        {!compact && <CompletionSummary task={task} />}

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <PriorityBadge priority={task.priority} />
          {(() => {
            const phaseId = readPhaseId(task);
            if (!phaseId) return null;
            return <PhaseBadge phase={phaseId} />;
          })()}
          {dueLabel && (
            <span
              className={cn(
                'inline-flex items-center gap-1',
                overdue && 'text-red-600 dark:text-red-400',
              )}
              aria-label={`task-due-${task.id}`}
            >
              <CalendarClock className="h-3 w-3" />
              {dueLabel}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1"
            aria-label={`task-agent-${task.agent_method}`}
          >
            {methodIcon(task.agent_method)}
            <span className="text-[10px] uppercase tracking-wide">
              {task.agent_method.replace('_', ' ')}
            </span>
          </span>
          {costLabel && (
            <span
              className="inline-flex items-center gap-0.5 tabular-nums"
              aria-label={`task-cost-${task.id}`}
              title="Accrued agent cost"
            >
              <DollarSign className="h-3 w-3" />
              {costLabel.replace(/^\$/, '')}
            </span>
          )}
          {snoozeLabel && (
            <span
              className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"
              aria-label={`task-snoozed-${task.id}`}
              title="Snoozed — hidden from default lists until this time"
            >
              <BellOff className="h-3 w-3" />
              {snoozeLabel.replace(/^(due|in) /, '')}
            </span>
          )}
        </div>

        {!compact && task.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {task.tags.slice(0, 6).map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
              >
                #{tag}
              </span>
            ))}
            {task.tags.length > 6 && (
              <span className="text-[10px] text-muted-foreground">
                +{task.tags.length - 6}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized so a card only re-renders when its own props change — not when a
 * sibling's selection toggles or a parent list re-renders for an unrelated
 * reason. List surfaces render hundreds of these; the default shallow prop
 * compare keeps scroll/selection interactions cheap. (Callers that pass inline
 * `onClick`/`actions` closures still re-render, but virtualized lists only
 * mount a handful of rows at a time, so the cost stays bounded.)
 */
export const TaskCard = memo(TaskCardImpl);
