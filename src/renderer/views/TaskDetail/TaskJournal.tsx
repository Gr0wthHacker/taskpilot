/**
 * Task journal timeline (Wave 15A).
 *
 * Renders the chronological narrative for a task — every event from every
 * source, in one panel. Slots into TaskDetail between "Execution log" and
 * the Wave 15B "Outputs" panel.
 *
 * Design notes:
 *   - Events are grouped by calendar day with sticky day headers so a long
 *     timeline stays scannable.
 *   - Initial fetch pulls 100 events (newest-first). The "Load more" button
 *     re-issues with a larger limit — append-only timeline, so re-fetching
 *     the wider window is simpler than threading a cursor.
 *   - Each row has an icon mapped from `event.kind` (Lucide), a relative
 *     timestamp with absolute tooltip, and an expandable details block when
 *     `event.details` has anything interesting.
 *   - aria-label `task-journal` per the spec.
 */

import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowDownToLine,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Coins,
  DollarSign,
  ExternalLink,
  FileText,
  FilePlus,
  GitPullRequest,
  Github,
  History,
  Mail,
  MessageSquare,
  NotebookPen,
  PencilLine,
  PlayCircle,
  PlusCircle,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { useTaskJournal } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  JournalEvent,
  JournalEventKind,
} from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  Icon + label mappings                                                     */
/* -------------------------------------------------------------------------- */

const KIND_ICONS: Record<JournalEventKind, typeof Activity> = {
  created: PlusCircle,
  edited: PencilLine,
  status_changed: Activity,
  agent_status_changed: Activity,
  derived: Sparkles,
  execution_started: PlayCircle,
  execution_completed: CheckCircle2,
  result_ingested: ArrowDownToLine,
  attachment_added: FilePlus,
  attachment_removed: FileText,
  feedback: NotebookPen,
  cost: DollarSign,
  pr_event: GitPullRequest,
  issue_event: Github,
  calendar_linked: CalendarClock,
  notion_synced: FileText,
  slack_linked: MessageSquare,
  gmail_linked: Mail,
  child_completed: CheckCircle2,
  archived: Archive,
  unarchived: RotateCcw,
  scheduled: CalendarClock,
  decision: NotebookPen,
};

/**
 * Tailwind text color for the kind's icon. Keeps the timeline scannable —
 * green for completions, red for failures, muted for ambient noise.
 */
const KIND_COLORS: Record<JournalEventKind, string> = {
  created: 'text-emerald-500',
  edited: 'text-muted-foreground',
  status_changed: 'text-muted-foreground',
  agent_status_changed: 'text-muted-foreground',
  derived: 'text-blue-500',
  execution_started: 'text-blue-500',
  execution_completed: 'text-emerald-500',
  result_ingested: 'text-emerald-500',
  attachment_added: 'text-amber-500',
  attachment_removed: 'text-muted-foreground',
  feedback: 'text-amber-500',
  cost: 'text-muted-foreground',
  pr_event: 'text-purple-500',
  issue_event: 'text-purple-500',
  calendar_linked: 'text-sky-500',
  notion_synced: 'text-sky-500',
  slack_linked: 'text-sky-500',
  gmail_linked: 'text-sky-500',
  child_completed: 'text-emerald-500',
  archived: 'text-muted-foreground',
  unarchived: 'text-muted-foreground',
  scheduled: 'text-sky-500',
  decision: 'text-indigo-500',
};

function iconFor(kind: string): typeof Activity {
  return KIND_ICONS[kind as JournalEventKind] ?? History;
}

function colorFor(kind: string): string {
  return KIND_COLORS[kind as JournalEventKind] ?? 'text-muted-foreground';
}

/* -------------------------------------------------------------------------- */
/*  Time helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * "YYYY-MM-DD" key in the user's local timezone, used to bucket events into
 * sticky day headers.
 */
