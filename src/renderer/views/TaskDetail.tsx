/**
 * Task detail — the single-task workspace. Lets the user edit the task in
 * place, view its derivative tree, fire derive/execute/approve/reject, and
 * inspect attached context.
 */

import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import {
  Archive as ArchiveIcon,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileText,
  Focus as FocusIcon,
  Github,
  Mail,
  MessageCircle,
  MoreHorizontal,
  PlayCircle,
  Repeat,
  RotateCcw,
  Share2,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ApiError, api } from '@/renderer/lib/api';

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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { Separator } from '@/renderer/components/ui/separator';
import { Textarea } from '@/renderer/components/ui/textarea';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  AgentMethodBadge,
  AgentStatusBadge,
  TaskStatusBadge,
} from '@/renderer/components/shared/StatusBadge';
import { ConfidenceBadge } from '@/renderer/components/shared/ConfidenceBadge';
import { MarkdownEditor } from '@/renderer/components/shared/MarkdownEditor';
import { MarkdownView } from '@/renderer/components/shared/MarkdownView';
import { AttachmentDrop } from '@/renderer/components/shared/AttachmentDrop';
import { AttachmentList } from '@/renderer/components/shared/AttachmentList';
import { OutputsPanel } from '@/renderer/components/shared/OutputsPanel';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/renderer/components/ui/tabs';
import { PermissionsEditor } from '@/renderer/components/shared/PermissionsEditor';
import { SkillBindingEditor } from '@/renderer/components/shared/SkillBindingEditor';
import { TaskLinkEditor } from '@/renderer/components/shared/TaskLinkEditor';
import { PhasePicker } from '@/renderer/components/shared/PhasePicker';
import { GoalPicker } from '@/renderer/components/shared/GoalPicker';
import { PriorityPicker } from '@/renderer/components/shared/PriorityPicker';
import { TagInput } from '@/renderer/components/shared/TagInput';
import { TaskCard } from '@/renderer/components/shared/TaskCard';
import { DecisionLog } from '@/renderer/components/shared/DecisionLog';
import { TaskJournal } from '@/renderer/views/TaskDetail/TaskJournal';
import {
  useApproveTask,
  useArchiveTask,
  useCreateGmailDraft,
  useCreateTemplate,
  useDeleteTask,
  useDeriveTask,
  useExecuteTask,
  useFeedbackForTask,
  useGmailStatus,
  usePostToSlack,
  useRejectTask,
  useScheduleTask,
  useSendGmailDraft,
  useSlackChannels,
  useSlackStatus,
  useSubredditPosts,
  useTask,
  useTaskChildren,
  useTaskKnowledge,
  useTaskOutputs,
  useUnarchiveTask,
  useUpdateTask,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import { useRecentsStore } from '@/renderer/store/recents';
import type {
  AgentMethod,
  RecurrenceRule,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from '@/shared/types';

/**
 * Human-readable summary of a recurrence rule. Mirrors the main-side
 * `describeRecurrence` but lives in the renderer so we don't pull in Node-only
 * code (better-sqlite3) through `@/main/recurrence`.
 */
function describeRecurrence(rule: RecurrenceRule | null): string {
  if (!rule) return '';
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));
  const everyN = interval === 1 ? '' : `every ${interval} `;
  let base: string;
  switch (rule.kind) {
    case 'daily':
      base = interval === 1 ? 'daily' : `${everyN}days`;
      break;
    case 'weekdays':
      base = interval === 1 ? 'every weekday' : `${everyN}weekdays`;
      break;
    case 'weekly':
      base = interval === 1 ? 'weekly' : `${everyN}weeks`;
      break;
    case 'monthly':
      base = interval === 1 ? 'monthly' : `${everyN}months`;
      break;
    default:
      return '';
  }
  const suffixes: string[] = [];
  if (typeof rule.end_after_count === 'number') {
    suffixes.push(`for ${rule.end_after_count} occurrences`);
  }
  if (rule.end_on) suffixes.push(`until ${rule.end_on.slice(0, 10)}`);
  return suffixes.length === 0 ? base : `${base} (${suffixes.join(', ')})`;
}

/**
 * Extract a recurrence rule from `task.context.recurrence` if present and
 * shaped correctly. Returns `null` otherwise.
 */
function readRecurrence(task: Task | null): RecurrenceRule | null {
  if (!task || !task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)['recurrence'];
  if (!raw || typeof raw !== 'object') return null;
  const kind = (raw as Record<string, unknown>)['kind'];
  if (
    kind !== 'daily' &&
    kind !== 'weekdays' &&
    kind !== 'weekly' &&
    kind !== 'monthly'
  ) {
    return null;
  }
  return raw as RecurrenceRule;
}

const TASK_STATUSES: TaskStatus[] = [
  'inbox',
  'queued',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'archived',
];

const AGENT_METHODS: AgentMethod[] = ['human_only', 'cowork', 'cli', 'either'];

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number): string => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function dueLabel(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = parseISO(iso);
    return `${d.toLocaleString()} (${formatDistanceToNowStrict(d, {
      addSuffix: true,
    })})`;
  } catch {
    return iso;
  }
}

interface DetailSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  ariaLabel?: string;
}

