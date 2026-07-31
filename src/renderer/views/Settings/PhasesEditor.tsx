/**
 * PhasesEditor — Settings → Phases tab (Wave 15).
 *
 * Lets the user inspect, edit, add, delete, and reset the pipeline catalog.
 * Pipelines are a soft signal layered on top of `status`: each task can sit
 * in any phase of whichever pipeline matches its tags. The editor surfaces
 * one card per pipeline with name + description + an orderable phase list +
 * the `applies_to` tag list.
 *
 * Mutation flow:
 *   - GET /api/phases/pipelines on mount (server-side seeded defaults).
 *   - PATCH /api/phases/pipelines/:id for edits, autosaved per pipeline.
 *   - POST /api/phases/pipelines for new entries.
 *   - DELETE /api/phases/pipelines/:id with confirm.
 *   - POST /api/phases/pipelines/reset for the "reset to defaults" button.
 */

import {
  ArrowDown,
  ArrowUp,
  Copy,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';

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
import { TagInput } from '@/renderer/components/shared/TagInput';
import { Textarea } from '@/renderer/components/ui/textarea';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useCreatePipeline,
  useDeletePipeline,
  usePipelines,
  useResetPipelines,
  useUpdatePipeline,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { PhaseDefinition, Pipeline } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function makeUniqueId(base: string, taken: Set<string>): string {
  const slug = slugify(base) || 'phase';
  if (!taken.has(slug)) return slug;
  let i = 2;
  while (taken.has(`${slug}-${i}`)) i += 1;
  return `${slug}-${i}`;
}

function blankPhase(name: string, taken: Set<string>): PhaseDefinition {
  return {
    id: makeUniqueId(name, taken),
    name,
  };
}

function blankPipeline(taken: Set<string>): Pipeline {
  return {
    id: makeUniqueId('pipeline', taken),
    name: 'New pipeline',
    description: '',
    phases: [
      { id: 'todo', name: 'Todo' },
      { id: 'doing', name: 'Doing' },
      { id: 'done', name: 'Done', is_terminal: true },
    ],
    applies_to: { tags: [], workspaces: [] },
  };
}

/* -------------------------------------------------------------------------- */
/*  Editor                                                                    */
/* -------------------------------------------------------------------------- */

export function PhasesEditor(): JSX.Element {
  const { toast } = useToast();
  const pipelinesQ = usePipelines();
  const createPipeline = useCreatePipeline();
  const updatePipeline = useUpdatePipeline();
  const deletePipeline = useDeletePipeline();
  const resetPipelines = useResetPipelines();

  const pipelines = pipelinesQ.data?.pipelines ?? [];

  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<Pipeline | null>(null);

  const handleNew = (): void => {
    const taken = new Set(pipelines.map((p) => p.id));
    setEditing(blankPipeline(taken));
    setNewOpen(true);
  };

  const handleEdit = (pipeline: Pipeline): void => {
    // Clone so the modal can edit a draft without mutating the cached list.
    setEditing(JSON.parse(JSON.stringify(pipeline)) as Pipeline);
    setNewOpen(true);
  };

  const handleDuplicate = async (pipeline: Pipeline): Promise<void> => {
    const taken = new Set(pipelines.map((p) => p.id));
    const id = makeUniqueId(`${pipeline.id}-copy`, taken);
    const clone: Pipeline = {
      ...JSON.parse(JSON.stringify(pipeline)),
      id,
      name: `${pipeline.name} (copy)`,
      default: false,
    };
    try {
      await createPipeline.mutateAsync(clone);
      toast({ title: 'Pipeline duplicated', description: clone.name });
    } catch (cause) {
      toast({
        title: 'Duplicate failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (pipeline: Pipeline): Promise<void> => {
    const ok = window.confirm(`Delete pipeline "${pipeline.name}"?`);
    if (!ok) return;
    try {
      await deletePipeline.mutateAsync({ id: pipeline.id });
      toast({ title: 'Pipeline deleted', description: pipeline.name });
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleReset = async (): Promise<void> => {
    const ok = window.confirm(
      'Reset all pipelines to defaults? Your custom pipelines will be replaced.',
    );
    if (!ok) return;
    try {
      await resetPipelines.mutateAsync();
      toast({ title: 'Pipelines reset to defaults' });
    } catch (cause) {
      toast({
        title: 'Reset failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleSaveModal = async (pipeline: Pipeline): Promise<void> => {
    const exists = pipelines.some((p) => p.id === pipeline.id);
    try {
      if (exists) {
        await updatePipeline.mutateAsync({ id: pipeline.id, patch: pipeline });
      } else {
        await createPipeline.mutateAsync(pipeline);
      }
      toast({ title: exists ? 'Pipeline updated' : 'Pipeline created' });
      setNewOpen(false);
      setEditing(null);
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div aria-label="settings-phases-editor" className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Pipelines define optional named phases for tasks beyond the broad
        status (inbox/queued/in_progress/done). Each pipeline binds to a set
        of tags or a workspace, or it can be a default that catches everything.
      </div>

      {pipelinesQ.isLoading && (
        <div className="text-xs text-muted-foreground">
          Loading pipelines…
        </div>
      )}

      <ul className="space-y-2" aria-label="pipelines-list">
        {pipelines.map((pipeline) => (
          <li
            key={pipeline.id}
            className="rounded-md border border-border bg-card/40 p-3"
            aria-label={`pipeline-row-${pipeline.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium">{pipeline.name}</div>
                  {pipeline.default && (
                    <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                      default
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {pipeline.id}
                </div>
                {pipeline.description && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pipeline.description}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {pipeline.phases.map((phase, idx) => (
                    <span
                      key={phase.id}
                      className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px]"
                      aria-label={`pipeline-${pipeline.id}-phase-${phase.id}`}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          phase.color ?? 'bg-zinc-400',
                        )}
                      />
                      {idx + 1}. {phase.name}
                      {phase.is_terminal && (
                        <span className="text-muted-foreground">★</span>
                      )}
                    </span>
                  ))}
                </div>
                {pipeline.applies_to?.tags &&
                  pipeline.applies_to.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      <span>tags:</span>
                      {pipeline.applies_to.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-secondary px-1 text-[10px]"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleEdit(pipeline)}
                  aria-label={`pipeline-edit-${pipeline.id}`}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void handleDuplicate(pipeline);
                  }}
                  aria-label={`pipeline-duplicate-${pipeline.id}`}
                >
                  <Copy className="mr-1 h-3 w-3" />
                  Duplicate
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void handleDelete(pipeline);
                  }}
                  aria-label={`pipeline-delete-${pipeline.id}`}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Delete
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleNew}
          aria-label="phases-add-pipeline"
        >
          <Plus className="mr-1 h-4 w-4" />
          New pipeline
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            void handleReset();
          }}
          aria-label="phases-reset-defaults"
        >
          <RotateCcw className="mr-1 h-4 w-4" />
          Reset to defaults
        </Button>
      </div>

      <Dialog
        open={newOpen}
        onOpenChange={(next) => {
          if (!next) {
            setNewOpen(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent
          aria-label="phases-editor-dialog"
          className="max-h-[80vh] overflow-y-auto sm:max-w-[560px]"
        >
          <DialogHeader>
            <DialogTitle>
              {editing && pipelines.some((p) => p.id === editing.id)
                ? 'Edit pipeline'
                : 'New pipeline'}
            </DialogTitle>
            <DialogDescription>
              Configure the ordered list of phases, the tags this pipeline
              applies to, and an optional default fallback.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <PipelineForm
              key={editing.id}
              initial={editing}
              onSave={(updated) => {
                void handleSaveModal(updated);
              }}
              onCancel={() => {
                setNewOpen(false);
                setEditing(null);
              }}
              saving={createPipeline.isPending || updatePipeline.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  PipelineForm — inside the modal                                           */
/* -------------------------------------------------------------------------- */

interface PipelineFormProps {
  initial: Pipeline;
  onSave: (pipeline: Pipeline) => void;
  onCancel: () => void;
  saving: boolean;
}

function PipelineForm({
  initial,
  onSave,
  onCancel,
  saving,
}: PipelineFormProps): JSX.Element {
  const [draft, setDraft] = useState<Pipeline>(() => initial);

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const updatePhase = (
    idx: number,
    patch: Partial<PhaseDefinition>,
  ): void => {
    setDraft((s) => {
      const next = s.phases.slice();
      const cur = next[idx];
      if (!cur) return s;
      next[idx] = { ...cur, ...patch };
      return { ...s, phases: next };
    });
  };

  const movePhase = (idx: number, dir: -1 | 1): void => {
    setDraft((s) => {
      const next = s.phases.slice();
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= next.length) return s;
      const tmp = next[idx];
      const other = next[targetIdx];
      if (!tmp || !other) return s;
      next[idx] = other;
      next[targetIdx] = tmp;
      return { ...s, phases: next };
    });
  };

  const removePhase = (idx: number): void => {
    setDraft((s) => {
      if (s.phases.length <= 1) return s;
      return { ...s, phases: s.phases.filter((_, i) => i !== idx) };
    });
  };

  const addPhase = (): void => {
    setDraft((s) => {
      const taken = new Set(s.phases.map((p) => p.id));
      const fresh = blankPhase('New phase', taken);
      return { ...s, phases: [...s.phases, fresh] };
    });
  };

  const handleSubmit = (): void => {
    // Re-slug phase ids when missing or duplicate so the backend accepts.
    const taken = new Set<string>();
    const phases = draft.phases.map((phase) => {
      let pid = phase.id || slugify(phase.name);
      if (!pid || taken.has(pid)) {
        pid = makeUniqueId(phase.name || 'phase', taken);
      }
      taken.add(pid);
      return { ...phase, id: pid };
    });
    onSave({ ...draft, phases });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="pipeline-name">Name</Label>
        <Input
          id="pipeline-name"
          value={draft.name}
          onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
          aria-label="pipeline-name-input"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pipeline-description">Description</Label>
        <Textarea
          id="pipeline-description"
          value={draft.description ?? ''}
          onChange={(e) =>
            setDraft((s) => ({ ...s, description: e.target.value }))
          }
          rows={2}
          aria-label="pipeline-description-input"
        />
      </div>

      <div className="space-y-1.5">
        <Label>Phases</Label>
        <ul className="space-y-2" aria-label="pipeline-phases-list">
          {draft.phases.map((phase, idx) => (
            <li
              key={`${phase.id}-${idx}`}
              className="rounded-md border border-border bg-background/40 p-2"
              aria-label={`pipeline-phase-row-${phase.id}`}
            >
              <div className="flex items-start gap-2">
                <div className="flex flex-col gap-0.5 pt-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5"
                    onClick={() => movePhase(idx, -1)}
                    disabled={idx === 0}
                    aria-label={`pipeline-phase-up-${phase.id}`}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5"
                    onClick={() => movePhase(idx, 1)}
                    disabled={idx === draft.phases.length - 1}
                    aria-label={`pipeline-phase-down-${phase.id}`}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                </div>
                <div className="flex-1 space-y-1">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={phase.name}
                      onChange={(e) =>
                        updatePhase(idx, { name: e.target.value })
                      }
                      placeholder="Name"
                      aria-label={`pipeline-phase-name-${phase.id}`}
                      className="h-7 text-xs"
                    />
                    <Input
                      value={phase.id}
                      onChange={(e) =>
                        updatePhase(idx, { id: slugify(e.target.value) })
                      }
                      placeholder="id-slug"
                      aria-label={`pipeline-phase-id-${phase.id}`}
                      className="h-7 font-mono text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={phase.color ?? ''}
                      onChange={(e) =>
                        updatePhase(idx, { color: e.target.value })
                      }
                      placeholder="bg-blue-500"
                      aria-label={`pipeline-phase-color-${phase.id}`}
                      className="h-7 font-mono text-xs"
                    />
                    <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={Boolean(phase.is_terminal)}
                        onChange={(e) =>
                          updatePhase(idx, {
                            is_terminal: e.target.checked,
                          })
                        }
                        aria-label={`pipeline-phase-terminal-${phase.id}`}
                      />
                      Terminal phase
                    </label>
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="mt-1 h-6 w-6"
                  onClick={() => removePhase(idx)}
                  disabled={draft.phases.length <= 1}
                  aria-label={`pipeline-phase-remove-${phase.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={addPhase}
          aria-label="pipeline-add-phase"
        >
          <Plus className="mr-1 h-3 w-3" />
          Add phase
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label>Applies to tags</Label>
        <TagInput
          value={draft.applies_to?.tags ?? []}
          onChange={(next) =>
            setDraft((s) => ({
              ...s,
              applies_to: {
                ...(s.applies_to ?? {}),
                tags: next,
              },
            }))
          }
          ariaLabel="pipeline-applies-to-tags"
        />
        <div className="text-[11px] text-muted-foreground">
          Tasks matching any of these tags will use this pipeline
          automatically.
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="inline-flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={Boolean(draft.default)}
            onChange={(e) =>
              setDraft((s) => ({ ...s, default: e.target.checked }))
            }
            aria-label="pipeline-default-checkbox"
          />
          Default pipeline (fallback when nothing else matches)
        </label>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          aria-label="pipeline-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={saving || draft.phases.length === 0}
          aria-label="pipeline-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </div>
  );
}

export default PhasesEditor;
