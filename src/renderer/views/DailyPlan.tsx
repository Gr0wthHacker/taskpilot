/**
 * Daily Plan — today-focused synthesis.
 *
 * Left column (60%): hour-by-hour timeline 7am–8pm. Events fall into their
 * slot; tasks with `due` today appear in their respective slots.
 *
 * Right column (40%): pending tasks pane.
 *  - Due today
 *  - Overdue (due < today AND status not in {done, failed})
 *  - Top priority (p0/p1 in {inbox, queued})
 *  Each item is a draggable TaskCard. Drop onto the timeline to schedule.
 *
 * Top bar: date label, prev/next day arrows, refresh, "Batch queue agent
 * tasks" → POST /api/tasks/:id/execute for every today/queued/agent_executable
 * task in parallel with progress toast.
 */

import {
  addDays,
  endOfDay,
  format,
  isSameDay,
  parseISO,
  startOfDay,
} from 'date-fns';
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Flame,
  RefreshCw,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { DailyPlanGenerator } from '@/renderer/components/DailyPlanGenerator';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import {
  TASK_DRAG_MIME,
  TimeSlot,
} from '@/renderer/components/shared/TimeSlot';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { useToast } from '@/renderer/components/ui/use-toast';
import { api } from '@/renderer/lib/api';
import { safeParseISO as safeParse } from '@/renderer/lib/date';
import {
  useCalendarEvents,
  useScheduleTask,
  useTasksList,
  useUpdateTask,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { CalendarEvent } from '@/shared/api-contract';
import type { Task } from '@/shared/types';

const HOUR_START = 7;
const HOUR_END = 20;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);


function eventsInHour(events: CalendarEvent[], day: Date, hour: number): CalendarEvent[] {
  return events.filter((e) => {
    const start = safeParse(e.start);
    if (!start) return false;
    if (!isSameDay(start, day)) return false;
    return start.getHours() === hour;
  });
}

function tasksInHour(tasks: Task[], day: Date, hour: number): Task[] {
  return tasks.filter((t) => {
    if (!t.due) return false;
    const due = safeParse(t.due);
    if (!due) return false;
    return isSameDay(due, day) && due.getHours() === hour;
  });
}

function isOverdue(task: Task, refStartOfToday: Date): boolean {
  if (!task.due) return false;
  if (task.status === 'done' || task.status === 'failed') return false;
  const due = safeParse(task.due);
  if (!due) return false;
  return due.getTime() < refStartOfToday.getTime();
}

interface PendingDrop {
  task: Task;
  slotStart: Date;
}

