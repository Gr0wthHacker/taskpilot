/**
 * Execution queue — all agent-executable tasks that are ready (or in flight)
 * for Claude to run. Rendered standalone via `<Execution />` when no `:id`
 * param is present.
 */

import { format, parseISO } from 'date-fns';
import { Link } from 'react-router-dom';
import { PlayCircle, ArrowRight, RefreshCw, Clock } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Badge } from '@/renderer/components/ui/badge';
import { Card, CardContent } from '@/renderer/components/ui/card';
import { PriorityBadge } from '@/renderer/components/shared/PriorityPicker';
import { useTasksList } from '@/renderer/lib/query';
import type { Task } from '@/shared/types';

function formatDue(iso: string): string {
  try {
    const d = parseISO(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return format(d, 'EEE MMM d, h:mm a');
  } catch {
    return iso;
  }
}

function filterExecutable(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) =>
      t.agent_executable &&
      (t.agent_status === 'assigned' ||
        t.agent_status === 'pending' ||
        t.agent_status === 'running') &&
      t.status !== 'done' &&
      t.status !== 'failed',
  );
}

function methodLabel(t: Task): string {
  switch (t.agent_method) {
    case 'cowork':
      return 'Cowork';
    case 'cli':
      return 'CLI';
    case 'either':
      return 'Either';
    case 'human_only':
      return 'Human';
    default:
      return t.agent_method;
  }
}

export default function ExecuteQueue(): JSX.Element {
  const query = useTasksList({ agent_only: true });
  const tasks = query.data ? filterExecutable(query.data.tasks) : [];

  return (
    <section
      aria-label="execute-queue"
      className="flex h-full flex-col gap-4 overflow-auto p-6"
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <PlayCircle className="h-6 w-6 text-muted-foreground" />
            Execution queue
          </h1>
          <p className="text-sm text-muted-foreground">
            Tasks ready for Claude (Cowork or CLI) to execute.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          aria-label="refresh-execute-queue"
        >
          <RefreshCw
            className={`mr-1 h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </header>

      {query.isLoading && (
        <div className="text-sm text-muted-foreground">Loading tasks…</div>
      )}

      {query.isError && (
        <div className="text-sm text-destructive">
          Failed to load the execution queue. Is the API server running?
        </div>
      )}

      {!query.isLoading && !query.isError && tasks.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tasks awaiting execution.
        </div>
      )}

      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <Card data-task-id={task.id}>
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <PriorityBadge priority={task.priority} />
                    <Badge variant="outline">{methodLabel(task)}</Badge>
                    <Badge variant="outline">{task.agent_status}</Badge>
                    <h2 className="truncate font-medium">{task.title}</h2>
                  </div>
                  {task.agent_instructions && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {task.agent_instructions}
                    </p>
                  )}
                  {task.due && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      Due {formatDue(task.due)}
                    </div>
                  )}
                </div>
                <Button asChild size="sm" aria-label={`start-execution-${task.id}`}>
                  <Link to={`/execute/${task.id}`}>
                    Start Execution
                    <ArrowRight className="ml-1 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
