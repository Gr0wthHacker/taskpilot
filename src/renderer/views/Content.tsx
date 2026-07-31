/**
 * Content view (`/content`).
 *
 * Publishing pipeline kanban: one column per state, cards per piece. Top bar
 * lets you create a new piece and filter to one business. State transitions
 * fire via the per-card action menu.
 */

import { FileText, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  useAdvanceContent,
  useBusinesses,
  useContentList,
  useCreateContent,
  useDeleteContent,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  ContentPiece,
  ContentState,
} from '@/shared/api-contract';

const STATES: ContentState[] = [
  'draft',
  'deai_checked',
  'atomized',
  'scheduled',
  'published',
  'tracked',
  'skipped',
];

const STATE_LABELS: Record<ContentState, string> = {
  draft: 'Draft',
  deai_checked: 'DEAI-checked',
  atomized: 'Atomized',
  scheduled: 'Scheduled',
  published: 'Published',
  tracked: 'Tracked',
  skipped: 'Skipped',
};

const STATE_NEXT: Record<ContentState, ContentState | null> = {
  draft: 'deai_checked',
  deai_checked: 'atomized',
  atomized: 'scheduled',
  scheduled: 'published',
  published: 'tracked',
  tracked: null,
  skipped: null,
};

function formatRel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const delta = Date.now() - ms;
  const min = Math.round(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/* -------------------------------------------------------------------------- */
/*  Card                                                                      */
/* -------------------------------------------------------------------------- */

function PieceCard({ piece }: { piece: ContentPiece }): JSX.Element {
  const advance = useAdvanceContent();
  const del = useDeleteContent();
  const next = STATE_NEXT[piece.state];
  return (
    <div className="rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary/40">
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold leading-snug">
          {piece.title}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
        {piece.business ? (
          <span className="rounded bg-muted px-1 py-0.5">{piece.business}</span>
        ) : null}
        <span>{formatRel(piece.updated_at)}</span>
        {piece.derivatives.length > 0 ? (
          <span>· {piece.derivatives.length} channel{piece.derivatives.length === 1 ? '' : 's'}</span>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        {next ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 flex-1 text-[11px]"
            onClick={() =>
              advance.mutate({ id: piece.id, body: { to: next } })
            }
            disabled={advance.isPending}
            aria-label={`advance-${piece.id}`}
          >
            → {STATE_LABELS[next]}
          </Button>
        ) : (
          <span className="flex-1 text-[11px] text-muted-foreground">
            Done.
          </span>
        )}
        {piece.state !== 'draft' && piece.state !== 'tracked' ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            onClick={() =>
              advance.mutate({ id: piece.id, body: { to: 'draft' } })
            }
            disabled={advance.isPending}
            aria-label={`rewind-${piece.id}`}
          >
            ↶
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-[11px] text-destructive"
          onClick={() => {
            if (confirm(`Delete "${piece.title}"?`)) {
              del.mutate({ id: piece.id });
            }
          }}
          aria-label={`delete-${piece.id}`}
        >
          ✕
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create dialog                                                             */
/* -------------------------------------------------------------------------- */

function CreateDialog({
  open,
  onOpenChange,
  businesses,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  businesses: Array<{ tag: string; name: string }>;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [business, setBusiness] = useState<string>('');
  const [draft, setDraft] = useState('');
  const create = useCreateContent();

  const submit = (): void => {
    if (title.trim().length === 0) return;
    create.mutate(
      {
        title: title.trim(),
        ...(business ? { business } : { business: null }),
        ...(draft.trim().length > 0 ? { draft_markdown: draft } : {}),
      },
      {
        onSuccess: () => {
          setTitle('');
          setBusiness('');
          setDraft('');
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New content piece</DialogTitle>
          <DialogDescription>
            Starts in `draft`. You can paste the long-form now or add it later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="content-title">Title</Label>
            <Input
              id="content-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="The case for compliance-first oncology marketing"
            />
          </div>
          <div>
            <Label htmlFor="content-business">Business (optional)</Label>
            <Select
              value={business || 'none'}
              onValueChange={(v) => setBusiness(v === 'none' ? '' : v)}
            >
              <SelectTrigger id="content-business">
                <SelectValue placeholder="No business" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No business</SelectItem>
                {businesses.map((b) => (
                  <SelectItem key={b.tag} value={b.tag}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="content-draft">Draft (optional)</Label>
            <Textarea
              id="content-draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              placeholder="Paste or sketch the long-form here. You can refine later."
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={title.trim().length === 0 || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create piece'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function Content(): JSX.Element {
  const q = useContentList();
  const businessesQ = useBusinesses();
  const [createOpen, setCreateOpen] = useState(false);
  const [businessFilter, setBusinessFilter] = useState<string>('');

  const businesses = businessesQ.data?.businesses ?? [];

  const filtered = useMemo(() => {
    const all = q.data?.pieces ?? [];
    return businessFilter
      ? all.filter((p) => p.business === businessFilter)
      : all;
  }, [q.data, businessFilter]);

  const columns = useMemo(() => {
    const by: Record<ContentState, ContentPiece[]> = {
      draft: [],
      deai_checked: [],
      atomized: [],
      scheduled: [],
      published: [],
      tracked: [],
      skipped: [],
    };
    for (const p of filtered) by[p.state].push(p);
    return by;
  }, [filtered]);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-content">
      <ViewHeader
        title="Content"
        subtitle="Long-form → DEAI → atomized → scheduled → published → tracked."
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={businessFilter || 'all'}
              onValueChange={(v) => setBusinessFilter(v === 'all' ? '' : v)}
            >
              <SelectTrigger className="h-8 w-[180px] text-xs" aria-label="content-business-filter">
                <SelectValue placeholder="All businesses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All businesses</SelectItem>
                {businesses.map((b) => (
                  <SelectItem key={b.tag} value={b.tag}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              onClick={() => setCreateOpen(true)}
              aria-label="new-content-piece"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> New piece
            </Button>
          </div>
        }
      />

      <div className="flex-1 overflow-auto px-4 py-3">
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No content pieces yet"
            description={
              businessFilter
                ? `No pieces for "${businessFilter}". Switch the filter or create a new one.`
                : 'Start one with the New piece button. Each piece walks the state machine; advance moves it forward, ↶ rewinds to draft.'
            }
            ariaLabel="content-empty"
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            {STATES.map((s) => (
              <div
                key={s}
                className={cn(
                  'flex min-w-0 flex-col gap-2 rounded-md bg-muted/30 p-2',
                )}
                aria-label={`content-column-${s}`}
              >
                <div className="flex items-center justify-between px-1 text-xs font-semibold">
                  <span>{STATE_LABELS[s]}</span>
                  <span className="text-muted-foreground">{columns[s].length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {columns[s].length === 0 ? (
                    <div className="rounded border border-dashed border-border/60 p-2 text-[11px] text-muted-foreground">
                      Empty
                    </div>
                  ) : (
                    columns[s].map((p) => <PieceCard key={p.id} piece={p} />)
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        businesses={businesses}
      />
    </div>
  );
}
