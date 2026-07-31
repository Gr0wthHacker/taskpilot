/**
 * Status report summary card (Wave 16E).
 *
 * The compact entry point mounted at the top of the Reports view. It shows a
 * live headline for the trailing 7 days (closed / cost / pending review), a
 * "Generate now" button that produces + publishes a report, and a link into
 * the full `/reports/status` workbench.
 *
 * It deliberately does NOT render the full markdown — that's the full view's
 * job. This card is the at-a-glance + one-click-generate surface.
 */

import { FileText, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useGenerateStatusReport,
  useStatusReportPreview,
  useStatusReportSchedule,
} from '@/renderer/lib/query';

function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

interface MiniStatProps {
  label: string;
  value: string;
  ariaLabel: string;
}

function MiniStat({ label, value, ariaLabel }: MiniStatProps): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5" aria-label={ariaLabel}>
      <span className="text-lg font-semibold tabular-nums leading-none">
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

export default function StatusReportCard(): JSX.Element {
  const { toast } = useToast();
  const previewQ = useStatusReportPreview('7d');
  const scheduleQ = useStatusReportSchedule();
  const generate = useGenerateStatusReport();

  const metrics = previewQ.data?.metrics;
  const pendingReview = metrics ? metrics.blocked + metrics.failed : 0;
  const schedule = scheduleQ.data;
  const destinations = schedule?.destinations ?? [];

  const handleGenerate = (): void => {
    generate.mutate(
      { window: '7d', destinations },
      {
        onSuccess: (res) => {
          const published = res.published.filter((p) => p.ok && !p.skipped);
          const disk = res.published.find((p) => p.destination === 'disk');
          toast({
            title: 'Status report generated',
            description:
              published.length > 0
                ? `Published to ${published.map((p) => p.destination).join(', ')}.`
                : disk?.ok
                  ? 'Saved to ~/.taskpilot/reports/.'
                  : 'Report generated.',
          });
        },
        onError: (err) => {
          toast({
            title: 'Could not generate report',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      aria-label="card-status-report"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Weekly status report</h2>
            <p className="text-[11px] text-muted-foreground">
              {schedule?.enabled
                ? `Auto-generates on schedule (${schedule.cron}).`
                : 'On-demand. Enable a schedule in the full view.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleGenerate}
            disabled={generate.isPending}
            aria-label="status-report-generate-now"
          >
            {generate.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Generating…
              </>
            ) : (
              'Generate now'
            )}
          </Button>
          <Button
            asChild
            type="button"
            size="sm"
            variant="outline"
            aria-label="status-report-open-full"
          >
            <Link to="/reports/status">Open</Link>
          </Button>
        </div>
      </div>

      {/* Live 7-day headline */}
      <div
        className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4"
        aria-label="status-report-headline"
      >
        <MiniStat
          label="Closed (7d)"
          value={previewQ.isLoading ? '–' : String(metrics?.done ?? 0)}
          ariaLabel="status-report-stat-done"
        />
        <MiniStat
          label="Spend (7d)"
          value={previewQ.isLoading ? '–' : fmtUsd(metrics?.cost_usd ?? 0)}
          ariaLabel="status-report-stat-cost"
        />
        <MiniStat
          label="Pending review"
          value={previewQ.isLoading ? '–' : String(pendingReview)}
          ariaLabel="status-report-stat-pending"
        />
        <MiniStat
          label="Overdue"
          value={previewQ.isLoading ? '–' : String(metrics?.overdue ?? 0)}
          ariaLabel="status-report-stat-overdue"
        />
      </div>
    </section>
  );
}
