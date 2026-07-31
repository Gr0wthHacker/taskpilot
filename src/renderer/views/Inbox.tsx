/**
 * Inbox view — every task with status='inbox'. Top bar holds the New Task
 * button, count badge, and the global filter strip. Selecting tasks unlocks
 * bulk "Derive" actions.
 */

import {
  CalendarClock,
  FileText,
  Flag,
  Plus,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { useToast } from '@/renderer/components/ui/use-toast';
import { NewTaskDialog } from '@/renderer/components/shared/NewTaskDialog';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { RecentsPanel } from '@/renderer/components/shared/RecentsPanel';
import { SmartDueInput } from '@/renderer/components/shared/SmartDueInput';
import { SnoozeButton } from '@/renderer/components/shared/SnoozeButton';
import { TagInput } from '@/renderer/components/shared/TagInput';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import { VirtualList } from '@/renderer/components/shared/VirtualList';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  TaskFilters,
  applyClientFilters,
  deriveTasksQuery,
} from '@/renderer/components/shared/TaskFilters';
import {
  useCreateTemplate,
  useDeleteTask,
  useDeriveTask,
  useTasksList,
  useUpdateTask,
} from '@/renderer/lib/query';
import { partitionSnoozed } from '@/renderer/lib/snooze';
import { sortByPriority } from '@/renderer/lib/task-sort';
import { cn } from '@/renderer/lib/utils';
import { useUiStore } from '@/renderer/store/ui';
import {
  applyWorkspaceFilter,
  useActiveWorkspace,
} from '@/renderer/store/workspace';
import type { Task, TaskPriority } from '@/shared/types';

