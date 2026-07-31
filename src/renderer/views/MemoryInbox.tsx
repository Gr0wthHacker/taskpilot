/**
 * Memory inbox — virtualized list of every captured item.
 *
 * The list is cursor-paged via `useMemoryInfinite()`; the visible window is
 * react-virtual so 10k+ items render at constant cost. Filters: status,
 * kind, tag, free-text. Click a row → detail view.
 */

import { Brain, FileText, Globe, Plus, Sparkles, Tag as TagIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { MemoryCaptureDialog } from '@/renderer/components/shared/MemoryCaptureDialog';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import { VirtualList } from '@/renderer/components/shared/VirtualList';
import {
  useMemoryInfinite,
  useMemoryStats,
  type MemoryItemShape,
  type MemoryListFilter,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';

const KIND_ICON: Record<MemoryItemShape['kind'], typeof FileText> = {
  text: FileText,
  url: Globe,
  file: FileText,
};

function MemoryRow({
  item,
  onClick,
}: {
  item: MemoryItemShape;
  onClick: (id: string) => void;
}): JSX.Element {
  const Icon = KIND_ICON[item.kind];
  const headline =
    item.title ??
    item.summary?.slice(0, 120) ??
    (item.kind === 'url' && item.source_url
      ? item.source_url
      : '(no title)');
  return (
    <button
      type="button"
      onClick={() => onClick(item.id)}
      className={cn(
        'group flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors',
        'hover:border-primary/40 hover:bg-card/70',
      )}
      aria-label={`memory-item-${item.id}`}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 truncate text-sm font-medium leading-tight">
          {headline}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
            item.status === 'enriched'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
              : item.status === 'failed'
                ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200'
                : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
          )}
        >
          {item.status === 'raw' ? 'enriching…' : item.status}
        </span>
      </div>
      {item.summary && item.title ? (
        <div className="line-clamp-2 pl-5 text-xs text-muted-foreground">
          {item.summary}
        </div>
      ) : null}
      {item.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 pl-5">
          {item.tags.slice(0, 6).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              <TagIcon className="h-2.5 w-2.5" />
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

export default function MemoryInbox(): JSX.Element {
  const navigate = useNavigate();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'raw' | 'enriched' | 'failed'>(
    'all',
  );
  const [kindFilter, setKindFilter] = useState<'all' | 'text' | 'url' | 'file'>(
    'all',
  );

  const filter = useMemo<MemoryListFilter>(() => {
    const f: MemoryListFilter = { fields: 'summary' };
    if (statusFilter !== 'all') f.status = statusFilter;
    if (kindFilter !== 'all') f.kind = kindFilter;
    if (search.trim().length >= 2) f.search = search.trim();
    return f;
  }, [statusFilter, kindFilter, search]);

  const list = useMemoryInfinite(filter);
  const statsQ = useMemoryStats();
  const stats = statsQ.data?.stats;

  // Flatten the infinite-query pages into a single array for the virtual list.
  const items = useMemo(() => {
    const pages = list.data?.pages ?? [];
    return pages.flatMap((p) => p.items);
  }, [list.data]);

  const handleClick = (id: string): void => {
    navigate(`/memory/${id}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-memory">
      <ViewHeader
        title="Memory"
        subtitle={
          stats
            ? `${stats.total} captured · ${stats.enriched} enriched · ${stats.raw} pending`
            : 'AI-enriched dump for anything you want to remember'
        }
        actions={
          <Button
            size="sm"
            onClick={() => setCaptureOpen(true)}
            aria-label="memory-new-capture"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Capture
          </Button>
        }
      />

      <div className="flex items-center gap-2 border-b border-border px-6 py-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memory…"
          className="h-8 w-64 text-sm"
          aria-label="memory-search-input"
        />
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as never)}>
          <SelectTrigger className="h-8 w-[120px] text-xs" aria-label="memory-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="raw">Pending</SelectItem>
            <SelectItem value="enriched">Enriched</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as never)}>
          <SelectTrigger className="h-8 w-[110px] text-xs" aria-label="memory-kind-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            <SelectItem value="text">Text</SelectItem>
            <SelectItem value="url">URL</SelectItem>
            <SelectItem value="file">File</SelectItem>
          </SelectContent>
        </Select>
        {list.hasNextPage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="ml-auto h-8 text-xs"
            aria-label="memory-load-more"
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 px-6 py-4">
        {list.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading memory…</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Brain}
            title="Nothing captured yet"
            description="Capture text, URLs, or files. Claude summarises and links them in the background so you can search later."
            ariaLabel="memory-empty"
            action={
              <Button onClick={() => setCaptureOpen(true)}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                Capture your first item
              </Button>
            }
          />
        ) : (
          <VirtualList
            items={items}
            estimateSize={() => 84}
            getKey={(item) => item.id}
            className="h-full"
            ariaLabel="memory-list"
            renderRow={(item) => (
              <div className="pb-2">
                <MemoryRow item={item} onClick={handleClick} />
              </div>
            )}
          />
        )}
      </div>

      <MemoryCaptureDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
      />
    </div>
  );
}
