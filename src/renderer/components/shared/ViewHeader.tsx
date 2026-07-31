/**
 * ViewHeader — the one page-header pattern every full-page view should use.
 *
 * Before this existed, views hand-rolled ~16 different header class strings
 * and split page titles between text-xl and text-2xl. This standardizes the
 * structure (leading icon · title · subtitle · right-aligned actions, with an
 * optional row beneath for filters/tabs/bulk bars) so every screen reads as
 * part of one product.
 *
 * Slots:
 *  - `actions`  → right-aligned controls (buttons, selects)
 *  - `children` → rendered below the title row (filter strips, tab bars, etc.)
 */

import type { LucideIcon } from 'lucide-react';

import { cn } from '@/renderer/lib/utils';

interface ViewHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** Override the header element's aria-label (preserved for Cowork targeting). */
  ariaLabel?: string;
  className?: string;
}

export function ViewHeader({
  title,
  subtitle,
  icon: Icon,
  actions,
  children,
  ariaLabel,
  className,
}: ViewHeaderProps): JSX.Element {
  return (
    <header
      aria-label={ariaLabel}
      className={cn(
        'flex flex-col gap-3 border-b border-border bg-background/60 px-6 py-4',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && (
            <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {title}
            </h1>
            {subtitle != null && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </header>
  );
}
