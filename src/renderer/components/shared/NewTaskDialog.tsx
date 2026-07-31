/**
 * Reusable dialog for creating a task. Used by the Inbox top bar and any
 * other quick-create surface. Inline validation keeps the contract tight
 * without pulling in a form library.
 */

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { Textarea } from '@/renderer/components/ui/textarea';
import { useToast } from '@/renderer/components/ui/use-toast';
import { MarkdownEditor } from '@/renderer/components/shared/MarkdownEditor';
import { PhasePicker } from '@/renderer/components/shared/PhasePicker';
import { SmartDueInput } from '@/renderer/components/shared/SmartDueInput';
import { TagInput } from '@/renderer/components/shared/TagInput';
import { apiUrl, resolveApiToken } from '@/renderer/lib/api';
import {
  useCreateTask,
  useDefaultTaskInputs,
  useMaterializeTemplate,
  usePipelines,
  useTemplates,
} from '@/renderer/lib/query';
import type {
  AgentMethod,
  CreateTaskInput,
  Pipeline,
  RecurrenceKind,
  RecurrenceRule,
  TaskPriority,
} from '@/shared/types';

const PRIORITIES: Array<{ value: TaskPriority; label: string }> = [
  { value: 'p0', label: 'P0 — Critical' },
  { value: 'p1', label: 'P1 — High' },
  { value: 'p2', label: 'P2 — Normal' },
  { value: 'p3', label: 'P3 — Low' },
];

const METHODS: Array<{ value: AgentMethod; label: string }> = [
  { value: 'human_only', label: 'Human only' },
  { value: 'cowork', label: 'Cowork' },
  { value: 'cli', label: 'Claude Code' },
  { value: 'either', label: 'Either' },
];

type RepeatChoice = 'none' | RecurrenceKind;

const REPEAT_OPTIONS: Array<{ value: RepeatChoice; label: string }> = [
  { value: 'none', label: "Doesn't repeat" },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays (Mon-Fri)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Optional defaults — useful for "new sibling/child" scenarios. */
  defaults?: Partial<CreateTaskInput>;
  onCreated?: (taskId: string) => void;
}

interface FormState {
  title: string;
  description: string;
  priority: TaskPriority;
  /** ISO 8601 string in UTC, or empty when no due date is set. */
  due: string;
  tags: string[];
  agent_method: AgentMethod;
  agent_instructions: string;
  repeat: RepeatChoice;
  repeatInterval: number;
  templateId: string;
  /**
   * Phase id (slug) for the chosen pipeline, or null when unset. The
   * pipeline itself is resolved client-side from {@link usePipelines} by
   * tag overlap whenever the user updates the tags.
   */
  phase: string | null;
  /**
   * Files queued for upload at task-create time. Stored on the form so we
   * can submit them in a second request once the task id exists.
   */
  pendingFiles: File[];
}

/**
 * Pick the pipeline that best matches a draft set of tags. Mirrors the
 * server-side resolver — first tag match wins, falling back to the default.
 */
function pickPipelineForTags(
  pipelines: Pipeline[],
  tags: string[],
): Pipeline | null {
  if (pipelines.length === 0) return null;
  for (const pipeline of pipelines) {
    const wantTags = pipeline.applies_to?.tags;
    if (!wantTags || wantTags.length === 0) continue;
    if (wantTags.some((t) => tags.includes(t))) return pipeline;
  }
  return pipelines.find((p) => p.default) ?? null;
}

/**
 * Upload an array of files against a freshly-created task. Fired right after
 * create succeeds — best-effort: a failure shows a toast but doesn't unwind
 * the task creation. The user can retry from TaskDetail.
 */
async function uploadFilesForTask(
  taskId: string,
  files: File[],
): Promise<{ ok: boolean; message?: string }> {
  if (files.length === 0) return { ok: true };
  const form = new FormData();
  for (const file of files) form.append('file', file, file.name);
  try {
    const url = await apiUrl(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    );
    const token = await resolveApiToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!response.ok) {
      let message = `Upload failed (${response.status})`;
      try {
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        if (body?.error?.message) message = body.error.message;
      } catch {
        /* non-JSON */
      }
      return { ok: false, message };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Upload failed',
    };
  }
}

interface SeededDefaults {
  priority: TaskPriority;
  agent_method: AgentMethod;
}

function initialState(
  defaults: Partial<CreateTaskInput> | undefined,
  seeded: SeededDefaults,
): FormState {
  return {
    title: defaults?.title ?? '',
    description: defaults?.description ?? '',
    priority: defaults?.priority ?? seeded.priority,
    due: defaults?.due ?? '',
    tags: defaults?.tags ?? [],
    agent_method: defaults?.agent_method ?? seeded.agent_method,
    agent_instructions: defaults?.agent_instructions ?? '',
    repeat: 'none',
    repeatInterval: 1,
    templateId: '',
    phase: null,
    pendingFiles: [],
  };
}

/**
 * `form.due` is already an ISO 8601 UTC string (the SmartDueInput resolves
 * the user's natural-language phrase into one), so this is just a guard for
 * the empty case. Kept as a helper so the submit path stays explicit.
 */
