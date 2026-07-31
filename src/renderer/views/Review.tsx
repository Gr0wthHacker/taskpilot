/**
 * Review queue view.
 *
 * A task lands here when it needs a human decision before the pipeline moves:
 *  - A derivation proposal awaiting approval ("derivation")
 *  - An execution result the agent flagged for review ("result")
 *  - A task that failed and needs triage ("failed")
 *
 * Each row shows the title, parent breadcrumb, reason chip, and a short
 * preview of the source so the reviewer can decide without leaving the page.
 * Inline buttons drive the per-row decision; bulk select + bulk approve/reject
 * lets the reviewer clear a backlog quickly.
 */

import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  PlayCircle,
  RotateCw,
  Sparkles,
  User,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AgentsTabs } from '@/renderer/components/AgentsTabs';
import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { ConfidenceBadge } from '@/renderer/components/shared/ConfidenceBadge';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  TaskStatusBadge,
  AgentMethodBadge,
} from '@/renderer/components/shared/StatusBadge';
import {
  useApproveReview,
  useRejectReview,
  useRejectTask,
  useReviewQueue,
  type ReviewItem,
  type ReviewReason,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';

type FilterValue = 'all' | ReviewReason;

const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'derivation', label: 'Derivation' },
  { value: 'result', label: 'Result' },
  { value: 'failed', label: 'Failed' },
];

const REASON_LABELS: Record<ReviewReason, string> = {
  derivation: 'Derivation',
  result: 'Result',
  failed: 'Failed',
};

const REASON_CLASS: Record<ReviewReason, string> = {
  derivation:
    'bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-200',
  result:
    'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200',
  failed:
    'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
};

function ReasonChip({ reason }: { reason: ReviewReason }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
        REASON_CLASS[reason],
      )}
      aria-label={`review-reason-${reason}`}
    >
      {REASON_LABELS[reason]}
    </span>
  );
}

interface ReviewRowProps {
  item: ReviewItem;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onApprove: (item: ReviewItem) => Promise<void>;
  onReject: (item: ReviewItem) => Promise<void>;
  onRequeue: (item: ReviewItem) => Promise<void>;
  busy: boolean;
}

