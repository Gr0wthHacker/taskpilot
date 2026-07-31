/**
 * Watch — ambient monitor stream.
 *
 * Shows two columns: the rolling feed of context observations on the left
 * (window polls, screenshots, browser captures, manual hotkey drops) and the
 * deliberation history on the right (interrupter vs waiter scores + verdict).
 *
 * Both panes back onto the shared `useObservations()` / `useDeliberations()`
 * hooks against `/api/context/*`. The status pill at the top reads
 * `/api/context/status` so the user sees whether the monitor is enabled,
 * whether the Chrome extension's last sync succeeded, and how many
 * deliberations are still pending. A "Deliberate now" button forces an
 * out-of-band deliberation request through the orchestrator.
 *
 * Visually mirrors the shell of `Calendar.tsx`: header row, body grid. Per
 * the wire phase: small, focused, single-file. Heavier sub-components
 * (ObservationCard, DeliberationHistory) can land in a later pass — for now
 * we keep everything inline so a missing util import doesn't block the
 * typecheck on a wire commit.
 */

import { formatDistanceToNow } from 'date-fns';
import {
  Activity,
  Camera,
  Eye,
  Globe,
  Loader2,
  Lock,
  Monitor,
  PenLine,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useContextStatus,
  useDeleteObservation,
  useDeliberateNow,
  useDeliberations,
  useObservations,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  ContextObservation,
  ContextObservationSource,
  Deliberation,
} from '@/shared/types';

type SourceFilter = 'all' | ContextObservationSource;
type TimeFilter = 'today' | '24h' | '7d' | 'all';

/**
 * Placeholder rendered in place of titles and URLs when panic mode is on.
 * Eight block characters — long enough to read as "redacted", short enough
 * not to wrap the row layout.
 */
const PANIC_CENSOR = '████████';

const SOURCE_CHIPS: Array<{ key: SourceFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'window', label: 'Window' },
  { key: 'screenshot', label: 'Screenshot' },
  { key: 'browser', label: 'Browser' },
  { key: 'manual', label: 'Manual' },
];

const TIME_CHIPS: Array<{ key: TimeFilter; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: 'all', label: 'All' },
];

function sinceIsoFor(range: TimeFilter): string | undefined {
  if (range === 'all') return undefined;
  const now = new Date();
  if (range === 'today') {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return midnight.toISOString();
  }
  const hours = range === '24h' ? 24 : 24 * 7;
  return new Date(now.getTime() - hours * 60 * 60 * 1_000).toISOString();
}

function sourceIcon(source: ContextObservationSource): React.ComponentType<{
  className?: string;
}> {
  switch (source) {
    case 'window':
      return Monitor;
    case 'screenshot':
      return Camera;
    case 'browser':
      return Globe;
    case 'manual':
      return PenLine;
    default:
      return Activity;
  }
}

function relativeOrAbsent(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

/* -------------------------------------------------------------------------- */
/*  Header                                                                    */
/* -------------------------------------------------------------------------- */

function WatchHeader({
  onDeliberate,
  deliberating,
  panicMode,
}: {
  onDeliberate: () => void;
  deliberating: boolean;
  panicMode: boolean;
}): JSX.Element {
  const status = useContextStatus();
  const data = status.data;
  const pillTone = (() => {
    if (status.isError) return 'bg-red-200 text-red-900';
    if (panicMode) return 'bg-amber-200 text-amber-900';
    if (!data) return 'bg-muted text-muted-foreground';
    if (!data.monitor_enabled) return 'bg-muted text-muted-foreground';
    return 'bg-emerald-200 text-emerald-900';
  })();
  const pillLabel = (() => {
    if (status.isError) return 'API error';
    if (panicMode) return 'Panic';
    if (!data) return 'Loading…';
    if (!data.monitor_enabled) return 'Monitor off';
    return 'Monitor on';
  })();
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-6 py-3">
      <Eye className="h-5 w-5 text-muted-foreground" />
      <div className="text-sm font-semibold">Watch</div>
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
          pillTone,
        )}
        aria-label="watch-status-pill"
      >
        {pillLabel}
      </span>
      <div className="text-xs text-muted-foreground" aria-label="watch-meta">
        {data
          ? `${data.observations_today} today · ${data.pending_deliberations} pending`
          : 'Loading status…'}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void status.refetch()}
          aria-label="watch-refresh"
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Refresh
        </Button>
        <Button
          size="sm"
          onClick={onDeliberate}
          disabled={deliberating}
          aria-label="watch-deliberate-now"
        >
          {deliberating ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="mr-1 h-3.5 w-3.5" />
          )}
          Deliberate now
        </Button>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panic banner                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sticky banner shown above the observation pane when `ambient_panic_mode`
 * is on. Tells the user that capture is suspended and points at the two
 * routes out (hotkey or tray). Kept inline rather than a separate file
 * because the rest of Watch is also single-file by design.
 */
