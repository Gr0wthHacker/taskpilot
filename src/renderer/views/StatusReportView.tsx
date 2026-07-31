/**
 * Status report workbench (Wave 16E) — route `/reports/status`.
 *
 * The full surface for the weekly status report:
 *   - Window picker (24h / 7d / 30d / 90d) driving a live Markdown preview.
 *   - Destination toggles (Slack / Notion / Gmail draft / Disk).
 *   - "Generate now" — produces + publishes to the selected destinations.
 *   - Schedule config — enable/disable, cron expression, default destinations.
 *   - History list — past reports persisted to `~/.taskpilot/reports/`.
 *
 * The preview re-runs as the window changes (a cheap generate-without-publish
 * call). Publishing is an explicit button press, never automatic from this
 * view.
 */

import { useEffect, useMemo, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';

import MarkdownView from '@/renderer/components/shared/MarkdownView';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useGenerateStatusReport,
  useStatusReportHistory,
  useStatusReportPreview,
  useStatusReportSchedule,
  useUpdateStatusReportSchedule,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  StatusReportDestination,
  StatusReportWindow,
} from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const WINDOWS: StatusReportWindow[] = ['24h', '7d', '30d', '90d'];
const WINDOW_LABELS: Record<StatusReportWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
};

const DESTINATIONS: { id: StatusReportDestination; label: string; hint: string }[] = [
  { id: 'slack', label: 'Slack', hint: 'Post to a channel' },
  { id: 'notion', label: 'Notion', hint: 'Create a page' },
  { id: 'gmail', label: 'Gmail', hint: 'Draft only — never sent' },
  { id: 'disk', label: 'Disk', hint: '~/.taskpilot/reports/' },
];

/* -------------------------------------------------------------------------- */
/*  Window picker                                                              */
/* -------------------------------------------------------------------------- */

