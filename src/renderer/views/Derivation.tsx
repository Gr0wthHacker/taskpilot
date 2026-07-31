/**
 * Derivation Workspace (PRD §9.4).
 *
 * Two-column layout designed for Cowork operation:
 *   left   — read-only context (`aria-label="derivation-context"`)
 *   right  — editable derivative form (`aria-label="derivation-form"`)
 *
 * If no `:id` is present in the URL we render the queue view inline so the
 * `/derive` route still has a sensible landing page even though the router
 * is owned by an earlier wave.
 */

import { format, parseISO } from 'date-fns';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  Plus,
  Save,
  Send,
  RotateCcw,
  Tag,
  Folder,
  Loader2,
} from 'lucide-react';

import type {
  ApprovalPayload,
  DerivativeProposal,
  RejectionPayload,
  Task,
} from '@/shared/types';
import { Button } from '@/renderer/components/ui/button';
import { Badge } from '@/renderer/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Separator } from '@/renderer/components/ui/separator';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useApproveTask,
  useCalendarEvents,
  useRejectTask,
  useTask,
  useTasksList,
  useUpdateTask,
} from '@/renderer/lib/query';
import DerivativeRow, {
  classificationFromProposal,
  emptyDerivative,
  proposalFromForm,
  type DerivativeFormValue,
} from '@/renderer/components/shared/DerivativeRow';
import DeriveQueue from './DeriveQueue';

function formatEventTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDue(iso: string): string {
  try {
    const d = parseISO(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return format(d, 'EEE MMM d, h:mm a');
  } catch {
    return iso;
  }
}

function derivativesToForm(children: Task[]): DerivativeFormValue[] {
  return children.map((child) => ({
    title: child.title,
    classification: child.agent_executable
      ? child.agent_status === 'needs_review'
        ? 'review'
        : 'auto'
      : 'human_only',
    agent_method: child.agent_method,
    agent_instructions: child.agent_instructions ?? '',
    estimated_minutes:
      typeof child.context?.estimated_minutes === 'number'
        ? (child.context.estimated_minutes as number)
        : 15,
    depends_on: Array.isArray(child.context?.depends_on)
      ? (child.context?.depends_on as string[])
      : [],
  }));
}

function draftFromContext(task: Task): DerivativeFormValue[] | null {
  const draft = task.context?.draft_derivatives;
  if (!Array.isArray(draft)) return null;
  return (draft as DerivativeProposal[]).map((p) => ({
    title: p.title,
    classification: classificationFromProposal(p),
    agent_method: p.agent_method,
    agent_instructions: p.agent_instructions ?? '',
    estimated_minutes: p.estimated_minutes,
    depends_on: Array.isArray(p.depends_on) ? p.depends_on : [],
  }));
}

interface DerivationWorkspaceProps {
  taskId: string;
}

function buildCalendarRange(): { from: string; to: string } {
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + 3);
  return { from: from.toISOString(), to: to.toISOString() };
}

