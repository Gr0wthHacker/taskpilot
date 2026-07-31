/**
 * Calendar — week-view (default), 3-day, or day grid.
 *
 * Left toolbar:
 *  - Prev / Today / Next
 *  - Week label
 *  - View-mode toggle (week / 3day / day)
 *
 * Grid:
 *  - Column per day, hour rows 7am–8pm.
 *  - Events absolutely positioned by start/end minutes.
 *  - Tasks with `due` in range are surfaced as small chips at the top of
 *    the relevant day column.
 *  - Drag a task chip onto an hour slot → schedule confirmation dialog →
 *    PATCH task with new `due` ISO. The server is expected to push the
 *    update to Google Calendar via the existing sync path.
 *  - Click an event → side panel with details + "Open Task" deep link.
 */

import {
  addDays,
  addWeeks,
  differenceInMinutes,
  endOfDay,
  format,
  isSameDay,
  parseISO,
  startOfDay,
  startOfWeek,
} from 'date-fns';
import {
  CalendarCheck,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  CalendarEventBlock,
  isAgentEvent,
} from '@/renderer/components/shared/CalendarEventBlock';
import { TASK_DRAG_MIME } from '@/renderer/components/shared/TimeSlot';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useCalendarEvents,
  useScheduleTask,
  useTask,
  useTasksList,
  useUpdateTask,
} from '@/renderer/lib/query';
import { getErrorCode } from '@/renderer/lib/api';
import { safeParseISO as safeParse } from '@/renderer/lib/date';
import { cn } from '@/renderer/lib/utils';
import {
  applyWorkspaceFilter,
  useActiveWorkspace,
} from '@/renderer/store/workspace';
import type { CalendarEvent } from '@/shared/api-contract';
import type { Task } from '@/shared/types';

type ViewMode = 'week' | '3day' | 'day';

const HOUR_START = 7;
const HOUR_END = 20; // exclusive
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
const SLOT_HEIGHT_PX = 56;
const HEADER_HEIGHT_PX = 56;

function rangeForMode(anchor: Date, mode: ViewMode): { from: Date; to: Date; days: Date[] } {
  if (mode === 'week') {
    const start = startOfWeek(anchor, { weekStartsOn: 1 });
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    return { from: startOfDay(start), to: endOfDay(addDays(start, 6)), days };
  }
  if (mode === '3day') {
    const start = startOfDay(anchor);
    const days = [start, addDays(start, 1), addDays(start, 2)];
    return { from: start, to: endOfDay(addDays(start, 2)), days };
  }
  const start = startOfDay(anchor);
  return { from: start, to: endOfDay(start), days: [start] };
}


function minutesFromGridTop(d: Date): number {
  return (d.getHours() - HOUR_START) * 60 + d.getMinutes();
}

interface PositionedEvent {
  event: CalendarEvent;
  topPx: number;
  heightPx: number;
}

function positionEventsForDay(events: CalendarEvent[], day: Date): PositionedEvent[] {
  const out: PositionedEvent[] = [];
  for (const evt of events) {
    const start = safeParse(evt.start);
    const end = safeParse(evt.end);
    if (!start || !end) continue;
    if (!isSameDay(start, day) && !isSameDay(end, day)) continue;
    const clampedStart = isSameDay(start, day) ? start : startOfDay(day);
    const clampedEnd = isSameDay(end, day) ? end : endOfDay(day);
    const startMin = Math.max(0, minutesFromGridTop(clampedStart));
    const endMin = Math.min(
      (HOUR_END - HOUR_START) * 60,
      minutesFromGridTop(clampedEnd),
    );
    if (endMin <= 0 || startMin >= (HOUR_END - HOUR_START) * 60) continue;
    const durationMin = Math.max(20, endMin - startMin);
    out.push({
      event: evt,
      topPx: (startMin / 60) * SLOT_HEIGHT_PX,
      heightPx: (durationMin / 60) * SLOT_HEIGHT_PX,
    });
  }
  return out;
}

function tasksForDay(tasks: Task[], day: Date): Task[] {
  return tasks.filter((t) => {
    if (!t.due) return false;
    const parsed = safeParse(t.due);
    if (!parsed) return false;
    return isSameDay(parsed, day);
  });
}