function normalizeDue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  defaults,
  onCreated,
}: NewTaskDialogProps): JSX.Element {
  const { defaults: seededDefaults } = useDefaultTaskInputs();
  const [form, setForm] = useState<FormState>(() =>
    initialState(defaults, seededDefaults),
  );
  const [error, setError] = useState<string | null>(null);
  const createTask = useCreateTask();
  const materializeTemplate = useMaterializeTemplate();
  const templatesQ = useTemplates();
  const pipelinesQ = usePipelines();
  const { toast } = useToast();

  const templates = templatesQ.data?.templates ?? [];
  const pipelines = pipelinesQ.data?.pipelines ?? [];
  const matchedPipeline = pickPipelineForTags(pipelines, form.tags);

  // Apply a template's defaults to the form when selected.
  const applyTemplate = (id: string): void => {
    setForm((s) => ({ ...s, templateId: id }));
    if (id === '') return;
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    setForm((s) => ({
      ...s,
      title: template.task_title,
      description: template.task_description ?? '',
      priority: template.priority ?? s.priority,
      agent_method: template.agent_method ?? s.agent_method,
      agent_instructions: template.agent_instructions ?? '',
      tags: template.tags,
    }));
  };

  // Re-seed the form when the dialog opens so the latest persisted defaults
  // win — without stomping mid-edit state (the form is reset on close
  // anyway, so this only fires on open transitions).
  useEffect(() => {
    if (!open) return;
    setForm(initialState(defaults, seededDefaults));
    setError(null);
    // We intentionally depend on `open` so this only fires on open. The
    // settings hook re-renders the dialog on its own when defaults arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seededDefaults.priority, seededDefaults.agent_method]);

  const reset = (): void => {
    setForm(initialState(defaults, seededDefaults));
    setError(null);
  };

  const handleOpenChange = (next: boolean): void => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = async (): Promise<void> => {
    const title = form.title.trim();
    if (title.length === 0) {
      setError('Title is required.');
      return;
    }
    if (title.length > 200) {
      setError('Title must be 200 characters or fewer.');
      return;
    }
    setError(null);

    // Build recurrence rule if a repeat option was chosen.
    let recurrence: RecurrenceRule | null = null;
    if (form.repeat !== 'none') {
      recurrence = {
        kind: form.repeat,
        interval: Math.max(1, Math.floor(form.repeatInterval)),
        occurrences_completed: 0,
      };
    }

    const dueIso = normalizeDue(form.due);
    const context = recurrence
      ? ({ recurrence } as Record<string, unknown>)
      : undefined;

    const body: CreateTaskInput & {
      phase?: string | null;
      pipeline_id?: string | null;
    } = {
      title,
      description: form.description.trim() || null,
      priority: form.priority,
      due: dueIso,
      tags: form.tags,
      agent_method: form.agent_method,
      agent_instructions: form.agent_instructions.trim() || null,
      agent_executable: form.agent_method !== 'human_only',
      ...(context ? { context } : {}),
      ...(form.phase ? { phase: form.phase } : {}),
    };

    try {
      let createdTaskId: string | null = null;
      // If a template is selected and the user hasn't edited away the
      // template's title, prefer materialize so the chain shows up.
      if (form.templateId) {
        const res = await materializeTemplate.mutateAsync({
          id: form.templateId,
          body: {
            overrides: {
              title,
              description: form.description.trim() || null,
              priority: form.priority,
              due: dueIso,
              tags: form.tags,
              agent_method: form.agent_method,
              agent_instructions: form.agent_instructions.trim() || null,
              ...(context ? { context } : {}),
            },
          },
        });
        const created = res.tasks[0];
        toast({ title: 'Task created from template', description: title });
        if (created) {
          createdTaskId = created.id;
          onCreated?.(created.id);
        }
      } else {
        const res = await createTask.mutateAsync(body);
        toast({ title: 'Task created', description: title });
        createdTaskId = res.task.id;
        onCreated?.(res.task.id);
      }
      // Upload any queued files now that the task id exists. Failures are
      // toasted but don't block dialog close — the user can retry from
      // TaskDetail without losing the new task.
      if (createdTaskId && form.pendingFiles.length > 0) {
        const upload = await uploadFilesForTask(
          createdTaskId,
          form.pendingFiles,
        );
        if (!upload.ok) {
          toast({
            title: 'Attachment upload failed',
            description: upload.message ?? 'Try again from the task detail.',
            variant: 'destructive',
          });
        } else {
          toast({
            title:
              form.pendingFiles.length === 1
                ? `Attached 1 file`
                : `Attached ${form.pendingFiles.length} files`,
          });
        }
      }
      reset();
      onOpenChange(false);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Failed to create task';
      setError(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-label="new-task-dialog" className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Drop a task into the inbox. Derive it later for Claude, or keep it
            human-only.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {templates.length > 0 && (
            <div className="space-y-1.5">
              <Label>Start from template</Label>
              <Select
                value={form.templateId || 'none'}
                onValueChange={(v) => applyTemplate(v === 'none' ? '' : v)}
              >
                <SelectTrigger aria-label="new-task-template">
                  <SelectValue placeholder="No template" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No template</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="new-task-title">Title</Label>
            <Input
              id="new-task-title"
              value={form.title}
              onChange={(e) =>
                setForm((s) => ({ ...s, title: e.target.value }))
              }
              placeholder="What needs doing?"
              aria-label="new-task-title"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-task-description">Description</Label>
            <MarkdownEditor
              id="new-task-description"
              value={form.description}
              onChange={(next) =>
                setForm((s) => ({ ...s, description: next }))
              }
              placeholder="Context, links, success criteria…"
              rows={4}
              ariaLabel="new-task-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select
                value={form.priority}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, priority: v as TaskPriority }))
                }
              >
                <SelectTrigger aria-label="new-task-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <SmartDueInput
                id="new-task-due"
                label="Due"
                isoValue={form.due || null}
                onChange={(iso) =>
                  setForm((s) => ({ ...s, due: iso ?? '' }))
                }
                ariaLabel="new-task-due"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Repeat</Label>
              <Select
                value={form.repeat}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, repeat: v as RepeatChoice }))
                }
              >
                <SelectTrigger aria-label="new-task-repeat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPEAT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {form.repeat !== 'none' && (
              <div className="space-y-1.5">
                <Label htmlFor="new-task-repeat-interval">Every</Label>
                <Input
                  id="new-task-repeat-interval"
                  type="number"
                  min={1}
                  max={365}
                  value={form.repeatInterval}
                  onChange={(e) => {
                    const next = Number.parseInt(e.target.value, 10);
                    setForm((s) => ({
                      ...s,
                      repeatInterval:
                        Number.isFinite(next) && next >= 1 ? next : 1,
                    }));
                  }}
                  aria-label="new-task-repeat-interval"
                />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Tags</Label>
            <TagInput
              value={form.tags}
              onChange={(next) => setForm((s) => ({ ...s, tags: next }))}
              ariaLabel="new-task-tags"
            />
          </div>

          {matchedPipeline && (
            <div className="space-y-1.5">
              <Label>Phase</Label>
              <PhasePicker
                value={form.phase}
                pipeline={matchedPipeline}
                onChange={(next) => setForm((s) => ({ ...s, phase: next }))}
                ariaLabel="new-task-phase"
              />
              <div className="text-[11px] text-muted-foreground">
                Pipeline: {matchedPipeline.name}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Agent method</Label>
            <Select
              value={form.agent_method}
              onValueChange={(v) =>
                setForm((s) => ({ ...s, agent_method: v as AgentMethod }))
              }
            >
              <SelectTrigger aria-label="new-task-agent-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.agent_method !== 'human_only' && (
            <div className="space-y-1.5">
              <Label htmlFor="new-task-agent-instructions">
                Agent instructions
              </Label>
              <Textarea
                id="new-task-agent-instructions"
                value={form.agent_instructions}
                onChange={(e) =>
                  setForm((s) => ({
                    ...s,
                    agent_instructions: e.target.value,
                  }))
                }
                placeholder="What should the agent do? Be specific."
                rows={3}
                aria-label="new-task-agent-instructions"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Attachments</Label>
            <PendingAttachmentsField
              files={form.pendingFiles}
              onChange={(next) =>
                setForm((s) => ({ ...s, pendingFiles: next }))
              }
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            aria-label="new-task-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void submit();
            }}
            disabled={createTask.isPending}
            aria-label="new-task-submit"
          >
            {createTask.isPending ? 'Creating…' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Pending attachments picker                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lightweight drag-drop / file-picker for the new-task dialog. The task id
 * doesn't exist yet, so we just hold the `File[]` in memory and submit them
 * after `POST /api/tasks` returns. Mirrors the standalone {@link
 * AttachmentDrop} component's UI without the upload network call.
 */
function PendingAttachmentsField({
  files,
  onChange,
}: {
  files: File[];
  onChange: (next: File[]) => void;
}): JSX.Element {
  const inputId = `new-task-attachments-input`;
  const handlePicker = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const picked = Array.from(e.target.files ?? []);
    onChange([...files, ...picked]);
    e.target.value = '';
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length > 0) onChange([...files, ...dropped]);
  };
  const removeAt = (idx: number): void => {
    onChange(files.filter((_, i) => i !== idx));
  };
  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={handleDrop}
        className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground"
        aria-label="new-task-attachment-drop"
      >
        <span>Drag files here, or</span>
        <label
          htmlFor={inputId}
          className="cursor-pointer rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium hover:bg-accent"
        >
          Choose files
        </label>
        <input
          id={inputId}
          type="file"
          multiple
          className="sr-only"
          onChange={handlePicker}
          aria-label="new-task-attachments"
        />
      </div>
      {files.length > 0 && (
        <ul className="space-y-1" aria-label="new-task-attachment-list">
          {files.map((f, idx) => (
            <li
              key={`${f.name}-${idx}`}
              className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="truncate" title={f.name}>
                {f.name}
              </span>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`new-task-attachment-remove-${idx}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
