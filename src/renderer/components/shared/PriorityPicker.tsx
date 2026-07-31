/**
 * Compact dropdown for setting a task's priority. Used inline in the detail
 * view and from any quick-edit surface.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { cn } from '@/renderer/lib/utils';
import type { TaskPriority } from '@/shared/types';

interface PriorityPickerProps {
  value: TaskPriority;
  onChange: (next: TaskPriority) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  p0: 'P0 — Critical',
  p1: 'P1 — High',
  p2: 'P2 — Normal',
  p3: 'P3 — Low',
};

export const PRIORITY_DOT: Record<TaskPriority, string> = {
  p0: 'bg-red-500',
  p1: 'bg-orange-500',
  p2: 'bg-zinc-400',
  p3: 'bg-blue-500',
};

export const PRIORITY_BORDER: Record<TaskPriority, string> = {
  p0: 'bg-red-500',
  p1: 'bg-orange-500',
  p2: 'bg-zinc-400',
  p3: 'bg-blue-500',
};

const ORDER: TaskPriority[] = ['p0', 'p1', 'p2', 'p3'];

export function PriorityPicker({
  value,
  onChange,
  disabled,
  className,
  ariaLabel,
}: PriorityPickerProps): JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as TaskPriority)}
      disabled={disabled}
    >
      <SelectTrigger
        className={cn('h-8 w-[140px] text-xs', className)}
        aria-label={ariaLabel ?? 'priority-picker'}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ORDER.map((p) => (
          <SelectItem key={p} value={p}>
            <span className="flex items-center gap-2">
              <span
                className={cn('h-2 w-2 rounded-full', PRIORITY_DOT[p])}
                aria-hidden="true"
              />
              {PRIORITY_LABELS[p]}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PriorityBadge({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
        className,
      )}
      aria-label={`priority-${priority}`}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_DOT[priority])}
        aria-hidden="true"
      />
      {priority}
    </span>
  );
}