function setTaskDueAtSlot(slotStart: Date, originalDue: string | null): string {
  // Preserve any explicit minutes the task already had if its original due
  // time is in the same hour as the drop. Otherwise pin to the slot's
  // top-of-hour. This keeps the UX predictable while letting careful users
  // refine minute-of-hour from the detail view.
  if (originalDue) {
    const existing = safeParse(originalDue);
    if (existing) {
      const sameHourDrop = new Date(slotStart);
      sameHourDrop.setMinutes(existing.getMinutes(), 0, 0);
      return sameHourDrop.toISOString();
    }
  }
  return slotStart.toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Calendar view                                                             */
/* -------------------------------------------------------------------------- */

interface PendingDrop {
  task: Task;
  slotStart: Date;
}

export default function Calendar(): JSX.Element {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [mode, setMode] = useState<ViewMode>('week');
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);

  const range = useMemo(() => rangeForMode(anchor, mode), [anchor, mode]);

  const eventsQ = useCalendarEvents({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  });
  const tasksQ = useTasksList({});

  const updateTask = useUpdateTask();
  const scheduleTask = useScheduleTask();
  const activeWorkspace = useActiveWorkspace();

  const events = eventsQ.data?.events ?? [];
  const allTasks = tasksQ.data?.tasks ?? [];

  const tasksWithDueInRange = useMemo(() => {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const inRange = allTasks.filter((t) => {
      if (!t.due) return false;
      const parsed = safeParse(t.due);
      if (!parsed) return false;
      const ms = parsed.getTime();
      return ms >= fromMs && ms <= toMs;
    });
    return applyWorkspaceFilter(inRange, activeWorkspace);
  }, [allTasks, range.from, range.to, activeWorkspace]);

  const calendarNotConnected =
    eventsQ.isError &&
    (() => {
      const err = eventsQ.error;
      if (!err) return false;
      const maybeBody = (err as unknown as { body?: unknown }).body;
      if (getErrorCode(maybeBody) === 'calendar_not_initialized') return true;
      return /calendar_not_initialized|not.*authenticated/i.test(err.message);
    })();

  const stepDays = mode === 'week' ? 7 : mode === '3day' ? 3 : 1;

  const goPrev = (): void => {
    if (mode === 'week') setAnchor((a) => addWeeks(a, -1));
    else setAnchor((a) => addDays(a, -stepDays));
  };
  const goNext = (): void => {
    if (mode === 'week') setAnchor((a) => addWeeks(a, 1));
    else setAnchor((a) => addDays(a, stepDays));
  };
  const goToday = (): void => setAnchor(startOfDay(new Date()));

  const handleDropTask = (taskId: string, slotStart: Date): void => {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) {
      toast({
        title: 'Drop failed',
        description: `Task ${taskId} not found in current list`,
        variant: 'destructive',
      });
      return;
    }
    setPendingDrop({ task, slotStart });
  };

  const confirmDrop = async (): Promise<void> => {
    if (!pendingDrop) return;
    const { task, slotStart } = pendingDrop;
    const nextDue = setTaskDueAtSlot(slotStart, task.due);
    try {
      await updateTask.mutateAsync({
        id: task.id,
        patch: { due: nextDue },
      });

      // Create a real calendar time-block for tasks not yet linked to an
      // event. Re-scheduling an already-linked task flows through the
      // due → calendar sync path, so we avoid spawning a duplicate event.
      let blocked = false;
      if (!task.calendar_event_id) {
        try {
          await scheduleTask.mutateAsync({
            id: task.id,
            body: { start: nextDue },
          });
          blocked = true;
        } catch {
          // Calendar not connected / unavailable — the due is still set.
        }
      }

      const when = format(parseISO(nextDue), 'EEE MMM d, h:mm a');
      toast(
        blocked
          ? {
              title: 'Scheduled',
              description: `${task.title} blocked on your calendar at ${when}`,
            }
          : task.calendar_event_id
            ? { title: 'Rescheduled', description: `${task.title} → ${when}` }
            : {
                title: 'Due set',
                description: `${task.title} → ${when}. Connect Google Calendar to create a time block.`,
              },
      );
      setPendingDrop(null);
    } catch (cause) {
      toast({
        title: 'Schedule failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const weekLabel = useMemo(() => {
    const first = range.days[0];
    const last = range.days[range.days.length - 1];
    if (!first || !last) return '';
    if (mode === 'day') return format(first, 'EEEE, MMMM d, yyyy');
    if (isSameDay(first, last)) return format(first, 'MMMM d, yyyy');
    if (first.getMonth() === last.getMonth()) {
      return `${format(first, 'MMM d')} – ${format(last, 'd, yyyy')}`;
    }
    return `${format(first, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`;
  }, [range.days, mode]);

  const showEmpty =
    !eventsQ.isLoading &&
    !eventsQ.isError &&
    events.length === 0 &&
    tasksWithDueInRange.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-calendar">
      <header className="flex flex-col gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Calendar</h1>
            <span className="text-xs text-muted-foreground">{weekLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => navigate('/plan')}
              aria-label="calendar-plan-my-day"
            >
              <CalendarCheck className="mr-1 h-4 w-4" />
              Plan my day
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={goPrev}
              aria-label="calendar-prev"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={goToday}
              aria-label="calendar-today"
            >
              Today
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={goNext}
              aria-label="calendar-next"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => {
                void eventsQ.refetch();
                void tasksQ.refetch();
              }}
              aria-label="calendar-refresh"
            >
              <RefreshCw
                className={cn('h-4 w-4', eventsQ.isFetching && 'animate-spin')}
              />
            </Button>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as ViewMode)}
            >
              <SelectTrigger
                className="h-8 w-[120px] text-xs"
                aria-label="calendar-view-mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="week">Week</SelectItem>
                <SelectItem value="3day">3 days</SelectItem>
                <SelectItem value="day">Day</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="relative flex-1 overflow-auto">
          {calendarNotConnected && (
            <div
              role="alert"
              className="m-4 rounded-md border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
              aria-label="calendar-not-connected"
            >
              Google Calendar isn’t connected. Open{' '}
              <Link to="/settings" className="underline">
                Settings → Calendar
              </Link>{' '}
              to connect.
            </div>
          )}

          {eventsQ.isLoading && (
            <div className="p-6 text-sm text-muted-foreground">Loading events…</div>
          )}

          {showEmpty && (
            <div
              className="mt-16 flex flex-col items-center justify-center gap-2 text-center"
              aria-label="calendar-empty"
            >
              <div className="rounded-full border border-dashed border-border p-4">
                <CalendarRange className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No events.</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {calendarNotConnected
                  ? 'Calendar may not be authenticated — check Settings.'
                  : 'Nothing scheduled in this window. Drag a task onto a day to schedule it.'}
              </p>
            </div>
          )}

          {!eventsQ.isLoading && !showEmpty && (
            <CalendarGrid
              days={range.days}
              events={events}
              tasksWithDue={tasksWithDueInRange}
              onEventClick={setSelectedEvent}
              onDropTask={handleDropTask}
              onTaskChipClick={(t) => navigate(`/task/${t.id}`)}
            />
          )}
        </div>

        {selectedEvent && (
          <EventSidePanel
            event={selectedEvent}
            onClose={() => setSelectedEvent(null)}
          />
        )}
      </div>

      <Dialog
        open={pendingDrop !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDrop(null);
        }}
      >
        <DialogContent aria-label="calendar-schedule-dialog">
          <DialogHeader>
            <DialogTitle>Schedule task</DialogTitle>
            <DialogDescription>
              {pendingDrop && (
                <>
                  Schedule{' '}
                  <span className="font-medium">{pendingDrop.task.title}</span>{' '}
                  at{' '}
                  <span className="font-medium">
                    {(() => {
                      // setTaskDueAtSlot preserves the minute portion of the
                      // existing due when present, so the display time can
                      // differ from the slot's :00 anchor. Format the
                      // resolved due so the dialog matches what we'll save.
                      const resolved = setTaskDueAtSlot(
                        pendingDrop.slotStart,
                        pendingDrop.task.due,
                      );
                      return format(parseISO(resolved), 'EEE MMM d, h:mm a');
                    })()}
                  </span>
                  ?
                </>
              )}
            </DialogDescription>
            {pendingDrop &&
              (() => {
                const existing = pendingDrop.task.due
                  ? safeParse(pendingDrop.task.due)
                  : null;
                if (!existing || existing.getMinutes() === 0) return null;
                return (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    aria-label="calendar-schedule-minute-hint"
                  >
                    Minute kept from existing due (:
                    {existing.getMinutes().toString().padStart(2, '0')}).
                  </p>
                );
              })()}
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingDrop(null)}
              aria-label="calendar-schedule-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void confirmDrop();
              }}
              disabled={updateTask.isPending || scheduleTask.isPending}
              aria-label="calendar-schedule-confirm"
            >
              {updateTask.isPending || scheduleTask.isPending
                ? 'Scheduling…'
                : 'Schedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Grid                                                                       */
/* -------------------------------------------------------------------------- */

interface CalendarGridProps {
  days: Date[];
  events: CalendarEvent[];
  tasksWithDue: Task[];
  onEventClick: (event: CalendarEvent) => void;
  onDropTask: (taskId: string, slotStart: Date) => void;
  onTaskChipClick: (task: Task) => void;
}

function CalendarGrid({
  days,
  events,
  tasksWithDue,
  onEventClick,
  onDropTask,
  onTaskChipClick,
}: CalendarGridProps): JSX.Element {
  const gridHeight = HOURS.length * SLOT_HEIGHT_PX;

  return (
    <div className="min-w-[720px]">
      <div className="flex border-b border-border bg-background sticky top-0 z-10">
        <div
          className="w-14 shrink-0 border-r border-border"
          style={{ height: HEADER_HEIGHT_PX }}
        />
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={cn(
              'flex-1 border-r border-border px-2 py-2 text-center last:border-r-0',
              isSameDay(day, new Date()) && 'bg-primary/5',
            )}
            aria-label={`calendar-day-header-${format(day, 'yyyy-MM-dd')}`}
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {format(day, 'EEE')}
            </div>
            <div
              className={cn(
                'text-lg font-semibold',
                isSameDay(day, new Date()) && 'text-primary',
              )}
            >
              {format(day, 'd')}
            </div>
          </div>
        ))}
      </div>

      <div className="flex">
        <div className="w-14 shrink-0 border-r border-border">
          {HOURS.map((h) => (
            <div
              key={h}
              className="border-b border-border/60 px-1 py-1 text-right text-[10px] uppercase tracking-wide text-muted-foreground"
              style={{ height: SLOT_HEIGHT_PX }}
            >
              {format(new Date(2020, 0, 1, h), 'h a')}
            </div>
          ))}
        </div>

        {days.map((day) => {
          const positioned = positionEventsForDay(events, day);
          const dayTasks = tasksForDay(tasksWithDue, day);
          return (
            <DayColumn
              key={day.toISOString()}
              day={day}
              gridHeight={gridHeight}
              positioned={positioned}
              dayTasks={dayTasks}
              onEventClick={onEventClick}
              onDropTask={onDropTask}
              onTaskChipClick={onTaskChipClick}
            />
          );
        })}
      </div>
    </div>
  );
}

