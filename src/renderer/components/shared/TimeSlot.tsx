/**
 * One hour-cell in the Calendar week view or the Daily Plan timeline.
 *
 * Acts as a drop target for tasks dragged from a TaskCard list. The drag
 * payload is a JSON object `{ kind: 'task', id: string }` stored on the
 * `application/x-taskpilot-task` mime type (falling back to `text/plain`
 * for browsers that block custom types).
 *
 * Visual layering:
 *  - The slot itself renders the hour gridline + drop highlight.
 *  - Events are positioned absolutely inside the column the caller owns —
 *    this slot only renders content the caller passes via children/events/tasks
 *    when used as a simple per-hour list (Daily Plan style).
 */

import { format } from 'date-fns';
import type { DragEvent, ReactNode } from 'react';
import { useState } from 'react';

import { CalendarEventBlock } from '@/renderer/components/shared/CalendarEventBlock';
import { cn } from '@/renderer/lib/utils';
import type { CalendarEvent } from '@/shared/api-contract';
import type { Task } from '@/shared/types';

export const TASK_DRAG_MIME = 'application/x-taskpilot-task';

export interface DroppedTaskPayload {
  kind: 'task';
  id: string;
}

export interface TimeSlotProps {
  /** The day this slot belongs to (start-of-day). */
  date: Date;
  /** 24h hour [0–23]. */
  hour: number;
  events?: CalendarEvent[];
  tasks?: Task[];
  onEventClick?: (event: CalendarEvent) => void;
  onTaskClick?: (task: Task) => void;
  onDropTask?: (taskId: string, slotStart: Date) => void;
  /** Optional content rendered alongside any auto-rendered events/tasks. */
  children?: ReactNode;
  className?: string;
  /** When true (default) shows the hour label on the left. */
  showLabel?: boolean;
  /** Density: `'compact'` for week view, `'comfortable'` for Daily Plan. */
  density?: 'compact' | 'comfortable';
}

function slotStartFor(date: Date, hour: number): Date {
  const next = new Date(date);
  next.setHours(hour, 0, 0, 0);
  return next;
}

function readDragPayload(e: DragEvent<HTMLDivElement>): string | null {
  const direct = e.dataTransfer.getData(TASK_DRAG_MIME);
  if (direct) {
    try {
      const parsed = JSON.parse(direct) as DroppedTaskPayload;
      if (parsed.kind === 'task' && typeof parsed.id === 'string') {
        return parsed.id;
      }
    } catch {
      // fall through
    }
  }
  const fallback = e.dataTransfer.getData('text/plain');
  if (fallback) {
    try {
      const parsed = JSON.parse(fallback) as DroppedTaskPayload;
      if (parsed.kind === 'task' && typeof parsed.id === 'string') {
        return parsed.id;
      }
    } catch {
      // last-ditch: treat the string itself as a task id
      if (fallback.startsWith('task:')) {
        return fallback.slice('task:'.length);
      }
    }
  }
  return null;
}

export function TimeSlot({
  date,
  hour,
  events,
  tasks,
  onEventClick,
  onTaskClick,
  onDropTask,
  children,
  className,
  showLabel = true,
  density = 'comfortable',
}: TimeSlotProps): JSX.Element {
  const [over, setOver] = useState(false);
  const slotStart = slotStartFor(date, hour);
  const hourLabel = format(slotStart, 'h a');

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!onDropTask) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!over) setOver(true);
  };

  const handleDragLeave = (): void => {
    if (over) setOver(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!onDropTask) return;
    e.preventDefault();
    setOver(false);
    const taskId = readDragPayload(e);
    if (taskId) onDropTask(taskId, slotStart);
  };

  return (
    <div
      className={cn(
        'group flex border-b border-border/60 transition-colors',
        density === 'compact' ? 'min-h-[44px]' : 'min-h-[64px]',
        over && 'bg-primary/10 ring-1 ring-inset ring-primary/40',
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label={`time-slot-${format(slotStart, 'yyyy-MM-dd-HH')}`}
      data-slot-iso={slotStart.toISOString()}
    >
      {showLabel && (
        <div
          className={cn(
            'shrink-0 select-none border-r border-border/60 px-2 py-1 text-right text-[10px] uppercase tracking-wide text-muted-foreground',
            density === 'compact' ? 'w-12' : 'w-16',
          )}
        >
          {hourLabel}
        </div>
      )}
      <div className="relative flex-1 px-1.5 py-1">
        {children}
        {events && events.length > 0 && (
          <div className="flex flex-col gap-1">
            {events.map((evt) => (
              <CalendarEventBlock
                key={evt.id}
                event={evt}
                onClick={onEventClick}
                compact={density === 'compact'}
              />
            ))}
          </div>
        )}
        {tasks && tasks.length > 0 && (
          <ul
            className="mt-1 flex flex-col gap-1"
            aria-label={`time-slot-tasks-${format(slotStart, 'yyyy-MM-dd-HH')}`}
          >
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => onTaskClick?.(task)}
                  className="w-full truncate rounded-md border border-dashed border-emerald-500/60 bg-emerald-100/70 px-2 py-1 text-left text-[11px] text-emerald-900 hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-ring dark:bg-emerald-900/30 dark:text-emerald-100 dark:hover:brightness-110"
                  aria-label={`time-slot-task-${task.id}`}
                  title={task.title}
                >
                  <span className="font-medium">{task.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
