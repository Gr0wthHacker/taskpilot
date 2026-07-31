/**
 * Onboarding shell.
 *
 * Common chrome wrapped around every step of the first-launch wizard:
 *   - top-right "Skip setup" link
 *   - centered step content (passed as children)
 *   - bottom progress dots + Back / Next buttons
 *
 * The shell is presentational. State (current step, busy flag, etc.) lives
 * in `Onboarding.tsx`; this component just reflects the props.
 */

import { cn } from '@/renderer/lib/utils';
import { Button } from '@/renderer/components/ui/button';

export interface OnboardingShellProps {
  step: number;
  totalSteps: number;
  children: React.ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  backLabel?: string;
  /** When true, the primary advance button is disabled (e.g. async in flight). */
  nextDisabled?: boolean;
  /** Hide the bottom controls (useful for the final "You're all set" step). */
  hideControls?: boolean;
  /** Hide the "Skip setup" link in the corner. */
  hideSkip?: boolean;
}

export default function OnboardingShell({
  step,
  totalSteps,
  children,
  onBack,
  onNext,
  onSkip,
  nextLabel = 'Next',
  backLabel = 'Back',
  nextDisabled = false,
  hideControls = false,
  hideSkip = false,
}: OnboardingShellProps): JSX.Element {
  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* Top bar: brand on left, Skip on right */}
      <header className="flex items-center justify-between border-b border-border/40 px-8 py-4">
        <div className="text-sm font-semibold tracking-tight text-muted-foreground">
          TaskPilot setup
        </div>
        {!hideSkip && onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Skip setup
          </button>
        )}
      </header>

      {/* Centered step content */}
      <main className="flex flex-1 items-center justify-center overflow-auto px-8 py-10">
        <div className="w-full max-w-2xl">{children}</div>
      </main>

      {/* Footer: progress + controls */}
      <footer className="flex items-center justify-between border-t border-border/40 px-8 py-4">
        {/* Progress dots */}
        <div className="flex items-center gap-2" aria-label="onboarding-progress">
          {Array.from({ length: totalSteps }, (_, i) => i + 1).map((n) => (
            <span
              key={n}
              aria-current={n === step ? 'step' : undefined}
              className={cn(
                'h-2 w-2 rounded-full transition-colors',
                n === step
                  ? 'bg-primary'
                  : n < step
                    ? 'bg-primary/40'
                    : 'bg-muted',
              )}
            />
          ))}
          <span className="ml-3 text-xs text-muted-foreground">
            Step {step} of {totalSteps}
          </span>
        </div>

        {!hideControls && (
          <div className="flex items-center gap-2">
            {onBack && (
              <Button variant="ghost" onClick={onBack}>
                {backLabel}
              </Button>
            )}
            {onNext && (
              <Button onClick={onNext} disabled={nextDisabled}>
                {nextLabel}
              </Button>
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
