/**
 * Cost breakdown card for the Reports view.
 *
 * Pulls `GET /api/cost/summary` for the active window and renders three
 * tables: by tag, by workspace, by model. Empty state is friendly — "no
 * costs recorded yet" rather than blank.
 */

import { DollarSign } from 'lucide-react';

import { useCostSummary } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  CostBreakdownEntry,
  CostSummaryResponse,
  ReportWindow,
} from '@/shared/api-contract';

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value === 0) return '0';
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function windowToCostWindow(w: ReportWindow): string {
  if (w === 'all') return 'all';
  return w;
}

interface BreakdownTableProps {
  title: string;
  entries: CostBreakdownEntry[];
  emptyHint: string;
  limit?: number;
}

function BreakdownTable({
  title,
  entries,
  emptyHint,
  limit = 8,
}: BreakdownTableProps): JSX.Element {
  const rows = entries.slice(0, limit);
  return (
    <div className="flex flex-col gap-2" aria-label={`cost-breakdown-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {emptyHint}
        </div>
      ) : (
        <table className="w-full text-xs" aria-label={`cost-table-${title.toLowerCase().replace(/\s+/g, '-')}`}>
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/50 text-left">
              <th className="py-1 font-normal">Key</th>
              <th className="py-1 text-right font-normal">USD</th>
              <th className="py-1 text-right font-normal">Events</th>
              <th className="py-1 text-right font-normal">Tokens (in / out)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-border/30">
                <td className="py-1 pr-2 font-mono text-[11px]">{row.key}</td>
                <td className="py-1 text-right tabular-nums">{formatUsd(row.total_usd)}</td>
                <td className="py-1 text-right tabular-nums">{row.events}</td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {formatTokens(row.input_tokens)} / {formatTokens(row.output_tokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {entries.length > limit && (
        <div className="text-[10px] text-muted-foreground">
          +{entries.length - limit} more
        </div>
      )}
    </div>
  );
}

interface CostBreakdownProps {
  window: ReportWindow;
}

export function CostBreakdown({ window }: CostBreakdownProps): JSX.Element {
  const summaryQ = useCostSummary(windowToCostWindow(window));
  const summary: CostSummaryResponse | undefined = summaryQ.data;
  const isLoading = summaryQ.isLoading;

  return (
    <section
      className="rounded-lg border border-border bg-card"
      aria-label="card-cost-breakdown"
    >
      <div className="flex items-baseline justify-between border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Cost breakdown</h2>
        </div>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Last {window === 'all' ? 'all-time' : window}
        </span>
      </div>

      <div className="px-4 py-3">
        {summaryQ.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Couldn’t load cost data.
          </div>
        ) : isLoading || !summary ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : summary.events === 0 ? (
          <div
            className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
            aria-label="cost-breakdown-empty"
          >
            No cost events recorded in this window. Claude reports tokens on
            execution results — once a task with a known model completes,
            data shows up here.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-3"
              aria-label="cost-breakdown-totals"
            >
              <div className="rounded-md border border-border bg-background/50 p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Total spend
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatUsd(summary.total_usd)}
                </div>
              </div>
              <div className="rounded-md border border-border bg-background/50 p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Input / output tokens
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatTokens(summary.input_tokens)} / {formatTokens(summary.output_tokens)}
                </div>
              </div>
              <div className="rounded-md border border-border bg-background/50 p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Events
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {summary.events}
                </div>
              </div>
            </div>

            <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-3')}>
              <BreakdownTable
                title="By tag"
                entries={summary.by_tag}
                emptyHint="No tagged tasks contributed cost."
              />
              <BreakdownTable
                title="By workspace"
                entries={summary.by_workspace}
                emptyHint="Configure workspaces in Settings to see this view."
              />
              <BreakdownTable
                title="By model"
                entries={summary.by_model}
                emptyHint="Tokens haven’t been attributed to a known model."
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default CostBreakdown;
