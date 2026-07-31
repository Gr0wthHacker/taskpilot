/**
 * Task link editor (Wave 12 intelligence layer).
 *
 * Three sections — Blocks / Related / Duplicate of — each backed by a
 * task-id list (or single nullable id for duplicate_of). Tasks are picked
 * by typing into a combobox that filters the global task list by title.
 *
 * Renders a panel similar to PermissionsEditor: read the current state via
 * `useTaskLinks`, patch via `useUpdateTaskLinks`. The component never mutates
 * the parent task directly — every change goes through the dedicated links
 * endpoint so the cleanup-on-delete hook stays the only writer.
 */

import { ArrowLeftRight, Ban, Copy as DuplicateIcon, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useTaskLinks,
  useTasksList,
  useUpdateTaskLinks,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { Task, TaskLinks } from '@/shared/types';

interface TaskLinkEditorProps {
  taskId: string;
  className?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function emptyLinks(): TaskLinks {
  return { blocks: [], related: [], duplicate_of: null };
}

function titleFor(tasks: Task[], id: string): string {
  return tasks.find((t) => t.id === id)?.title ?? id;
}

/* -------------------------------------------------------------------------- */
/*  Picker                                                                    */
/* -------------------------------------------------------------------------- */

interface TaskPickerProps {
  excludeIds: ReadonlySet<string>;
  onPick: (id: string) => void;
  placeholder?: string;
  ariaLabel: string;
}

function TaskPicker({
  excludeIds,
  onPick,
  placeholder,
  ariaLabel,
}: TaskPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const tasksQ = useTasksList({});
  const tasks = tasksQ.data?.tasks ?? [];

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return tasks
      .filter((t) => !excludeIds.has(t.id))
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [query, tasks, excludeIds]);

  const handlePick = (id: string): void => {
    onPick(id);
    setQuery('');
  };

  return (
    <div className="relative" aria-label={ariaLabel}>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder ?? 'Search tasks…'}
        className="h-8 text-xs"
      />
      {matches.length > 0 && (
        <ul
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-lg"
          role="listbox"
          aria-label={`${ariaLabel}-results`}
        >
          {matches.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => handlePick(t.id)}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent/40"
                aria-label={`${ariaLabel}-pick-${t.id}`}
              >
                <span className="truncate">{t.title}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {t.id}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Chip row                                                                  */
/* -------------------------------------------------------------------------- */

interface ChipRowProps {
  ids: string[];
  tasks: Task[];
  onRemove: (id: string) => void;
  ariaLabel: string;
  emptyMessage: string;
}

function ChipRow({
  ids,
  tasks,
  onRemove,
  ariaLabel,
  emptyMessage,
}: ChipRowProps): JSX.Element {
  if (ids.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] italic text-muted-foreground"
        aria-label={`${ariaLabel}-empty`}
      >
        {emptyMessage}
      </div>
    );
  }
  return (
    <ul
      className="flex flex-wrap gap-1.5"
      role="list"
      aria-label={ariaLabel}
    >
      {ids.map((id) => (
        <li
          key={id}
          className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
          aria-label={`${ariaLabel}-chip-${id}`}
        >
          <span className="max-w-[220px] truncate">{titleFor(tasks, id)}</span>
          <button
            type="button"
            onClick={() => onRemove(id)}
            className="rounded-sm hover:bg-secondary-foreground/10"
            aria-label={`${ariaLabel}-remove-${id}`}
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Editor                                                                    */
/* -------------------------------------------------------------------------- */

export function TaskLinkEditor({
  taskId,
  className,
}: TaskLinkEditorProps): JSX.Element {
  const { toast } = useToast();
  const linksQ = useTaskLinks(taskId);
  const updateLinks = useUpdateTaskLinks();
  const tasksQ = useTasksList({});
  const tasks = tasksQ.data?.tasks ?? [];

  const links = linksQ.data?.links ?? emptyLinks();
  const blockedBy = linksQ.data?.blocked_by ?? [];

  const excludeBlocks = useMemo(
    () => new Set<string>([taskId, ...links.blocks]),
    [taskId, links.blocks],
  );
  const excludeRelated = useMemo(
    () => new Set<string>([taskId, ...links.related]),
    [taskId, links.related],
  );
  const excludeDuplicate = useMemo(
    () =>
      new Set<string>(
        links.duplicate_of ? [taskId, links.duplicate_of] : [taskId],
      ),
    [taskId, links.duplicate_of],
  );

  const patch = async (
    next: { blocks?: string[]; related?: string[]; duplicate_of?: string | null },
  ): Promise<void> => {
    try {
      await updateLinks.mutateAsync({ id: taskId, patch: next });
    } catch (cause) {
      toast({
        title: 'Link update failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  if (linksQ.isLoading) {
    return (
      <div
        className={cn('text-xs text-muted-foreground', className)}
        aria-label="task-link-editor-loading"
      >
        Loading links…
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-col gap-4', className)}
      aria-label="task-link-editor"
    >
      {/* Blocks ----------------------------------------------------------- */}
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <Ban className="h-3.5 w-3.5 text-amber-500" />
          <Label className="text-xs font-semibold">Blocks</Label>
          <span className="text-[10px] text-muted-foreground">
            This task is blocking…
          </span>
        </div>
        <ChipRow
          ids={links.blocks}
          tasks={tasks}
          ariaLabel="task-link-blocks"
          emptyMessage="No blocked tasks."
          onRemove={(id) =>
            void patch({ blocks: links.blocks.filter((x) => x !== id) })
          }
        />
        <div className="flex items-center gap-2">
          <Plus className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          <TaskPicker
            excludeIds={excludeBlocks}
            ariaLabel="task-link-blocks-picker"
            placeholder="Add a task this blocks…"
            onPick={(id) => void patch({ blocks: [...links.blocks, id] })}
          />
        </div>

        {blockedBy.length > 0 && (
          <div
            className="rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
            aria-label="task-link-blocked-by"
          >
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide">
              Blocked by ({blockedBy.length})
            </div>
            <ul className="space-y-0.5">
              {blockedBy.map((id) => (
                <li key={id} className="truncate">
                  · {titleFor(tasks, id)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Related ---------------------------------------------------------- */}
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <ArrowLeftRight className="h-3.5 w-3.5 text-blue-500" />
          <Label className="text-xs font-semibold">Related</Label>
          <span className="text-[10px] text-muted-foreground">
            See-also pointers, both directions.
          </span>
        </div>
        <ChipRow
          ids={links.related}
          tasks={tasks}
          ariaLabel="task-link-related"
          emptyMessage="No related tasks linked."
          onRemove={(id) =>
            void patch({ related: links.related.filter((x) => x !== id) })
          }
        />
        <div className="flex items-center gap-2">
          <Plus className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          <TaskPicker
            excludeIds={excludeRelated}
            ariaLabel="task-link-related-picker"
            placeholder="Link a related task…"
            onPick={(id) => void patch({ related: [...links.related, id] })}
          />
        </div>
      </div>

      {/* Duplicate of ----------------------------------------------------- */}
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <DuplicateIcon className="h-3.5 w-3.5 text-purple-500" />
          <Label className="text-xs font-semibold">Duplicate of</Label>
          <span className="text-[10px] text-muted-foreground">
            Mark this task as a duplicate of another.
          </span>
        </div>
        {links.duplicate_of ? (
          <div
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            aria-label="task-link-duplicate-of"
          >
            <span className="max-w-[300px] truncate">
              {titleFor(tasks, links.duplicate_of)}
            </span>
            <button
              type="button"
              onClick={() => void patch({ duplicate_of: null })}
              aria-label="task-link-duplicate-clear"
              className="rounded-sm hover:bg-secondary-foreground/10"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Plus
              className="h-3 w-3 text-muted-foreground"
              aria-hidden="true"
            />
            <TaskPicker
              excludeIds={excludeDuplicate}
              ariaLabel="task-link-duplicate-picker"
              placeholder="Pick the original task…"
              onPick={(id) => void patch({ duplicate_of: id })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