function DerivationWorkspace({ taskId }: DerivationWorkspaceProps): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();

  const taskQuery = useTask(taskId);
  const allTasksQuery = useTasksList();
  const calendarRange = useMemo(buildCalendarRange, []);
  const calendarQuery = useCalendarEvents(calendarRange);

  const approveMutation = useApproveTask();
  const rejectMutation = useRejectTask();
  const updateMutation = useUpdateTask();

  const [derivatives, setDerivatives] = useState<DerivativeFormValue[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const task = taskQuery.data?.task ?? null;

  // Hydrate the form once. Order of preference: existing children, then a
  // draft saved on context, then a single empty row.
  useEffect(() => {
    if (hydrated || !task) return;
    const allTasks = allTasksQuery.data?.tasks ?? [];
    const children = allTasks.filter((t) => t.parent_id === task.id);
    if (children.length > 0) {
      setDerivatives(derivativesToForm(children));
    } else {
      const draft = draftFromContext(task);
      if (draft && draft.length > 0) {
        setDerivatives(draft);
      } else {
        setDerivatives([emptyDerivative()]);
      }
    }
    setHydrated(true);
  }, [hydrated, task, allTasksQuery.data]);

  const relatedTasks = useMemo<Task[]>(() => {
    if (!task || !allTasksQuery.data) return [];
    const tagSet = new Set(task.tags);
    return allTasksQuery.data.tasks.filter((t) => {
      if (t.id === task.id) return false;
      if (t.parent_id && t.parent_id === task.parent_id) return true;
      if (task.parent_id && t.id === task.parent_id) return true;
      return t.tags.some((tag) => tagSet.has(tag));
    });
  }, [task, allTasksQuery.data]);

  const projectContext = useMemo<Task[]>(() => {
    if (!task || !allTasksQuery.data) return [];
    const projectTags = task.tags.filter(
      (t) => t.startsWith('project:') || t.startsWith('proj/'),
    );
    const matchTags = projectTags.length > 0 ? projectTags : task.tags.slice(0, 1);
    if (matchTags.length === 0) return [];
    const set = new Set(matchTags);
    return allTasksQuery.data.tasks
      .filter((t) => t.id !== task.id && t.tags.some((tag) => set.has(tag)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 5);
  }, [task, allTasksQuery.data]);

  const availableDepsByIndex = useMemo(
    () =>
      derivatives.map((_, i) =>
        derivatives
          .slice(0, i)
          .map((d) => d.title.trim())
          .filter((t) => t.length > 0),
      ),
    [derivatives],
  );

  function updateDerivative(index: number, next: DerivativeFormValue): void {
    setDerivatives((prev) => prev.map((d, i) => (i === index ? next : d)));
  }

  function addDerivative(): void {
    setDerivatives((prev) => [...prev, emptyDerivative()]);
  }

  function removeDerivative(index: number): void {
    setDerivatives((prev) => prev.filter((_, i) => i !== index));
  }

  async function submitFinal(): Promise<void> {
    if (!task) return;
    const edits: DerivativeProposal[] = derivatives
      .filter((d) => d.title.trim() !== '')
      .map(proposalFromForm);
    if (edits.length === 0) {
      toast({
        title: 'Nothing to submit',
        description: 'Add at least one derivative with a title.',
        variant: 'destructive',
      });
      return;
    }
    const body: ApprovalPayload = { kind: 'derivation', edits };
    try {
      await approveMutation.mutateAsync({ id: task.id, body });
      toast({
        title: 'Derivatives submitted',
        description: `Created ${edits.length} child task${edits.length === 1 ? '' : 's'}.`,
      });
      navigate('/board');
    } catch (err) {
      toast({
        title: 'Submit failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }

  async function saveDraft(): Promise<void> {
    if (!task) return;
    const draft = derivatives.map(proposalFromForm);
    const existing = (task.context ?? {}) as Record<string, unknown>;
    try {
      await updateMutation.mutateAsync({
        id: task.id,
        patch: { context: { ...existing, draft_derivatives: draft } },
      });
      toast({
        title: 'Draft saved',
        description: 'Your in-progress derivatives are persisted.',
      });
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }

  async function rejectAndRederive(): Promise<void> {
    if (!task) return;
    const body: RejectionPayload = { kind: 'derivation', requeue: true };
    try {
      await rejectMutation.mutateAsync({ id: task.id, body });
      toast({
        title: 'Re-queued for derivation',
        description: 'Claude will be asked to propose again.',
      });
      navigate('/board');
    } catch (err) {
      toast({
        title: 'Reject failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  }

  if (taskQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading task…
      </div>
    );
  }

  if (taskQuery.isError || !task) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold">Task not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Could not load task <code>{taskId}</code>. Is the API server running?
        </p>
      </div>
    );
  }

  const submitPending = approveMutation.isPending;
  const draftPending = updateMutation.isPending;
  const rejectPending = rejectMutation.isPending;
  const anyPending = submitPending || draftPending || rejectPending;

  return (
    <div className="flex h-full flex-col">
      <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* Left: read-only context */}
        <ScrollArea className="border-r border-border">
          <section aria-label="derivation-context" className="space-y-4 p-6">
            <header>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{task.priority}</Badge>
                {task.due && (
                  <Badge variant="outline" className="font-normal">
                    Due {formatDue(task.due)}
                  </Badge>
                )}
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-tight">
                {task.title}
              </h1>
              {task.description && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {task.description}
                </p>
              )}
              {task.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {task.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="gap-1">
                      <Tag className="h-3 w-3" />
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </header>

            <Separator />

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Related tasks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {relatedTasks.length === 0 ? (
                  <p className="text-muted-foreground">No related tasks found.</p>
                ) : (
                  relatedTasks.slice(0, 6).map((rt) => (
                    <div key={rt.id} className="flex items-center gap-2">
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {rt.status}
                      </Badge>
                      <span className="truncate">{rt.title}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <CalendarDays className="h-4 w-4" />
                  Calendar snapshot (next 3 days)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {calendarQuery.isLoading ? (
                  <p className="text-muted-foreground">Loading events…</p>
                ) : calendarQuery.data && calendarQuery.data.events.length > 0 ? (
                  calendarQuery.data.events.slice(0, 8).map((event) => (
                    <div key={event.id} className="flex items-baseline gap-2">
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatEventTime(event.start)}
                      </span>
                      <span className="truncate">{event.summary}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">
                    No events in the next 3 days.
                  </p>
                )}
              </CardContent>
            </Card>

            {projectContext.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <Folder className="h-4 w-4" />
                    Project context
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {projectContext.map((pt) => (
                    <div key={pt.id} className="flex items-center gap-2">
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {pt.status}
                      </Badge>
                      <span className="truncate">{pt.title}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </section>
        </ScrollArea>

        {/* Right: form */}
        <ScrollArea>
          <form
            aria-label="derivation-form"
            className="space-y-3 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              void submitFinal();
            }}
          >
            <header className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Derivatives</h2>
                <p className="text-sm text-muted-foreground">
                  Edit Claude&apos;s proposal. Color = classification.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addDerivative}
                aria-label="add-derivative"
              >
                <Plus className="mr-1 h-4 w-4" />
                Add Derivative
              </Button>
            </header>

            {derivatives.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No derivatives yet. Click &ldquo;Add Derivative&rdquo;.
              </div>
            )}

            {derivatives.map((d, i) => (
              <DerivativeRow
                key={i}
                index={i}
                value={d}
                onChange={(next) => updateDerivative(i, next)}
                onRemove={() => removeDerivative(i)}
                availableDeps={availableDepsByIndex[i] ?? []}
              />
            ))}

            {/* Hidden submit so Enter inside the form triggers submitFinal. */}
            <button type="submit" className="sr-only" tabIndex={-1}>
              submit
            </button>
          </form>
        </ScrollArea>
      </div>

      {/* Bottom action bar */}
      <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-6 py-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => void rejectAndRederive()}
          disabled={anyPending}
          aria-label="reject-and-rederive"
        >
          {rejectPending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="mr-1 h-4 w-4" />
          )}
          Reject and Re-derive
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void saveDraft()}
            disabled={anyPending}
            aria-label="save-derivation-draft"
          >
            {draftPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            Save Draft
          </Button>
          <Button
            type="button"
            onClick={() => void submitFinal()}
            disabled={anyPending}
            aria-label="submit-derivatives"
          >
            {submitPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-1 h-4 w-4" />
            )}
            Submit Derivatives
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Derivation(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) return <DeriveQueue />;
  return <DerivationWorkspace taskId={id} />;
}
