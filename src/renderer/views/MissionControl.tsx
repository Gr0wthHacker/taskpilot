/**
 * Mission Control — one live view of what the agents are doing right now.
 *
 * Built to reduce the anxiety of autonomous execution: at a glance you can see
 * what's running, what's waiting on your review, what failed, and what just
 * finished (with cost). It's the agent's-eye complement to the human-action
 * "Your move" view — this answers "what are the robots doing?", that answers
 * "what's on me?".
 *
 * Read-only by design (mutations live in Review / TaskDetail / I/O Dashboard).
 * Respects the active workspace lens like every other task surface.
 */

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Eye,
  Loader2,
  PauseCircle,
  Bot,
} from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { AgentsTabs } from '@/renderer/components/AgentsTabs';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import PipelineCount, {
  type PipelineCountTone,
} from '@/renderer/components/shared/PipelineCount';
import { api } from '@/renderer/lib/api';
import { useIoStatus, useReviewQueue, useTasksList } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import {
  applyWorkspaceFilter,
  useActiveWorkspace,
} from '@/renderer/store/workspace';
import type { Task } from '@/shared/types';

const RECENT_LIMIT = 8;

/** Read the `agent_paused` setting; defaults to false when unset/unavailable. */
function useAgentPaused(): boolean {
  const q = useQuery({
    queryKey: ['settings', 'agent_paused'],
    queryFn: async (): Promise<boolean> => {
      try {
        const res = await api.get<{ value: unknown }>(
          '/api/settings/agent_paused',
        );
        return res.value === true || res.value === 'true';
      } catch {
        return false;
      }
    },
    staleTime: 30_000,
    retry: false,
  });
  return q.data ?? false;
}

function byUpdatedDesc(a: Task, b: Task): number {
  return b.updated_at.localeCompare(a.updated_at);
}

export default function MissionControl(): JSX.Element {
  const navigate = useNavigate();
  const activeWorkspace = useActiveWorkspace();

  const tasksQ = useTasksList();
  const reviewQ = useReviewQueue('all');
  const ioQ = useIoStatus();
  const paused = useAgentPaused();

  const tasks = useMemo(
    () => applyWorkspaceFilter(tasksQ.data?.tasks ?? [], activeWorkspace),
    [tasksQ.data, activeWorkspace],
  );

  const running = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            t.agent_status === 'running' || t.agent_status === 'assigned',
        )
        .sort(byUpdatedDesc),
    [tasks],
  );

  const failed = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'failed' || t.agent_status === 'failed')
        .sort(byUpdatedDesc),
    [tasks],
  );

  const recentlyDone = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'done' && t.agent_method !== 'human_only')
        .sort(byUpdatedDesc)
        .slice(0, RECENT_LIMIT),
    [tasks],
  );

  const reviewItems = reviewQ.data?.items ?? [];
  const watcher = ioQ.data?.watcher ?? 'stopped';
  const watcherStalled = watcher !== 'running';

  const tiles: Array<{
    label: string;
    count: number;
    icon: typeof Activity;
    tone: PipelineCountTone;
  }> = [
    { label: 'running', count: running.length, icon: Loader2, tone: 'default' },
    {
      label: 'needs review',
      count: reviewItems.length,
      icon: Eye,
      tone: reviewItems.length > 0 ? 'warning' : 'default',
    },
    {
      label: 'failed',
      count: failed.length,
      icon: AlertTriangle,
      tone: failed.length > 0 ? 'warning' : 'default',
    },
    {
      label: 'done (recent)',
      count: recentlyDone.length,
      icon: CheckCircle2,
      tone: 'default',
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentsTabs />
      <section
        aria-label="view-mission-control"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6"
      >
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">
              Mission Control
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            What the agents are doing right now — running, awaiting review,
            failed, and recently completed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {paused && (
            <button
              type="button"
              onClick={() => navigate('/settings')}
              aria-label="mission-paused-badge"
            >
              <Badge variant="destructive" className="gap-1">
                <PauseCircle className="h-3 w-3" />
                Agents paused
              </Badge>
            </button>
          )}
          <Badge
            variant={watcherStalled ? 'destructive' : 'secondary'}
            className={cn(
              'gap-1',
              !watcherStalled &&
                'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100',
            )}
            aria-label="mission-watcher-status"
          >
            <Activity className="h-3 w-3" />
            Watcher: {watcher}
          </Badge>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <PipelineCount
            key={t.label}
            label={t.label}
            count={t.count}
            icon={t.icon}
            tone={t.tone}
          />
        ))}
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Running now */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Loader2
                className={cn(
                  'h-4 w-4 text-primary',
                  running.length > 0 && 'animate-spin',
                )}
              />
              Running now
            </CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-2 overflow-auto">
            {running.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No agents running. Approved CLI tasks fire automatically.
              </p>
            ) : (
              running.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  compact
                  showCost
                  onClick={() => navigate(`/task/${task.id}`)}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* Needs your review */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Eye className="h-4 w-4 text-amber-500" />
              Needs your review
            </CardTitle>
            {reviewItems.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => navigate('/review')}
                aria-label="mission-open-review"
              >
                Open review
              </Button>
            )}
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-2 overflow-auto">
            {reviewItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing waiting on you. Results auto-approve unless flagged.
              </p>
            ) : (
              reviewItems.slice(0, RECENT_LIMIT).map((item) => (
                <button
                  key={item.task.id}
                  type="button"
                  onClick={() => navigate(`/task/${item.task.id}`)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card p-2 text-left hover:bg-accent/40"
                  aria-label={`mission-review-${item.task.id}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {item.task.title}
                  </span>
                  {item.flag_label && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {item.flag_label}
                    </Badge>
                  )}
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {/* Failed / needs attention */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Failed
            </CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-2 overflow-auto">
            {failed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No failures. Re-queue stalled work from the I/O Dashboard.
              </p>
            ) : (
              failed.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  compact
                  onClick={() => navigate(`/task/${task.id}`)}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* Recently completed */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Recently completed
            </CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-2 overflow-auto">
            {recentlyDone.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Completed agent work shows up here with its cost.
              </p>
            ) : (
              recentlyDone.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  compact
                  showCost
                  onClick={() => navigate(`/task/${task.id}`)}
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>
      </section>
    </div>
  );
}
