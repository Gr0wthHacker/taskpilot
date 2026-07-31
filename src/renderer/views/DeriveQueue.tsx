/**
 * Derivation queue — all tasks that need to be broken into derivatives. Rendered
 * standalone via `<Derivation />` when no `:id` param is present.
 */

import { Link } from 'react-router-dom';
import { Workflow, ArrowRight, RefreshCw } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Badge } from '@/renderer/components/ui/badge';
import { Card, CardContent } from '@/renderer/components/ui/card';
import { PriorityBadge } from '@/renderer/components/shared/PriorityPicker';
import { useTasksList } from '@/renderer/lib/query';
import type { Task } from '@/shared/types';

function filterPendingDerivation(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === 'inbox' && t.parent_id === null);
}

export default function DeriveQueue(): JSX.Element {
  const query = useTasksList({ status: 'inbox' });
  const tasks = query.data ? filterPendingDerivation(query.data.tasks) : [];

  return (
    <section
      aria-label="derive-queue"
      className="flex h-full flex-col gap-4 overflow-auto p-6"
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Workflow className="h-6 w-6 text-muted-foreground" />
            Derivation queue
          </h1>
          <p className="text-sm text-muted-foreground">
            Tasks waiting to be broken into derivatives.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          aria-label="refresh-derive-queue"
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
          Failed to load the derivation queue. Is the API server running?
        </div>
      )}

      {!query.isLoading && !query.isError && tasks.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tasks awaiting derivation. The inbox is empty.
        </div>
      )}

      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <Card>
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <PriorityBadge priority={task.priority} />
                    <h2 className="truncate font-medium">{task.title}</h2>
                  </div>
                  {task.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {task.description}
                    </p>
                  )}
                  {task.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {task.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px]">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button asChild size="sm">
                  <Link
                    to={`/derive/${task.id}`}
                    aria-label={`open-derivation-${task.id}`}
                  >
                    Open Derivation Workspace
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
