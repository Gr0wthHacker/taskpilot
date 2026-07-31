/**
 * Conversations view (`/conversations`).
 *
 * Lists every ingested Claude Code session with title, project, age,
 * compression state, and topic chips. Click-through opens detail with the
 * digest, linked tasks, and a Compact-now button.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ChevronRight,
  FileText,
  Link as LinkIcon,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import { api } from '@/renderer/lib/api';
import { cn } from '@/renderer/lib/utils';

interface Conversation {
  id: string;
  source: string;
  source_id: string;
  source_path: string | null;
  project_path: string | null;
  title: string | null;
  started_at: string;
  ended_at: string;
  model: string | null;
  message_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  digest: string | null;
  topics: string[];
  key_decisions: string[];
  files_touched: string[];
  compressed_at: string | null;
  archived_at: string | null;
}

interface ListResponse {
  conversations: Conversation[];
}

interface DetailResponse {
  conversation: Conversation;
  links: Array<{
    id: string;
    conversation_id: string;
    task_id: string;
    task_title: string | null;
    kind: string;
    confidence: number;
    created_at: string;
  }>;
}

interface TopicAggregate {
  topic: string;
  conversation_count: number;
  total_tokens: number;
  total_cost_usd: number;
  latest_at: string;
}

interface CompactResponse {
  dispatched: number;
  ingested: number;
  archived: number;
}

interface ReconcileResponse {
  scanned: number;
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatProject(path: string | null): string {
  if (!path) return '(unknown)';
  const segs = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return segs.slice(-2).join('/') || path;
}

type CompressedFilter = 'all' | 'compressed' | 'live';

const AGE_FILTERS: Array<{ key: string; label: string; days: number | null }> = [
  { key: 'all', label: 'Any time', days: null },
  { key: '7d', label: 'Past 7d', days: 7 },
  { key: '30d', label: 'Past 30d', days: 30 },
  { key: '90d', label: 'Past 90d', days: 90 },
];

export default function ConversationsView(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const compressedFilter =
    (searchParams.get('compressed') as CompressedFilter | null) ?? 'all';
  const topicFilter = searchParams.get('topic');
  const ageFilter = searchParams.get('age') ?? 'all';
  const selectedId = searchParams.get('id');

  const patchParams = (patch: Record<string, string | null>): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  };
  const setSearch = (v: string): void => patchParams({ q: v || null });
  const setCompressedFilter = (v: CompressedFilter): void =>
    patchParams({ compressed: v === 'all' ? null : v });
  const setTopicFilter = (v: string | null): void => patchParams({ topic: v });
  const setAgeFilter = (v: string): void =>
    patchParams({ age: v === 'all' ? null : v });
  const setSelectedId = (v: string | null): void => patchParams({ id: v });

  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ['conversations', { search, compressedFilter, topicFilter, ageFilter }],
    queryFn: async (): Promise<ListResponse> => {
      const query: Record<string, string> = {};
      if (search) query.search = search;
      if (compressedFilter === 'compressed') query.compressed = 'true';
      if (compressedFilter === 'live') query.compressed = 'false';
      if (topicFilter) query.topic = topicFilter;
      const result = await api.get<ListResponse>('/api/conversations', query);
      const ageConfig = AGE_FILTERS.find((a) => a.key === ageFilter);
      if (!ageConfig || ageConfig.days === null) return result;
      const cutoff = Date.now() - ageConfig.days * 24 * 60 * 60 * 1000;
      return {
        conversations: result.conversations.filter(
          (c) => new Date(c.ended_at).getTime() >= cutoff,
        ),
      };
    },
  });

  const topicsQuery = useQuery({
    queryKey: ['conversations', 'topics'],
    queryFn: () => api.get<{ topics: TopicAggregate[] }>('/api/conversations/topics'),
  });

  const detailQuery = useQuery({
    queryKey: ['conversations', selectedId],
    queryFn: async (): Promise<DetailResponse> => {
      return api.get<DetailResponse>(`/api/conversations/${selectedId}`);
    },
    enabled: !!selectedId,
  });

  const reconcileMut = useMutation({
    mutationFn: () =>
      api.post<ReconcileResponse>('/api/conversations/reconcile'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const compactMut = useMutation({
    mutationFn: () => api.post<CompactResponse>('/api/conversations/compact'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/conversations/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const recompressMut = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean }>(`/api/conversations/${id}/recompress`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const conversations = listQuery.data?.conversations ?? [];
  const totalTokens = useMemo(
    () =>
      conversations.reduce(
        (acc, c) => acc + (c.input_tokens ?? 0) + (c.output_tokens ?? 0),
        0,
      ),
    [conversations],
  );

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Conversations"
        subtitle="Claude Code sessions ingested from ~/.claude/projects/"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => reconcileMut.mutate()}
              disabled={reconcileMut.isPending}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Reconcile
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => compactMut.mutate()}
              disabled={compactMut.isPending}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Compact now
            </Button>
          </div>
        }
      />

      <div className="border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, digest, topics…"
            className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <select
            value={ageFilter}
            onChange={(e) => setAgeFilter(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {AGE_FILTERS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
          <select
            value={compressedFilter}
            onChange={(e) =>
              setCompressedFilter(e.target.value as CompressedFilter)
            }
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="live">Pre-compression</option>
            <option value="compressed">Compressed</option>
          </select>
          <div className="text-xs text-muted-foreground">
            {conversations.length} session
            {conversations.length === 1 ? '' : 's'} ·{' '}
            {totalTokens.toLocaleString()} tokens
          </div>
        </div>
        {topicFilter && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Filter by topic:</span>
            <button
              onClick={() => setTopicFilter(null)}
              className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-primary hover:bg-primary/25"
            >
              {topicFilter}
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {!topicFilter && topicsQuery.data && topicsQuery.data.topics.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Top topics:</span>
            {topicsQuery.data.topics.slice(0, 12).map((t) => (
              <button
                key={t.topic}
                onClick={() => setTopicFilter(t.topic)}
                className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
              >
                {t.topic}
                <span className="ml-1 opacity-70">{t.conversation_count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid flex-1 grid-cols-[420px_1fr] overflow-hidden">
        <div className="overflow-y-auto border-r">
          {listQuery.isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : conversations.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No conversations yet"
              description="Claude Code sessions land here automatically. Click Reconcile to scan now."
            />
          ) : (
            <ul>
              {conversations.map((c) => (
                <li
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    'cursor-pointer border-b px-4 py-3 hover:bg-muted/50',
                    selectedId === c.id && 'bg-muted',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium leading-tight line-clamp-2">
                      {c.title ?? '(untitled)'}
                    </div>
                    {c.compressed_at && (
                      <Archive
                        className="h-3 w-3 flex-shrink-0 text-muted-foreground"
                        aria-label="Compressed"
                      />
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatProject(c.project_path)}</span>
                    <span>·</span>
                    <span>{relativeAge(c.ended_at)}</span>
                    <span>·</span>
                    <span>{c.message_count} msgs</span>
                  </div>
                  {c.topics.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.topics.slice(0, 5).map((t) => (
                        <span
                          key={t}
                          className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="overflow-y-auto p-6">
          {!selectedId ? (
            <div className="text-sm text-muted-foreground">
              Select a conversation on the left.
            </div>
          ) : detailQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : detailQuery.data ? (
            <ConversationDetail
              data={detailQuery.data}
              onTopicClick={setTopicFilter}
              onDelete={() =>
                detailQuery.data && deleteMut.mutate(detailQuery.data.conversation.id)
              }
              isDeleting={deleteMut.isPending}
              onRecompress={() =>
                detailQuery.data && recompressMut.mutate(detailQuery.data.conversation.id)
              }
              isRecompressing={recompressMut.isPending}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface DetailProps {
  data: DetailResponse;
  onTopicClick: (topic: string) => void;
  onDelete: () => void;
  isDeleting: boolean;
  onRecompress: () => void;
  isRecompressing: boolean;
}

interface TranscriptResponse {
  conversation_id: string;
  total_messages: number;
  offset: number;
  limit: number;
  messages: Array<{
    role: 'user' | 'assistant';
    timestamp: string;
    text: string;
    code_blocks: string[];
    files_touched: string[];
    tool_calls: string[];
  }>;
}

function ConversationDetail({
  data,
  onTopicClick,
  onDelete,
  isDeleting,
  onRecompress,
  isRecompressing,
}: DetailProps): JSX.Element {
  const c = data.conversation;
  const cost = c.cost_usd ? `$${c.cost_usd.toFixed(4)}` : null;
  const [showTranscript, setShowTranscript] = useState(false);
  const transcriptQuery = useQuery({
    queryKey: ['conversations', c.id, 'transcript'],
    queryFn: () =>
      api.get<TranscriptResponse>(`/api/conversations/${c.id}/transcript`, {
        limit: '500',
      }),
    enabled: showTranscript && !!c.source_path,
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{c.title ?? '(untitled)'}</h2>
          <div className="mt-1 text-xs text-muted-foreground">
            {c.source} · {c.source_id} · {formatProject(c.project_path)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {new Date(c.started_at).toLocaleString()} →{' '}
            {new Date(c.ended_at).toLocaleString()} · {c.message_count} messages
            {c.model ? ` · ${c.model}` : ''}
            {cost ? ` · ${cost}` : ''}
          </div>
          {c.compressed_at && (
            <div className="mt-1 inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              <Archive className="h-3 w-3" /> Compressed{' '}
              {relativeAge(c.compressed_at)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {c.compressed_at && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRecompress}
              disabled={isRecompressing}
              title="Re-summarize"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (
                confirm(
                  'Delete this conversation from the catalogue? The on-disk JSONL is not affected.',
                )
              ) {
                onDelete();
              }
            }}
            disabled={isDeleting}
            className="text-red-600 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {c.topics.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Topics
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {c.topics.map((t) => (
              <button
                key={t}
                onClick={() => onTopicClick(t)}
                className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary hover:bg-primary/20"
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {c.key_decisions.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Key decisions ({c.key_decisions.length})
          </div>
          <ul className="mt-1.5 space-y-1 text-sm">
            {c.key_decisions.map((d, i) => (
              <li key={i} className="text-muted-foreground">
                • {d}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.links.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Linked tasks
          </div>
          <ul className="mt-1.5 space-y-1 text-sm">
            {data.links.map((l) => (
              <li key={l.id} className="flex items-center gap-2">
                <LinkIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <a
                  href={`#/task/${l.task_id}`}
                  className="text-primary hover:underline"
                >
                  {l.task_title ?? l.task_id}
                </a>
                <span className="text-xs text-muted-foreground">
                  ({l.kind}, conf {l.confidence.toFixed(2)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.digest && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {c.compressed_at ? 'Summary' : 'Digest'}
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs leading-relaxed">
            {c.digest}
          </pre>
        </div>
      )}

      {c.files_touched.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Files touched
          </div>
          <ul className="mt-1.5 space-y-0.5 font-mono text-xs">
            {c.files_touched.slice(0, 40).map((f) => (
              <li key={f} className="text-muted-foreground">
                {f}
              </li>
            ))}
            {c.files_touched.length > 40 && (
              <li className="text-muted-foreground">
                … and {c.files_touched.length - 40} more
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        source_path:{' '}
        <span className="font-mono">{c.source_path ?? '(archived)'}</span>
      </div>

      {c.source_path && (
        <div className="border-t pt-4">
          <button
            onClick={() => setShowTranscript((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                showTranscript && 'rotate-90',
              )}
            />
            <FileText className="h-3.5 w-3.5" />
            Raw transcript
          </button>
          {showTranscript && (
            <div className="mt-3 space-y-3">
              {transcriptQuery.isLoading && (
                <div className="text-xs text-muted-foreground">Loading…</div>
              )}
              {transcriptQuery.data && (
                <>
                  <div className="text-xs text-muted-foreground">
                    Showing {transcriptQuery.data.messages.length} of{' '}
                    {transcriptQuery.data.total_messages} messages
                  </div>
                  {transcriptQuery.data.messages.map((m, i) => (
                    <div
                      key={i}
                      className="rounded border bg-muted/20 px-3 py-2 text-xs"
                    >
                      <div className="mb-1 flex items-center justify-between font-semibold">
                        <span
                          className={cn(
                            m.role === 'user'
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-emerald-600 dark:text-emerald-400',
                          )}
                        >
                          {m.role}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {new Date(m.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <pre className="whitespace-pre-wrap font-sans leading-relaxed">
                        {m.text}
                      </pre>
                      {m.tool_calls.length > 0 && (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          tools: {m.tool_calls.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
