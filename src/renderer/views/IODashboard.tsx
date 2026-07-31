/**
 * I/O Dashboard (PRD §9.7).
 *
 * Pipeline overview: per-directory counts, watcher health, recent IPC events,
 * stale items, and the operational quick actions Cowork uses to nudge the
 * pipeline (force ingest, refresh context, open IO folder).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Inbox as InboxIcon,
  Workflow,
  PackageCheck,
  PlayCircle,
  FileCheck2,
  Eye,
  Activity,
  AlertTriangle,
  RefreshCw,
  FolderOpen,
  RotateCcw,
} from 'lucide-react';

import { AgentsTabs } from '@/renderer/components/AgentsTabs';
import { Button } from '@/renderer/components/ui/button';
import { Badge } from '@/renderer/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { useToast } from '@/renderer/components/ui/use-toast';
import { cn } from '@/renderer/lib/utils';
import { api } from '@/renderer/lib/api';
import {
  queryKeys,
  useIoStatus,
  useRejectTask,
  useTasksList,
} from '@/renderer/lib/query';
import type { Task } from '@/shared/types';
import PipelineCount, {
  type PipelineCountTone,
} from '@/renderer/components/shared/PipelineCount';

interface IoEventLogEntry {
  at: string;
  kind: string;
  task_id?: string;
  path: string;
  action: 'added' | 'ingested' | 'invalid';
}

function isStale(task: Task, cutoffMs: number): boolean {
  const updated = Date.parse(task.updated_at);
  if (Number.isNaN(updated) || updated > cutoffMs) return false;
  const stalledDerivation =
    task.status === 'inbox' && task.agent_status === 'pending';
  const stalledExecution =
    task.agent_executable &&
    (task.agent_status === 'assigned' || task.agent_status === 'running');
  return stalledDerivation || stalledExecution;
}

export default function IODashboard(): JSX.Element {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const statusQuery = useIoStatus();
  const tasksQuery = useTasksList();
  const rejectMutation = useRejectTask();

  const staleTasks = useMemo<Task[]>(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return (tasksQuery.data?.tasks ?? []).filter((t) => isStale(t, cutoff));
  }, [tasksQuery.data]);

  // Renderer-side rolling log fed by IPC. Capped at 50 entries.
  const [activityLog, setActivityLog] = useState<IoEventLogEntry[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bridge = window.taskpilot;
    if (!bridge?.onIOEvent) return;
    const off = bridge.onIOEvent((event) => {
      const action: IoEventLogEntry['action'] =
        event.kind === 'invalid'
          ? 'invalid'
          : event.kind === 'result' || event.kind === 'derived'
            ? 'ingested'
            : 'added';
      const entry: IoEventLogEntry = {
        at: event.at,
        kind: event.kind,
        ...(event.task_id !== undefined ? { task_id: event.task_id } : {}),
        path: event.path,
        action,
      };
      setActivityLog((prev) => [entry, ...prev].slice(0, 50));
      void queryClient.invalidateQueries({ queryKey: queryKeys.io.status });
    });
    return off;
  }, [queryClient]);

  const counts = statusQuery.data?.counts;
  const watcher = statusQuery.data?.watcher ?? 'stopped';
  const watcherStalled = watcher !== 'running';

  const pipelineCards = useMemo(
    (): Array<{
      label: string;
      count: number;
      icon: typeof InboxIcon;
      tone: PipelineCountTone;
    }> => [
      {
        label: 'inbox',
        count: counts?.inbox ?? 0,
        icon: InboxIcon,
        tone: 'default',
      },
      {
        label: 'derive',
        count: counts?.derive ?? 0,
        icon: Workflow,
        tone: (counts?.derive ?? 0) > 5 ? 'warning' : 'default',
      },
      {
        label: 'derived',
        count: counts?.derived ?? 0,
        icon: PackageCheck,
        tone: 'default',
      },
      {
        label: 'execute',
        count: counts?.execute ?? 0,
        icon: PlayCircle,
        tone: (counts?.execute ?? 0) > 5 ? 'warning' : 'default',
      },
      {
        label: 'results',
        count: counts?.results ?? 0,
        icon: FileCheck2,
        tone: 'default',
      },
      {
        label: 'review',
        count: counts?.review ?? 0,
        icon: Eye,
        tone: (counts?.review ?? 0) > 0 ? 'warning' : 'default',
      },
    ],
    [counts],
  );

  const triggerIngest = useCallback(
    async (refresh: boolean) => {
      try {
        const res = refresh
          ? await api.post<{ scanned?: number; ingested?: number }>(
              '/api/io/ingest',
              { refresh_context: true },
            )
          : await api.post<{ scanned?: number; ingested?: number }>(
              '/api/io/ingest',
            );
        // The endpoint returns `{scanned, ingested}` — surface those counts so
        // the operator gets a meaningful signal instead of "Ingest triggered".
        const scanned = typeof res?.scanned === 'number' ? res.scanned : null;
        const ingested = typeof res?.ingested === 'number' ? res.ingested : null;
        const description =
          ingested !== null && scanned !== null
            ? `Ingested ${ingested} file${ingested === 1 ? '' : 's'}, scanned ${scanned}.`
            : 'Watcher rescanned the I/O directories.';
        toast({
          title: refresh ? 'Context refresh complete' : 'Ingest complete',
          description,
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.io.all });
      } catch (err) {
        toast({
          title: 'Action failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
    [queryClient, toast],
  );

  const requeueStale = useCallback(
    async (task: Task) => {
      const kind =
        task.status === 'inbox' && task.agent_status === 'pending'
          ? ('derivation' as const)
          : ('result' as const);
      try {
        await rejectMutation.mutateAsync({
          id: task.id,
          body: { kind, requeue: true },
        });
        toast({ title: 'Task re-queued', description: task.title });
      } catch (err) {
        toast({
          title: 'Re-queue failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
    [rejectMutation, toast],
  );

  function openIoFolder(): void {
    const bridge = window.taskpilot as
      | (typeof window.taskpilot & {
          openIoFolder?: () => Promise<void> | void;
        })
      | undefined;
    if (bridge?.openIoFolder) {
      void bridge.openIoFolder();
    } else {
      toast({
        title: 'Folder open unavailable',
        description: 'This build does not expose openIoFolder on the bridge.',
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentsTabs />
      <section
        aria-label="view-io-dashboard"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6"
      >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">I/O Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Live state of the agent I/O pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={watcherStalled ? 'destructive' : 'secondary'}
            className={cn(
              'gap-1',
              !watcherStalled && 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100',
            )}
            aria-label="watcher-status"
          >
            <Activity className="h-3 w-3" />
            Watcher: {watcher}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void statusQuery.refetch()}
            disabled={statusQuery.isFetching}
            aria-label="refresh-io-status"
          >
            <RefreshCw
              className={`mr-1 h-4 w-4 ${statusQuery.isFetching ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>
      </header>

      {/* Counts row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {pipelineCards.map((card) => (
          <PipelineCount
            key={card.label}
            label={card.label}
            count={card.count}
            icon={card.icon}
            tone={card.tone}
          />
        ))}
      </div>

      {/* Quick actions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Quick actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => void triggerIngest(false)}
            aria-label="force-ingest"
          >
            <RotateCcw className="mr-1 h-4 w-4" />
            Force Ingest
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void triggerIngest(true)}
            aria-label="refresh-context"
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            Refresh Context
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={openIoFolder}
            aria-label="open-io-folder"
          >
            <FolderOpen className="mr-1 h-4 w-4" />
            Open IO Folder
          </Button>
        </CardContent>
      </Card>

      {/* Two-column lower section */}
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Activity log */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              Recent I/O activity
            </CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto">
            {activityLog.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No events yet this session. Activity log requires future
                implementation for historical persistence.
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1 pr-2 font-medium">Time</th>
                    <th className="pb-1 pr-2 font-medium">Dir</th>
                    <th className="pb-1 pr-2 font-medium">Task</th>
                    <th className="pb-1 pr-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {activityLog.map((entry, i) => (
                    <tr key={`${entry.at}-${i}`} className="border-t border-border">
                      <td className="py-1 pr-2 font-mono">
                        {new Date(entry.at).toLocaleTimeString()}
                      </td>
                      <td className="py-1 pr-2">{entry.kind}</td>
                      <td className="py-1 pr-2 font-mono">
                        {entry.task_id ?? '—'}
                      </td>
                      <td className="py-1 pr-2">
                        <Badge
                          variant={
                            entry.action === 'invalid'
                              ? 'destructive'
                              : entry.action === 'ingested'
                                ? 'secondary'
                                : 'outline'
                          }
                          className="text-[10px]"
                        >
                          {entry.action}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Stale items */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Stale items
            </CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto">
            {tasksQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Scanning…</p>
            ) : staleTasks.length > 0 ? (
              <ul className="space-y-2">
                {staleTasks.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-2 rounded-md border bg-card p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {t.status}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {t.agent_status}
                        </Badge>
                        <span className="truncate text-sm">{t.title}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        Last updated {new Date(t.updated_at).toLocaleString()}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void requeueStale(t)}
                      aria-label={`requeue-${t.id}`}
                      disabled={rejectMutation.isPending}
                    >
                      Re-queue
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing has been sitting more than an hour. Pipeline looks healthy.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      </section>
    </div>
  );
}
