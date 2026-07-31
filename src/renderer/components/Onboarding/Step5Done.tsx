/**
 * Onboarding step 5 — completion screen.
 *
 * Confirms setup is done and offers a single CTA that POSTs to
 * `/api/onboarding/complete` then navigates to `/` (Inbox).
 *
 * The parent wires `onComplete` to the actual POST + navigate so this
 * component stays declarative — it only renders state.
 */

import { Button } from '@/renderer/components/ui/button';

export interface Step5DoneProps {
  onComplete: () => void;
  /** True while the parent's POST is in flight. */
  loading?: boolean;
}

export default function Step5Done({
  onComplete,
  loading = false,
}: Step5DoneProps): JSX.Element {
  return (
    <section aria-label="onboarding-step-5" className="space-y-6 text-center">
      <div className="space-y-3">
        <h2 className="text-4xl font-semibold tracking-tight">You're all set</h2>
        <p className="mx-auto max-w-lg text-sm text-muted-foreground">
          TaskPilot is ready. Add tasks from the Inbox, send them to Claude
          when you want help, and triage results from the Review queue. The
          system tray icon stays out of the way until you need it.
        </p>
      </div>

      <ul className="mx-auto grid max-w-xl grid-cols-1 gap-2 text-left text-xs text-muted-foreground">
        <li className="rounded-md border border-border/40 bg-card/40 px-3 py-2">
          <span className="font-medium text-foreground">Quick add:</span>{' '}
          Ctrl/Cmd+Shift+Space from anywhere (or via the tray icon). When
          TaskPilot is focused, press <code>n</code> to add a task.
        </li>
        <li className="rounded-md border border-border/40 bg-card/40 px-3 py-2">
          <span className="font-medium text-foreground">Review queue:</span> badges
          when Claude finishes work that needs your sign-off.
        </li>
        <li className="rounded-md border border-border/40 bg-card/40 px-3 py-2">
          <span className="font-medium text-foreground">IO folder:</span> every
          file the agent reads or writes lives under <code>~/.taskpilot/io</code>.
        </li>
      </ul>

      <div className="flex justify-center pt-2">
        <Button size="lg" onClick={onComplete} disabled={loading} className="px-8">
          {loading ? 'Finishing…' : "You're all set →"}
        </Button>
      </div>
    </section>
  );
}
