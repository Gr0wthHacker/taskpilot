/**
 * Execution Workspace (PRD §9.5).
 *
 * Single-task focus designed to be operable end-to-end by Cowork. The ARIA
 * labels here are load-bearing (PRD §6.2):
 *   - `task-instructions`     read instructions
 *   - `copy-instructions`     copy to clipboard
 *   - `start-execution`       start the timer
 *   - `execution-output`      large textarea for output
 *   - `attach-output-file`    drag/drop zone
 *   - `result-summary`        one-line outcome input
 *   - `mark-complete`, `mark-failed`, `mark-needs-review`  submit buttons
 *
 * If no `:id` is present in the URL we render the queue view inline so the
 * `/execute` route still has a sensible landing page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  PlayCircle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Paperclip,
  X,
  Loader2,
  ArrowLeft,
} from 'lucide-react';

import type { ExecutionStatus, Task } from '@/shared/types';
import { Button } from '@/renderer/components/ui/button';
import { Badge } from '@/renderer/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Textarea } from '@/renderer/components/ui/textarea';
import { Separator } from '@/renderer/components/ui/separator';
import { useToast } from '@/renderer/components/ui/use-toast';
import { cn } from '@/renderer/lib/utils';
import { api } from '@/renderer/lib/api';
import { queryKeys, useTask } from '@/renderer/lib/query';
import ExecuteQueue from './ExecuteQueue';

interface AttachedFile {
  name: string;
  path: string;
}

interface ResultSubmitPayload {
  task_id: string;
  result: {
    status: ExecutionStatus;
    summary: string;
    completed_at: string;
    notes?: string;
    error?: string;
  };
  output_files?: string[];
}

function statusVariant(
  status: Task['agent_status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'running':
      return 'default';
    case 'succeeded':
      return 'secondary';
    case 'failed':
      return 'destructive';
    case 'needs_review':
      return 'outline';
    default:
      return 'outline';
  }
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface ExecutionWorkspaceProps {
  taskId: string;
}

function ExecutionWorkspace({ taskId }: ExecutionWorkspaceProps): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const taskQuery = useTask(taskId);
  const task = taskQuery.data?.task ?? null;

  const parentQuery = useTask(task?.parent_id);
  const parent = parentQuery.data?.task ?? null;

  const [output, setOutput] = useState('');
  const [summary, setSummary] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [submitting, setSubmitting] = useState<ExecutionStatus | null>(null);
  const [done, setDone] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Timer for the running indicator
  useEffect(() => {
    if (!running || startedAt === null) return;
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);

  // Refresh task when Claude completes externally and the watcher emits an IPC.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bridge = window.taskpilot;
    if (!bridge?.onIOEvent) return;
    const off = bridge.onIOEvent((event) => {
      if (event.kind === 'result' && event.task_id === taskId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.detail(taskId),
        });
        toast({
          title: 'Result ingested',
          description: 'Claude wrote a result file for this task.',
        });
      }
    });
    return off;
  }, [taskId, queryClient, toast]);

  const parentOutputFiles = useMemo<string[]>(() => {
    if (!parent?.context) return [];
    const outputs = parent.context.output_files;
    return Array.isArray(outputs) ? (outputs as string[]) : [];
  }, [parent]);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const dropped = Array.from(e.dataTransfer.files);
      const added: AttachedFile[] = dropped.map((f) => {
        // Electron exposes `path` on File objects at runtime even though
        // TypeScript's lib.dom.d.ts does not declare it.
        const maybePath = (f as unknown as { path?: string }).path;
        return { name: f.name, path: maybePath ?? f.name };
      });
      if (added.length > 0) {
        setFiles((prev) => [...prev, ...added]);
      }
    },
    [],
  );

  function preventDefault(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.stopPropagation();
  }

  function pickFile(): void {
    fileInputRef.current?.click();
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>): void {
    const chosen = Array.from(e.target.files ?? []);
    const added: AttachedFile[] = chosen.map((f) => {
      const maybePath = (f as unknown as { path?: string }).path;
      return { name: f.name, path: maybePath ?? f.name };
    });
    if (added.length > 0) {
      setFiles((prev) => [...prev, ...added]);
    }
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
  }

  function removeFile(idx: number): void {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function startExecution(): void {
    setRunning(true);
    setStartedAt(Date.now());
    setElapsed(0);
    toast({
      title: 'Execution started',
      description: 'Timer started. Capture your output as you go.',
    });
  }

  async function copyInstructions(): Promise<void> {
    if (!task?.agent_instructions) return;
    try {
      await navigator.clipboard.writeText(task.agent_instructions);
      toast({ title: 'Instructions copied' });
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Clipboard unavailable.',
        variant: 'destructive',
      });
    }
  }

  async function submitResult(status: ExecutionStatus): Promise<void> {
    if (!task) return;
    if (summary.trim() === '' && status !== 'failed') {
      toast({
        title: 'Summary required',
        description: 'Add a one-line result summary before completing.',
        variant: 'destructive',
      });
      return;
    }
    const outputFiles = files.map((f) => f.path);
    const body: ResultSubmitPayload = {
      task_id: task.id,
      result: {
        status,
        summary: summary.trim() || (status === 'failed' ? 'Execution failed' : ''),
        completed_at: new Date().toISOString(),
        ...(output.trim() !== '' ? { notes: output } : {}),
        ...(status === 'failed' && errorMsg.trim() !== ''
          ? { error: errorMsg }
          : {}),
      },
      ...(outputFiles.length > 0 ? { output_files: outputFiles } : {}),
    };
    setSubmitting(status);
    try {
      // Server-side endpoint (Wave 6 server work) — accepts the result body
      // and writes the result file via the I/O pipeline, then invalidates
      // the task's React Query cache via SSE.
      await api.post<{ ok: true }>('/api/results', body);
      toast({
        title: 'Result submitted',
        description: `Task marked ${status}.`,
      });
      setRunning(false);
      setDone(true);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(task.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.all,
      });
      // Auto-navigate after a short pause so the user can see the "Submitted"
      // state confirmation before being whisked away. Destination depends on
      // the result status — successes go to the Board (work flows on),
      // anything else lands on Review so the user can decide next steps.
      const destination = status === 'succeeded' ? '/board' : '/review';
      window.setTimeout(() => {
        navigate(destination);
      }, 1500);
    } catch (err) {
      toast({
        title: 'Submit failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(null);
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
          Could not load task <code>{taskId}</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      {/* Header */}
      <header className="space-y-2 border-b border-border p-6">
        {task.parent_id && (
          <nav className="flex items-center gap-1 text-xs text-muted-foreground">
            <Link
              to={`/task/${task.parent_id}`}
              className="inline-flex items-center gap-1 hover:underline"
            >
              <ArrowLeft className="h-3 w-3" />
              {parent?.title ?? 'Parent task'}
            </Link>
          </nav>
        )}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {task.title}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(task.agent_status)}>
                {task.agent_status}
              </Badge>
              <Badge variant="outline">{task.priority}</Badge>
              <Badge variant="outline">{task.agent_method}</Badge>
              {running && (
                <span className="text-xs font-mono text-muted-foreground">
                  {formatElapsed(elapsed)}
                </span>
              )}
              {done && (
                <span
                  className="text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  Submitted. Returning to board…
                </span>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate('/board')}>
            Back to board
          </Button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 p-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Left column: instructions + output */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-semibold">Instructions</CardTitle>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void copyInstructions()}
                aria-label="copy-instructions"
                disabled={!task.agent_instructions}
              >
                <Copy className="mr-1 h-4 w-4" />
                Copy
              </Button>
            </CardHeader>
            <CardContent>
              <div
                role="region"
                aria-label="task-instructions"
                tabIndex={0}
                className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-base leading-relaxed"
              >
                {task.agent_instructions ?? (
                  <span className="italic text-muted-foreground">
                    No instructions yet. This task may need derivation first.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Output</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                aria-label="execution-output"
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                placeholder="Paste output, notes, or commands as you execute."
                className="min-h-[200px] font-mono text-xs"
              />

              <div
                aria-label="attach-output-file"
                role="button"
                tabIndex={0}
                onDrop={onDrop}
                onDragOver={preventDefault}
                onDragEnter={preventDefault}
                onClick={pickFile}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pickFile();
                  }
                }}
                className={cn(
                  'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-input p-4 text-center transition-colors hover:border-ring',
                )}
              >
                <Paperclip className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  Drop files here or click to attach output files.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileInput}
                  aria-hidden="true"
                  tabIndex={-1}
                />
              </div>

              {files.length > 0 && (
                <ul className="space-y-1">
                  {files.map((f, i) => (
                    <li
                      key={`${f.path}-${i}`}
                      className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-xs"
                    >
                      <span className="truncate font-mono" title={f.path}>
                        {f.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(i)}
                        aria-label={`remove-file-${i}`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: context + actions */}
        <div className="space-y-4">
          {parentOutputFiles.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">
                  Parent outputs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {parentOutputFiles.map((p, i) => (
                  <div
                    key={`${p}-${i}`}
                    className="truncate rounded-md bg-muted/40 px-2 py-1 font-mono text-xs"
                    title={p}
                  >
                    {p}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Run</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                type="button"
                onClick={startExecution}
                disabled={running || done}
                className="w-full"
                aria-label="start-execution"
              >
                <PlayCircle className="mr-1 h-4 w-4" />
                {running ? 'Running…' : done ? 'Submitted' : 'Start Execution'}
              </Button>

              <Separator />

              <div className="space-y-1.5">
                <Label htmlFor="result-summary-input">Result summary</Label>
                <Input
                  id="result-summary-input"
                  aria-label="result-summary"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="One-line outcome"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="error-input">Error (if failed)</Label>
                <Input
                  id="error-input"
                  aria-label="execution-error"
                  value={errorMsg}
                  onChange={(e) => setErrorMsg(e.target.value)}
                  placeholder="Optional, shown on failure"
                />
              </div>

              <div className="grid grid-cols-1 gap-2">
                <Button
                  type="button"
                  onClick={() => void submitResult('succeeded')}
                  disabled={submitting !== null || done}
                  aria-label="mark-complete"
                >
                  {submitting === 'succeeded' ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1 h-4 w-4" />
                  )}
                  Mark Complete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void submitResult('needs_review')}
                  disabled={submitting !== null || done}
                  aria-label="mark-needs-review"
                >
                  {submitting === 'needs_review' ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <AlertCircle className="mr-1 h-4 w-4" />
                  )}
                  Mark Needs Review
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void submitResult('failed')}
                  disabled={submitting !== null || done}
                  aria-label="mark-failed"
                >
                  {submitting === 'failed' ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="mr-1 h-4 w-4" />
                  )}
                  Mark Failed
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function Execution(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) return <ExecuteQueue />;
  return <ExecutionWorkspace taskId={id} />;
}
