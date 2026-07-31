/**
 * Goal detail view (`/goals/:id`).
 *
 * Header (editable name / description / target / status), a large rolled-up
 * progress bar, member tasks grouped by status, and an "Add tasks" multi-
 * select that attaches existing tasks to this goal. Also surfaces a timeline
 * of goal-related completions (done members, newest-first).
 *
 * Edits persist on blur / change through {@link useUpdateGoal}. Member
 * attachment goes through {@link useAttachTaskGoal}.
 */

import { ArrowLeft, Target, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  GoalProgressBar,
  GOAL_STATUS_LABELS,
} from '@/renderer/components/shared/GoalProgressBar';
import { TagInput } from '@/renderer/components/shared/TagInput';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import {
  useAttachTaskGoal,
  useDeleteGoal,
  useGoal,
  useTasksList,
  useUpdateGoal,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { GoalStatus, Task, TaskStatus } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const STATUS_ORDER: TaskStatus[] = [
  'in_progress',
  'blocked',
  'queued',
  'inbox',
  'failed',
  'done',
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  queued: 'Queued',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

const GOAL_STATUSES: GoalStatus[] = [
  'active',
  'achieved',
  'on_hold',
  'abandoned',
];

function toDateInput(target: string | null): string {
  if (!target) return '';
  const ms = Date.parse(target);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

function groupByStatus(tasks: Task[]): Array<[TaskStatus, Task[]]> {
  const buckets = new Map<TaskStatus, Task[]>();
  for (const t of tasks) {
    const arr = buckets.get(t.status) ?? [];
    arr.push(t);
    buckets.set(t.status, arr);
  }
  return STATUS_ORDER.filter((s) => buckets.has(s)).map((s) => [
    s,
    buckets.get(s) as Task[],
  ]);
}

/* -------------------------------------------------------------------------- */
/*  Add-tasks dialog                                                          */
/* -------------------------------------------------------------------------- */

function AddTasksDialog({
  open,
  onOpenChange,
  goalId,
  memberIds,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  goalId: string;
  memberIds: Set<string>;
}): JSX.Element {
  const tasksQ = useTasksList({});
  const attach = useAttachTaskGoal();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  const candidates = useMemo(() => {
    const all = tasksQ.data?.tasks ?? [];
    const q = filter.trim().toLowerCase();
    return all.filter(
      (t) =>
        !memberIds.has(t.id) &&
        (q.length === 0 || t.title.toLowerCase().includes(q)),
    );
  }, [tasksQ.data, memberIds, filter]);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = (): void => {
    const ids = [...selected];
    if (ids.length === 0) {
      onOpenChange(false);
      return;
    }
    let remaining = ids.length;
    for (const id of ids) {
      attach.mutate(
        { id, body: { goal_id: goalId } },
        {
          onSettled: () => {
            remaining -= 1;
            if (remaining === 0) {
              setSelected(new Set());
              onOpenChange(false);
            }
          },
        },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="add-tasks-dialog">
        <DialogHeader>
          <DialogTitle>Add tasks to goal</DialogTitle>
          <DialogDescription>
            Attach existing tasks. They keep their own status — attaching just
            rolls them up here.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tasks…"
          aria-label="add-tasks-filter"
        />

        <div className="max-h-[320px] space-y-1 overflow-auto">
          {candidates.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No matching unattached tasks.
            </div>
          ) : (
            candidates.map((t) => (
              <label
                key={t.id}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm',
                  'hover:bg-accent/50',
                  selected.has(t.id) && 'border-primary/40 bg-accent/40',
                )}
                aria-label={`add-task-row-${t.id}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(t.id)}
                  onChange={() => toggle(t.id)}
                  aria-label={`add-task-checkbox-${t.id}`}
                />
                <span className="flex-1 truncate">{t.title}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t.status.replace('_', ' ')}
                </span>
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={selected.size === 0 || attach.isPending}
            aria-label="add-tasks-submit"
          >
            Attach {selected.size > 0 ? `(${selected.size})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function GoalDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goalQ = useGoal(id);
  const updateGoal = useUpdateGoal();
  const deleteGoal = useDeleteGoal();
  const attach = useAttachTaskGoal();

  const [addOpen, setAddOpen] = useState(false);

  const goal = goalQ.data?.goal ?? null;
  const tasks = goalQ.data?.tasks ?? [];
  const progress = goalQ.data?.progress ?? null;

  const memberIds = useMemo(
    () => new Set(tasks.map((t) => t.id)),
    [tasks],
  );

  const grouped = useMemo(() => groupByStatus(tasks), [tasks]);

  const completions = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'done')
        .slice()
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [tasks],
  );

  if (goalQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Loading goal…
      </div>
    );
  }

  if (!goal || !progress) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <div className="text-sm font-medium">Goal not found</div>
        <Button variant="outline" size="sm" onClick={() => navigate('/goals')}>
          Back to goals
        </Button>
      </div>
    );
  }

  const patch = (p: Parameters<typeof updateGoal.mutate>[0]['patch']): void => {
    updateGoal.mutate({ id: goal.id, patch: p });
  };

  const handleDelete = (): void => {
    deleteGoal.mutate(
      { id: goal.id },
      { onSuccess: () => navigate('/goals') },
    );
  };

  const detach = (taskId: string): void => {
    attach.mutate({ id: taskId, body: { goal_id: null } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-goal-detail">
      <header className="border-b border-border bg-background/60 px-6 py-4">
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate('/goals')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-label="goal-detail-back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Goals
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={deleteGoal.isPending}
            className="text-red-700 hover:text-red-800 dark:text-red-300"
            aria-label="goal-detail-delete"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Delete
          </Button>
        </div>

        <div className="flex items-start gap-2">
          <Target className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="flex-1 space-y-3">
            <Input
              defaultValue={goal.name}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next.length > 0 && next !== goal.name) {
                  patch({ name: next });
                }
              }}
              className="h-9 text-lg font-semibold"
              aria-label="goal-detail-name"
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <Select
                  value={goal.status}
                  onValueChange={(v) => patch({ status: v as GoalStatus })}
                >
                  <SelectTrigger
                    className="h-8 text-xs"
                    aria-label="goal-detail-status"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GOAL_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {GOAL_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Target date</Label>
                <Input
                  type="date"
                  defaultValue={toDateInput(goal.target_date)}
                  onChange={(e) =>
                    patch({ target_date: e.target.value || null })
                  }
                  className="h-8 text-xs"
                  aria-label="goal-detail-target"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Tags (auto-include)</Label>
                <TagInput
                  value={goal.tags}
                  onChange={(next) => patch({ tags: next })}
                  ariaLabel="goal-detail-tags"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Description / success criteria</Label>
              <Textarea
                defaultValue={goal.description ?? ''}
                onBlur={(e) =>
                  patch({ description: e.target.value.trim() || null })
                }
                rows={3}
                aria-label="goal-detail-description"
              />
            </div>

            <GoalProgressBar progress={progress} size="large" />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">
            Tasks ({progress.total})
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddOpen(true)}
            aria-label="goal-detail-add-tasks"
          >
            + Add tasks
          </Button>
        </div>

        {tasks.length === 0 ? (
          <div
            className="rounded-md border border-dashed border-border bg-card/40 p-8 text-center text-xs text-muted-foreground"
            aria-label="goal-detail-empty-tasks"
          >
            No tasks rolled up yet. Attach tasks or add a shared tag.
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map(([status, items]) => (
              <section key={status} aria-label={`goal-detail-group-${status}`}>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {STATUS_LABELS[status]} ({items.length})
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {items.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      onClick={() => navigate(`/task/${t.id}`)}
                      actions={
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            detach(t.id);
                          }}
                          className="text-[10px] text-muted-foreground hover:text-red-600"
                          aria-label={`goal-detail-detach-${t.id}`}
                          title="Detach from goal"
                        >
                          Detach
                        </button>
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {completions.length > 0 && (
          <section className="mt-8" aria-label="goal-detail-timeline">
            <h2 className="mb-2 text-sm font-semibold tracking-tight">
              Completions
            </h2>
            <ol className="space-y-1.5 border-l border-border pl-4">
              {completions.map((t) => (
                <li
                  key={t.id}
                  className="relative text-xs text-muted-foreground"
                >
                  <span className="absolute -left-[1.30rem] top-1 h-2 w-2 rounded-full bg-emerald-500" />
                  <button
                    type="button"
                    onClick={() => navigate(`/task/${t.id}`)}
                    className="text-left hover:text-foreground"
                  >
                    <span className="font-medium text-foreground">
                      {t.title}
                    </span>{' '}
                    · {new Date(t.updated_at).toLocaleDateString()}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <AddTasksDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        goalId={goal.id}
        memberIds={memberIds}
      />
    </div>
  );
}
