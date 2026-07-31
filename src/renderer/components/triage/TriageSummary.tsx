/**
 * TriageSummary — the "inbox zero" celebration shown after the last task is
 * reviewed (or when the snapshot drains to empty). Shows a checkmark, the
 * headline count + elapsed time, and a per-action breakdown.
 *
 * Presentational: the Triage view passes resolved counts. Action buttons
 * ("Back to inbox", "Triage again") are wired by the parent.
 */

import { CheckCircle2 } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import type { TriageAction } from '@/renderer/store/triage';

/** Human labels + display order for the breakdown rows. */
const BREAKDOWN_ROWS: Array<{ action: TriageAction; label: string }> = [
  { action: 'priority', label: 'Re-prioritized' },
  { action: 'done', label: 'Marked done' },
  { action: 'derive', label: 'Sent to Claude' },
  { action: 'workspace', label: 'Moved to workspace' },
  { action: 'tag', label: 'Tagged' },
  { action: 'template', label: 'Saved as template' },
  { action: 'archive', label: 'Archived' },
  { action: 'delete', label: 'Deleted' },
  { action: 'keep', label: 'Kept as-is' },
  { action: 'skipped', label: 'Skipped' },
];

interface TriageSummaryProps {
  reviewed: number;
  elapsed: string;
  breakdown: Record<TriageAction, number>;
  onBackToInbox: () => void;
  onRestart: () => void;
  /** True when the session ended because the inbox was already empty. */
  emptyInbox?: boolean;
}

export function TriageSummary({
  reviewed,
  elapsed,
  breakdown,
  onBackToInbox,
  onRestart,
  emptyInbox = false,
}: TriageSummaryProps): JSX.Element {
  const rows = BREAKDOWN_ROWS.filter((r) => breakdown[r.action] > 0);

  return (
    <div
      className="flex w-full max-w-md flex-col items-center gap-6 text-center"
      aria-label="triage-summary"
    >
      <div className="rounded-full bg-green-100 p-4 dark:bg-green-900/30">
        <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
      </div>

      {emptyInbox ? (
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">
            Inbox is already clear.
          </h2>
          <p className="text-sm text-muted-foreground">
            Nothing to triage right now.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">
            Triage complete
          </h2>
          <p className="text-sm text-muted-foreground" aria-label="triage-summary-headline">
            {reviewed} reviewed in {elapsed}.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="w-full space-y-1.5" aria-label="triage-summary-breakdown">
          {rows.map((r) => (
            <li
              key={r.action}
              className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-sm"
            >
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-semibold tabular-nums">
                {breakdown[r.action]}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onBackToInbox}
          aria-label="triage-summary-back"
        >
          Back to inbox
        </Button>
        {!emptyInbox && (
          <Button
            type="button"
            variant="outline"
            onClick={onRestart}
            aria-label="triage-summary-restart"
          >
            Triage again
          </Button>
        )}
      </div>
    </div>
  );
}

export default TriageSummary;
