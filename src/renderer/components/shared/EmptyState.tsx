/**
 * EmptyState — the shared "nothing here yet" panel. Replaces the dashed-circle
 * + icon + title + hint block that 14 views had each hand-rolled, so empty
 * screens look and feel identical everywhere.
 */

import type { LucideIcon } from 'lucide-react';

import { cn } from '@/renderer/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** Optional call-to-action rendered beneath the copy (e.g. a button). */
  action?: React.ReactNode;
  /** Tone of the icon ring — `accent` (default) or `positive` (all-clear). */
  tone?: 'accent' | 'positive';
  ariaLabel?: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'accent',
  ariaLabel,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        'mt-16 flex flex-col items-center justify-center gap-2 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="rounded-full border border-dashed border-border p-4">
          <Icon
            className={cn(
              'h-6 w-6',
              tone === 'positive'
                ? 'text-emerald-500'
                : 'text-muted-foreground',
            )}
          />
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description != null && (
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
