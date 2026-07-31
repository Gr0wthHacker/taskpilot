/**
 * Daily plan generator panel.
 *
 * Sits at the top of the Daily Plan view. Clicking "Generate today's plan"
 * fires `POST /api/plan/today` and renders the resulting markdown + clickable
 * time-block list. Task blocks navigate to `/task/:id` so Jack can jump
 * straight into editing.
 *
 * The plan generator on the server already builds:
 *   - Markdown synthesis (rendered by `<MarkdownView>` from shared/)
 *   - An ordered `blocks[]` (meetings + slotted tasks + breaks)
 *   - Buckets for overdue / due-today / top-priority
 *
 * This component is intentionally additive — it doesn't replace the existing
 * Daily Plan timeline/right-column layout, just gives Jack a one-shot
 * synthesis above it.
 */

import { format } from 'date-fns';
import { ClipboardCopy, Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { MarkdownView } from '@/renderer/components/shared/MarkdownView';
import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { safeParseISO as safeParse } from '@/renderer/lib/date';
import { useDailyPlan } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { PlanBlock } from '@/shared/api-contract';

function formatRange(start: string, end: string): string {
  const s = safeParse(start);
  const e = safeParse(end);
  if (!s || !e) return `${start} – ${end}`;
  return `${format(s, 'h:mm a')} – ${format(e, 'h:mm a')}`;
}

function blockKindLabel(kind: PlanBlock['kind']): string {
  switch (kind) {
    case 'meeting':
      return 'Meeting';
    case 'task':
      return 'Task';
    case 'focus':
      return 'Focus';
    case 'break':
    default:
      return 'Break';
  }
}

function blockKindClass(kind: PlanBlock['kind']): string {
  switch (kind) {
    case 'meeting':
      return 'border-l-blue-500/70 bg-blue-500/5';
    case 'task':
      return 'border-l-emerald-500/70 bg-emerald-500/5';
    case 'focus':
      return 'border-l-purple-500/70 bg-purple-500/5';
    case 'break':
    default:
      return 'border-l-neutral-500/40 bg-neutral-500/5';
  }
}

interface DailyPlanGeneratorProps {
  /** YYYY-MM-DD anchor for the plan. Omit for today. */
  date?: string;
}

export function DailyPlanGenerator({
  date,
}: DailyPlanGeneratorProps): JSX.Element {
  const { toast } = useToast();
  const navigate = useNavigate();
  const planQ = useDailyPlan(date);
  const [hasGenerated, setHasGenerated] = useState(false);

  const isLoading = planQ.isFetching;
  const plan = planQ.data;

  const handleGenerate = async (): Promise<void> => {
    setHasGenerated(true);
    try {
      await planQ.refetch();
    } catch (err) {
      toast({
        title: 'Plan generation failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleCopyMarkdown = async (): Promise<void> => {
    if (!plan?.markdown) return;
    try {
      await navigator.clipboard.writeText(plan.markdown);
      toast({
        title: 'Copied',
        description: 'Plan markdown copied to clipboard.',
      });
    } catch (err) {
      toast({
        title: 'Copy failed',
        description: err instanceof Error ? err.message : 'Clipboard unavailable',
        variant: 'destructive',
      });
    }
  };

  const handleBlockClick = (block: PlanBlock): void => {
    if (block.task_id) navigate(`/task/${block.task_id}`);
  };

  return (
    <section
      aria-label="daily-plan-generator"
      className="border-b border-border bg-background/40"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-400" />
          <h2 className="text-sm font-medium">Today&apos;s synthesis</h2>
          {plan && (
            <span className="text-xs text-muted-foreground">
              {plan.blocks.length} block{plan.blocks.length === 1 ? '' : 's'} ·{' '}
              {plan.due_today.length} due · {plan.overdue.length} overdue
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {plan && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                void handleCopyMarkdown();
              }}
              aria-label="daily-plan-copy"
            >
              <ClipboardCopy className="mr-1 h-3.5 w-3.5" />
              Copy
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleGenerate();
            }}
            disabled={isLoading}
            aria-label="daily-plan-generate"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                {hasGenerated ? 'Regenerate' : "Generate today's plan"}
              </>
            )}
          </Button>
        </div>
      </header>

      {plan && (
        <div className="grid gap-4 px-6 pb-4 md:grid-cols-2">
          <div
            aria-label="daily-plan-markdown"
            className="rounded-md border border-border bg-background/60 p-4"
          >
            <MarkdownView source={plan.markdown} />
          </div>

          <div
            aria-label="daily-plan-blocks"
            className="rounded-md border border-border bg-background/60 p-3"
          >
            {plan.blocks.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                No blocks slotted. Connect your calendar or add tasks with due
                dates / estimates.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {plan.blocks.map((block, idx) => (
                  <li key={`${block.start}-${idx}`}>
                    <button
                      type="button"
                      onClick={() => handleBlockClick(block)}
                      disabled={!block.task_id}
                      aria-label={`daily-plan-block-${idx}`}
                      className={cn(
                        'w-full rounded-sm border-l-2 px-2 py-1.5 text-left text-xs transition-colors',
                        blockKindClass(block.kind),
                        block.task_id
                          ? 'cursor-pointer hover:bg-accent/50'
                          : 'cursor-default',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {formatRange(block.start, block.end)}
                        </span>
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                          {blockKindLabel(block.kind)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-foreground">{block.title}</div>
                      {block.notes && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {block.notes}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {planQ.isError && !plan && (
        <div
          role="alert"
          className="mx-6 mb-3 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
        >
          Couldn&apos;t generate the plan. Check Settings → Calendar if you
          expected meetings to appear.
        </div>
      )}
    </section>
  );
}

export default DailyPlanGenerator;