function Section({
  title,
  description,
  children,
  ariaLabel,
}: DetailSectionProps): JSX.Element {
  return (
    <section
      className="rounded-lg border border-border bg-card/40 p-4"
      aria-label={ariaLabel}
    >
      <header className="mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}

interface DetailParams extends Record<string, string | undefined> {
  id: string;
}

export default function TaskDetail(): JSX.Element {
  const { id } = useParams<DetailParams>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const taskQ = useTask(id);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const deriveTask = useDeriveTask();
  const executeTask = useExecuteTask();
  const approveTask = useApproveTask();
  const rejectTask = useRejectTask();
  const archiveTask = useArchiveTask();
  const unarchiveTask = useUnarchiveTask();
  const scheduleTask = useScheduleTask();
  const createTemplate = useCreateTemplate();
  const childrenQ = useTaskChildren(id);
  const parentQ = useTask(taskQ.data?.task.parent_id ?? null);
  const feedbackQ = useFeedbackForTask(id);
  const outputsQ = useTaskOutputs(id);
  const outputsCount = outputsQ.data
    ? outputsQ.data.files.length +
      outputsQ.data.attachments.length +
      outputsQ.data.artifacts.length
    : 0;
  const knowledgeQ = useTaskKnowledge(id);

  // Details vs. Outputs tab. Defaults to Details; the Outputs tab shows a
  // count badge so a finished task's results are obvious without scrolling.
  const [detailTab, setDetailTab] = useState<'details' | 'outputs'>('details');

  // Description editing toggle — markdown when read-only, textarea when editing.
  const [editingDescription, setEditingDescription] = useState(false);
  const [saveAsTemplateOpen, setSaveAsTemplateOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState('');

  // Schedule dialog state.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleWhen, setScheduleWhen] = useState<'auto' | 'specific'>('auto');
  const [scheduleStart, setScheduleStart] = useState<string>('');
  const [scheduleDuration, setScheduleDuration] = useState<number>(30);

  // Slack post dialog state.
  const [slackOpen, setSlackOpen] = useState(false);
  const [slackChannel, setSlackChannel] = useState<string>('');
  const [slackText, setSlackText] = useState<string>('');
  const [slackThreadTs, setSlackThreadTs] = useState<string>('');
  const slackStatusQ = useSlackStatus();
  const slackConnected = Boolean(slackStatusQ.data?.connected);
  const slackChannelsQ = useSlackChannels(slackConnected && slackOpen);
  const postToSlack = usePostToSlack();

  // Gmail draft dialog state.
  const [gmailOpen, setGmailOpen] = useState(false);
  const [gmailTo, setGmailTo] = useState<string>('');
  const [gmailSubject, setGmailSubject] = useState<string>('');
  const [gmailBody, setGmailBody] = useState<string>('');
  const [gmailDraftId, setGmailDraftId] = useState<string | null>(null);
  const gmailStatusQ = useGmailStatus();
  const gmailConnected = Boolean(gmailStatusQ.data?.connected);
  const gmailSendEnabled = Boolean(gmailStatusQ.data?.send_enabled);
  const createGmailDraft = useCreateGmailDraft();
  const sendGmailDraft = useSendGmailDraft();

  // Local editable mirror. We hydrate from server data and patch on blur.
  // Only re-sync from server when the underlying `updated_at` changes so the
  // user's in-flight edits don't get stomped by background refetches.
  const serverTask = taskQ.data?.task ?? null;
  const [draft, setDraft] = useState<Task | null>(serverTask);

  useEffect(() => {
    if (!serverTask) return;
    setDraft((prev) =>
      prev && prev.id === serverTask.id && prev.updated_at === serverTask.updated_at
        ? prev
        : serverTask,
    );
  }, [serverTask]);

  // Record the visit for the "Where was I" resume list. Keyed on id+title so
  // a title edit refreshes the snapshot without spamming on every re-render.
  const recordVisit = useRecentsStore((s) => s.recordVisit);
  useEffect(() => {
    if (!serverTask) return;
    recordVisit({ id: serverTask.id, title: serverTask.title });
  }, [serverTask?.id, serverTask?.title, recordVisit]);

  const dirtyPatch = useMemo<UpdateTaskInput | null>(() => {
    if (!draft || !serverTask) return null;
    const patch: UpdateTaskInput = {};
    const keys: Array<keyof Task> = [
      'title',
      'description',
      'priority',
      'status',
      'due',
      'agent_method',
      'agent_executable',
      'agent_instructions',
      'tags',
    ];
    let any = false;
    for (const key of keys) {
      const dv = draft[key];
      const sv = serverTask[key];
      if (key === 'tags') {
        const dtags = draft.tags;
        const stags = serverTask.tags;
        if (
          dtags.length !== stags.length ||
          dtags.some((t, i) => t !== stags[i])
        ) {
          patch.tags = dtags;
          any = true;
        }
        continue;
      }
      if (dv !== sv) {
        (patch as Record<string, unknown>)[key] = dv;
        any = true;
      }
    }
    return any ? patch : null;
  }, [draft, serverTask]);

  const persist = async (patch?: UpdateTaskInput): Promise<void> => {
    if (!id) return;
    const body = patch ?? dirtyPatch;
    if (!body) return;
    try {
      await updateTask.mutateAsync({ id, patch: body });
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDerive = async (): Promise<void> => {
    if (!id) return;
    try {
      await deriveTask.mutateAsync({ id });
      toast({ title: 'Derivation requested' });
      navigate(`/derive/${id}`);
    } catch (cause) {
      toast({
        title: 'Derive failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleExecute = async (): Promise<void> => {
    if (!id) return;
    try {
      await executeTask.mutateAsync({ id });
      toast({ title: 'Execution requested' });
      navigate(`/execute/${id}`);
    } catch (cause) {
      toast({
        title: 'Execute failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleApprove = async (
    kind: 'derivation' | 'result',
  ): Promise<void> => {
    if (!id) return;
    try {
      await approveTask.mutateAsync({ id, body: { kind } });
      toast({ title: `Approved ${kind}` });
    } catch (cause) {
      toast({
        title: 'Approve failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleReject = async (
    kind: 'derivation' | 'result',
  ): Promise<void> => {
    if (!id) return;
    try {
      await rejectTask.mutateAsync({ id, body: { kind, requeue: false } });
      toast({ title: `Rejected ${kind}` });
    } catch (cause) {
      toast({
        title: 'Reject failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!id || !serverTask) return;
    const ok = window.confirm('Delete this task? This cannot be undone.');
    if (!ok) return;
    try {
      await deleteTask.mutateAsync({ id, parent_id: serverTask.parent_id });
      toast({ title: 'Task deleted' });
      navigate('/');
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleArchive = async (): Promise<void> => {
    if (!id) return;
    try {
      await archiveTask.mutateAsync({ id });
      toast({ title: 'Task archived' });
    } catch (cause) {
      toast({
        title: 'Archive failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleUnarchive = async (): Promise<void> => {
    if (!id) return;
    try {
      await unarchiveTask.mutateAsync({ id });
      toast({ title: 'Task restored' });
    } catch (cause) {
      toast({
        title: 'Restore failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleSchedule = async (): Promise<void> => {
    if (!id) return;
    const body: { start?: string; duration_minutes?: number } = {};
    if (scheduleWhen === 'specific') {
      const iso = fromLocalInput(scheduleStart);
      if (!iso) {
        toast({
          title: 'Schedule failed',
          description: 'Pick a valid start time first.',
          variant: 'destructive',
        });
        return;
      }
      body.start = iso;
    }
    if (Number.isFinite(scheduleDuration) && scheduleDuration > 0) {
      body.duration_minutes = scheduleDuration;
    }
    try {
      const result = await scheduleTask.mutateAsync({ id, body });
      const pretty = (() => {
        try {
          return new Date(result.start).toLocaleString();
        } catch {
          return result.start;
        }
      })();
      toast({
        title: 'Scheduled',
        description: (
          <a
            href={result.calendar_url}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {pretty}
          </a>
        ),
      });
      setScheduleOpen(false);
    } catch (cause) {
      toast({
        title: 'Schedule failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const slackContext = useMemo(() => {
    if (!draft?.context || typeof draft.context !== 'object') return null;
    const ctx = draft.context as Record<string, unknown>;
    const permalink = typeof ctx.slack_permalink === 'string' ? ctx.slack_permalink : null;
    const channel = typeof ctx.slack_channel === 'string' ? ctx.slack_channel : null;
    const channelId = typeof ctx.slack_channel_id === 'string' ? ctx.slack_channel_id : null;
    const user = typeof ctx.slack_user === 'string' ? ctx.slack_user : null;
    const threadTs = typeof ctx.slack_thread_ts === 'string' ? ctx.slack_thread_ts : null;
    const messageTs = typeof ctx.slack_message_ts === 'string' ? ctx.slack_message_ts : null;
    return { permalink, channel, channelId, user, threadTs, messageTs };
  }, [draft]);

  const gmailContext = useMemo(() => {
    if (!draft?.context || typeof draft.context !== 'object') return null;
    const ctx = draft.context as Record<string, unknown>;
    const messageId = typeof ctx.gmail_message_id === 'string' ? ctx.gmail_message_id : null;
    if (!messageId) return null;
    return {
      messageId,
      threadId: typeof ctx.gmail_thread_id === 'string' ? ctx.gmail_thread_id : null,
      from: typeof ctx.gmail_from === 'string' ? ctx.gmail_from : null,
      subject: typeof ctx.gmail_subject === 'string' ? ctx.gmail_subject : null,
      permalink: typeof ctx.gmail_permalink === 'string'
        ? ctx.gmail_permalink
        : `https://mail.google.com/mail/u/0/#inbox/${messageId}`,
      snippet: typeof ctx.gmail_snippet === 'string' ? ctx.gmail_snippet : null,
    };
  }, [draft]);

  const looksLikeEmailTask = useMemo(() => {
    if (!draft) return false;
    const text = `${draft.agent_instructions ?? ''} ${draft.title ?? ''}`.toLowerCase();
    return /\b(email|draft|send|reply|message|follow.?up)\b/.test(text);
  }, [draft]);

  const openExternalLink = async (url: string): Promise<void> => {
    if (typeof window === 'undefined') return;
    const bridge = (window as unknown as {
      taskpilot?: {
        openExternal?: (url: string) => Promise<unknown> | unknown;
        shell?: { openExternal?: (url: string) => Promise<void> | void };
      };
    }).taskpilot;
    try {
      if (bridge?.openExternal) {
        await bridge.openExternal(url);
        return;
      }
      if (bridge?.shell?.openExternal) {
        await bridge.shell.openExternal(url);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handlePostToSlack = async (): Promise<void> => {
    if (!id) return;
    const channel = slackChannel.trim();
    const text = slackText.trim();
    if (channel.length === 0 || text.length === 0) {
      toast({
        title: 'Pick a channel and write a message',
        variant: 'destructive',
      });
      return;
    }
    const threadTs = slackThreadTs.trim();
    try {
      const result = await postToSlack.mutateAsync({
        channel,
        text,
        ...(threadTs.length > 0 ? { thread_ts: threadTs } : {}),
      });
      toast({
        title: 'Posted to Slack',
        description: result.permalink ?? '',
      });
      // Persist the thread ts and permalink on the task so subsequent posts
      // can default into the same thread.
      const nextContext: Record<string, unknown> = {
        ...((draft?.context as Record<string, unknown>) ?? {}),
        slack_channel_id: result.channel,
        slack_thread_ts: threadTs.length > 0 ? threadTs : result.ts,
      };
      if (result.permalink) {
        nextContext.slack_permalink = result.permalink;
      }
      try {
        await updateTask.mutateAsync({ id, patch: { context: nextContext } });
      } catch {
        /* non-fatal — toast already fired */
      }
      setSlackOpen(false);
      setSlackText('');
    } catch (cause) {
      toast({
        title: 'Post failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const openGmailDialog = (): void => {
    setGmailDraftId(null);
    if (gmailContext) {
      setGmailTo(gmailContext.from ?? '');
      const subj = gmailContext.subject ?? '';
      setGmailSubject(/^re:/i.test(subj.trim()) ? subj : `Re: ${subj}`);
      setGmailBody('');
    } else {
      setGmailTo('');
      setGmailSubject('');
      setGmailBody('');
    }
    setGmailOpen(true);
  };

  const handleCreateGmailDraft = async (): Promise<void> => {
    if (!id) return;
    const to = gmailTo.trim();
    const subject = gmailSubject.trim();
    const body = gmailBody.trim();
    if (to.length === 0 || subject.length === 0 || body.length === 0) {
      toast({
        title: 'Fill in To, Subject, and Body first',
        variant: 'destructive',
      });
      return;
    }
    try {
      const result = await createGmailDraft.mutateAsync({
        to,
        subject,
        body,
        ...(gmailContext?.messageId
          ? { in_reply_to_message_id: gmailContext.messageId }
          : {}),
      });
      setGmailDraftId(result.draft_id);
      toast({
        title: 'Draft saved to Gmail',
        description: 'The draft is in your Drafts folder. Click Send to deliver.',
      });
    } catch (cause) {
      toast({
        title: 'Draft failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleSendGmailDraft = async (): Promise<void> => {
    if (!gmailDraftId) return;
    try {
      const result = await sendGmailDraft.mutateAsync({ draft_id: gmailDraftId });
      toast({
        title: 'Sent',
        description: `Gmail message ${result.message_id}.`,
      });
      setGmailOpen(false);
      setGmailDraftId(null);
      setGmailBody('');
    } catch (cause) {
      toast({
        title: 'Send failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleSaveAsTemplate = async (): Promise<void> => {
    if (!serverTask) return;
    const name = templateNameDraft.trim();
    if (name.length === 0) return;
    try {
      await createTemplate.mutateAsync({
        name,
        task_title: serverTask.title,
        task_description: serverTask.description ?? null,
        priority: serverTask.priority,
        agent_method: serverTask.agent_method,
        agent_instructions: serverTask.agent_instructions ?? null,
        tags: serverTask.tags,
      });
      toast({ title: 'Template saved', description: name });
      setSaveAsTemplateOpen(false);
      setTemplateNameDraft('');
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  if (taskQ.isLoading || !draft || !serverTask) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        aria-label="view-task-detail"
      >
        Loading task…
      </div>
    );
  }

  if (taskQ.isError) {
    return (
      <div
        className="p-6"
        aria-label="view-task-detail"
        role="alert"
      >
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Couldn’t load task {id}.
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
      </div>
    );
  }

  const children = childrenQ.data?.tasks ?? [];
  const parent = parentQ.data?.task ?? null;
  const isAgentTask = draft.agent_method !== 'human_only';
  const canDerive = draft.status === 'inbox';
  const canExecute =
    isAgentTask && (draft.status === 'queued' || draft.status === 'inbox');
  const isAwaitingDerivApproval =
    draft.agent_status === 'needs_review' && draft.status === 'inbox';
  const isAwaitingResultApproval =
    draft.agent_status === 'needs_review' && draft.status === 'in_progress';
  const hasResult = draft.status === 'done' || draft.status === 'failed';

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-label="view-task-detail"
    >
      <header className="border-b border-border bg-background/60 px-6 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate(-1)}
            aria-label="task-detail-back"
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={draft.status} />
            <AgentStatusBadge status={draft.agent_status} />
            <AgentMethodBadge method={draft.agent_method} />
          </div>
        </div>

        <Input
          value={draft.title}
          onChange={(e) =>
            setDraft((s) => (s ? { ...s, title: e.target.value } : s))
          }
          onBlur={() => {
            if (draft.title.trim().length === 0) {
              setDraft((s) =>
                s ? { ...s, title: serverTask.title } : s,
              );
              return;
            }
            void persist();
          }}
          className="h-auto border-0 bg-transparent px-0 text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0"
          aria-label="task-title-input"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>ID: {draft.id}</span>
          <span>·</span>
          <span>Created {new Date(draft.created_at).toLocaleString()}</span>
          <span>·</span>
          <span>Updated {new Date(draft.updated_at).toLocaleString()}</span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void handleDerive();
            }}
            disabled={!canDerive || deriveTask.isPending}
            aria-label="task-detail-derive"
          >
            <Sparkles className="mr-1 h-4 w-4" />
            Derive
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void handleExecute();
            }}
            disabled={!canExecute || executeTask.isPending}
            aria-label="task-detail-execute"
          >
            <PlayCircle className="mr-1 h-4 w-4" />
            Execute
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => navigate(`/focus/${draft.id}`)}
            aria-label="task-detail-focus"
          >
            <FocusIcon className="mr-1 h-4 w-4" />
            Focus
          </Button>
          {(isAwaitingDerivApproval || isAwaitingResultApproval) && (
            <>
              <Separator orientation="vertical" className="mx-1 h-6" />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void handleApprove(
                    isAwaitingDerivApproval ? 'derivation' : 'result',
                  );
                }}
                disabled={approveTask.isPending}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                aria-label="task-detail-approve"
              >
                <CheckCircle2 className="mr-1 h-4 w-4" />
                Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleReject(
                    isAwaitingDerivApproval ? 'derivation' : 'result',
                  );
                }}
                disabled={rejectTask.isPending}
                aria-label="task-detail-reject"
              >
                <XCircle className="mr-1 h-4 w-4" />
                Reject
              </Button>
            </>
          )}

          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label="task-detail-more"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={
                    draft.status === 'done' ||
                    draft.status === 'failed' ||
                    draft.status === 'archived' ||
                    scheduleTask.isPending
                  }
                  onClick={() => {
                    setScheduleWhen('auto');
                    setScheduleStart(toLocalInput(draft.due ?? null));
                    setScheduleOpen(true);
                  }}
                  aria-label="task-detail-schedule"
                >
                  <CalendarClock className="mr-2 h-4 w-4" />
                  {draft.calendar_event_id
                    ? 'Update calendar event'
                    : 'Schedule on calendar'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setTemplateNameDraft(draft.title);
                    setSaveAsTemplateOpen(true);
                  }}
                  aria-label="task-detail-save-as-template"
                >
                  <FileText className="mr-2 h-4 w-4" />
                  Save as template
                </DropdownMenuItem>
                {draft.status === 'archived' ? (
                  <DropdownMenuItem
                    disabled={unarchiveTask.isPending}
                    onClick={() => {
                      void handleUnarchive();
                    }}
                    aria-label="task-detail-unarchive"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    disabled={archiveTask.isPending}
                    onClick={() => {
                      void handleArchive();
                    }}
                    aria-label="task-detail-archive"
                  >
                    <ArchiveIcon className="mr-2 h-4 w-4" />
                    Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={deleteTask.isPending}
                  onClick={() => {
                    void handleDelete();
                  }}
                  className="text-red-600 focus:text-red-700 dark:text-red-400"
                  aria-label="task-detail-delete"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {(() => {
          const rule = readRecurrence(draft);
          if (!rule) return null;
          return (
            <div
              className="mt-3 inline-flex items-center gap-1 rounded-md bg-secondary/60 px-2 py-1 text-[11px] text-secondary-foreground"
              aria-label="task-detail-recurrence"
            >
              <Repeat className="h-3 w-3" />
              Repeats {describeRecurrence(rule)}
            </div>
          );
        })()}
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <Tabs
            value={detailTab}
            onValueChange={(v) => setDetailTab(v as 'details' | 'outputs')}
          >
            <TabsList aria-label="task-detail-tabs">
              <TabsTrigger value="details" aria-label="task-detail-tab-details">
                Details
              </TabsTrigger>
              <TabsTrigger value="outputs" aria-label="task-detail-tab-outputs">
                Outputs{outputsCount > 0 ? ` (${outputsCount})` : ''}
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="outputs"
              className="mt-4"
              aria-label="task-detail-tab-content-outputs"
            >
              <OutputsPanel taskId={draft.id} />
            </TabsContent>

            <TabsContent
              value="details"
              className="mt-4 flex flex-col gap-4"
              aria-label="task-detail-tab-content-details"
            >
          <Section
            title="Description"
            description="Markdown supported (tables, lists, links, code)."
            ariaLabel="task-detail-description-section"
          >
            {editingDescription ? (
              <MarkdownEditor
                value={draft.description ?? ''}
                onChange={(next) =>
                  setDraft((s) =>
                    s ? { ...s, description: next.length > 0 ? next : null } : s,
                  )
                }
                onBlur={() => {
                  setEditingDescription(false);
                  void persist();
                }}
                rows={8}
                placeholder="Context, success criteria, related links…"
                ariaLabel="task-description-input"
                autoFocus
              />
            ) : (
              <div
                role="button"
                tabIndex={0}
                onClick={() => setEditingDescription(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditingDescription(true);
                  }
                }}
                aria-label="task-description-markdown"
                className="min-h-[3rem] cursor-text rounded-md border border-transparent px-2 py-1 hover:border-border"
              >
                {draft.description ? (
                  <MarkdownView source={draft.description} />
                ) : (
                  <p className="text-xs italic text-muted-foreground">
                    Click to add a description.
                  </p>
                )}
              </div>
            )}
          </Section>

          <Section title="Metadata" ariaLabel="task-detail-metadata-section">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <Select
                  value={draft.status}
                  onValueChange={(v) => {
                    const next = v as TaskStatus;
                    setDraft((s) => (s ? { ...s, status: next } : s));
                    void persist({ status: next });
                  }}
                >
                  <SelectTrigger
                    className="h-8 text-xs"
                    aria-label="task-detail-status"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status.replace('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Priority</Label>
                <PriorityPicker
                  value={draft.priority}
                  onChange={(next: TaskPriority) => {
                    setDraft((s) => (s ? { ...s, priority: next } : s));
                    void persist({ priority: next });
                  }}
                  className="w-full"
                  ariaLabel="task-detail-priority"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Phase</Label>
                <PhasePicker
                  taskId={draft.id}
                  className="w-full"
                  ariaLabel="task-detail-phase"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Goal</Label>
                <GoalPicker
                  taskId={draft.id}
                  className="w-full"
                  ariaLabel="task-detail-goal"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Due</Label>
                <Input
                  type="datetime-local"
                  value={toLocalInput(draft.due)}
                  onChange={(e) => {
                    const iso = fromLocalInput(e.target.value);
                    setDraft((s) => (s ? { ...s, due: iso } : s));
                  }}
                  onBlur={() => {
                    void persist();
                  }}
                  aria-label="task-detail-due"
                  className="h-8 text-xs"
                />
                <div className="text-[11px] text-muted-foreground">
                  {dueLabel(draft.due)}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Agent method</Label>
                <Select
                  value={draft.agent_method}
                  onValueChange={(v) => {
                    const next = v as AgentMethod;
                    setDraft((s) =>
                      s
                        ? {
                            ...s,
                            agent_method: next,
                            agent_executable: next !== 'human_only',
                          }
                        : s,
                    );
                    void persist({
                      agent_method: next,
                      agent_executable: next !== 'human_only',
                    });
                  }}
                >
                  <SelectTrigger
                    className="h-8 text-xs"
                    aria-label="task-detail-agent-method"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m.replace('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs">Tags</Label>
                <TagInput
                  value={draft.tags}
                  onChange={(next) => {
                    setDraft((s) => (s ? { ...s, tags: next } : s));
                    void persist({ tags: next });
                  }}
                  ariaLabel="task-detail-tags"
                />
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs">Calendar event</Label>
                <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  {draft.calendar_event_id ?? 'Not linked to a calendar event.'}
                </div>
              </div>
            </div>
          </Section>

          {isAgentTask && (
            <Section
              title="Agent instructions"
              description="What Claude should do when executing this task."
              ariaLabel="task-detail-agent-instructions-section"
            >
              <Textarea
                value={draft.agent_instructions ?? ''}
                onChange={(e) =>
                  setDraft((s) =>
                    s
                      ? {
                          ...s,
                          agent_instructions: e.target.value || null,
                        }
                      : s,
                  )
                }
                onBlur={() => {
                  void persist();
                }}
                rows={4}
                placeholder="Step-by-step. Reference files, paths, success criteria."
                aria-label="task-detail-agent-instructions"
              />
            </Section>
          )}

          <RedditSection task={draft} />
          <LovableSection task={draft} />
          <GithubIssueSection task={draft} />
          <NotionPageSection task={draft} />

          <Section
            title="Permissions"
            description="Controls what an agent may read/write/run when working on this task. Inherits from the parent unless overridden."
            ariaLabel="task-detail-permissions-section"
          >
            <PermissionsEditor taskId={draft.id} />
          </Section>

          <Section
            title="Links"
            description="Cross-task relationships beyond the parent → child tree. Blocks, related, duplicate-of."
            ariaLabel="task-detail-links-section"
          >
            <TaskLinkEditor taskId={draft.id} />
          </Section>

          <Section
            title="Skill bindings"
            description="Which Claude skills should handle this task. Auto-injected into derive + execute requests."
            ariaLabel="task-detail-skills-section"
          >
            <SkillBindingEditor taskId={draft.id} />
          </Section>

          <Section
            title="Attachments"
            description="Drop files onto this task. Claude can read them during execution; the on-disk path is surfaced via context.attachment_paths."
            ariaLabel="task-detail-attachments-section"
          >
            <div className="space-y-3">
              <AttachmentDrop taskId={draft.id} />
              <AttachmentList taskId={draft.id} />
            </div>
          </Section>

          <Section
            title="Derivative tree"
            description="Parent and child tasks linked to this one."
            ariaLabel="task-detail-tree-section"
          >
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Parent</Label>
                {parent ? (
                  <Link
                    to={`/task/${parent.id}`}
                    className="mt-1 flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/40"
                    aria-label="task-detail-parent-link"
                  >
                    <span className="truncate">{parent.title}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                ) : (
                  <div className="mt-1 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    Top-level task (no parent).
                  </div>
                )}
              </div>

              <div>
                <Label className="text-xs text-muted-foreground">
                  Children ({children.length})
                </Label>
                {childrenQ.isLoading && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Loading…
                  </div>
                )}
                {!childrenQ.isLoading && children.length === 0 && (
                  <div className="mt-1 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    No derivatives yet. Run “Derive” to generate sub-tasks.
                  </div>
                )}
                {children.length > 0 && (
                  <ul
                    className="mt-1 flex flex-col gap-2"
                    aria-label="task-detail-children"
                  >
                    {children.map((child) => (
                      <li key={child.id}>
                        <TaskCard
                          task={child}
                          compact
                          onClick={() => navigate(`/task/${child.id}`)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Link
                to={`/graph?root=${encodeURIComponent(draft.id)}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-label="task-detail-view-in-graph"
              >
                <Share2 className="h-3.5 w-3.5" />
                View in graph
              </Link>
            </div>
          </Section>

          <Section
            title="Execution log"
            description="Latest run details for this task."
            ariaLabel="task-detail-execution-section"
          >
            {hasResult ? (
              <div className="space-y-2 text-sm">
                <div
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs',
                    draft.status === 'done'
                      ? 'border-emerald-300/40 bg-emerald-50 text-emerald-900 dark:border-emerald-800/40 dark:bg-emerald-950/40 dark:text-emerald-200'
                      : 'border-red-300/40 bg-red-50 text-red-900 dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-200',
                  )}
                >
                  <span>Final status: {draft.status}</span>
                  {(() => {
                    // Pull the latest confidence value off task.context.
                    // Ingestion writes it whenever Claude reports one.
                    const ctx = draft.context as Record<string, unknown> | null;
                    const raw = ctx?.['last_confidence'];
                    if (typeof raw !== 'number') return null;
                    return (
                      <ConfidenceBadge
                        value={raw}
                        threshold={0.7}
                        aria-label="task-detail-confidence"
                      />
                    );
                  })()}
                </div>
                <p className="text-xs text-muted-foreground">
                  Detailed logs and output files surface once Wave 2H lights up
                  the execution view.
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                No execution yet.
              </div>
            )}
          </Section>

          <Section
            title="Journal"
            description="Every event that touched this task — runs, derivations, feedback, costs, integrations — in order."
            ariaLabel="task-detail-journal-section"
          >
            <TaskJournal taskId={draft.id} />
          </Section>

          <Section
            title="Decision log"
            description="Append-only notes — decisions, context, references, rationale, and risks. Claude writes these during execute; add your own below."
            ariaLabel="task-detail-decision-log-section"
          >
            <DecisionLog taskId={draft.id} />
          </Section>

          <Section
            title="Knowledge"
            description="Local knowledge auto-matched to this task by business + relevance. Injected into derive/execute so the agent can read it."
            ariaLabel="task-detail-knowledge-section"
          >
            {knowledgeQ.isLoading ? (
              <div className="text-xs text-muted-foreground">Loading…</div>
            ) : !knowledgeQ.data || knowledgeQ.data.matches.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                No matched knowledge. Tag this task with a business (e.g.{' '}
                <code>leal-health</code>) and drop resources in its Knowledge
                folder.
              </div>
            ) : (
              <ul
                className="flex flex-col gap-2 text-xs"
                aria-label="task-detail-knowledge-list"
              >
                {knowledgeQ.data.matches.map(({ resource, score }) => (
                  <li
                    key={`${resource.business}/${resource.file}`}
                    className="rounded-md border border-border bg-background/40 p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {resource.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {resource.business} · {score}
                      </span>
                    </div>
                    {resource.summary && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                        {resource.summary}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Feedback"
            description="Rejections and notes recorded on this task."
            ariaLabel="task-detail-feedback-section"
          >
            {(() => {
              const entries = feedbackQ.data?.entries ?? [];
              if (feedbackQ.isLoading) {
                return (
                  <div className="text-xs text-muted-foreground">Loading…</div>
                );
              }
              if (entries.length === 0) {
                return (
                  <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    No feedback recorded.
                  </div>
                );
              }
              return (
                <ul
                  className="flex flex-col gap-2 text-xs"
                  aria-label="task-detail-feedback-list"
                >
                  {entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="rounded-md border border-border bg-background/40 p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                          {entry.kind.replace(/_/g, ' ')}
                        </span>
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {new Date(entry.at).toLocaleString()}
                        </span>
                      </div>
                      {entry.reason && (
                        <p className="mt-1 whitespace-pre-wrap text-foreground">
                          {entry.reason}
                        </p>
                      )}
                      {entry.details && (
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-1 text-[10px] text-muted-foreground">
                          {entry.details}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              );
            })()}
          </Section>

          <Section
            title="Context attachments"
            description="Structured context Claude can reference at derive/execute time."
            ariaLabel="task-detail-context-section"
          >
            {draft.context && Object.keys(draft.context).length > 0 ? (
              <pre
                className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed"
                aria-label="task-detail-context-json"
              >
                {JSON.stringify(draft.context, null, 2)}
              </pre>
            ) : (
              <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                No context attached.
              </div>
            )}
          </Section>

          <Section
            title="Slack thread"
            description="Linked Slack message or post task updates back to Slack."
            ariaLabel="task-detail-slack-section"
          >
            {slackContext?.permalink ? (
              <div className="space-y-2 text-xs" aria-label="task-detail-slack-permalink">
                <button
                  type="button"
                  onClick={() => {
                    void openExternalLink(slackContext.permalink as string);
                  }}
                  className="inline-flex items-center gap-1 text-primary underline"
                  aria-label="task-detail-slack-open-permalink"
                >
                  Open in Slack
                </button>
                <div className="text-muted-foreground">
                  {slackContext.channel ? `#${slackContext.channel}` : ''}
                  {slackContext.user ? ` · @${slackContext.user}` : ''}
                </div>
                <div className="break-all rounded bg-muted px-2 py-1 font-mono text-[10px]">
                  {slackContext.permalink}
                </div>
                {slackConnected && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSlackChannel(slackContext.channelId ?? '');
                      setSlackThreadTs(
                        slackContext.threadTs ?? slackContext.messageTs ?? '',
                      );
                      setSlackText('');
                      setSlackOpen(true);
                    }}
                    aria-label="task-detail-slack-reply"
                  >
                    Reply in thread
                  </Button>
                )}
              </div>
            ) : slackConnected ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setSlackChannel('');
                  setSlackThreadTs('');
                  setSlackText('');
                  setSlackOpen(true);
                }}
                aria-label="task-detail-slack-post"
              >
                Post update to Slack
              </Button>
            ) : (
              <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                Slack isn’t connected. Open Settings → Integrations to enable
                posting task updates to Slack.
              </div>
            )}
          </Section>

          <Section
            title={gmailContext ? 'From Gmail' : 'Email'}
            description={
              gmailContext
                ? 'This task was captured from a Gmail message.'
                : 'Draft an email tied to this task.'
            }
            ariaLabel="task-detail-gmail-section"
          >
            {gmailContext ? (
              <div className="space-y-2 text-xs" aria-label="task-detail-gmail-context">
                {gmailContext.subject && (
                  <div className="font-medium text-foreground">
                    {gmailContext.subject}
                  </div>
                )}
                {gmailContext.from && (
                  <div className="text-muted-foreground">
                    From: {gmailContext.from}
                  </div>
                )}
                {gmailContext.snippet && (
                  <div className="rounded bg-muted/50 px-2 py-1 text-muted-foreground">
                    {gmailContext.snippet}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      void openExternalLink(gmailContext.permalink);
                    }}
                    className="inline-flex items-center gap-1 text-primary underline"
                    aria-label="task-detail-gmail-open"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open in Gmail
                  </button>
                  {gmailConnected && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={openGmailDialog}
                      aria-label="task-detail-gmail-reply"
                    >
                      <Mail className="mr-1 h-4 w-4" />
                      Draft reply
                    </Button>
                  )}
                </div>
              </div>
            ) : gmailConnected && looksLikeEmailTask ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={openGmailDialog}
                aria-label="task-detail-gmail-draft"
              >
                <Mail className="mr-1 h-4 w-4" />
                Draft an email
              </Button>
            ) : (
              <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                {gmailConnected
                  ? 'No Gmail message linked. Click "Draft an email" if you want to compose one.'
                  : 'Gmail isn’t connected. Open Settings → Integrations to enable email capture and drafts.'}
                {gmailConnected && !looksLikeEmailTask && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={openGmailDialog}
                    className="ml-2"
                    aria-label="task-detail-gmail-draft-anyway"
                  >
                    Draft an email
                  </Button>
                )}
              </div>
            )}
          </Section>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent
          aria-label="task-detail-schedule-dialog"
          className="sm:max-w-[460px]"
        >
          <DialogHeader>
            <DialogTitle>
              {draft.calendar_event_id
                ? 'Update calendar event'
                : 'Schedule on calendar'}
            </DialogTitle>
            <DialogDescription>
              Reserve a block on your calendar for this task. Auto-pick uses
              the next available window; specific time lets you nail down a
              start.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium">When?</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="schedule-when"
                  value="auto"
                  checked={scheduleWhen === 'auto'}
                  onChange={() => setScheduleWhen('auto')}
                  aria-label="task-detail-schedule-when-auto"
                />
                Auto-pick next free slot
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="schedule-when"
                  value="specific"
                  checked={scheduleWhen === 'specific'}
                  onChange={() => setScheduleWhen('specific')}
                  aria-label="task-detail-schedule-when-specific"
                />
                Specific time
              </label>
              {scheduleWhen === 'specific' && (
                <Input
                  type="datetime-local"
                  value={scheduleStart}
                  onChange={(e) => setScheduleStart(e.target.value)}
                  aria-label="task-detail-schedule-start"
                  className="h-8 text-xs"
                />
              )}
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor="schedule-duration" className="text-xs">
                Duration (minutes)
              </Label>
              <Input
                id="schedule-duration"
                type="number"
                min={5}
                max={1440}
                step={5}
                value={scheduleDuration}
                onChange={(e) =>
                  setScheduleDuration(
                    Number.parseInt(e.target.value, 10) || 30,
                  )
                }
                aria-label="task-detail-schedule-duration"
                className="h-8 text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setScheduleOpen(false)}
              aria-label="task-detail-schedule-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void handleSchedule();
              }}
              disabled={scheduleTask.isPending}
              aria-label="task-detail-schedule-confirm"
            >
              Create event
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={slackOpen} onOpenChange={setSlackOpen}>
        <DialogContent
          aria-label="task-detail-slack-dialog"
          className="sm:max-w-[460px]"
        >
          <DialogHeader>
            <DialogTitle>Post to Slack</DialogTitle>
            <DialogDescription>
              {slackThreadTs.length > 0
                ? 'Reply in the linked thread.'
                : 'Post a task update to a channel.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Channel</Label>
              <Select
                value={slackChannel}
                onValueChange={(v) => setSlackChannel(v)}
              >
                <SelectTrigger
                  className="h-8 text-xs"
                  aria-label="task-detail-slack-channel"
                >
                  <SelectValue
                    placeholder={
                      slackChannelsQ.isLoading
                        ? 'Loading channels…'
                        : 'Pick a channel'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(slackChannelsQ.data?.channels ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      #{c.name}
                      {c.is_private ? ' (private)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="slack-thread-ts">
                Thread ts (optional)
              </Label>
              <Input
                id="slack-thread-ts"
                value={slackThreadTs}
                onChange={(e) => setSlackThreadTs(e.target.value)}
                placeholder="1701234567.000200"
                aria-label="task-detail-slack-thread-ts"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="slack-text">
                Message
              </Label>
              <Textarea
                id="slack-text"
                value={slackText}
                onChange={(e) => setSlackText(e.target.value)}
                rows={5}
                placeholder="Task done — see PR at …"
                aria-label="task-detail-slack-text"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSlackOpen(false)}
              aria-label="task-detail-slack-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void handlePostToSlack();
              }}
              disabled={
                postToSlack.isPending ||
                slackChannel.trim().length === 0 ||
                slackText.trim().length === 0
              }
              aria-label="task-detail-slack-submit"
            >
              {postToSlack.isPending ? 'Posting…' : 'Post'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={saveAsTemplateOpen} onOpenChange={setSaveAsTemplateOpen}>
        <DialogContent
          aria-label="task-detail-save-template-dialog"
          className="sm:max-w-[460px]"
        >
          <DialogHeader>
            <DialogTitle>Save task as template</DialogTitle>
            <DialogDescription>
              Reuse this task’s title, description, priority, tags, and agent
              settings as a one-click template.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="save-template-name">Template name</Label>
            <Input
              id="save-template-name"
              value={templateNameDraft}
              onChange={(e) => setTemplateNameDraft(e.target.value)}
              placeholder="Weekly review prep"
              aria-label="task-detail-template-name"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSaveAsTemplateOpen(false)}
              aria-label="task-detail-template-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void handleSaveAsTemplate();
              }}
              disabled={
                createTemplate.isPending ||
                templateNameDraft.trim().length === 0
              }
              aria-label="task-detail-template-save"
            >
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={gmailOpen} onOpenChange={setGmailOpen}>
        <DialogContent
          aria-label="task-detail-gmail-dialog"
          className="sm:max-w-[520px]"
        >
          <DialogHeader>
            <DialogTitle>
              {gmailContext ? 'Reply via Gmail' : 'Draft an email'}
            </DialogTitle>
            <DialogDescription>
              {gmailDraftId
                ? 'Draft is saved in Gmail. Review it there before sending if you’d like.'
                : 'Saves to your Gmail Drafts folder. Sending requires "Enable send" in Settings.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">To</Label>
              <Input
                type="text"
                value={gmailTo}
                onChange={(e) => setGmailTo(e.target.value)}
                placeholder="recipient@example.com"
                aria-label="task-detail-gmail-to"
                className="h-8 text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Subject</Label>
              <Input
                type="text"
                value={gmailSubject}
                onChange={(e) => setGmailSubject(e.target.value)}
                aria-label="task-detail-gmail-subject"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Body</Label>
              <Textarea
                value={gmailBody}
                onChange={(e) => setGmailBody(e.target.value)}
                rows={8}
                aria-label="task-detail-gmail-body"
                placeholder="Write the email body here…"
              />
            </div>
            {gmailDraftId && (
              <div
                className="rounded-md border border-emerald-500/40 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-100"
                aria-label="task-detail-gmail-draft-ready"
              >
                Draft saved (id: <code>{gmailDraftId}</code>). Click Send when
                you’re ready.
              </div>
            )}
            {!gmailSendEnabled && (
              <div className="rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
                Sending is disabled. Toggle "Enable send" in Settings →
                Integrations → Gmail to allow Claude to send on your behalf.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setGmailOpen(false)}
              aria-label="task-detail-gmail-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void handleCreateGmailDraft();
              }}
              disabled={
                createGmailDraft.isPending ||
                gmailTo.trim().length === 0 ||
                gmailSubject.trim().length === 0 ||
                gmailBody.trim().length === 0
              }
              aria-label="task-detail-gmail-save-draft"
            >
              {createGmailDraft.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              type="button"
              onClick={() => {
                void handleSendGmailDraft();
              }}
              disabled={
                !gmailDraftId || !gmailSendEnabled || sendGmailDraft.isPending
              }
              aria-label="task-detail-gmail-send"
            >
              {sendGmailDraft.isPending ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Reddit section                                                            */
/* -------------------------------------------------------------------------- */

interface RedditContextShape {
  reddit?: {
    subreddit?: string;
    post_id?: string;
  };
}

function readRedditContext(task: Task): {
  subreddit: string;
  post_id: string | null;
} | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const ctx = task.context as RedditContextShape;
  const sub = ctx.reddit?.subreddit;
  if (typeof sub !== 'string' || sub.trim().length === 0) return null;
  let normalized = sub.trim();
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized.toLowerCase().startsWith('r/')) normalized = normalized.slice(2);
  const postId = ctx.reddit?.post_id;
  return {
    subreddit: normalized,
    post_id:
      typeof postId === 'string' && postId.trim().length > 0
        ? postId.trim()
        : null,
  };
}

interface RedditSectionProps {
  task: Task;
}

function RedditSection({ task }: RedditSectionProps): JSX.Element | null {
  const ref = readRedditContext(task);
  const [open, setOpen] = useState(false);
  const postsQ = useSubredditPosts(
    ref?.subreddit ?? null,
    { sort: 'hot', limit: 10 },
    { enabled: open },
  );

  if (!ref) return null;

  return (
    <Section
      title="Reddit"
      description={`This task targets r/${ref.subreddit}.`}
      ariaLabel="task-detail-reddit-section"
    >
      <div className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`https://reddit.com/r/${ref.subreddit}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs hover:bg-muted"
            aria-label="task-detail-reddit-subreddit-link"
          >
            <MessageCircle className="h-3 w-3" aria-hidden="true" />
            r/{ref.subreddit}
            <ExternalLink className="h-3 w-3" />
          </a>
          {ref.post_id ? (
            <a
              href={`https://reddit.com/r/${ref.subreddit}/comments/${ref.post_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs hover:bg-muted"
              aria-label="task-detail-reddit-post-link"
            >
              Post {ref.post_id}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen((s) => !s)}
            aria-label="task-detail-reddit-pull-posts"
          >
            {open ? 'Hide posts' : 'Pull posts'}
          </Button>
        </div>

        {open && (
          <div
            className="rounded-md border border-border bg-muted/20 p-2"
            aria-label="task-detail-reddit-posts"
          >
            {postsQ.isLoading && (
              <div className="text-muted-foreground">Loading…</div>
            )}
            {postsQ.isError && (
              <div className="text-destructive">
                {postsQ.error instanceof Error
                  ? postsQ.error.message
                  : 'Failed to load posts.'}
              </div>
            )}
            {postsQ.data && postsQ.data.posts.length === 0 && (
              <div className="text-muted-foreground">No posts.</div>
            )}
            {postsQ.data && postsQ.data.posts.length > 0 && (
              <ul className="space-y-1.5">
                {postsQ.data.posts.slice(0, 10).map((post) => (
                  <li key={post.id} className="flex items-start gap-2">
                    <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                      {post.score}
                    </span>
                    <a
                      href={`https://reddit.com${post.permalink}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 truncate text-primary underline"
                    >
                      {post.title}
                    </a>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {post.num_comments}c
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Lovable section                                                           */
/* -------------------------------------------------------------------------- */

interface LovableContextShape {
  lovable?: {
    project_id?: string;
    url?: string;
  };
}

function readLovableContext(task: Task): {
  project_id: string;
  url: string | null;
} | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const ctx = task.context as LovableContextShape;
  const id = ctx.lovable?.project_id;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  const url = ctx.lovable?.url;
  return {
    project_id: id.trim(),
    url: typeof url === 'string' && url.trim().length > 0 ? url.trim() : null,
  };
}

interface LovableSectionProps {
  task: Task;
}

function LovableSection({ task }: LovableSectionProps): JSX.Element | null {
  const ref = readLovableContext(task);
  if (!ref) return null;

  const url =
    ref.url ?? `https://lovable.dev/projects/${encodeURIComponent(ref.project_id)}`;

  return (
    <Section
      title="Lovable"
      description="This task targets a Lovable.dev project. Claude routes execution through the lovable-builder skill."
      ariaLabel="task-detail-lovable-section"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs hover:bg-muted"
          aria-label="task-detail-lovable-open"
        >
          <Sparkles className="h-3 w-3" aria-hidden="true" />
          Open in Lovable
          <ExternalLink className="h-3 w-3" />
        </a>
        <div className="font-mono text-[10px] text-muted-foreground">
          project_id: {ref.project_id}
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  GitHub Issue section                                                      */
/* -------------------------------------------------------------------------- */

interface GithubIssueShape {
  github_issue?: {
    owner?: string;
    repo?: string;
    number?: number;
    url?: string;
    state?: string;
    labels?: string[];
  };
}

function readGithubIssue(task: Task): {
  owner: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  labels: string[];
} | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const ctx = task.context as GithubIssueShape;
  const issue = ctx.github_issue;
  if (
    !issue ||
    typeof issue.owner !== 'string' ||
    typeof issue.repo !== 'string' ||
    typeof issue.number !== 'number'
  ) {
    return null;
  }
  return {
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    url:
      typeof issue.url === 'string' && issue.url.length > 0
        ? issue.url
        : `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`,
    state: typeof issue.state === 'string' ? issue.state : 'open',
    labels: Array.isArray(issue.labels)
      ? issue.labels.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

interface GithubIssueSectionProps {
  task: Task;
}

function GithubIssueSection({
  task,
}: GithubIssueSectionProps): JSX.Element | null {
  // The hook MUST run unconditionally to satisfy React's Rules of
  // Hooks, even though we return null on the next line when the task
  // has no linked issue. The hook is cheap (cached query under
  // `staleTime: 60_000`) so the extra call is negligible.
  const syncBack = useStringSettingLocal('github_issues_sync_back', '');
  const ref = readGithubIssue(task);
  if (!ref) return null;

  const isOn = syncBack.value === 'true' || syncBack.value === '1';

  return (
    <Section
      title="GitHub issue"
      description="Linked GitHub issue mirrored into this task."
      ariaLabel="task-detail-github-issue-section"
    >
      <div className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={ref.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs hover:bg-muted"
            aria-label="task-detail-github-issue-link"
          >
            <Github className="h-3 w-3" aria-hidden="true" />
            {ref.owner}/{ref.repo}#{ref.number}
            <ExternalLink className="h-3 w-3" />
          </a>
          <span
            className={
              ref.state === 'closed'
                ? 'rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-900 dark:bg-purple-950/40 dark:text-purple-200'
                : 'rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
            }
          >
            {ref.state}
          </span>
        </div>
        {ref.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {ref.labels.map((label) => (
              <span
                key={label}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        )}
        <label
          className="flex items-center gap-2 text-[11px] text-muted-foreground"
          aria-label="task-detail-github-issue-mirror-toggle"
        >
          <input
            type="checkbox"
            checked={isOn}
            onChange={(e) => {
              void syncBack.save(e.target.checked ? 'true' : '');
            }}
            className="h-3.5 w-3.5"
            aria-label="task-detail-github-issue-mirror-checkbox"
          />
          Mirror task status to issue (close on done, reopen on requeue)
        </label>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Notion page section                                                       */
/* -------------------------------------------------------------------------- */

interface NotionPageShape {
  notion_page_id?: string;
  notion_page_url?: string;
  notion_synced_at?: string;
}

function readNotionContext(task: Task): {
  pageId: string;
  url: string | null;
  syncedAt: string | null;
} | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const ctx = task.context as NotionPageShape;
  const id = ctx.notion_page_id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    pageId: id,
    url: typeof ctx.notion_page_url === 'string' ? ctx.notion_page_url : null,
    syncedAt:
      typeof ctx.notion_synced_at === 'string' ? ctx.notion_synced_at : null,
  };
}

interface NotionPageSectionProps {
  task: Task;
}

function NotionPageSection({
  task,
}: NotionPageSectionProps): JSX.Element | null {
  const ref = readNotionContext(task);
  if (!ref) return null;

  const syncedLabel = ref.syncedAt
    ? (() => {
        try {
          return formatDistanceToNowStrict(parseISO(ref.syncedAt!), {
            addSuffix: true,
          });
        } catch {
          return ref.syncedAt;
        }
      })()
    : null;

  return (
    <Section
      title="Notion page"
      description="This task is mirrored to Notion."
      ariaLabel="task-detail-notion-section"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {ref.url ? (
          <a
            href={ref.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs hover:bg-muted"
            aria-label="task-detail-notion-link"
          >
            Open in Notion
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground">
            page_id: {ref.pageId}
          </span>
        )}
        {syncedLabel && (
          <span className="text-[10px] text-muted-foreground">
            Last sync: {syncedLabel}
          </span>
        )}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Local setting hook (mirrors the one inside NotionIntegrationCard)         */
/* -------------------------------------------------------------------------- */

interface LocalSettingResponse {
  value: string | null;
}

function useStringSettingLocal(
  key: string,
  defaultValue: string,
): {
  value: string;
  save: (next: string) => Promise<void>;
} {
  const qc = useQueryClient();
  const settingQ = useQuery({
    queryKey: ['settings', key],
    queryFn: async (): Promise<LocalSettingResponse | null> => {
      try {
        return await api.get<LocalSettingResponse>(
          `/api/settings/${encodeURIComponent(key)}`,
        );
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) {
          return { value: null };
        }
        return null;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (next: string): Promise<void> => {
      await api.patch(`/api/settings/${encodeURIComponent(key)}`, {
        value: next.length === 0 ? null : next,
      });
    },
    onSuccess: (_res, next) => {
      qc.setQueryData(['settings', key], {
        value: next.length === 0 ? null : next,
      });
    },
  });
  const raw =
    settingQ.data && typeof settingQ.data === 'object' && 'value' in settingQ.data
      ? (settingQ.data as LocalSettingResponse).value
      : null;
  const value = raw === null ? defaultValue : raw;
  return {
    value,
    save: async (next: string): Promise<void> => {
      await mutation.mutateAsync(next);
    },
  };
}