interface DayColumnProps {
  day: Date;
  gridHeight: number;
  positioned: PositionedEvent[];
  dayTasks: Task[];
  onEventClick: (event: CalendarEvent) => void;
  onDropTask: (taskId: string, slotStart: Date) => void;
  onTaskChipClick: (task: Task) => void;
}

function DayColumn({
  day,
  gridHeight,
  positioned,
  dayTasks,
  onEventClick,
  onDropTask,
  onTaskChipClick,
}: DayColumnProps): JSX.Element {
  return (
    <div
      className={cn(
        'relative flex-1 border-r border-border last:border-r-0',
        isSameDay(day, new Date()) && 'bg-primary/5',
      )}
      aria-label={`calendar-day-${format(day, 'yyyy-MM-dd')}`}
      style={{ minHeight: gridHeight }}
    >
      {dayTasks.length > 0 && (
        <div
          className="flex flex-wrap gap-1 border-b border-border/60 bg-background/80 p-1"
          aria-label={`calendar-day-task-chips-${format(day, 'yyyy-MM-dd')}`}
        >
          {dayTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              draggable
              onDragStart={(e) => {
                const payload = JSON.stringify({ kind: 'task', id: task.id });
                e.dataTransfer.setData(TASK_DRAG_MIME, payload);
                e.dataTransfer.setData('text/plain', payload);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onTaskChipClick(task)}
              className="max-w-full truncate rounded-md border border-emerald-500/60 bg-emerald-100/70 px-1.5 py-0.5 text-[10px] text-emerald-900 hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-ring dark:bg-emerald-900/30 dark:text-emerald-100"
              aria-label={`calendar-task-chip-${task.id}`}
              title={task.title}
            >
              {task.title}
            </button>
          ))}
        </div>
      )}

      <div className="relative" style={{ height: gridHeight }}>
        {HOURS.map((h) => (
          <DropSlot
            key={h}
            day={day}
            hour={h}
            onDropTask={onDropTask}
          />
        ))}

        {positioned.map(({ event, topPx, heightPx }) => (
          <CalendarEventBlock
            key={event.id}
            event={event}
            onClick={onEventClick}
            compact={heightPx < 48}
            style={{
              position: 'absolute',
              left: 4,
              right: 4,
              top: topPx,
              height: heightPx,
              zIndex: isAgentEvent(event) ? 2 : 1,
            }}
          />
        ))}
      </div>
    </div>
  );
}

