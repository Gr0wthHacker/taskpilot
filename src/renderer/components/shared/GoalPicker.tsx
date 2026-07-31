/**
 * GoalPicker — attach a task to a goal (or detach it).
 *
 * Task-driven: pass `taskId` and the picker fetches the goal list, reads the
 * task's current `context.goal_id`, and writes back through
 * {@link useAttachTaskGoal}. Used inline on TaskDetail's metadata grid.
 *
 * The dropdown lists active goals first. The current attachment is shown even
 * if its goal is no longer active (so the user can see + clear a stale link).
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { useAttachTaskGoal, useGoals, useTask } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';

interface GoalPickerProps {
  taskId: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

const CLEAR_VALUE = '__none__';

export function GoalPicker({
  taskId,
  disabled,
  className,
  ariaLabel,
}: GoalPickerProps): JSX.Element {
  const goalsQ = useGoals();
  const taskQ = useTask(taskId);
  const attach = useAttachTaskGoal();

  const goals = goalsQ.data?.goals ?? [];
  const ctx = taskQ.data?.task.context;
  const currentGoalId =
    ctx && typeof ctx === 'object'
      ? ((ctx as Record<string, unknown>)['goal_id'] as string | undefined)
      : undefined;

  const value = currentGoalId ?? CLEAR_VALUE;
  // If the attached goal isn't in the list (e.g. an archived/abandoned goal
  // filtered out elsewhere — though we fetch all here), still show it.
  const knownGoal = goals.find((g) => g.id === currentGoalId);

  const handleChange = (next: string): void => {
    const goalId = next === CLEAR_VALUE ? null : next;
    attach.mutate({ id: taskId, body: { goal_id: goalId } });
  };

  const busy = goalsQ.isLoading || taskQ.isLoading || attach.isPending;

  return (
    <Select
      value={value}
      onValueChange={handleChange}
      disabled={disabled || busy || goals.length === 0}
    >
      <SelectTrigger
        className={cn('h-8 text-xs', className)}
        aria-label={ariaLabel ?? 'task-goal-picker'}
      >
        <SelectValue
          placeholder={
            goalsQ.isLoading
              ? 'Loading…'
              : goals.length === 0
                ? 'No goals yet'
                : 'No goal'
          }
        />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CLEAR_VALUE}>
          <span className="text-muted-foreground">— No goal —</span>
        </SelectItem>
        {/* Surface a stale attachment that isn't in the active set. */}
        {currentGoalId && !knownGoal && (
          <SelectItem value={currentGoalId}>
            <span className="text-muted-foreground">
              (attached goal {currentGoalId})
            </span>
          </SelectItem>
        )}
        {goals.map((g) => (
          <SelectItem key={g.id} value={g.id}>
            <span className="flex items-center gap-2">
              <span className="truncate">{g.name}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {g.progress.done}/{g.progress.total}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