function ReviewRow({
  item,
  selected,
  onToggleSelect,
  onOpen,
  onApprove,
  onReject,
  onRequeue,
  busy,
}: ReviewRowProps): JSX.Element {
  const {
    task,
    reason,
    parent,
    source_preview: preview,
    confidence,
    confidence_threshold: confidenceThreshold,
    low_confidence: lowConfidence,
    flag_label: flagLabel,
    derivatives,
  } = item;
  const requeueLabel = reason === 'derivation' ? 'Re-derive' : 'Re-execute';
  const [expanded, setExpanded] = useState(false);

  // What the expand toggle reveals: the proposed sub-tasks for a derivation,
  // or the full (un-clamped) output for a result/failure. Only offer the
  // toggle when there's more to show than the collapsed preview already gives.
  const hasDerivativeList = reason === 'derivation' && (derivatives?.length ?? 0) > 0;
  const hasLongPreview = reason !== 'derivation' && preview.length > 140;
  const canExpand = hasDerivativeList || hasLongPreview;

  return (
    <li
      className={cn(
        'group flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3 transition-colors',
        selected && 'border-primary/60 bg-primary/5',
      )}
      aria-label={`review-row-${task.id}`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(task.id)}
          aria-label={`review-select-${task.id}`}
          className="mt-1 h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-1 focus:ring-ring"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ReasonChip reason={reason} />
            {flagLabel && (
              <span
                className={cn(
                  'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
                  lowConfidence
                    ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200'
                    : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
                )}
                aria-label={`review-flag-${task.id}`}
              >
                {flagLabel}
              </span>
            )}
            {confidence !== null && (
              <ConfidenceBadge
                value={confidence}
                threshold={confidenceThreshold}
              />
            )}
            <TaskStatusBadge status={task.status} />
            <AgentMethodBadge method={task.agent_method} />
          </div>

          <button
            type="button"
            onClick={() => onOpen(task.id)}
            className="mt-1 block w-full truncate text-left text-sm font-medium hover:underline"
            title={task.title}
            aria-label={`review-open-${task.id}`}
          >
            {task.title}
          </button>

          {parent && (
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <span>Parent:</span>
              <button
                type="button"
                className="inline-flex items-center gap-0.5 hover:underline"
                onClick={() => onOpen(parent.id)}
                aria-label={`review-open-parent-${parent.id}`}
              >
                <span className="max-w-[18rem] truncate">{parent.title}</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}

          <p
            className={cn(
              'mt-1.5 whitespace-pre-wrap break-words text-xs text-muted-foreground',
              !expanded && 'line-clamp-2',
            )}
            aria-label={`review-preview-${task.id}`}
          >
            {preview}
          </p>

          {expanded && hasDerivativeList && (
            <ul
              className="mt-2 space-y-1 rounded-md border border-border bg-background/60 p-2"
              aria-label={`review-derivatives-${task.id}`}
            >
              {derivatives!.map((d, i) => (
                <li
                  key={`${d.title}-${i}`}
                  className="flex items-center gap-2 text-xs"
                >
                  {d.agent_method === 'human_only' ? (
                    <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <Bot className="h-3 w-3 shrink-0 text-primary" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {d.agent_method.replace('_', ' ')}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              aria-label={`review-expand-${task.id}`}
              aria-expanded={expanded}
            >
              <ChevronDown
                className={cn(
                  'h-3 w-3 transition-transform',
                  expanded && 'rotate-180',
                )}
              />
              {expanded
                ? 'Hide details'
                : hasDerivativeList
                  ? `Show ${derivatives!.length} sub-task${derivatives!.length === 1 ? '' : 's'}`
                  : 'Show full output'}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onOpen(task.id)}
          aria-label={`review-detail-${task.id}`}
        >
          <Eye className="mr-1 h-3.5 w-3.5" />
          Open
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void onRequeue(item);
          }}
          disabled={busy}
          aria-label={`review-requeue-${task.id}`}
        >
          {reason === 'derivation' ? (
            <Sparkles className="mr-1 h-3.5 w-3.5" />
          ) : (
            <PlayCircle className="mr-1 h-3.5 w-3.5" />
          )}
          {requeueLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void onReject(item);
          }}
          disabled={busy}
          className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-950/30"
          aria-label={`review-reject-${task.id}`}
        >
          <XCircle className="mr-1 h-3.5 w-3.5" />
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void onApprove(item);
          }}
          disabled={busy}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
          aria-label={`review-approve-${task.id}`}
        >
          <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
          Approve
        </Button>
      </div>
    </li>
  );
}

export default function Review(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [filter, setFilter] = useState<FilterValue>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const queueQ = useReviewQueue(filter);
  const approve = useApproveReview();
  const reject = useRejectReview();
  // `rejectTask` hits /api/tasks/:id/reject which accepts {kind, requeue}.
  // We use it for the "Re-derive / Re-execute" path so the server can clear
  // the review marker atomically instead of racing a fresh derive/execute
  // against a still-present pending review.
  const rejectTask = useRejectTask();

  const items = queueQ.data?.items ?? [];
  const totalCount = items.length;

  const counts = useMemo(() => {
    const c = { derivation: 0, result: 0, failed: 0 } as Record<
      ReviewReason,
      number
    >;
    for (const i of items) c[i.reason] += 1;
    return c;
  }, [items]);

  const busy =
    approve.isPending || reject.isPending || rejectTask.isPending;

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = (): void => setSelected(new Set());

  const handleOpen = (id: string): void => {
    navigate(`/task/${id}`);
  };

  const handleApprove = async (item: ReviewItem): Promise<void> => {
    try {
      await approve.mutateAsync({ id: item.task.id });
      toast({
        title: 'Approved',
        description: item.task.title,
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(item.task.id);
        return next;
      });
    } catch (cause) {
      toast({
        title: 'Approve failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleReject = async (item: ReviewItem): Promise<void> => {
    try {
      await reject.mutateAsync({ id: item.task.id });
      toast({
        title: 'Rejected',
        description: item.task.title,
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(item.task.id);
        return next;
      });
    } catch (cause) {
      toast({
        title: 'Reject failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleRequeue = async (item: ReviewItem): Promise<void> => {
    // Re-queue is "reject this review and ask the server to rebuild from
    // scratch". The server clears the review marker when we set
    // requeue:true, which avoids the race we used to hit by firing
    // derive/execute directly without first rejecting.
    const kind: 'derivation' | 'result' =
      item.reason === 'derivation' ? 'derivation' : 'result';
    try {
      await rejectTask.mutateAsync({
        id: item.task.id,
        body: { kind, requeue: true },
      });
      toast({
        title:
          item.reason === 'derivation'
            ? 'Re-derivation requested'
            : 'Re-execution requested',
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(item.task.id);
        return next;
      });
    } catch (cause) {
      toast({
        title: 'Re-queue failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const runBulk = async (
    action: (item: ReviewItem) => Promise<void>,
    actionLabel: string,
  ): Promise<void> => {
    if (selected.size === 0) return;
    const targets = items.filter((i) => selected.has(i.task.id));
    let ok = 0;
    let failed = 0;
    for (const item of targets) {
      try {
        await action(item);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    clearSelection();
    toast({
      title: `Bulk ${actionLabel} complete`,
      description: `${ok} succeeded${failed > 0 ? `, ${failed} failed` : ''}`,
      variant: failed > 0 ? 'destructive' : 'default',
    });
  };

  const bulkApprove = async (): Promise<void> => {
    await runBulk(async (item) => {
      await approve.mutateAsync({ id: item.task.id });
    }, 'approve');
  };

  const bulkReject = async (): Promise<void> => {
    await runBulk(async (item) => {
      await reject.mutateAsync({ id: item.task.id });
    }, 'reject');
  };

  const hasSelection = selected.size > 0;

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-review">
      <AgentsTabs />
      <ViewHeader
        title="Review"
        subtitle={
          totalCount === 0
            ? 'Nothing awaiting human review.'
            : `${totalCount} item${totalCount === 1 ? '' : 's'} awaiting review`
        }
        actions={
          <>
            <span
              className="inline-flex items-center rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground"
              aria-label="review-count"
            >
              {totalCount} pending
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void queueQ.refetch();
              }}
              aria-label="review-refresh"
            >
              <RotateCw className="mr-1 h-3.5 w-3.5" />
              Refresh
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2" role="tablist">
          {FILTERS.map((f) => {
            const isActive = filter === f.value;
            const count =
              f.value === 'all'
                ? totalCount
                : counts[f.value];
            const tabId = `review-tab-${f.value}`;
            return (
              <button
                key={f.value}
                id={tabId}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="review-tabpanel"
                onClick={() => setFilter(f.value)}
                aria-label={`review-filter-${f.value}`}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                  isActive
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
              >
                <span>{f.label}</span>
                <span className="rounded bg-secondary px-1.5 text-[10px] text-secondary-foreground">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {hasSelection && (
          <div
            className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
            aria-label="review-bulk-actions"
          >
            <div className="text-xs text-muted-foreground">
              {selected.size} selected
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void bulkApprove();
                }}
                disabled={busy}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                aria-label="review-bulk-approve"
              >
                <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                Approve selected
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void bulkReject();
                }}
                disabled={busy}
                className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-950/30"
                aria-label="review-bulk-reject"
              >
                <XCircle className="mr-1 h-3.5 w-3.5" />
                Reject selected
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                aria-label="review-bulk-clear"
              >
                Clear
              </Button>
            </div>
          </div>
        )}
      </ViewHeader>

      <div
        className="flex-1 overflow-auto px-6 py-4"
        role="tabpanel"
        id="review-tabpanel"
        aria-labelledby={`review-tab-${filter}`}
      >
        {queueQ.isLoading && (
          <div className="text-sm text-muted-foreground">Loading review queue…</div>
        )}
        {queueQ.isError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            Couldn’t load the review queue. The server may not be running.
          </div>
        )}
        {!queueQ.isLoading && !queueQ.isError && items.length === 0 && (
          <EmptyState
            icon={CheckCircle2}
            tone="positive"
            title="All clear."
            description="Approved work is the most rewarding work."
            ariaLabel="review-empty"
          />
        )}

        {items.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="review-list">
            {items.map((item) => (
              <ReviewRow
                key={item.task.id}
                item={item}
                selected={selected.has(item.task.id)}
                onToggleSelect={toggleSelect}
                onOpen={handleOpen}
                onApprove={handleApprove}
                onReject={handleReject}
                onRequeue={handleRequeue}
                busy={busy}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