interface DropSlotProps {
  day: Date;
  hour: number;
  onDropTask: (taskId: string, slotStart: Date) => void;
}

function DropSlot({ day, hour, onDropTask }: DropSlotProps): JSX.Element {
  const [over, setOver] = useState(false);

  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!over) setOver(true);
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const direct = e.dataTransfer.getData(TASK_DRAG_MIME);
        const fallback = e.dataTransfer.getData('text/plain');
        const raw = direct || fallback;
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { kind: string; id: string };
          if (parsed.kind === 'task' && parsed.id) {
            const slotStart = new Date(day);
            slotStart.setHours(hour, 0, 0, 0);
            onDropTask(parsed.id, slotStart);
          }
        } catch {
          // ignored
        }
      }}
      aria-label={`calendar-drop-slot-${format(day, 'yyyy-MM-dd')}-${hour}`}
      className={cn(
        'border-b border-border/40 transition-colors',
        over && 'bg-primary/10',
      )}
      style={{ height: SLOT_HEIGHT_PX }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Side panel                                                                */
/* -------------------------------------------------------------------------- */

interface EventSidePanelProps {
  event: CalendarEvent;
  onClose: () => void;
}

function EventSidePanel({ event, onClose }: EventSidePanelProps): JSX.Element {
  const linkedTaskId = event.task_id ?? null;
  const linkedTaskQ = useTask(linkedTaskId);
  const linkedTask = linkedTaskQ.data?.task;

  const start = safeParse(event.start);
  const end = safeParse(event.end);
  const agent = isAgentEvent(event);

  return (
    <aside
      className="w-[320px] shrink-0 overflow-auto border-l border-border bg-background p-4"
      aria-label="calendar-event-panel"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold leading-tight">{event.summary}</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label="calendar-event-panel-close"
        >
          Close
        </Button>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        {start && end && (
          <div>
            {format(start, 'EEE MMM d, h:mm a')} –{' '}
            {isSameDay(start, end) ? format(end, 'h:mm a') : format(end, 'MMM d, h:mm a')}
            <span className="ml-1">
              ({Math.max(1, differenceInMinutes(end, start))} min)
            </span>
          </div>
        )}
        {event.calendar_id && (
          <div className="mt-0.5">Calendar: {event.calendar_id}</div>
        )}
      </div>

      {agent && (
        <div
          className="mt-3 inline-flex items-center rounded-md bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-900 dark:bg-violet-900/30 dark:text-violet-100"
          aria-label="calendar-event-agent-work"
        >
          Agent Work
        </div>
      )}

      {event.description && (
        <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs">
          {event.description}
        </div>
      )}

      {event.attendees && event.attendees.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Attendees
          </div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {event.attendees.map((a) => (
              <li key={a} className="truncate">
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        {linkedTaskId ? (
          linkedTaskQ.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading task…</div>
          ) : linkedTask ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Linked task
              </div>
              <div className="mt-1 text-sm font-medium">{linkedTask.title}</div>
              <Link
                to={`/task/${linkedTask.id}`}
                className="mt-2 inline-flex items-center gap-1 text-xs text-primary underline"
                aria-label="calendar-event-open-task"
              >
                Open task
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Task {linkedTaskId} not found locally.
            </div>
          )
        ) : (
          <div className="text-xs text-muted-foreground">
            No TaskPilot task linked to this event.
          </div>
        )}
      </div>
    </aside>
  );
}
