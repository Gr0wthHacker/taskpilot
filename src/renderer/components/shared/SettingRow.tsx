/**
 * Layout helper for a single row inside the Settings tabs.
 *
 * Renders a label + description on the left and the supplied control on the
 * right. Keeps every settings row visually consistent without forcing
 * callers to repeat the same flex/typography boilerplate.
 */

import type { ReactNode } from 'react';

import { cn } from '@/renderer/lib/utils';

export interface SettingRowProps {
  label: string;
  description?: string;
  /** Optional aria-label override; defaults to `setting-row-<label>`. */
  ariaLabel?: string;
  /** The control(s) rendered on the right (toggle, select, button, etc.). */
  children: ReactNode;
  className?: string;
  /** When true the control stacks below the label (useful for long controls). */
  stacked?: boolean;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function SettingRow({
  label,
  description,
  ariaLabel,
  children,
  className,
  stacked,
}: SettingRowProps): JSX.Element {
  return (
    <div
      aria-label={ariaLabel ?? `setting-row-${slugify(label)}`}
      className={cn(
        'flex gap-4 border-b border-border/60 py-4 last:border-b-0',
        stacked
          ? 'flex-col'
          : 'flex-col items-start justify-between sm:flex-row sm:items-center',
        className,
      )}
    >
      <div className="min-w-0 max-w-prose">
        <div className="text-sm font-medium leading-snug">{label}</div>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className={cn('shrink-0', stacked && 'w-full')}>{children}</div>
    </div>
  );
}
