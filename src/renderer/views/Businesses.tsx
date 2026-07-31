/**
 * Businesses view (`/businesses`).
 *
 * One row per configured business from `~/.taskpilot/projects.json`. Each
 * row expands to show the live status snapshot: headline, next steps, open
 * tasks, recent decisions, mapped Claude sessions, and the cross-session
 * update feed. A "Log update" button lets you append a delta inline so it's
 * visible to the next Claude session you open.
 *
 * The view is read-mostly — most data is derived. The only mutation is
 * recording a status update (`POST /api/businesses/:tag/update`), which the
 * server uses to re-render the cached STATUS.md.
 */

import { Briefcase, ChevronDown, MessageSquarePlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Textarea } from '@/renderer/components/ui/textarea';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  useBusiness,
  useBusinesses,
  usePostBusinessUpdate,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  BusinessOverviewEntry,
  BusinessSnapshot,
  LastInteractionKind,
} from '@/shared/api-contract';

const LAST_INTERACTION_LABEL: Record<LastInteractionKind, string> = {
  chat: 'chat',
  code: 'code',
  status_delta: 'status',
  decision: 'decision',
  task: 'task',
  none: '—',
};

const LAST_INTERACTION_STYLE: Record<LastInteractionKind, string> = {
  chat: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  code: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  status_delta: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  decision: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  task: 'bg-muted text-muted-foreground',
  none: 'bg-muted/40 text-muted-foreground',
};

/* -------------------------------------------------------------------------- */
/*  Date helpers                                                              */
/* -------------------------------------------------------------------------- */

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const delta = Date.now() - ms;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/* -------------------------------------------------------------------------- */
/*  Snapshot panel                                                            */
/* -------------------------------------------------------------------------- */

