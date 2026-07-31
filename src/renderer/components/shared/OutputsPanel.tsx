/**
 * Outputs panel (Wave 15).
 *
 * The "everything this task produced" section on TaskDetail. Pulls together
 * the result summary, Claude-authored output files, user-uploaded
 * attachments, external artifacts (PR, calendar event, Notion page,
 * Slack thread, Gmail draft, GitHub issue), and execution metrics into a
 * single readable block.
 *
 * Sub-sections:
 *   1. Summary — big readable result text
 *   2. Files & Artifacts — uniform card grid for files + external refs
 *   3. Metrics — small stat row (cost, tokens, time, confidence, runs)
 *
 * Also exposes the "Export briefing pack" button, which streams a ZIP of
 * everything to the user's downloads folder via the `useBriefingPack`
 * hook.
 */

import { Loader2, Package } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { ConfidenceBadge } from '@/renderer/components/shared/ConfidenceBadge';
import { MarkdownView } from '@/renderer/components/shared/MarkdownView';
import {
  OutputArtifactCard,
  OutputFileCard,
} from '@/renderer/components/shared/OutputCard';
import { OutputFileViewer } from '@/renderer/components/shared/OutputFileViewer';
import { useBriefingPack, useTaskOutputs } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { OutputFile } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatHours(hours: number | null): string {
  if (hours === null) return 'n/a';
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `${mins}m`;
  }
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

/* -------------------------------------------------------------------------- */
/*  Stat                                                                      */
/* -------------------------------------------------------------------------- */

interface StatProps {
  label: string;
  value: React.ReactNode;
  ariaLabel?: string;
}

function Stat({ label, value, ariaLabel }: StatProps): JSX.Element {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-md border border-border bg-card/40 px-3 py-2"
      aria-label={ariaLabel}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panel                                                                     */
/* -------------------------------------------------------------------------- */

export interface OutputsPanelProps {
  taskId: string;
  className?: string;
}

export function OutputsPanel({
  taskId,
  className,
}: OutputsPanelProps): JSX.Element {
  const { toast } = useToast();
  const outputsQ = useTaskOutputs(taskId);
  const downloadBriefingPack = useBriefingPack();
  const [downloading, setDownloading] = useState(false);
  const [viewerFile, setViewerFile] = useState<OutputFile | null>(null);

  const handleExport = async (): Promise<void> => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadBriefingPack(taskId);
      toast({ title: 'Briefing pack downloaded' });
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setDownloading(false);
    }
  };

  if (outputsQ.isLoading) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 text-xs text-muted-foreground',
          className,
        )}
        aria-label="task-outputs"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading outputs…
      </div>
    );
  }

  if (outputsQ.isError || !outputsQ.data) {
    return (
      <div
        className={cn(
          'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive',
          className,
        )}
        aria-label="task-outputs"
        role="alert"
      >
        Couldn’t load outputs.
        {outputsQ.error instanceof Error ? ` ${outputsQ.error.message}` : ''}
      </div>
    );
  }

  const bundle = outputsQ.data;
  const hasFiles = bundle.files.length > 0;
  const hasAttachments = bundle.attachments.length > 0;
  const hasArtifacts = bundle.artifacts.length > 0;
  const hasSummary = Boolean(bundle.summary && bundle.summary.trim().length > 0);
  const isEmpty =
    !hasFiles && !hasAttachments && !hasArtifacts && !hasSummary;

  return (
    <div
      className={cn('flex flex-col gap-4', className)}
      aria-label="task-outputs"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {bundle.metrics.execution_count > 0
            ? `${bundle.metrics.execution_count} run${
                bundle.metrics.execution_count === 1 ? '' : 's'
              } · generated ${new Date(bundle.generated_at).toLocaleTimeString()}`
            : 'No executions yet.'}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void handleExport();
          }}
          disabled={downloading || isEmpty}
          aria-label="task-outputs-export-briefing-pack"
          title={
            isEmpty
              ? 'No outputs to export yet'
              : 'Download a zip with the README, result, files, attachments, artifacts, metrics, and journal.'
          }
        >
          {downloading ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Package className="mr-1 h-4 w-4" />
          )}
          Export briefing pack
        </Button>
      </header>

      {isEmpty && (
        <div
          className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground"
          aria-label="task-outputs-empty"
        >
          <p className="font-medium">No outputs yet.</p>
          <p className="mt-1">
            Outputs appear once Claude finishes executing this task or when the
            task has a linked PR, calendar event, Notion page, Slack thread,
            or Gmail draft.
          </p>
        </div>
      )}

      {/* Summary --------------------------------------------------------- */}
      {hasSummary && (
        <section
          className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-3"
          aria-label="task-outputs-summary"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Result summary
          </h3>
          <div className="text-sm">
            <MarkdownView source={bundle.summary ?? ''} />
          </div>
        </section>
      )}

      {/* Files & artifacts ---------------------------------------------- */}
      {(hasFiles || hasArtifacts || hasAttachments) && (
        <section
          className="flex flex-col gap-3"
          aria-label="task-outputs-files-artifacts"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Files & artifacts
          </h3>

          {hasFiles && (
            <div
              className="grid grid-cols-1 gap-2 md:grid-cols-2"
              aria-label="task-outputs-files"
            >
              {bundle.files.map((file) => (
                <OutputFileCard
                  key={file.path}
                  file={file}
                  onView={setViewerFile}
                />
              ))}
            </div>
          )}

          {hasArtifacts && (
            <div
              className="grid grid-cols-1 gap-2 md:grid-cols-2"
              aria-label="task-outputs-artifacts"
            >
              {bundle.artifacts.map((artifact, idx) => (
                <OutputArtifactCard
                  key={`${artifact.kind}-${idx}`}
                  artifact={artifact}
                />
              ))}
            </div>
          )}

          {hasAttachments && (
            <div className="flex flex-col gap-2" aria-label="task-outputs-attachments">
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Attached by you
              </h4>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {bundle.attachments.map((file) => (
                  <OutputFileCard
                    key={file.path}
                    file={file}
                    attachment
                    onView={setViewerFile}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Metrics --------------------------------------------------------- */}
      <section
        className="flex flex-col gap-2"
        aria-label="task-outputs-metrics"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Metrics
        </h3>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Stat
            label="Cost"
            ariaLabel="task-outputs-metric-cost"
            value={`$${bundle.metrics.total_cost_usd.toFixed(4)}`}
          />
          <Stat
            label="Input tokens"
            ariaLabel="task-outputs-metric-input-tokens"
            value={formatTokens(bundle.metrics.total_input_tokens)}
          />
          <Stat
            label="Output tokens"
            ariaLabel="task-outputs-metric-output-tokens"
            value={formatTokens(bundle.metrics.total_output_tokens)}
          />
          <Stat
            label="Time to done"
            ariaLabel="task-outputs-metric-time"
            value={formatHours(bundle.metrics.time_to_done_hours)}
          />
          <Stat
            label="Confidence"
            ariaLabel="task-outputs-metric-confidence"
            value={
              bundle.metrics.last_confidence === null ? (
                'n/a'
              ) : (
                <ConfidenceBadge
                  value={bundle.metrics.last_confidence}
                  threshold={0.7}
                  aria-label="task-outputs-confidence-badge"
                />
              )
            }
          />
        </div>
      </section>

      <OutputFileViewer
        taskId={taskId}
        file={viewerFile}
        open={viewerFile !== null}
        onOpenChange={(next) => {
          if (!next) setViewerFile(null);
        }}
      />
    </div>
  );
}

