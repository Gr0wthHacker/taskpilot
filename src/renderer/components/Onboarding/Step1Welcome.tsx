/**
 * Onboarding step 1 — welcome screen.
 *
 * Sets the frame: what TaskPilot is, why it exists, and the two ways forward
 * (run the wizard or skip straight to the app shell).
 *
 * Copy is paraphrased from PRD §1 — kept short so the user moves fast.
 */

import { Button } from '@/renderer/components/ui/button';

export interface Step1WelcomeProps {
  onGetStarted: () => void;
  onSkip: () => void;
}

export default function Step1Welcome({
  onGetStarted,
  onSkip,
}: Step1WelcomeProps): JSX.Element {
  return (
    <section aria-label="onboarding-step-1" className="space-y-8 text-center">
      <div className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">
          Welcome to TaskPilot
        </h1>
        <p className="mx-auto max-w-xl text-base text-muted-foreground">
          A local task command center for the AI era. Capture work, hand pieces
          to Claude when it makes sense, and review what comes back — all in
          one place, on your machine, with your data.
        </p>
      </div>

      <ul className="mx-auto grid max-w-xl grid-cols-1 gap-3 text-left text-sm text-muted-foreground sm:grid-cols-3">
        <li className="rounded-lg border border-border/50 bg-card/50 p-3">
          <div className="font-medium text-foreground">Capture</div>
          Inbox + quick-add for anything that crosses your mind.
        </li>
        <li className="rounded-lg border border-border/50 bg-card/50 p-3">
          <div className="font-medium text-foreground">Delegate</div>
          Send tasks to Claude (cowork or CLI) and get structured results back.
        </li>
        <li className="rounded-lg border border-border/50 bg-card/50 p-3">
          <div className="font-medium text-foreground">Review</div>
          Every agent output passes through your approval queue.
        </li>
      </ul>

      <div className="flex flex-col items-center gap-3">
        <Button size="lg" onClick={onGetStarted} className="px-8">
          Get started
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Skip setup
        </button>
      </div>
    </section>
  );
}
