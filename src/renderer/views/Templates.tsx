/**
 * Templates view — manage reusable task blueprints. Lists every template as a
 * card with "Use" / "Edit" / "Delete" affordances. "Use" materializes the
 * template into a new task in the inbox and navigates to it.
 */

import {
  FileText,
  Pencil,
  Plus,
  Sparkles as SparklesIcon,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { Textarea } from '@/renderer/components/ui/textarea';
import { useToast } from '@/renderer/components/ui/use-toast';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { TagInput } from '@/renderer/components/shared/TagInput';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  useCreateTemplate,
  useDeleteTemplate,
  useMaterializeTemplate,
  useTemplates,
  useUpdateTemplate,
} from '@/renderer/lib/query';
import type {
  AgentMethod,
  CreateTaskTemplateInput,
  TaskPriority,
  TaskTemplate,
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

interface TemplateFormState {
  name: string;
  description: string;
  task_title: string;
  task_description: string;
  priority: TaskPriority;
  agent_method: AgentMethod;
  agent_instructions: string;
  tags: string[];
}

function emptyForm(template?: TaskTemplate | null): TemplateFormState {
  return {
    name: template?.name ?? '',
    description: template?.description ?? '',
    task_title: template?.task_title ?? '',
    task_description: template?.task_description ?? '',
    priority: template?.priority ?? 'p2',
    agent_method: template?.agent_method ?? 'human_only',
    agent_instructions: template?.agent_instructions ?? '',
    tags: template?.tags ?? [],
  };
}

interface EditDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  existing?: TaskTemplate | null;
  onSaved?: (template: TaskTemplate) => void;
}

function TemplateEditDialog({
  open,
  onOpenChange,
  existing,
  onSaved,
}: EditDialogProps): JSX.Element {
  const [form, setForm] = useState<TemplateFormState>(() => emptyForm(existing));
  const [error, setError] = useState<string | null>(null);
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setForm(emptyForm(existing));
      setError(null);
    }
  }, [open, existing]);

  const submit = async (): Promise<void> => {
    if (form.name.trim().length === 0) {
      setError('Name is required.');
      return;
    }
    if (form.task_title.trim().length === 0) {
      setError('Task title is required.');
      return;
    }
    const payload: CreateTaskTemplateInput = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      task_title: form.task_title.trim(),
      task_description: form.task_description.trim() || null,
      priority: form.priority,
      agent_method: form.agent_method,
      agent_instructions: form.agent_instructions.trim() || null,
      tags: form.tags,
    };
    try {
      let saved: TaskTemplate;
      if (existing) {
        const res = await update.mutateAsync({
          id: existing.id,
          patch: payload,
        });
        saved = res.template;
      } else {
        const res = await create.mutateAsync(payload);
        saved = res.template;
      }
      toast({ title: existing ? 'Template updated' : 'Template created' });
      onSaved?.(saved);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="template-edit-dialog"
        className="sm:max-w-[560px]"
      >
        <DialogHeader>
          <DialogTitle>
            {existing ? 'Edit template' : 'New template'}
          </DialogTitle>
          <DialogDescription>
            Templates spawn fresh tasks. Use{' '}
            <code className="rounded bg-muted px-1 text-xs">
              {'{{variable}}'}
            </code>{' '}
            in the title or description to substitute values at materialize
            time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Template name</Label>
            <Input
              value={form.name}
              onChange={(e) =>
                setForm((s) => ({ ...s, name: e.target.value }))
              }
              placeholder="Weekly review prep"
              aria-label="template-name"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>Template description</Label>
            <Input
              value={form.description}
              onChange={(e) =>
                setForm((s) => ({ ...s, description: e.target.value }))
              }
              placeholder="What this template is for"
              aria-label="template-description"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Task title</Label>
            <Input
              value={form.task_title}
              onChange={(e) =>
                setForm((s) => ({ ...s, task_title: e.target.value }))
              }
              placeholder="e.g. Weekly review — {{week}}"
              aria-label="template-task-title"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Task description (markdown)</Label>
            <Textarea
              value={form.task_description}
              onChange={(e) =>
                setForm((s) => ({ ...s, task_description: e.target.value }))
              }
              rows={4}
              placeholder="Markdown supported. {{variables}} substituted at use time."
              aria-label="template-task-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Default priority</Label>
              <Select
                value={form.priority}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, priority: v as TaskPriority }))
                }
              >
                <SelectTrigger aria-label="template-priority">
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
              <Label>Default agent method</Label>
              <Select
                value={form.agent_method}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, agent_method: v as AgentMethod }))
                }
              >
                <SelectTrigger aria-label="template-agent-method">
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
          </div>

          {form.agent_method !== 'human_only' && (
            <div className="space-y-1.5">
              <Label>Agent instructions</Label>
              <Textarea
                value={form.agent_instructions}
                onChange={(e) =>
                  setForm((s) => ({
                    ...s,
                    agent_instructions: e.target.value,
                  }))
                }
                rows={3}
                placeholder="What the agent should do"
                aria-label="template-agent-instructions"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Tags</Label>
            <TagInput
              value={form.tags}
              onChange={(next) => setForm((s) => ({ ...s, tags: next }))}
              ariaLabel="template-tags"
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
            onClick={() => onOpenChange(false)}
            aria-label="template-edit-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void submit();
            }}
            disabled={create.isPending || update.isPending}
            aria-label="template-edit-submit"
          >
            {existing ? 'Save' : 'Create template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface UseDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  template: TaskTemplate | null;
}

