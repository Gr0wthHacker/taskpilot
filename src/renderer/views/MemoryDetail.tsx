/**
 * Single memory item — summary, raw content, suggested links, edit + delete.
 *
 * SSE invalidation hits `['memory']` on `memory_enriched`, so this page
 * transitions live from `status='raw'` to `status='enriched'` without a
 * reload.
 */

import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  Sparkles,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Textarea } from '@/renderer/components/ui/textarea';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useDeleteMemory,
  useMemoryDetail,
  useRetryMemoryEnrichment,
  useUpdateMemory,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';

export default function MemoryDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const detailQ = useMemoryDetail(id);
  const updateM = useUpdateMemory();
  const deleteM = useDeleteMemory();
  const retryM = useRetryMemoryEnrichment();

  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftTags, setDraftTags] = useState('');

  const item = detailQ.data?.item;
  const links = detailQ.data?.links ?? [];

  const tagPills = useMemo(() => (item?.tags ?? []).slice(0, 16), [item]);

  const startEditing = (): void => {
    if (!item) return;
    setDraftTitle(item.title ?? '');
    setDraftTags(item.tags.join(', '));
    setEditing(true);
  };

  const saveEdit = async (): Promise<void> => {
    if (!item) return;
    const tags = draftTags
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'))
      .filter((t) => t.length > 0 && t.length <= 64)
      .slice(0, 12);
    try {
      await updateM.mutateAsync({
        id: item.id,
        patch: { title: draftTitle.trim() || null, tags },
      });
      setEditing(false);
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const remove = async (): Promise<void> => {
    if (!item) return;
    if (!confirm(`Delete this memory? "${item.title ?? item.summary ?? ''}"`)) return;
    try {
      await deleteM.mutateAsync(item.id);
      navigate('/memory');
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const reEnrich = async (): Promise<void> => {
    if (!item) return;
    try {
      await retryM.mutateAsync(item.id);
      toast({
        title: 'Re-enrichment queued',
        description: 'The next runner pass picks it up.',
      });
    } catch (err) {
      toast({
        title: 'Failed to queue',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  if (detailQ.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (!item) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={() => navigate('/memory')}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to memory
        </Button>
        <p className="mt-6 text-sm text-muted-foreground">
          Memory item not found.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-auto"
      aria-label="view-memory-detail"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/memory')}
            className="-ml-3 h-7 text-xs text-muted-foreground"
          >
            <ArrowLeft className="mr-1 h-3 w-3" /> Memory
          </Button>
          {editing ? (
            <Input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Title"
              className="mt-2 max-w-2xl text-base font-semibold"
              aria-label="memory-detail-title-input"
            />
          ) : (
            <h1 className="mt-1 truncate text-lg font-semibold tracking-tight">
              {item.title ?? item.summary?.slice(0, 120) ?? '(untitled)'}
            </h1>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-md bg-muted px-1.5 py-0.5 uppercase">
              {item.kind}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5',
                item.status === 'enriched'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
                  : item.status === 'failed'
                    ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200'
                    : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
              )}
            >
              {item.status === 'raw' ? 'enriching…' : item.status}
            </span>
            <span>{new Date(item.created_at).toLocaleString()}</span>
            {item.source_url ? (
              <a
                href={item.source_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 truncate text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {item.source_url.replace(/^https?:\/\//, '').slice(0, 60)}
              </a>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => void saveEdit()}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => void reEnrich()}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                Re-enrich
              </Button>
              <Button size="sm" variant="ghost" onClick={startEditing}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove()}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="grid flex-1 min-h-0 gap-6 px-6 py-4 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4 min-w-0">
          {item.summary ? (
            <section className="rounded-md border border-border bg-card p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                Summary
              </div>
              <p className="mt-1.5 text-sm leading-relaxed">{item.summary}</p>
            </section>
          ) : item.status === 'raw' ? (
            <div className="rounded-md border border-dashed border-border bg-card/50 p-3 text-xs text-muted-foreground">
              Waiting for enrichment — Claude will summarise and tag this when
              the next runner picks it up.
            </div>
          ) : item.status === 'failed' && item.enrichment_error ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Enrichment failed</div>
                <div>{item.enrichment_error}</div>
              </div>
            </div>
          ) : null}

          {editing ? (
            <div className="space-y-1.5">
              <Label htmlFor="edit-tags" className="text-xs">
                Tags (comma-separated)
              </Label>
              <Input
                id="edit-tags"
                value={draftTags}
                onChange={(e) => setDraftTags(e.target.value)}
                aria-label="memory-detail-tags-input"
              />
            </div>
          ) : tagPills.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {tagPills.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  <TagIcon className="h-3 w-3" />
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          <section className="rounded-md border border-border bg-card p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Raw content
            </div>
            <Textarea
              value={item.raw_content ?? ''}
              readOnly
              rows={20}
              className="mt-1.5 resize-none border-0 bg-transparent p-0 font-mono text-xs leading-snug shadow-none focus-visible:ring-0"
            />
          </section>
        </div>

        <aside className="space-y-4 min-w-0">
          <section>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Linked
            </div>
            {links.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                No links yet. Enrichment proposes related items; you can also
                manually link from a task detail page.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {links.map((link) => (
                  <li
                    key={link.id}
                    className="rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      className="w-full text-left hover:text-primary"
                      onClick={() => {
                        if (link.target_kind === 'memory') {
                          navigate(`/memory/${link.target_id}`);
                        } else if (link.target_kind === 'task') {
                          navigate(`/task/${link.target_id}`);
                        } else if (link.target_kind === 'goal') {
                          navigate(`/goals/${link.target_id}`);
                        }
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase">
                          {link.target_kind}
                        </span>
                        <span className="truncate font-medium">
                          {link.target_id}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {link.link_kind} · {(link.score * 100).toFixed(0)}%
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {item.entities ? (
            <section>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Entities
              </div>
              <pre className="mt-1.5 max-h-72 overflow-auto rounded-md bg-muted/30 p-2 text-[10px] leading-tight">
                {JSON.stringify(item.entities, null, 2)}
              </pre>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
