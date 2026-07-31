/**
 * Compact dropdown for setting a task's phase within its resolved pipeline.
 * Used inline on TaskDetail (metadata grid) and inside NewTaskDialog.
 *
 * Two modes:
 *   - **Controlled, with explicit `pipeline`**: caller passes a pipeline and
 *     the current phase id. The picker renders that pipeline's phases.
 *     Used by NewTaskDialog where no task exists yet.
 *   - **Task-driven**: pass only `taskId` and the picker fetches the
 *     resolved `{pipeline, phase}` via {@link useTaskPhase}, writes back
 *     through {@link useUpdateTaskPhase}.
 *
 * When no pipeline applies (no tags match any pipeline's `applies_to` and
 * no `default: true` pipeline is configured), the picker renders a muted
 * placeholder and stays disabled.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import {
  useTaskPhase,
  useUpdateTaskPhase,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { PhaseDefinition, Pipeline } from '@/shared/types';

import { PhaseBadge } from './PhaseBadge';

interface PhasePickerProps {
  /**
   * When provided, the picker reads/writes through the task-phase API. Use
   * this on TaskDetail.
   */
  taskId?: string;
  /**
   * Controlled value used when `taskId` isn't provided (NewTaskDialog flow).
   * Phase id (slug) or `null` when nothing is selected yet.
   */
  value?: string | null;
  /**
   * Pipeline whose phases populate the dropdown. Required in controlled
   * mode; ignored in task-driven mode (the API resolves the pipeline).
   */
  pipeline?: Pipeline | null;
  /**
   * Controlled change handler. Called with the new phase id (or `null` when
   * the user clears the selection). Ignored in task-driven mode.
   */
  onChange?: (next: string | null) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

const CLEAR_VALUE = '__none__';

export function PhasePicker(props: PhasePickerProps): JSX.Element {
  if (props.taskId) {
    return <TaskPhasePicker {...props} taskId={props.taskId} />;
  }
  return <ControlledPhasePicker {...props} />;
}

/* -------------------------------------------------------------------------- */
/*  Controlled variant                                                        */
/* -------------------------------------------------------------------------- */

function ControlledPhasePicker({
  value,
  pipeline,
  onChange,
  disabled,
  className,
  ariaLabel,
}: PhasePickerProps): JSX.Element {
  const phases = pipeline?.phases ?? [];
  const hasPipeline = phases.length > 0;
  const currentValue = value ?? CLEAR_VALUE;

  return (
    <Select
      value={currentValue}
      onValueChange={(next) => {
        if (!onChange) return;
        onChange(next === CLEAR_VALUE ? null : next);
      }}
      disabled={disabled || !hasPipeline}
    >
      <SelectTrigger
        className={cn('h-8 w-[160px] text-xs', className)}
        aria-label={ariaLabel ?? 'phase-picker'}
      >
        <SelectValue
          placeholder={hasPipeline ? 'No phase' : 'No pipeline'}
        />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CLEAR_VALUE}>
          <span className="text-muted-foreground">— No phase —</span>
        </SelectItem>
        {phases.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  p.color ?? 'bg-zinc-400',
                )}
                aria-hidden="true"
              />
              {p.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* -------------------------------------------------------------------------- */
/*  Task-driven variant                                                       */
/* -------------------------------------------------------------------------- */

interface TaskPhasePickerProps extends PhasePickerProps {
  taskId: string;
}

function TaskPhasePicker({
  taskId,
  disabled,
  className,
  ariaLabel,
}: TaskPhasePickerProps): JSX.Element {
  const phaseQ = useTaskPhase(taskId);
  const updatePhase = useUpdateTaskPhase();

  const pipeline = phaseQ.data?.pipeline ?? null;
  const phase = phaseQ.data?.phase ?? null;
  const phaseDef: PhaseDefinition | null =
    phaseQ.data?.phase_definition ?? null;

  const phases = pipeline?.phases ?? [];
  const hasPipeline = phases.length > 0;
  const currentValue = phase ?? CLEAR_VALUE;

  const handleChange = (next: string): void => {
    const phaseId = next === CLEAR_VALUE ? null : next;
    updatePhase.mutate({ id: taskId, body: { phase: phaseId } });
  };

  return (
    <div
      className="flex items-center gap-2"
      aria-label={ariaLabel ?? 'task-phase-picker'}
    >
      <Select
        value={currentValue}
        onValueChange={handleChange}
        disabled={
          disabled ||
          !hasPipeline ||
          phaseQ.isLoading ||
          updatePhase.isPending
        }
      >
        <SelectTrigger
          className={cn('h-8 w-[160px] text-xs', className)}
          aria-label={`${ariaLabel ?? 'task-phase-picker'}-trigger`}
        >
          <SelectValue
            placeholder={
              phaseQ.isLoading
                ? 'Loading…'
                : hasPipeline
                  ? 'No phase'
                  : 'No pipeline applies'
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CLEAR_VALUE}>
            <span className="text-muted-foreground">— No phase —</span>
          </SelectItem>
          {phases.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    p.color ?? 'bg-zinc-400',
                  )}
                  aria-hidden="true"
                />
                {p.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pipeline && (
        <span
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
          aria-label={`task-phase-pipeline-${pipeline.id}`}
          title={pipeline.description ?? pipeline.name}
        >
          {pipeline.name}
        </span>
      )}
      {!pipeline && phaseDef && (
        // Stale binding: we have a stored phase id but no pipeline matched.
        // Render the badge anyway so the user can see the dangling value.
        <PhaseBadge definition={phaseDef} />
      )}
    </div>
  );
}