function PanicBanner(): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 border-b border-amber-300 bg-amber-100 px-6 py-2 text-[12px] text-amber-900"
      aria-label="watch-panic-banner"
      role="status"
    >
      <Lock className="h-3.5 w-3.5 shrink-0" />
      <span>
        Panic mode active. Window-poll and screenshot capture suspended. Press
        Ctrl+Shift+\ or click the tray to resume.
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Observation row                                                           */
/* -------------------------------------------------------------------------- */

function ObservationRow({
  obs,
  onDelete,
  panicMode,
}: {
  obs: ContextObservation;
  onDelete: (id: string) => void;
  panicMode: boolean;
}): JSX.Element {
  const Icon = sourceIcon(obs.source);
  const rawPrimary =
    obs.url ??
    obs.app_name ??
    (obs.source === 'screenshot' ? 'Screenshot' : 'Untitled');
  const rawSecondary =
    obs.page_title ?? obs.window_title ?? obs.h1 ?? obs.selection ?? null;
  // In panic mode every title + URL is replaced by a fixed censor block.
  // Screenshot thumbnails follow the same rule below (the row only renders
  // an icon + censored text — the dedicated thumbnail substitution shows
  // up for any future inline thumb expansion in this row).
  const primary = panicMode ? PANIC_CENSOR : rawPrimary;
  const secondary = panicMode ? PANIC_CENSOR : rawSecondary;
  return (
    <div
      className="group flex items-start gap-3 border-b border-border/60 px-4 py-3 text-sm"
      aria-label="watch-observation-row"
      data-panic={panicMode ? 'true' : 'false'}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <div
            className={cn(
              'truncate font-medium',
              panicMode && 'font-mono tracking-tight text-muted-foreground',
            )}
            title={panicMode ? 'panic mode — content hidden' : primary}
          >
            {primary}
          </div>
          <div className="shrink-0 text-[11px] text-muted-foreground">
            {relativeOrAbsent(obs.captured_at)}
          </div>
        </div>
        {secondary && (
          <div
            className={cn(
              'mt-0.5 truncate text-xs text-muted-foreground',
              panicMode && 'font-mono',
            )}
            title={panicMode ? 'panic mode — content hidden' : secondary}
          >
            {secondary}
          </div>
        )}
        {panicMode && obs.source === 'screenshot' && (
          <div
            className="mt-2 flex h-16 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground"
            aria-label="watch-panic-thumb"
          >
            panic mode — captures hidden
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDelete(obs.id)}
        className="invisible shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground group-hover:visible"
        aria-label={`watch-delete-${obs.id}`}
        title="Delete observation"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Deliberation row                                                          */
/* -------------------------------------------------------------------------- */

function DeliberationRow({ row }: { row: Deliberation }): JSX.Element {
  const decisionTone = (() => {
    if (row.decision === 'interrupt') return 'bg-red-200 text-red-900';
    if (row.decision === 'wait') return 'bg-slate-200 text-slate-700';
    if (row.status === 'pending') return 'bg-amber-200 text-amber-900';
    return 'bg-muted text-muted-foreground';
  })();
  const decisionLabel =
    row.decision ?? (row.status === 'pending' ? 'pending' : row.status);
  const interrupt = row.interrupter_score ?? 0;
  const wait = row.waiter_score ?? 0;
  return (
    <div
      className="border-b border-border/60 px-4 py-3 text-sm"
      aria-label="watch-deliberation-row"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
            decisionTone,
          )}
        >
          {decisionLabel}
        </span>
        <div className="text-[11px] text-muted-foreground">
          {relativeOrAbsent(row.result_at ?? row.requested_at)}
        </div>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground" title={row.batch_id}>
        Batch {row.batch_id.slice(0, 8)} · {row.observation_ids.length} obs · {row.trigger_reason}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <span>Interrupt</span>
          <span className="tabular-nums">{interrupt.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span>Wait</span>
          <span className="tabular-nums">{wait.toFixed(2)}</span>
        </div>
      </div>
      {row.summary && (
        <div className="mt-2 line-clamp-3 text-xs">{row.summary}</div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function Watch(): JSX.Element {
  const { toast } = useToast();
  const [source, setSource] = useState<SourceFilter>('all');
  const [time, setTime] = useState<TimeFilter>('today');

  const observationsQ = useObservations({
    limit: 100,
    source: source === 'all' ? undefined : source,
    since: sinceIsoFor(time),
  });
  const deliberationsQ = useDeliberations({ limit: 50 });
  const deliberateMut = useDeliberateNow();
  const deleteObsMut = useDeleteObservation();
  // Read panic mode from the same status payload the header pill uses.
  // The query has a 5s refetch interval so a hotkey/tray toggle propagates
  // without user action. Default false until the first response lands.
  const statusQ = useContextStatus();
  const panicMode = statusQ.data?.panic_mode_active === true;

  const observations = useMemo(
    () => observationsQ.data?.observations ?? [],
    [observationsQ.data],
  );
  const deliberations = useMemo(
    () => deliberationsQ.data?.deliberations ?? [],
    [deliberationsQ.data],
  );

  const handleDeliberate = (): void => {
    deliberateMut.mutate(
      { reason: 'manual' },
      {
        onSuccess: (res) => {
          toast({
            title: 'Deliberation requested',
            description: `Batch ${res.batch_id.slice(0, 8)} queued.`,
          });
        },
        onError: (err) => {
          toast({
            title: 'Couldn’t request deliberation',
            description: err.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDelete = (id: string): void => {
    deleteObsMut.mutate(
      { id },
      {
        onError: (err) => {
          toast({
            title: 'Delete failed',
            description: err.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <WatchHeader
        onDeliberate={handleDeliberate}
        deliberating={deliberateMut.isPending}
        panicMode={panicMode}
      />
      {panicMode && <PanicBanner />}

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-6 py-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Source
        </div>
        {SOURCE_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setSource(chip.key)}
            aria-label={`watch-source-${chip.key}`}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              source === chip.key
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent/50',
            )}
          >
            {chip.label}
          </button>
        ))}
        <div className="ml-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Time
        </div>
        {TIME_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setTime(chip.key)}
            aria-label={`watch-time-${chip.key}`}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              time === chip.key
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent/50',
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[3fr_2fr]">
        <section
          className="flex flex-col overflow-hidden border-r border-border"
          aria-label="watch-observation-pane"
        >
          <div className="border-b border-border bg-card px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Observations
          </div>
          <div className="flex-1 overflow-y-auto">
            {observationsQ.isLoading && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                Loading observations…
              </div>
            )}
            {!observationsQ.isLoading && observations.length === 0 && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                No observations in this window. Enable the monitor in Settings
                or trigger a manual capture from the Chrome extension.
              </div>
            )}
            {observations.map((obs) => (
              <ObservationRow
                key={obs.id}
                obs={obs}
                onDelete={handleDelete}
                panicMode={panicMode}
              />
            ))}
          </div>
        </section>

        <section
          className="flex flex-col overflow-hidden"
          aria-label="watch-deliberation-pane"
        >
          <div className="border-b border-border bg-card px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Deliberations
          </div>
          <div className="flex-1 overflow-y-auto">
            {deliberationsQ.isLoading && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                Loading deliberations…
              </div>
            )}
            {!deliberationsQ.isLoading && deliberations.length === 0 && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                No deliberations yet.
              </div>
            )}
            {deliberations.map((row) => (
              <DeliberationRow key={row.id} row={row} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