export default function Inbox(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();

  const filters = useUiStore((s) => s.filters);
  const activeWorkspace = useActiveWorkspace();
  const selectedTaskIds = useUiStore((s) => s.selectedTaskIds);
  const toggleSelected = useUiStore((s) => s.toggleTaskSelected);
  const clearSelection = useUiStore((s) => s.clearSelection);

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleIso, setScheduleIso] = useState<string | null>(null);
  const [addTagOpen, setAddTagOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState<string[]>([]);
  const [showSnoozed, setShowSnoozed] = useState(false);

  const query = useMemo(
    () => deriveTasksQuery(filters, { status: 'inbox' }),
    [filters],
  );
  const tasksQ = useTasksList(query);
  const updateTask = useUpdateTask();
  const deriveTask = useDeriveTask();
  const deleteTask = useDeleteTask();
  const createTemplate = useCreateTemplate();

  const filtered = useMemo(() => {
    const list = tasksQ.data?.tasks ?? [];
    return sortByPriority(
      applyWorkspaceFilter(applyClientFilters(list, filters), activeWorkspace),
    );
  }, [tasksQ.data, filters, activeWorkspace]);

  const { active: activeTasks, snoozed: snoozedTasks } = useMemo(
    () => partitionSnoozed(filtered),
    [filtered],
  );

  const visibleTasks = showSnoozed ? filtered : activeTasks;
  const hasSelection = selectedTaskIds.length > 0;

  const runDerive = async (id: string): Promise<void> => {
    try {
      await deriveTask.mutateAsync({ id });
      toast({
        title: 'Derivation requested',
        description: `Wrote io/derive/${id}.json`,
      });
    } catch (cause) {
      toast({
        title: 'Derive failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const runDeriveSelected = async (): Promise<void> => {
    const ids = [...selectedTaskIds];
    if (ids.length === 0) return;
    // Fire in parallel — derives are independent and the server happily
    // handles concurrent requests. `allSettled` lets us tally failures
    // without one bad task short-circuiting the rest.
    const results = await Promise.allSettled(
      ids.map((id) => deriveTask.mutateAsync({ id })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    clearSelection();
    toast({
      title: 'Bulk derive complete',
      description: `${succeeded} requested${failed > 0 ? `, ${failed} failed` : ''}`,
      variant: failed > 0 ? 'destructive' : 'default',
    });
  };

  const deleteSelected = async (): Promise<void> => {
    const targets = visibleTasks.filter((t) => selectedTaskIds.includes(t.id));
    if (targets.length === 0) return;
    const ok = window.confirm(
      `Delete ${targets.length} selected task${targets.length === 1 ? '' : 's'}? This cannot be undone.`,
    );
    if (!ok) return;
    const results = await Promise.allSettled(
      targets.map((t) =>
        deleteTask.mutateAsync({ id: t.id, parent_id: t.parent_id }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    clearSelection();
    toast({
      title: 'Bulk delete complete',
      description: `${succeeded} deleted${failed > 0 ? `, ${failed} failed` : ''}`,
      variant: failed > 0 ? 'destructive' : 'default',
    });
  };

  const setPrioritySelected = async (
    priority: TaskPriority,
  ): Promise<void> => {
    const ids = [...selectedTaskIds];
    if (ids.length === 0) return;
    const results = await Promise.allSettled(
      ids.map((id) => updateTask.mutateAsync({ id, patch: { priority } })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    clearSelection();
    toast({
      title: 'Priority updated',
      description: `${succeeded} task(s) set to ${priority.toUpperCase()}`,
    });
  };

  const submitScheduleSelected = async (): Promise<void> => {
    const ids = [...selectedTaskIds];
    if (ids.length === 0) return;
    const results = await Promise.allSettled(
      ids.map((id) =>
        updateTask.mutateAsync({ id, patch: { due: scheduleIso } }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    setScheduleOpen(false);
    setScheduleIso(null);
    clearSelection();
    toast({
      title: scheduleIso ? 'Due date set' : 'Due date cleared',
      description: `${succeeded} task(s) updated${failed > 0 ? `, ${failed} failed` : ''}`,
      variant: failed > 0 ? 'destructive' : 'default',
    });
  };

  const submitAddTagSelected = async (): Promise<void> => {
    const tagsToAdd = tagDraft.filter((t) => t.trim().length > 0);
    if (tagsToAdd.length === 0) {
      setAddTagOpen(false);
      return;
    }
    const targets = visibleTasks.filter((t) => selectedTaskIds.includes(t.id));
    if (targets.length === 0) return;
    // Merge — never clobber a task's existing tags.
    const results = await Promise.allSettled(
      targets.map((t) => {
        const merged = Array.from(new Set([...t.tags, ...tagsToAdd]));
        return updateTask.mutateAsync({ id: t.id, patch: { tags: merged } });
      }),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    setAddTagOpen(false);
    setTagDraft([]);
    clearSelection();
    toast({
      title: 'Tags added',
      description: `${succeeded} task(s) updated${failed > 0 ? `, ${failed} failed` : ''}`,
      variant: failed > 0 ? 'destructive' : 'default',
    });
  };

  const openSaveTemplate = (): void => {
    const selected = visibleTasks.filter((t) =>
      selectedTaskIds.includes(t.id),
    );
    if (selected.length === 0) return;
    // Single selection auto-fills the title verbatim. Multi-select clears the
    // name so the user names the combined template explicitly — the first
    // task's title is rarely representative of the bundle.
    setTemplateName(
      selected.length === 1 ? selected[0]!.title : '',
    );
    setSaveTemplateOpen(true);
  };

  const submitSaveTemplate = async (): Promise<void> => {
    const selected = visibleTasks.filter((t) =>
      selectedTaskIds.includes(t.id),
    );
    if (selected.length === 0) return;
    const name = templateName.trim();
    if (name.length === 0) return;

    // Combine multi-task selections into one template — title from the first
    // task, description joins the rest with a blank line and a bullet header.
    const head = selected[0]!;
    const task_title =
      selected.length === 1
        ? head.title
        : `${head.title} (template)`;
    const task_description =
      selected.length === 1
        ? head.description
        : selected
            .map((t) => `## ${t.title}\n\n${t.description ?? ''}`.trim())
            .join('\n\n---\n\n');

    const tagSet = new Set<string>();
    for (const t of selected) for (const tag of t.tags) tagSet.add(tag);

    try {
      await createTemplate.mutateAsync({
        name,
        task_title,
        task_description: task_description ?? null,
        priority: head.priority,
        agent_method: head.agent_method,
        agent_instructions: head.agent_instructions ?? null,
        tags: Array.from(tagSet),
      });
      toast({
        title: 'Template saved',
        description: `From ${selected.length} task${selected.length === 1 ? '' : 's'}`,
      });
      setSaveTemplateOpen(false);
      setTemplateName('');
      clearSelection();
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleCardClick = (task: Task): void => {
    navigate(`/task/${task.id}`);
  };

  const totalInbox = tasksQ.data?.tasks.length ?? 0;
  const showingFiltered = visibleTasks.length;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-label="view-inbox"
    >
      <ViewHeader
        title="Inbox"
        subtitle={
          totalInbox === 0
            ? 'No tasks awaiting triage.'
            : `${showingFiltered} of ${totalInbox} task${totalInbox === 1 ? '' : 's'} shown`
        }
        actions={
          <>
            {totalInbox >= 3 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/triage')}
                aria-label="inbox-triage"
                size="sm"
              >
                <Zap className="mr-1 h-4 w-4" />
                Triage inbox →
              </Button>
            )}
            <Button
              type="button"
              onClick={() => setNewTaskOpen(true)}
              aria-label="inbox-new-task"
              size="sm"
            >
              <Plus className="mr-1 h-4 w-4" />
              New task
            </Button>
          </>
        }
      >
        <TaskFilters hideStatus />

        {snoozedTasks.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSnoozed((v) => !v)}
            className="self-start text-xs text-amber-600 hover:underline dark:text-amber-400"
            aria-label="inbox-toggle-snoozed"
            aria-pressed={showSnoozed}
          >
            {showSnoozed
              ? `Hide ${snoozedTasks.length} snoozed`
              : `Show ${snoozedTasks.length} snoozed`}
          </button>
        )}

        {hasSelection && (
          <div
            className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
            aria-label="inbox-bulk-actions"
          >
            <div className="text-xs text-muted-foreground">
              {selectedTaskIds.length} selected
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void runDeriveSelected();
                }}
                aria-label="inbox-bulk-derive"
              >
                <Sparkles className="mr-1 h-4 w-4" />
                Derive selected
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label="inbox-bulk-priority"
                  >
                    <Flag className="mr-1 h-4 w-4" />
                    Set priority
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {(['p0', 'p1', 'p2', 'p3'] as TaskPriority[]).map((p) => (
                    <DropdownMenuItem
                      key={p}
                      onClick={() => {
                        void setPrioritySelected(p);
                      }}
                      aria-label={`inbox-bulk-priority-${p}`}
                    >
                      {p.toUpperCase()}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setScheduleIso(null);
                  setScheduleOpen(true);
                }}
                aria-label="inbox-bulk-schedule"
              >
                <CalendarClock className="mr-1 h-4 w-4" />
                Schedule
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setTagDraft([]);
                  setAddTagOpen(true);
                }}
                aria-label="inbox-bulk-add-tag"
              >
                <TagIcon className="mr-1 h-4 w-4" />
                Add tag
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={openSaveTemplate}
                aria-label="inbox-bulk-save-template"
              >
                <FileText className="mr-1 h-4 w-4" />
                Save as template
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void deleteSelected();
                }}
                disabled={deleteTask.isPending}
                aria-label="inbox-bulk-delete"
                className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                <Trash2 className="mr-1 h-4 w-4" />
                Delete selected
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                aria-label="inbox-bulk-clear"
              >
                Clear
              </Button>
            </div>
          </div>
        )}
      </ViewHeader>

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <RecentsPanel />
        {tasksQ.isLoading && (
          <div className="text-sm text-muted-foreground">Loading inbox…</div>
        )}
        {tasksQ.isError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            Couldn’t load tasks. The server may not be running.
          </div>
        )}
        {!tasksQ.isLoading && !tasksQ.isError && visibleTasks.length === 0 && (
          <EmptyState
            icon={Sparkles}
            title="Inbox is clear."
            description="Create a task, or it’ll come from Claude/calendar."
            ariaLabel="inbox-empty"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setNewTaskOpen(true)}
                aria-label="inbox-empty-new-task"
              >
                <Plus className="mr-1 h-4 w-4" />
                New task
              </Button>
            }
          />
        )}

        {visibleTasks.length > 0 && (
          // Virtualized — only the rows in the viewport mount. Stays smooth
          // at 10k+ inbox tasks. Min-height stops the wrapper from
          // collapsing when the list is short. The estimateSize is the
          // measured card height plus the row gap; react-virtual corrects
          // per-row as cards render.
          <VirtualList
            items={visibleTasks}
            estimateSize={() => 72}
            getKey={(task) => task.id}
            className="flex-1 min-h-[400px] pr-1"
            ariaLabel="inbox-task-list"
            renderRow={(task) => {
              const selected = selectedTaskIds.includes(task.id);
              return (
                <div className="flex items-center gap-2 pb-2">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelected(task.id)}
                    aria-label={`inbox-select-${task.id}`}
                    className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-1 focus:ring-ring"
                  />
                  <div className="flex-1">
                    <TaskCard
                      task={task}
                      selected={selected}
                      onClick={handleCardClick}
                      actions={
                        <div
                          className={cn(
                            'flex items-center gap-1 opacity-0 transition-opacity',
                            'group-hover:opacity-100 focus-within:opacity-100',
                          )}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              void runDerive(task.id);
                            }}
                            disabled={deriveTask.isPending}
                            aria-label={`inbox-derive-${task.id}`}
                            data-card-action
                          >
                            <Sparkles className="mr-1 h-3 w-3" />
                            Derive
                          </Button>
                          <SnoozeButton task={task} />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => {
                              void deleteTask
                                .mutateAsync({
                                  id: task.id,
                                  parent_id: task.parent_id,
                                })
                                .then(() => {
                                  toast({
                                    title: 'Task deleted',
                                    description: task.title,
                                  });
                                })
                                .catch((cause) => {
                                  toast({
                                    title: 'Delete failed',
                                    description:
                                      cause instanceof Error
                                        ? cause.message
                                        : 'Unknown error',
                                    variant: 'destructive',
                                  });
                                });
                            }}
                            aria-label={`inbox-delete-${task.id}`}
                            data-card-action
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      }
                    />
                  </div>
                </div>
              );
            }}
          />
        )}
      </div>

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        onCreated={(id) => {
          navigate(`/task/${id}`);
        }}
      />

      <Dialog open={saveTemplateOpen} onOpenChange={setSaveTemplateOpen}>
        <DialogContent
          aria-label="inbox-save-template-dialog"
          className="sm:max-w-[460px]"
        >
          <DialogHeader>
            <DialogTitle>Save selected as template</DialogTitle>
            <DialogDescription>
              {selectedTaskIds.length === 1
                ? 'Reuse this task as a one-click template.'
                : `Combine ${selectedTaskIds.length} tasks into a single reusable template.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="inbox-template-name">Template name</Label>
            <Input
              id="inbox-template-name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={
                selectedTaskIds.length > 1
                  ? 'Name your template…'
                  : 'Weekly review'
              }
              aria-label="inbox-template-name"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSaveTemplateOpen(false)}
              aria-label="inbox-template-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void submitSaveTemplate();
              }}
              disabled={
                createTemplate.isPending || templateName.trim().length === 0
              }
              aria-label="inbox-template-save"
            >
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent
          aria-label="inbox-schedule-dialog"
          className="sm:max-w-[460px]"
        >
          <DialogHeader>
            <DialogTitle>Schedule selected</DialogTitle>
            <DialogDescription>
              Set a due date on {selectedTaskIds.length} selected task
              {selectedTaskIds.length === 1 ? '' : 's'}. Leave blank to clear.
            </DialogDescription>
          </DialogHeader>
          <SmartDueInput
            isoValue={scheduleIso}
            onChange={setScheduleIso}
            label="Due date"
            ariaLabel="inbox-schedule-due"
            autoFocus
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setScheduleOpen(false)}
              aria-label="inbox-schedule-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void submitScheduleSelected();
              }}
              disabled={updateTask.isPending}
              aria-label="inbox-schedule-apply"
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addTagOpen} onOpenChange={setAddTagOpen}>
        <DialogContent
          aria-label="inbox-add-tag-dialog"
          className="sm:max-w-[460px]"
        >
          <DialogHeader>
            <DialogTitle>Add tags to selected</DialogTitle>
            <DialogDescription>
              Tags are merged into {selectedTaskIds.length} selected task
              {selectedTaskIds.length === 1 ? '' : 's'} — existing tags are
              kept.
            </DialogDescription>
          </DialogHeader>
          <TagInput
            value={tagDraft}
            onChange={setTagDraft}
            ariaLabel="inbox-add-tag-input"
            placeholder="Add tag, press Enter…"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAddTagOpen(false)}
              aria-label="inbox-add-tag-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void submitAddTagSelected();
              }}
              disabled={updateTask.isPending || tagDraft.length === 0}
              aria-label="inbox-add-tag-apply"
            >
              Add tags
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
