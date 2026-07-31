/**
 * Compact badge that renders a task's current phase. Used inline on
 * {@link TaskCard}, the daily plan view, and anywhere else a row needs a
 * "where in the pipeline" marker.
 *
 * The badge accepts either a full {@link PhaseDefinition} (when the caller
 * has already resolved one) or just a `phase` string (when only the id is
 * available — typically off `task.context.phase`). When only the id is
 * passed, the badge renders the id verbatim with neutral colors.
 */

import { cn } from '@/renderer/lib/utils';
import type { PhaseDefinition } from '@/shared/types';

interface PhaseBadgeProps {
  /**
   * Full phase definition (preferred). Carries the human-readable name plus
   * the tailwind color fragment.
   */
  definition?: PhaseDefinition | null;
  /**
   * Fallback: just the stored phase id when no definition was resolved.
   * Usually means the assigned phase id doesn't exist in any pipeline (stale
   * binding) — we still render the id so the user knows something is set.
   */
  phase?: string | null;
  className?: string;
}

/**
 * Default color fragment when a phase definition didn't carry one. Mirrors
 * the muted look used by the priority badge.
 */
const DEFAULT_DOT = 'bg-zinc-400';

export function PhaseBadge({
  definition,
  phase,
  className,
}: PhaseBadgeProps): JSX.Element | null {
  // Nothing to render — defensive: callers should guard, but bail safely.
  if (!definition && (!phase || phase.length === 0)) return null;

  const label = definition?.name ?? phase ?? '';
  const dot = definition?.color ?? DEFAULT_DOT;
  const phaseId = definition?.id ?? phase ?? '';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
        className,
      )}
      aria-label={`phase-${phaseId}`}
      title={definition?.description ?? label}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', dot)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