export default function DailyPlan(): JSX.Element {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);

  const range = useMemo(
    () => ({ from: startOfDay(day), to: endOfDay(day) }),
    [day],
  );

  const eventsQ = useCalendarEvents({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  });
  const tasksQ = useTasksList({});
  const updateTask = useUpdateTask();
  const scheduleTask = useScheduleTask();

  const events = eventsQ.data?.events ?? [];
  const tasks = tasksQ.data?.tasks ?? [];

  const tasksDueToday = useMemo(
    () => tasks.filter((t) => t.due && isSameDay(parseISO(t.due), day)),
    [tasks, day],
  );

  const tasksOverdue = useMemo(() => {
    const ref = startOfDay(day);
    return tasks
      .filter((t) => isOverdue(t, ref))
      .sort((a, b) =>
        (a.due ?? '').localeCompare(b.due ?? ''),
      );
  }, [tasks, day]);

  const tasksTopPriority = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            (t.priority === 'p0' || t.priority === 'p1') &&
            (t.status === 'inbox' || t.status === 'queued'),
        )
        .sort((a, b) => {
          if (a.priority === b.priority) {
            return (a.due ?? 'z').localeCompare(b.due ?? 'z');
          }
          return a.priority < b.priority ? -1 : 1;
        }),
    [tasks],
  );

  const handleDropTask = (taskId: string, slotStart: Date): void => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      toast({
        title: 'Drop failed',
        description: `Task ${taskId} not found`,
        variant: 'destructive',
      });
      return;
    }
    setPendingDrop({ task, slotStart });
  };

  const confirmDrop = async (): Promise<void> => {
    if (!pendingDrop) return;
    const { task, slotStart } = pendingDrop;
    const existing = task.due ? safeParse(task.due) : null;
    const nextDue = new Date(slotStart);
    if (existing) nextDue.setMinutes(existing.getMinutes(), 0, 0);
    const nextDueIso = nextDue.toISOString();
    try {
      await updateTask.mutateAsync({
        id: task.id,
        patch: { due: nextDueIso },
      });

      // Create a real calendar time-block for tasks not yet linked to an
      // event. Re-scheduling a linked task flows through the due → calendar
      // sync path, so we avoid spawning a duplicate event.
      let blocked = false;
      if (!task.calendar_event_id) {
        try {
          await scheduleTask.mutateAsync({
            id: task.id,
            body: { start: nextDueIso },
          });
          blocked = true;
        } catch {
          // Calendar not connected / unavailable — the due is still set.
        }
      }

      const when = format(nextDue, 'h:mm a');
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
                description: `${task.title} → ${when}. Connect Google Calendar for a time block.`,
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

  const batchQueueAgentTasks = async (): Promise<void> => {
    const candidates = tasksDueToday.filter(
      (t) => t.agent_executable && t.status === 'queued',
    );
    if (candidates.length === 0) {
      toast({
        title: 'Nothing to queue',
        description: 'No agent-executable queued tasks due today.',
      });
      return;
    }
    setBatchRunning(true);
    let succeeded = 0;
    let failed = 0;
    await Promise.all(
      candidates.map(async (t) => {
        try {
          await api.post(`/api/tasks/${encodeURIComponent(t.id)}/execute`);
          succeeded += 1;
        } catch {
          failed += 1;
        }
      }),
    );
    setBatchRunning(false);
    toast({
      title: 'Batch execute requested',
      description: `${succeeded} requested${failed > 0 ? `, ${failed} failed` : ''}`,
      variant: failed > 0 ? 'destructive' : 'default',
    });
  };

  const isToday = isSameDay(day, new Date());
  const planDate = format(day, 'yyyy-MM-dd');

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-daily-plan">
      <DailyPlanGenerator date={planDate} />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Daily Plan</h1>
          <span className="text-xs text-muted-foreground">
            {format(day, 'EEEE, MMMM d, yyyy')}
            {isToday ? ' · today' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setDay((d) => addDays(d, -1))}
            aria-label="daily-plan-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDay(startOfDay(new Date()))}
            aria-label="daily-plan-today"
          >
            Today
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setDay((d) => addDays(d, 1))}
            aria-label="daily-plan-next"
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
            aria-label="daily-plan-refresh"
          >
            <RefreshCw
              className={cn(
                'h-4 w-4',
                (eventsQ.isFetching || tasksQ.isFetching) && 'animate-spin',
              )}
            />
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void batchQueueAgentTasks();
            }}
            disabled={batchRunning}
            aria-label="daily-plan-batch-execute"
          >
            <Bot className="mr-1 h-4 w-4" />
            {batchRunning ? 'Queuing…' : 'Batch queue agent tasks'}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <section
          className="flex w-3/5 min-w-0 flex-col overflow-auto border-r border-border"
          aria-label="daily-plan-timeline"
        >
          {eventsQ.isError && (
            <div
              role="alert"
              className="m-4 rounded-md border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
            >
              Couldn’t load calendar events. Check Settings → Calendar.
            </div>
          )}

          <div className="border-b border-border bg-background/60 px-4 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            Timeline · drop tasks to schedule
          </div>

          <div className="flex-1">
            {HOURS.map((h) => (
              <TimeSlot
                key={h}
                date={day}
                hour={h}
                events={eventsInHour(events, day, h)}
                tasks={tasksInHour(tasksDueToday, day, h)}
                onEventClick={(evt) => {
                  if (evt.task_id) navigate(`/task/${evt.task_id}`);
                }}
                onTaskClick={(t) => navigate(`/task/${t.id}`)}
                onDropTask={handleDropTask}
                density="comfortable"
              />
            ))}
          </div>
        </section>

        <aside
          className="flex w-2/5 min-w-0 flex-col overflow-auto bg-muted/20"
          aria-label="daily-plan-pending"
        >
          <PendingSection
            title="Due today"
            icon={<CalendarDays className="h-4 w-4 text-emerald-600" />}
            tasks={tasksDueToday}
            emptyHint="No tasks due today."
            onTaskClick={(t) => navigate(`/task/${t.id}`)}
            ariaLabel="daily-plan-section-due-today"
          />
          <PendingSection
            title="Overdue"
            icon={<AlertTriangle className="h-4 w-4 text-red-600" />}
            tasks={tasksOverdue}
            emptyHint="Nothing overdue. Nice."
            onTaskClick={(t) => navigate(`/task/${t.id}`)}
            ariaLabel="daily-plan-section-overdue"
          />
          <PendingSection
            title="Top priority"
            icon={<Flame className="h-4 w-4 text-orange-600" />}
            tasks={tasksTopPriority}
            emptyHint="No P0/P1 in your inbox or queue."
            onTaskClick={(t) => navigate(`/task/${t.id}`)}
            ariaLabel="daily-plan-section-top-priority"
          />
        </aside>
      </div>

      <Dialog
        open={pendingDrop !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDrop(null);
        }}
      >
        <DialogContent aria-label="daily-plan-schedule-dialog">
          <DialogHeader>
            <DialogTitle>Schedule task</DialogTitle>
            <DialogDescription>
              {pendingDrop && (
                <>
                  Schedule{' '}
                  <span className="font-medium">{pendingDrop.task.title}</span>{' '}
                  at{' '}
                  <span className="font-medium">
                    {format(pendingDrop.slotStart, 'EEE MMM d, h:mm a')}
                  </span>
                  ?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingDrop(null)}
              aria-label="daily-plan-schedule-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void confirmDrop();
              }}
              disabled={updateTask.isPending || scheduleTask.isPending}
              aria-label="daily-plan-schedule-confirm"
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
/*  Pending section                                                           */
/* -------------------------------------------------------------------------- */

interface PendingSectionProps {
  title: string;
  icon: JSX.Element;
  tasks: Task[];
  emptyHint: string;
  onTaskClick: (task: Task) => void;
  ariaLabel: string;
}

function PendingSection({
  title,
  icon,
  tasks,
  emptyHint,
  onTaskClick,
  ariaLabel,
}: PendingSectionProps): JSX.Element {
  return (
    <section
      aria-label={ariaLabel}
      className="border-b border-border last:border-b-0"
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-medium">{title}</h2>
        </div>
        <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
          {tasks.length}
        </span>
      </header>

      <div className="px-3 py-3">
        {tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyHint}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => (
              <li key={task.id}>
                <div
                  draggable
                  onDragStart={(e) => {
                    const payload = JSON.stringify({
                      kind: 'task',
                      id: task.id,
                    });
                    e.dataTransfer.setData(TASK_DRAG_MIME, payload);
                    e.dataTransfer.setData('text/plain', payload);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  aria-label={`daily-plan-draggable-${task.id}`}
                >
                  <TaskCard task={task} compact onClick={onTaskClick} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