function dayKey(iso: string): string {
  try {
    const d = parseISO(iso);
    if (Number.isNaN(d.getTime())) return 'unknown';
    const pad = (n: number): string => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch {
    return 'unknown';
  }
}

function dayLabel(iso: string): string {
  if (iso === 'unknown') return 'Unknown date';
  try {
    const d = parseISO(iso);
    const now = new Date();
    const sameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  } catch {
    return iso;
  }
}

function relativeLabel(iso: string): string {
  try {
    const d = parseISO(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return formatDistanceToNowStrict(d, { addSuffix: true });
  } catch {
    return iso;
  }
}

function absoluteLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/* -------------------------------------------------------------------------- */
/*  Row                                                                       */
/* -------------------------------------------------------------------------- */

interface RowProps {
  event: JournalEvent;
}

function hasDetailsToShow(event: JournalEvent): boolean {
  if (!event.details) return false;
  if (typeof event.details !== 'object') return false;
  for (const [, v] of Object.entries(event.details)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return true;
  }
  return false;
}

function Row({ event }: RowProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(event.kind);
  const detailsHaveContent = hasDetailsToShow(event);

  let linkNode: ReactNode = null;
  if (event.link?.url) {
    linkNode = (
      <a
        href={event.link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-primary hover:underline"
        aria-label={`journal-event-link-${event.kind}`}
      >
        <ExternalLink className="h-3 w-3" />
        Open
      </a>
    );
  } else if (event.link?.ref) {
    linkNode = (
      <span className="font-mono text-[10px] text-muted-foreground">
        {event.link.ref}
      </span>
    );
  }

  return (
    <li
      className="flex items-start gap-3 border-b border-border/60 py-2 last:border-0"
      aria-label={`journal-event-${event.kind}`}
    >
      <div className={cn('mt-0.5 shrink-0', colorFor(event.kind))}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm text-foreground">{event.title}</span>
          <span
            className="text-[10px] tabular-nums text-muted-foreground"
            title={absoluteLabel(event.at)}
          >
            {relativeLabel(event.at)}
          </span>
          {event.actor && (
            <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
              {event.actor}
            </span>
          )}
          {linkNode && <span className="ml-auto text-[11px]">{linkNode}</span>}
        </div>
        {detailsHaveContent && (
          <button
            type="button"
            onClick={() => setOpen((s) => !s)}
            className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            aria-label={`journal-event-toggle-${event.kind}`}
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {open ? 'Hide details' : 'Show details'}
          </button>
        )}
        {open && detailsHaveContent && (
          <pre
            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-1 text-[10px] text-muted-foreground"
            aria-label={`journal-event-details-${event.kind}`}
          >
            {JSON.stringify(event.details, null, 2)}
          </pre>
        )}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Day group                                                                 */
/* -------------------------------------------------------------------------- */

interface DayGroup {
  key: string;
  events: JournalEvent[];
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export interface TaskJournalProps {
  taskId: string;
  /** Optional max events to fetch on initial render. Defaults to 100. */
  initialLimit?: number;
}

export function TaskJournal({
  taskId,
  initialLimit = 100,
}: TaskJournalProps): JSX.Element {
  const [limit, setLimit] = useState(initialLimit);
  const journalQ = useTaskJournal(taskId, limit);

  const groups = useMemo<DayGroup[]>(() => {
    const events = journalQ.data?.events ?? [];
    const byDay = new Map<string, JournalEvent[]>();
    for (const ev of events) {
      const k = dayKey(ev.at);
      const bucket = byDay.get(k);
      if (bucket) bucket.push(ev);
      else byDay.set(k, [ev]);
    }
    // Map insertion preserves order — events are already newest-first so the
    // first day inserted is the newest day. Materialize the groups in that
    // order.
    const out: DayGroup[] = [];
    for (const [key, list] of byDay.entries()) {
      out.push({ key, events: list });
    }
    return out;
  }, [journalQ.data]);

  if (journalQ.isLoading) {
    return (
      <div
        className="text-xs text-muted-foreground"
        aria-label="task-journal"
      >
        Loading journal…
      </div>
    );
  }

  if (journalQ.isError) {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        role="alert"
        aria-label="task-journal"
      >
        <AlertCircle className="mr-1 inline h-3 w-3" />
        Failed to load journal:{' '}
        {journalQ.error instanceof Error
          ? journalQ.error.message
          : 'Unknown error'}
      </div>
    );
  }

  const totalEvents = journalQ.data?.events.length ?? 0;
  if (totalEvents === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground"
        aria-label="task-journal"
      >
        Nothing has happened on this task yet.
      </div>
    );
  }

  // We treat "we got back exactly `limit` events" as the signal that more
  // may exist. The server caps at 500, so once we hit that we hide the
  // button instead of letting the user keep pressing.
  const mayHaveMore = totalEvents >= limit && limit < 500;

  return (
    <div className="space-y-3" aria-label="task-journal">
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.key} className="space-y-1">
            <div
              className="sticky top-0 z-10 -mx-1 bg-card/95 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur"
              aria-label={`journal-day-${group.key}`}
            >
              {dayLabel(group.key)}
            </div>
            <ul className="flex flex-col">
              {group.events.map((event, i) => (
                <Row key={`${event.kind}-${event.at}-${i}`} event={event} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {totalEvents} event{totalEvents === 1 ? '' : 's'}
        </span>
        {mayHaveMore && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLimit((n) => Math.min(n + 100, 500))}
            disabled={journalQ.isFetching}
            aria-label="task-journal-load-more"
          >
            <Coins className="mr-1 h-3 w-3" aria-hidden="true" />
            Load more
          </Button>
        )}
      </div>
    </div>
  );
}

export default TaskJournal;
