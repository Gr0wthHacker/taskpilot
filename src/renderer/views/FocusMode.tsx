/**
 * Focus mode — a full-screen, distraction-free view of a single task with an
 * optional countdown timer. Mounted outside the Layout shell (like Triage and
 * Onboarding) so the sidebar and chrome are hidden: one task, nothing else.
 *
 * Built for the short deep-work windows an interrupted day allows. The timer
 * is a simple count-down (default 25 min) with start/pause/reset — no
 * persistence, no notifications wiring; it resets when you leave.
 */

import { ArrowLeft, CheckCircle2, Pause, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { MarkdownView } from '@/renderer/components/shared/MarkdownView';
import { PriorityBadge } from '@/renderer/components/shared/PriorityPicker';
import { useTask, useUpdateTask } from '@/renderer/lib/query';

const PRESETS_MIN = [15, 25, 45];
const DEFAULT_MIN = 25;

function format(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function FocusMode(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const taskQ = useTask(id);
  const updateTask = useUpdateTask();
  const task = taskQ.data?.task ?? null;

  const [durationMin, setDurationMin] = useState(DEFAULT_MIN);
  const [remaining, setRemaining] = useState(DEFAULT_MIN * 60);
  const [running, setRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive the countdown. Clears itself at zero and pings once.
  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          setRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const finished = remaining === 0;

  const reset = useCallback(
    (min: number) => {
      setRunning(false);
      setDurationMin(min);
      setRemaining(min * 60);
    },
    [],
  );

  const exit = (): void => {
    if (id) navigate(`/task/${id}`);
    else navigate('/');
  };

  const markDone = async (): Promise<void> => {
    if (!task) return;
    try {
      await updateTask.mutateAsync({ id: task.id, patch: { status: 'done' } });
      toast({ title: 'Nice — task done', description: task.title });
      navigate(`/task/${task.id}`);
    } catch (cause) {
      toast({
        title: 'Couldn’t mark done',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div
      className="flex h-screen w-screen flex-col bg-background"
      aria-label="view-focus-mode"
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={exit}
          aria-label="focus-exit"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Exit focus
        </Button>
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Focus mode
        </span>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void markDone();
          }}
          disabled={!task || updateTask.isPending}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
          aria-label="focus-mark-done"
        >
          <CheckCircle2 className="mr-1 h-4 w-4" />
          Mark done
        </Button>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 overflow-auto p-8">
        {taskQ.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {!taskQ.isLoading && !task && (
          <p className="text-sm text-muted-foreground">Task not found.</p>
        )}
        {task && (
          <>
            <div className="w-full max-w-2xl text-center">
              <div className="mb-3 flex items-center justify-center gap-2">
                <PriorityBadge priority={task.priority} />
                {task.tags.slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
              <h1 className="text-3xl font-semibold tracking-tight">
                {task.title}
              </h1>
            </div>

            {/* Timer */}
            <div className="flex flex-col items-center gap-4">
              <div
                className={`font-mono text-7xl tabular-nums ${
                  finished ? 'text-emerald-600' : 'text-foreground'
                }`}
                aria-label="focus-timer"
                aria-live="polite"
              >
                {format(remaining)}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={() => setRunning((v) => !v)}
                  disabled={finished}
                  aria-label="focus-timer-toggle"
                >
                  {running ? (
                    <Pause className="mr-1 h-4 w-4" />
                  ) : (
                    <Play className="mr-1 h-4 w-4" />
                  )}
                  {running ? 'Pause' : 'Start'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => reset(durationMin)}
                  aria-label="focus-timer-reset"
                >
                  <RotateCcw className="mr-1 h-4 w-4" />
                  Reset
                </Button>
              </div>
              <div
                className="flex items-center gap-1"
                aria-label="focus-timer-presets"
              >
                {PRESETS_MIN.map((min) => (
                  <button
                    key={min}
                    type="button"
                    onClick={() => reset(min)}
                    aria-pressed={durationMin === min}
                    className={`rounded-md px-2 py-1 text-xs transition-colors ${
                      durationMin === min
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/40'
                    }`}
                  >
                    {min}m
                  </button>
                ))}
              </div>
            </div>

            {task.description && (
              <div className="w-full max-w-2xl rounded-lg border border-border bg-card/40 p-4">
                <MarkdownView source={task.description} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
