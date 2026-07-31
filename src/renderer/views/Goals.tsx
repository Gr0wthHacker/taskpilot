/**
 * Goals view (`/goals`).
 *
 * A tier above tasks. Renders a card grid — one card per goal — showing the
 * rolled-up progress bar, target date (overdue-highlighted), status badge, and
 * member count. A "+ New goal" button opens an inline create dialog. The list
 * filters by workspace (synced to the active workspace store) and by status.
 *
 * Progress is computed server-side (`GET /api/goals` returns goals bundled
 * with their {@link GoalProgress}), so this view is a thin presenter.
 */

import { Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
  GoalStatusBadge,
  GOAL_STATUS_LABELS,
} from '@/renderer/components/shared/GoalProgressBar';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { TagInput } from '@/renderer/components/shared/TagInput';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import { useCreateGoal, useGoals } from '@/renderer/lib/query';
import { useWorkspaceStore } from '@/renderer/store/workspace';
import { cn } from '@/renderer/lib/utils';
import type { GoalStatus, GoalWithProgress } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Date helpers                                                              */
/* -------------------------------------------------------------------------- */

function formatTarget(target: string | null): string | null {
  if (!target) return null;
  const ms = Date.parse(target);
  if (Number.isNaN(ms)) return target;
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function isOverdue(target: string | null, status: GoalStatus): boolean {
  if (!target || status === 'achieved' || status === 'abandoned') return false;
  const ms = Date.parse(target);
  if (Number.isNaN(ms)) return false;
  return ms < Date.now();
}

/* -------------------------------------------------------------------------- */
/*  Card                                                                      */
/* -------------------------------------------------------------------------- */

function GoalCard({
  goal,
  onClick,
}: {
  goal: GoalWithProgress;
  onClick: (id: string) => void;
}): JSX.Element {
  const target = formatTarget(goal.target_date);
  const overdue = isOverdue(goal.target_date, goal.status);

  return (
    <button
      type="button"
      onClick={() => onClick(goal.id)}
      className={cn(
        'group flex flex-col items-stretch gap-3 rounded-lg border border-border bg-card p-4 text-left',
        'transition-colors hover:border-primary/40 hover:bg-accent/40',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      aria-label={`goal-card-${goal.id}`}
    >
      <div className="flex items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold tracking-tight">
          {goal.name}
        </span>
        <GoalStatusBadge status={goal.status} />
      </div>

      {goal.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {goal.description}
        </p>
      )}

      <GoalProgressBar progress={goal.progress} size="compact" />

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span aria-label={`goal-card-members-${goal.id}`}>
          {goal.progress.total} task{goal.progress.total === 1 ? '' : 's'}
        </span>
        {target && (
          <span
            className={cn(
              overdue && 'font-medium text-red-700 dark:text-red-300',
            )}
            aria-label={`goal-card-target-${goal.id}`}
          >
            {overdue ? 'Overdue · ' : 'Target · '}
            {target}
          </span>
        )}
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  New goal dialog                                                           */
/* -------------------------------------------------------------------------- */

function NewGoalDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onCreated?: (id: string) => void;
}): JSX.Element {
  const createGoal = useCreateGoal();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [tags, setTags] = useState<string[]>([]);

  const reset = (): void => {
    setName('');
    setDescription('');
    setTargetDate('');
    setTags([]);
  };

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    createGoal.mutate(
      {
        name: trimmed,
        description: description.trim() || null,
        target_date: targetDate || null,
        tags,
      },
      {
        onSuccess: (res) => {
          reset();
          onOpenChange(false);
          onCreated?.(res.goal.id);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="new-goal-dialog">
        <DialogHeader>
          <DialogTitle>New goal</DialogTitle>
          <DialogDescription>
            An initiative tasks roll up to. Add tags to auto-include matching
            tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Hit $50k MRR at Actually Health"
              aria-label="new-goal-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              Description / success criteria
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What does done look like? Be specific."
              aria-label="new-goal-description"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Target date</Label>
            <Input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              aria-label="new-goal-target-date"
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Tags (auto-include)</Label>
            <TagInput
              value={tags}
              onChange={setTags}
              ariaLabel="new-goal-tags"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            aria-label="new-goal-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={name.trim().length === 0 || createGoal.isPending}
            aria-label="new-goal-submit"
          >
            {createGoal.isPending ? 'Creating…' : 'Create goal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

const STATUS_FILTERS: Array<{ value: GoalStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: GOAL_STATUS_LABELS.active },
  { value: 'achieved', label: GOAL_STATUS_LABELS.achieved },
  { value: 'on_hold', label: GOAL_STATUS_LABELS.on_hold },
  { value: 'abandoned', label: GOAL_STATUS_LABELS.abandoned },
];

export default function Goals(): JSX.Element {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<GoalStatus | 'all'>('all');
  const [dialogOpen, setDialogOpen] = useState(false);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWorkspace =
    activeWorkspaceId === null
      ? null
      : (workspaces.find((w) => w.id === activeWorkspaceId) ?? null);

  const goalsQ = useGoals(
    statusFilter === 'all' ? undefined : { status: statusFilter },
  );

  const goals = useMemo(() => {
    const list = goalsQ.data?.goals ?? [];
    // Narrow to the active workspace. A goal matches when its own `workspace`
    // id equals the active one OR its tags overlap the workspace's tags.
    if (!activeWorkspace) return list;
    const wsTags = new Set(activeWorkspace.tags);
    return list.filter(
      (g) =>
        g.workspace === activeWorkspace.id ||
        g.tags.some((t) => wsTags.has(t)),
    );
  }, [goalsQ.data, activeWorkspace]);

  const openGoal = (id: string): void => navigate(`/goals/${id}`);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-goals">
      <ViewHeader
        title="Goals"
        subtitle="Initiatives tasks roll up to. Track progress toward what matters."
        actions={
          <>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as GoalStatus | 'all')}
            >
              <SelectTrigger
                className="h-8 w-[150px] text-xs"
                aria-label="goals-status-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              aria-label="goals-new-button"
            >
              + New goal
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-auto px-6 py-4">
        {goalsQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading goals…</div>
        ) : goals.length === 0 ? (
          <EmptyState
            icon={Target}
            title="No goals yet"
            description='Create a goal to group tasks toward an outcome — "Hit $X MRR", "Ship the v2 deck", "Close the round". Tasks attach explicitly or by sharing a tag.'
            ariaLabel="goals-empty"
            action={
              <Button
                size="sm"
                onClick={() => setDialogOpen(true)}
                aria-label="goals-empty-new-button"
              >
                + New goal
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {goals.map((goal) => (
              <GoalCard key={goal.id} goal={goal} onClick={openGoal} />
            ))}
          </div>
        )}
      </div>

      <NewGoalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={openGoal}
      />
    </div>
  );
}
