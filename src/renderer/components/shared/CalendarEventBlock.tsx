/**
 * Reusable visual block for a single calendar event.
 *
 * Used by the Calendar week-view and the Daily Plan timeline. Caller is
 * responsible for absolute positioning (top/height) via the `style` prop —
 * this component only renders the inner chrome (title, time, badges).
 *
 * "Agent Work" events (events linked to a TaskPilot task via `task_id`) are
 * styled with a dashed border and a bot icon so they're visually distinct
 * from regular human-owned events.
 */

import { format, parseISO } from 'date-fns';
import { Bot, Link2 } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';

import { cn } from '@/renderer/lib/utils';
import type { CalendarEvent } from '@/shared/api-contract';

export interface CalendarEventBlockProps {
  event: CalendarEvent;
  onClick?: (event: CalendarEvent) => void;
  style?: CSSProperties;
  className?: string;
  /** When true, renders a denser version for narrow columns. */
  compact?: boolean;
}

/**
 * An event is considered "Agent Work" when it carries a `task_id` link back
 * to a TaskPilot task. The server is expected to populate this field from
 * the Google extendedProperties.private.taskpilot_task_id key.
 */
export function isAgentEvent(event: CalendarEvent): boolean {
  return Boolean(event.task_id);
}

function safeFormat(iso: string, fmt: string): string {
  try {
    const parsed = parseISO(iso);
    if (Number.isNaN(parsed.getTime())) return iso;
    return format(parsed, fmt);
  } catch {
    return iso;
  }
}

export function CalendarEventBlock({
  event,
  onClick,
  style,
  className,
  compact,
}: CalendarEventBlockProps): JSX.Element {
  const agent = isAgentEvent(event);

  const handleClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (!onClick) return;
    e.stopPropagation();
    onClick(event);
  };

  const handleKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(event);
    }
  };

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKey}
      aria-label={`calendar-event-${event.id}`}
      title={event.summary}
      style={style}
      className={cn(
        'overflow-hidden rounded-md px-2 py-1 text-[11px] leading-tight shadow-sm transition-colors',
        agent
          ? 'border-2 border-dashed border-violet-500/70 bg-violet-100/70 text-violet-900 dark:bg-violet-900/30 dark:text-violet-100'
          : 'border border-blue-500/60 bg-blue-100/80 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100',
        onClick &&
          'cursor-pointer hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-ring dark:hover:brightness-110',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 truncate font-medium">{event.summary}</div>
        {agent && (
          <Bot
            className="h-3 w-3 shrink-0 opacity-80"
            aria-label="event-agent-work"
          />
        )}
        {!agent && event.task_id === null && (
          <Link2
            className="h-3 w-3 shrink-0 opacity-50"
            aria-hidden="true"
          />
        )}
      </div>
      {!compact && (
        <div className="mt-0.5 truncate text-[10px] opacity-80">
          {safeFormat(event.start, 'h:mm a')} – {safeFormat(event.end, 'h:mm a')}
        </div>
      )}
    </div>
  );
}
