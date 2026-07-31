/**
 * Archive view — every task with `status='archived'`. Lists them in a single
 * column with restore + delete-forever affordances. No bulk actions yet —
 * archive is meant to be a "stash, occasionally revisit" surface.
 */

import { Archive as ArchiveIcon, RotateCcw, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  useDeleteTask,
  useTasksList,
  useUnarchiveTask,
} from '@/renderer/lib/query';
import type { Task } from '@/shared/types';

export default function Archive(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();

  const tasksQ = useTasksList({ status: 'archived' });
  const unarchive = useUnarchiveTask();
  const deleteTask = useDeleteTask();

  const tasks = tasksQ.data?.tasks ?? [];

  const handleRestore = async (id: string): Promise<void> => {
    try {
      await unarchive.mutateAsync({ id });
      toast({ title: 'Task restored', description: 'Back in your inbox.' });
    } catch (cause) {
      toast({
        title: 'Restore failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDeleteForever = async (task: Task): Promise<void> => {
    const ok = window.confirm(
      `Delete "${task.title}" forever? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await deleteTask.mutateAsync({ id: task.id, parent_id: task.parent_id });
      toast({ title: 'Task deleted' });
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-archive">
      <ViewHeader
        title="Archive"
        subtitle={
          tasks.length === 0
            ? 'Nothing archived yet.'
            : `${tasks.length} archived task${tasks.length === 1 ? '' : 's'}`
        }
      />

      <div className="flex-1 overflow-auto p-6">
        {tasksQ.isLoading && (
          <div className="text-sm text-muted-foreground">Loading archive…</div>
        )}
        {tasksQ.isError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            Couldn’t load archive. The server may not be running.
          </div>
        )}
        {!tasksQ.isLoading && !tasksQ.isError && tasks.length === 0 && (
          <EmptyState
            icon={ArchiveIcon}
            title="Archived tasks live here."
            description="Nothing yet. Archive a task from its detail page when you want to stash it without deleting."
            ariaLabel="archive-empty"
          />
        )}

        {tasks.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="archive-task-list">
            {tasks.map((task) => (
              <li key={task.id} className="flex items-center gap-2">
                <div className="flex-1">
                  <TaskCard
                    task={task}
                    onClick={() => navigate(`/task/${task.id}`)}
                    actions={
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRestore(task.id);
                          }}
                          disabled={unarchive.isPending}
                          aria-label={`archive-restore-${task.id}`}
                          data-card-action
                        >
                          <RotateCcw className="mr-1 h-3 w-3" />
                          Restore
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteForever(task);
                          }}
                          disabled={deleteTask.isPending}
                          aria-label={`archive-delete-forever-${task.id}`}
                          data-card-action
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