function TemplateUseDialog({
  open,
  onOpenChange,
  template,
}: UseDialogProps): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const materialize = useMaterializeTemplate();
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [varKey, setVarKey] = useState('');
  const [varValue, setVarValue] = useState('');

  useEffect(() => {
    if (open) {
      setVariables({});
      setVarKey('');
      setVarValue('');
    }
  }, [open]);

  const addVariable = (): void => {
    if (varKey.trim().length === 0) return;
    setVariables((s) => ({ ...s, [varKey.trim()]: varValue }));
    setVarKey('');
    setVarValue('');
  };

  const submit = async (): Promise<void> => {
    if (!template) return;
    try {
      const res = await materialize.mutateAsync({
        id: template.id,
        body: {
          overrides:
            Object.keys(variables).length > 0 ? { variables } : undefined,
        },
      });
      toast({
        title: 'Task created from template',
        description: res.tasks[0]?.title,
      });
      onOpenChange(false);
      if (res.tasks[0]) navigate(`/task/${res.tasks[0].id}`);
    } catch (cause) {
      toast({
        title: 'Materialize failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="template-use-dialog" className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Use template: {template?.name}</DialogTitle>
          <DialogDescription>
            Fill any{' '}
            <code className="rounded bg-muted px-1 text-xs">
              {'{{variable}}'}
            </code>{' '}
            placeholders, then create the task.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {Object.keys(variables).length > 0 && (
            <ul className="space-y-1 rounded-md border border-border p-2">
              {Object.entries(variables).map(([k, v]) => (
                <li
                  key={k}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="font-mono text-muted-foreground">
                    {'{{'}
                    {k}
                    {'}}'}
                  </span>
                  <span className="truncate text-foreground">{v}</span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() =>
                      setVariables((s) => {
                        const next = { ...s };
                        delete next[k];
                        return next;
                      })
                    }
                    aria-label={`template-use-remove-var-${k}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-[1fr_2fr_auto] gap-2">
            <Input
              placeholder="key"
              value={varKey}
              onChange={(e) => setVarKey(e.target.value)}
              aria-label="template-use-var-key"
            />
            <Input
              placeholder="value"
              value={varValue}
              onChange={(e) => setVarValue(e.target.value)}
              aria-label="template-use-var-value"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addVariable}
              aria-label="template-use-var-add"
            >
              Add
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            aria-label="template-use-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void submit();
            }}
            disabled={materialize.isPending}
            aria-label="template-use-submit"
          >
            {materialize.isPending ? 'Creating…' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Templates(): JSX.Element {
  const { toast } = useToast();
  const templatesQ = useTemplates();
  const deleteTemplate = useDeleteTemplate();

  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TaskTemplate | null>(null);
  const [useOpen, setUseOpen] = useState(false);
  const [useTarget, setUseTarget] = useState<TaskTemplate | null>(null);

  const templates = templatesQ.data?.templates ?? [];

  const handleDelete = async (template: TaskTemplate): Promise<void> => {
    const ok = window.confirm(
      `Delete template "${template.name}"? Tasks already spawned from it stay.`,
    );
    if (!ok) return;
    try {
      await deleteTemplate.mutateAsync({ id: template.id });
      toast({ title: 'Template deleted' });
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-templates">
      <ViewHeader
        title="Templates"
        subtitle={
          templates.length === 0
            ? 'No templates yet.'
            : `${templates.length} template${templates.length === 1 ? '' : 's'}`
        }
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditTarget(null);
              setEditOpen(true);
            }}
            aria-label="templates-new"
          >
            <Plus className="mr-1 h-4 w-4" />
            New template
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-6">
        {templatesQ.isLoading && (
          <div className="text-sm text-muted-foreground">
            Loading templates…
          </div>
        )}
        {!templatesQ.isLoading && templates.length === 0 && (
          <EmptyState
            icon={FileText}
            title="No templates yet."
            description="Save a recurring task pattern once and spin up fresh copies in one click."
            ariaLabel="templates-empty"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditTarget(null);
                  setEditOpen(true);
                }}
                aria-label="templates-empty-new"
              >
                <Plus className="mr-1 h-4 w-4" />
                New template
              </Button>
            }
          />
        )}

        {templates.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="templates-list">
            {templates.map((template) => (
              <li
                key={template.id}
                className="rounded-lg border border-border bg-card p-4"
                aria-label={`template-card-${template.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">
                      {template.name}
                    </h2>
                    {template.description && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {template.description}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setUseTarget(template);
                        setUseOpen(true);
                      }}
                      aria-label={`template-use-${template.id}`}
                    >
                      <SparklesIcon className="mr-1 h-3 w-3" />
                      Use
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        setEditTarget(template);
                        setEditOpen(true);
                      }}
                      aria-label={`template-edit-${template.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        void handleDelete(template);
                      }}
                      aria-label={`template-delete-${template.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 text-xs text-muted-foreground">
                  <div className="truncate">
                    <span className="text-foreground">Task title:</span>{' '}
                    {template.task_title}
                  </div>
                  {template.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {template.tags.slice(0, 6).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <TemplateEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        existing={editTarget}
      />
      <TemplateUseDialog
        open={useOpen}
        onOpenChange={setUseOpen}
        template={useTarget}
      />
    </div>
  );
}