function SnapshotPanel({ tag }: { tag: string }): JSX.Element {
  const q = useBusiness(tag);
  if (q.isLoading) {
    return (
      <div className="px-5 py-4 text-xs text-muted-foreground">Loading…</div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="px-5 py-4 text-xs text-destructive">
        {q.error instanceof Error ? q.error.message : 'Failed to load snapshot'}
      </div>
    );
  }
  const snap: BusinessSnapshot = q.data.snapshot;
  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 lg:grid-cols-2">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Next steps
        </h4>
        <ul className="space-y-1.5 text-sm">
          {snap.next_steps.length === 0 ? (
            <li className="text-muted-foreground">(none suggested)</li>
          ) : (
            snap.next_steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span className="text-foreground">{s.text}</span>
              </li>
            ))
          )}
        </ul>

        <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Open tasks ({snap.task_counts.inbox + snap.task_counts.queued + snap.task_counts.in_progress + snap.task_counts.blocked})
        </h4>
        <ul className="space-y-1 text-sm">
          {snap.open_tasks.slice(0, 6).map((t) => (
            <li key={t.id} className="flex items-start gap-2">
              <span
                className={cn(
                  'mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                  t.priority === 'p0' && 'bg-destructive/15 text-destructive',
                  t.priority === 'p1' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                  t.priority === 'p2' && 'bg-muted text-muted-foreground',
                  t.priority === 'p3' && 'bg-muted/50 text-muted-foreground',
                )}
              >
                {t.priority}
              </span>
              <span className="truncate">{t.title}</span>
            </li>
          ))}
          {snap.open_tasks.length === 0 && (
            <li className="text-muted-foreground">(none open)</li>
          )}
        </ul>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Recent status updates
        </h4>
        <ul className="space-y-2 text-sm">
          {snap.recent_updates.length === 0 ? (
            <li className="text-muted-foreground">(no updates logged yet)</li>
          ) : (
            snap.recent_updates.slice(0, 6).map((u, i) => (
              <li key={i} className="rounded border border-border bg-muted/30 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{formatRelative(u.at)}</span>
                  {u.source ? <span className="truncate">{u.source}</span> : null}
                </div>
                <div className="text-sm">{u.headline}</div>
                {u.what_changed ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {u.what_changed}
                  </div>
                ) : null}
              </li>
            ))
          )}
        </ul>

        {snap.recent_conversations.length > 0 && (
          <>
            <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent Claude sessions
            </h4>
            <ul className="space-y-1 text-sm">
              {snap.recent_conversations.slice(0, 4).map((c) => (
                <li key={c.id} className="truncate text-muted-foreground">
                  <span className="text-foreground">{c.title}</span>{' '}
                  <span className="text-xs">— {formatRelative(c.ended_at)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Row                                                                       */
/* -------------------------------------------------------------------------- */

interface RowProps {
  entry: BusinessOverviewEntry;
  expanded: boolean;
  onToggle: () => void;
  onLogUpdate: () => void;
}

function Row({ entry, expanded, onToggle, onLogUpdate }: RowProps): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`business-row-${entry.tag}`}
        aria-expanded={expanded}
      >
        <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{entry.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tracking-tight text-muted-foreground">
              {entry.tag}
            </span>
            {entry.last_touched_at ? (
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-tight',
                  LAST_INTERACTION_STYLE[entry.last_interaction_kind],
                )}
                aria-label={`last-interaction-${entry.tag}`}
                title={`Last touch was a ${LAST_INTERACTION_LABEL[entry.last_interaction_kind]}`}
              >
                {LAST_INTERACTION_LABEL[entry.last_interaction_kind]}
              </span>
            ) : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {entry.headline}
          </div>
        </div>
        <div className="hidden flex-col items-end text-xs text-muted-foreground sm:flex">
          <span>{entry.open_task_count} open</span>
          {entry.overdue_task_count > 0 ? (
            <span className="text-destructive">
              {entry.overdue_task_count} overdue
            </span>
          ) : (
            <span>{formatRelative(entry.last_touched_at)}</span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onLogUpdate();
          }}
          aria-label={`log-update-${entry.tag}`}
        >
          <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
          Log update
        </Button>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {expanded ? <SnapshotPanel tag={entry.tag} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Dialog                                                                    */
/* -------------------------------------------------------------------------- */

function LogUpdateDialog({
  tag,
  name,
  open,
  onOpenChange,
}: {
  tag: string | null;
  name: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}): JSX.Element {
  const [headline, setHeadline] = useState('');
  const [whatChanged, setWhatChanged] = useState('');
  const mutation = usePostBusinessUpdate();

  const submit = (): void => {
    if (!tag || headline.trim().length === 0) return;
    mutation.mutate(
      {
        tag,
        body: {
          headline: headline.trim(),
          ...(whatChanged.trim().length > 0
            ? { what_changed: whatChanged.trim() }
            : {}),
          source: 'taskpilot-ui',
        },
      },
      {
        onSuccess: () => {
          setHeadline('');
          setWhatChanged('');
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log status update — {name}</DialogTitle>
          <DialogDescription>
            One-liner of what changed. Appears in the next session that opens
            via the MCP tool or the STATUS.md file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="biz-update-headline">Headline</Label>
            <Input
              id="biz-update-headline"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Migrated auth middleware to new compliance schema"
            />
          </div>
          <div>
            <Label htmlFor="biz-update-body">What changed (optional)</Label>
            <Textarea
              id="biz-update-body"
              value={whatChanged}
              onChange={(e) => setWhatChanged(e.target.value)}
              placeholder="Replaced session-token storage with the new vault. Next step is migrating the legacy table."
              rows={4}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!tag || headline.trim().length === 0 || mutation.isPending}
          >
            {mutation.isPending ? 'Logging…' : 'Log update'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Top-level view                                                            */
/* -------------------------------------------------------------------------- */

export default function Businesses(): JSX.Element {
  const navigate = useNavigate();
  void navigate; // reserved for future drill-in actions
  const q = useBusinesses();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [logDialog, setLogDialog] = useState<{
    tag: string | null;
    name: string;
  }>({
    tag: null,
    name: '',
  });

  const rows = useMemo(() => q.data?.businesses ?? [], [q.data]);

  const toggle = (tag: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-businesses">
      <ViewHeader
        title="Businesses"
        subtitle="One card per business in projects.json — headline, next steps, and the cross-session status feed."
        actions={
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {rows.length} businesses
          </span>
        }
      />

      <div className="flex-1 overflow-auto px-6 py-4">
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No businesses configured"
            description="Add a `projects` entry under ~/.taskpilot/projects.json with a tag, name, and list of repos to start the status feed."
            ariaLabel="businesses-empty"
          />
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((entry) => (
              <Row
                key={entry.tag}
                entry={entry}
                expanded={expanded.has(entry.tag)}
                onToggle={() => toggle(entry.tag)}
                onLogUpdate={() =>
                  setLogDialog({ tag: entry.tag, name: entry.name })
                }
              />
            ))}
          </div>
        )}
      </div>

      <LogUpdateDialog
        tag={logDialog.tag}
        name={logDialog.name}
        open={logDialog.tag !== null}
        onOpenChange={(v) => {
          if (!v) setLogDialog({ tag: null, name: '' });
        }}
      />
    </div>
  );
}