function WindowPicker({
  value,
  onChange,
}: {
  value: StatusReportWindow;
  onChange: (next: StatusReportWindow) => void;
}): JSX.Element {
  return (
    <div
      className="inline-flex rounded-md border border-border bg-card p-0.5"
      role="tablist"
      aria-label="status-report-window-picker"
    >
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          role="tab"
          aria-selected={value === w}
          aria-label={`status-report-window-${w}`}
          onClick={() => onChange(w)}
          className={cn(
            'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
            value === w
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {WINDOW_LABELS[w]}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Destination toggles                                                        */
/* -------------------------------------------------------------------------- */

function DestinationToggles({
  selected,
  onToggle,
}: {
  selected: Set<StatusReportDestination>;
  onToggle: (id: StatusReportDestination) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2" aria-label="status-report-destinations">
      {DESTINATIONS.map((d) => {
        const on = selected.has(d.id);
        return (
          <button
            key={d.id}
            type="button"
            aria-pressed={on}
            aria-label={`status-report-destination-${d.id}`}
            onClick={() => onToggle(d.id)}
            className={cn(
              'flex flex-col items-start rounded-md border px-3 py-1.5 text-left transition-colors',
              on
                ? 'border-primary bg-primary/10'
                : 'border-border bg-card hover:bg-accent/40',
            )}
          >
            <span className="text-xs font-medium">{d.label}</span>
            <span className="text-[10px] text-muted-foreground">{d.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Schedule config                                                            */
/* -------------------------------------------------------------------------- */

function ScheduleConfig(): JSX.Element {
  const { toast } = useToast();
  const scheduleQ = useStatusReportSchedule();
  const update = useUpdateStatusReportSchedule();

  const [cron, setCron] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [destinations, setDestinations] = useState<Set<StatusReportDestination>>(
    new Set(),
  );

  // Hydrate local form state from the server once it loads.
  useEffect(() => {
    if (scheduleQ.data) {
      setCron(scheduleQ.data.cron);
      setEnabled(scheduleQ.data.enabled);
      setDestinations(new Set(scheduleQ.data.destinations));
    }
  }, [scheduleQ.data]);

  const toggle = (id: StatusReportDestination): void => {
    setDestinations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = (): void => {
    update.mutate(
      { enabled, cron, destinations: [...destinations] },
      {
        onSuccess: () => {
          toast({ title: 'Schedule saved' });
        },
        onError: (err) => {
          toast({
            title: 'Could not save schedule',
            description: err instanceof Error ? err.message : 'Invalid cron?',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      aria-label="status-report-schedule"
    >
      <h2 className="mb-3 text-sm font-semibold">Schedule</h2>
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            aria-label="status-report-schedule-enabled"
          />
          Enabled
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Cron expression
          </span>
          <Input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 8 * * 1"
            className="max-w-[220px] font-mono text-xs"
            aria-label="status-report-schedule-cron"
          />
          <span className="text-[10px] text-muted-foreground">
            5-field cron (min hour dom mon dow). Default `0 8 * * 1` = Mondays
            8am.
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Default destinations
          </span>
          <DestinationToggles selected={destinations} onToggle={toggle} />
        </div>

        <div>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={update.isPending}
            aria-label="status-report-schedule-save"
          >
            {update.isPending ? 'Saving…' : 'Save schedule'}
          </Button>
          {scheduleQ.data?.last_run_at && (
            <span className="ml-3 text-[11px] text-muted-foreground">
              Last run: {new Date(scheduleQ.data.last_run_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  History list                                                               */
/* -------------------------------------------------------------------------- */

function HistoryList(): JSX.Element {
  const historyQ = useStatusReportHistory(20);
  const reports = historyQ.data?.reports ?? [];

  return (
    <section
      className="rounded-lg border border-border bg-card"
      aria-label="status-report-history"
    >
      <div className="border-b border-border/60 px-4 py-3">
        <h2 className="text-sm font-semibold">History</h2>
      </div>
      {historyQ.isLoading ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>
      ) : reports.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">
          No reports generated yet.
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {reports.map((r) => (
            <li
              key={r.filename}
              className="flex items-center justify-between px-4 py-2.5 text-xs"
              aria-label={`status-report-history-${r.filename}`}
            >
              <div className="flex flex-col">
                <span className="font-medium">
                  {r.generated_at
                    ? new Date(r.generated_at).toLocaleString()
                    : r.filename}
                </span>
                {r.window && (
                  <span className="text-[10px] text-muted-foreground">
                    {r.window.from.slice(0, 10)} → {r.window.to.slice(0, 10)}
                  </span>
                )}
              </div>
              {r.metrics && (
                <span className="tabular-nums text-muted-foreground">
                  {r.metrics.done} closed
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                       */
/* -------------------------------------------------------------------------- */

export default function StatusReportView(): JSX.Element {
  const { toast } = useToast();
  const [window, setWindow] = useState<StatusReportWindow>('7d');
  const [destinations, setDestinations] = useState<Set<StatusReportDestination>>(
    new Set<StatusReportDestination>(['disk']),
  );

  const previewQ = useStatusReportPreview(window);
  const generate = useGenerateStatusReport();

  const markdown = previewQ.data?.markdown ?? '';

  const toggleDestination = (id: StatusReportDestination): void => {
    setDestinations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerate = (): void => {
    generate.mutate(
      { window, destinations: [...destinations] },
      {
        onSuccess: (res) => {
          const ok = res.published.filter((p) => p.ok);
          const skipped = res.published.filter((p) => p.skipped);
          const parts: string[] = [];
          if (ok.length > 0) {
            parts.push(`Published: ${ok.map((p) => p.destination).join(', ')}`);
          }
          if (skipped.length > 0) {
            parts.push(
              `Skipped: ${skipped.map((p) => p.destination).join(', ')}`,
            );
          }
          toast({
            title: 'Status report generated',
            description: parts.join(' · ') || 'Report generated.',
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

  const publishResults = generate.data?.published ?? [];
  const headline = useMemo(() => {
    const m = previewQ.data?.metrics;
    if (!m) return null;
    return `${m.done} closed · ${m.in_progress} in progress · ${m.blocked + m.failed} stuck`;
  }, [previewQ.data]);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-status-report">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Status report
            </h1>
            <p className="text-xs text-muted-foreground">
              {headline ?? 'What got done, what is in flight, what is stuck.'}
            </p>
          </div>
        </div>
        <WindowPicker value={window} onChange={setWindow} />
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Preview — spans two columns on wide screens */}
          <section
            className="rounded-lg border border-border bg-card lg:col-span-2"
            aria-label="status-report-preview"
          >
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <h2 className="text-sm font-semibold">Preview</h2>
              <Button
                type="button"
                size="sm"
                onClick={handleGenerate}
                disabled={generate.isPending || previewQ.isLoading}
                aria-label="status-report-generate"
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
            </div>
            <div className="px-4 py-3">
              {previewQ.isLoading ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  Building preview…
                </div>
              ) : previewQ.isError ? (
                <div className="py-8 text-center text-xs text-destructive">
                  Couldn't build the preview. Is the API running?
                </div>
              ) : (
                <MarkdownView source={markdown} />
              )}
            </div>
          </section>

          {/* Right column: destinations, publish results, schedule, history */}
          <div className="flex flex-col gap-4">
            <section
              className="rounded-lg border border-border bg-card p-4"
              aria-label="status-report-publish"
            >
              <h2 className="mb-3 text-sm font-semibold">Publish to</h2>
              <DestinationToggles
                selected={destinations}
                onToggle={toggleDestination}
              />
              {publishResults.length > 0 && (
                <ul className="mt-3 space-y-1" aria-label="status-report-publish-results">
                  {publishResults.map((p) => (
                    <li
                      key={p.destination}
                      className={cn(
                        'flex items-center justify-between text-[11px]',
                        p.ok
                          ? 'text-foreground'
                          : p.skipped
                            ? 'text-muted-foreground'
                            : 'text-destructive',
                      )}
                    >
                      <span className="font-medium capitalize">
                        {p.destination}
                      </span>
                      <span className="ml-2 truncate" title={p.detail}>
                        {p.ok ? '✓' : p.skipped ? 'skipped' : '✗'} {p.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <ScheduleConfig />
            <HistoryList />
          </div>
        </div>
      </div>
    </div>
  );
}
