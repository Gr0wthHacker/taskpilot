/**
 * Decision log (Wave 16).
 *
 * Renders a task's append-only decision log — newest-first — with a compact
 * "+ Add note" form. Claude writes entries during execute; the user adds
 * their own here. Entries are never edited in place; the only mutation
 * besides create is delete (a small trash affordance per row).
 *
 * Design notes:
 *   - aria-label `task-decision-log` on the root per spec.
 *   - Each category gets a Lucide icon + color so the log is scannable.
 *   - The add form is collapsed to a single "+ Add note" button until the
 *     user opens it, keeping the panel quiet when they're just reading.
 */

import {
  BookOpen,
  GitBranch,
  Link2,
  Lightbulb,
  AlertTriangle,
  StickyNote,
  Plus,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  useCreateDecision,
  useDeleteDecision,
  useTaskDecisions,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { DecisionCategory, DecisionEntry } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Category metadata                                                         */
/* -------------------------------------------------------------------------- */

const CATEGORY_ORDER: readonly DecisionCategory[] = [
  'decision',
  'rationale',
  'context',
  'reference',
  'risk',
  'note',
];

const CATEGORY_ICONS: Record<DecisionCategory, LucideIcon> = {
  decision: GitBranch,
  context: BookOpen,
  reference: Link2,
  rationale: Lightbulb,
  risk: AlertTriangle,
  note: StickyNote,
};

const CATEGORY_COLORS: Record<DecisionCategory, string> = {
  decision: 'text-indigo-500',
  context: 'text-sky-500',
  reference: 'text-cyan-500',
  rationale: 'text-amber-500',
  risk: 'text-red-500',
  note: 'text-muted-foreground',
};

const CATEGORY_LABELS: Record<DecisionCategory, string> = {
  decision: 'Decision',
  context: 'Context',
  reference: 'Reference',
  rationale: 'Rationale',
  risk: 'Risk',
  note: 'Note',
};

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
  entry: DecisionEntry;
  onDelete: (id: string) => void;
  deleting: boolean;
}

function Row({ entry, onDelete, deleting }: RowProps): JSX.Element {
  const category = (CATEGORY_ICONS[entry.category] ? entry.category : 'note') as
    DecisionCategory;
  const Icon = CATEGORY_ICONS[category];
  return (
    <li
      className="group flex items-start gap-3 border-b border-border/60 py-2 last:border-0"
      aria-label={`decision-entry-${entry.id}`}
    >
      <div className={cn('mt-0.5 shrink-0', CATEGORY_COLORS[category])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABELS[category]}
          </span>
          <span
            className="text-[10px] tabular-nums text-muted-foreground"
            title={absoluteLabel(entry.created_at)}
          >
            {relativeLabel(entry.created_at)}
          </span>
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
            {entry.author}
          </span>
          <button
            type="button"
            onClick={() => onDelete(entry.id)}
            disabled={deleting}
            className="ml-auto text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 disabled:opacity-40"
            aria-label={`decision-delete-${entry.id}`}
            title="Delete entry"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">
          {entry.text}
        </p>
        {entry.link && (
          <a
            href={entry.link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-flex items-center gap-1 break-all text-[11px] text-primary hover:underline"
            aria-label={`decision-link-${entry.id}`}
          >
            <Link2 className="h-3 w-3" aria-hidden="true" />
            {entry.link}
          </a>
        )}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Add form                                                                  */
/* -------------------------------------------------------------------------- */

interface AddFormProps {
  taskId: string;
  onClose: () => void;
}

function AddForm({ taskId, onClose }: AddFormProps): JSX.Element {
  const [category, setCategory] = useState<DecisionCategory>('note');
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const createMut = useCreateDecision();

  const canSubmit = text.trim().length > 0 && !createMut.isPending;

  const submit = (): void => {
    if (!canSubmit) return;
    createMut.mutate(
      {
        taskId,
        body: {
          category,
          text: text.trim(),
          ...(link.trim().length > 0 ? { link: link.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          setText('');
          setLink('');
          setCategory('note');
          onClose();
        },
      },
    );
  };

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
      aria-label="decision-add-form"
    >
      <div className="flex items-center gap-2">
        <label
          htmlFor="decision-category"
          className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          Category
        </label>
        <select
          id="decision-category"
          value={category}
          onChange={(e) => setCategory(e.target.value as DecisionCategory)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          aria-label="decision-category-select"
        >
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What was decided, the context, a risk to watch…"
        rows={3}
        className="text-sm"
        aria-label="decision-text-input"
      />
      <Input
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="Optional link (URL or file path)"
        className="text-xs"
        aria-label="decision-link-input"
      />
      {createMut.isError && (
        <p className="text-[11px] text-destructive" role="alert">
          {createMut.error instanceof Error
            ? createMut.error.message
            : 'Failed to add note'}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="decision-cancel"
        >
          <X className="mr-1 h-3 w-3" aria-hidden="true" />
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={!canSubmit}
          aria-label="decision-submit"
        >
          <Plus className="mr-1 h-3 w-3" aria-hidden="true" />
          Add note
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export interface DecisionLogProps {
  taskId: string;
}

export function DecisionLog({ taskId }: DecisionLogProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const decisionsQ = useTaskDecisions(taskId);
  const deleteMut = useDeleteDecision();

  const entries = decisionsQ.data?.decisions ?? [];

  const handleDelete = (id: string): void => {
    deleteMut.mutate({ id, taskId });
  };

  return (
    <div className="space-y-3" aria-label="task-decision-log">
      {decisionsQ.isLoading ? (
        <div className="text-xs text-muted-foreground">Loading decisions…</div>
      ) : decisionsQ.isError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          Failed to load decision log:{' '}
          {decisionsQ.error instanceof Error
            ? decisionsQ.error.message
            : 'Unknown error'}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No decisions logged yet.
        </div>
      ) : (
        <ul className="flex flex-col" aria-label="decision-list">
          {entries.map((entry) => (
            <Row
              key={entry.id}
              entry={entry}
              onDelete={handleDelete}
              deleting={
                deleteMut.isPending && deleteMut.variables?.id === entry.id
              }
            />
          ))}
        </ul>
      )}

      {adding ? (
        <AddForm taskId={taskId} onClose={() => setAdding(false)} />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAdding(true)}
          aria-label="decision-add-toggle"
        >
          <Plus className="mr-1 h-3 w-3" aria-hidden="true" />
          Add note
        </Button>
      )}
    </div>
  );
}

export default DecisionLog;
