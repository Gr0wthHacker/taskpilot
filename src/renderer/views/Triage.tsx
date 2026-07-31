/**
 * Triage view (`/triage`) — email-style, keyboard-driven zero-inbox mode.
 *
 * Mounted OUTSIDE the Layout subtree (like onboarding) so it owns the whole
 * window with no competing sidebar. The flow:
 *
 *   1. On mount, if no session is active, freeze a snapshot of the current
 *      inbox (workspace-filtered, priority-sorted) into the triage store.
 *   2. Walk the snapshot one task at a time. Each keypress applies an action
 *      optimistically (revert + toast on failure) and advances.
 *   3. After the last task, show the summary ("N reviewed in M:SS").
 *
 * Keyboard map (handled by a local listener; global hotkeys are suppressed
 * for the duration so chords like `g i` don't fire mid-triage):
 *   1/2/3/4  set priority p0/p1/p2/p3 + advance
 *   d        delete (undoable toast)
 *   a        archive (undoable toast)
 *   t        save current task as a template
 *   r        request derivation
 *   e        mark done
 *   w        open workspace picker (apply workspace's first tag)
 *   g        open tag picker
 *   /        focus inline search to jump within the queue
 *   Enter    keep as-is + advance
 *   ←        previous task
 *   →        advance (keep position, no decision)
 *   Esc      exit triage
 */

import { ArrowLeft, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  TriageActionHint,
  type TriageHintKey,
} from '@/renderer/components/triage/TriageActionHint';
import { TriageCard } from '@/renderer/components/triage/TriageCard';
import { TriageProgress } from '@/renderer/components/triage/TriageProgress';
import { TriageSummary } from '@/renderer/components/triage/TriageSummary';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { ToastAction } from '@/renderer/components/ui/toast';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import {
  useArchiveTask,
  useCreateTask,
  useCreateTemplate,
  useDeleteTask,
  useDeriveTask,
  useTaskChildren,
  useTasksList,
  useUnarchiveTask,
  useUpdateTask,
} from '@/renderer/lib/query';
import { setSuppressed } from '@/renderer/lib/hotkeys';
import { sortByPriority } from '@/renderer/lib/task-sort';
import { useWorkspaceStore } from '@/renderer/store/workspace';
import {
  currentTaskId,
  decisionBreakdown,
  elapsedMs,
  formatElapsed,
  isComplete,
  position as positionOf,
  reviewedCount,
  totalCount,
  useTriageStore,
  type TriageAction,
} from '@/renderer/store/triage';
import type { Task, TaskPriority } from '@/shared/types';

/** Map the 1/2/3/4 keys to a priority. */
const PRIORITY_FOR_KEY: Record<'1' | '2' | '3' | '4', TaskPriority> = {
  '1': 'p0',
  '2': 'p1',
  '3': 'p2',
  '4': 'p3',
};

/**
 * Self-contained elapsed clock. Owns its own 1s interval so only this tiny
 * span re-renders each tick — not the ~800-LOC Triage view around it (which
 * previously forced a full-view re-render every second). Reads start/finish
 * straight from the store and stops ticking once the session finishes.
 */
function TriageElapsed(): JSX.Element {
  const startedAt = useTriageStore((s) => s.startedAt);
  const finishedAt = useTriageStore((s) => s.finishedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (startedAt === null || finishedAt !== null) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt, finishedAt]);
  return <>{formatElapsed(elapsedMs({ startedAt, finishedAt }))}</>;
}

export default function Triage(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();

  const session = useTriageStore();
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  // Live inbox — used to (a) seed the snapshot on entry and (b) resolve each
  // queued id against current data + reconcile vanished tasks. `useTasksList`
  // already narrows to the active workspace, so the snapshot matches exactly
  // what Jack sees in the inbox view.
  const inboxQ = useTasksList({ status: 'inbox' });
  const liveTasks = useMemo(() => inboxQ.data?.tasks ?? [], [inboxQ.data]);
  const liveById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of liveTasks) map.set(t.id, t);
    return map;
  }, [liveTasks]);

  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const archiveTask = useArchiveTask();
  const unarchiveTask = useUnarchiveTask();
  const deriveTask = useDeriveTask();
  const createTemplate = useCreateTemplate();
  const createTask = useCreateTask();

  const [busy, setBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // The live elapsed clock now lives in <TriageElapsed>, a self-contained leaf
  // that owns its own 1s interval — so the tick no longer re-renders this
  // whole view. `elapsed` below stays for the frozen post-session summary.

  // Suppress global hotkeys for the lifetime of the view so triage's single-key
  // bindings own the keyboard.
  useEffect(() => {
    setSuppressed(true);
    return () => setSuppressed(false);
  }, []);

  // Seed the session the first time the inbox finishes loading and no session
  // is in flight. Guard with a ref so a refetch (SSE/invalidation) never
  // re-freezes a fresh snapshot mid-triage.
  const seededRef = useRef(false);
  useEffect(() => {
    if (session.active) {
      seededRef.current = true;
      return;
    }
    if (seededRef.current) return; // already ran a session this mount
    if (inboxQ.isLoading) return;
    const ordered = sortByPriority(liveTasks).map((t) => t.id);
    seededRef.current = true;
    session.start(ordered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxQ.isLoading, session.active, liveTasks]);

  // Reconcile the frozen queue against live data so tasks deleted by another
  // surface drop out without crashing the card resolution.
  useEffect(() => {
    if (!session.active) return;
    if (inboxQ.isLoading) return;
    // Only reconcile against ids we actually know about. If the query errored
    // we keep the snapshot untouched rather than nuking everything.
    if (inboxQ.isError) return;
    session.reconcile(new Set(liveById.keys()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveById, session.active, inboxQ.isLoading, inboxQ.isError]);

  const curId = currentTaskId(session);
  const curTask = curId ? liveById.get(curId) ?? null : null;
  const childrenQ = useTaskChildren(curTask?.id ?? null);
  const subTasks = childrenQ.data?.tasks ?? [];

  const total = totalCount(session);
  const reviewed = reviewedCount(session);
  const pos = positionOf(session);
  const complete = isComplete(session);
  const elapsed = formatElapsed(elapsedMs(session));

  /* ----------------------------------------------------------------------- */
  /*  Actions                                                                 */
  /* ----------------------------------------------------------------------- */

  const exitToInbox = useCallback((): void => {
    session.exit();
    navigate('/inbox');
  }, [navigate, session]);

  // Optimistically run an async action against the current task, then advance.
  // On failure we surface a toast and DO NOT advance (the user can retry).
  const runAndAdvance = useCallback(
    async (
      action: TriageAction,
      fn: () => Promise<void>,
      opts?: { onUndo?: () => void; undoTitle?: string },
    ): Promise<void> => {
      if (!curTask || busy) return;
      const target = curTask;
      setBusy(true);
      try {
        await fn();
        session.record(action);
        if (opts?.onUndo) {
          toast({
            title: opts.undoTitle ?? 'Done',
            description: target.title,
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => {
                  void opts.onUndo?.();
                }}
              >
                Undo
              </ToastAction>
            ),
          });
        }
      } catch (cause) {
        toast({
          title: 'Action failed',
          description: cause instanceof Error ? cause.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, curTask, session, toast],
  );

  // Recreate a deleted task (the delete-undo path). The original row is gone
  // server-side, so this re-inserts an equivalent task into the inbox under a
  // fresh id rather than truly restoring — nothing is silently lost.
  const recreateTask = useCallback(
    async (target: Task): Promise<void> => {
      try {
        await createTask.mutateAsync({
          title: target.title,
          description: target.description,
          priority: target.priority,
          due: target.due,
          agent_method: target.agent_method,
          agent_instructions: target.agent_instructions,
          tags: target.tags,
          status: 'inbox',
        });
      } catch (cause) {
        toast({
          title: 'Recreate failed',
          description: cause instanceof Error ? cause.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
    [createTask, toast],
  );

  const setPriority = useCallback(
    (key: '1' | '2' | '3' | '4'): void => {
      if (!curTask) return;
      const priority = PRIORITY_FOR_KEY[key];
      void runAndAdvance('priority', async () => {
        await updateTask.mutateAsync({ id: curTask.id, patch: { priority } });
      });
    },
    [curTask, runAndAdvance, updateTask],
  );

  const doDelete = useCallback((): void => {
    if (!curTask) return;
    const target = curTask;
    void runAndAdvance(
      'delete',
      async () => {
        await deleteTask.mutateAsync({
          id: target.id,
          parent_id: target.parent_id,
        });
      },
      {
        undoTitle: 'Task deleted',
        // Delete is hard to truly undo (the row is gone); we offer a recreate
        // from the snapshot we still hold in memory.
        onUndo: () => {
          toast({
            title: 'Recreating…',
            description: target.title,
          });
          // Best-effort recreate. The server assigns a new id; the original is
          // gone. We re-add it to the inbox so nothing is silently lost.
          void recreateTask(target);
        },
      },
    );
  }, [curTask, deleteTask, recreateTask, runAndAdvance, toast]);

  const doArchive = useCallback((): void => {
    if (!curTask) return;
    const target = curTask;
    void runAndAdvance(
      'archive',
      async () => {
        await archiveTask.mutateAsync({ id: target.id });
      },
      {
        undoTitle: 'Task archived',
        onUndo: () => {
          void unarchiveTask.mutateAsync({ id: target.id }).catch((cause) => {
            toast({
              title: 'Undo failed',
              description:
                cause instanceof Error ? cause.message : 'Unknown error',
              variant: 'destructive',
            });
          });
        },
      },
    );
  }, [archiveTask, curTask, runAndAdvance, toast, unarchiveTask]);

  const doDerive = useCallback((): void => {
    if (!curTask) return;
    const target = curTask;
    void runAndAdvance('derive', async () => {
      await deriveTask.mutateAsync({ id: target.id });
      toast({
        title: 'Derivation requested',
        description: target.title,
      });
    });
  }, [curTask, deriveTask, runAndAdvance, toast]);

  const doDone = useCallback((): void => {
    if (!curTask) return;
    const target = curTask;
    const prevStatus = target.status;
    void runAndAdvance(
      'done',
      async () => {
        await updateTask.mutateAsync({
          id: target.id,
          patch: { status: 'done' },
        });
      },
      {
        undoTitle: 'Marked done',
        onUndo: () => {
          void updateTask
            .mutateAsync({ id: target.id, patch: { status: prevStatus } })
            .catch(() => undefined);
        },
      },
    );
  }, [curTask, runAndAdvance, updateTask]);

  const doTemplate = useCallback((): void => {
    if (!curTask) return;
    const target = curTask;
    void runAndAdvance('template', async () => {
      await createTemplate.mutateAsync({
        name: target.title,
        task_title: target.title,
        task_description: target.description ?? null,
        priority: target.priority,
        agent_method: target.agent_method,
        agent_instructions: target.agent_instructions ?? null,
        tags: target.tags,
      });
      toast({ title: 'Saved as template', description: target.title });
    });
  }, [createTemplate, curTask, runAndAdvance, toast]);

  const applyWorkspace = useCallback(
    (workspaceId: string): void => {
      if (!curTask) return;
      const ws = workspaces.find((w) => w.id === workspaceId);
      const tag = ws?.tags[0];
      if (!ws || !tag) return;
      const target = curTask;
      if (target.tags.includes(tag)) {
        // Already in the workspace — just record + advance.
        session.record('workspace');
        return;
      }
      void runAndAdvance('workspace', async () => {
        await updateTask.mutateAsync({
          id: target.id,
          patch: { tags: [...target.tags, tag] },
        });
        toast({ title: `Moved to ${ws.name}`, description: target.title });
      });
    },
    [curTask, runAndAdvance, session, toast, updateTask, workspaces],
  );

  const applyTag = useCallback(
    (rawTag: string): void => {
      if (!curTask) return;
      const tag = rawTag.trim().replace(/^#/, '').toLowerCase();
      if (tag.length === 0) return;
      const target = curTask;
      if (target.tags.includes(tag)) {
        session.record('tag');
        return;
      }
      void runAndAdvance('tag', async () => {
        await updateTask.mutateAsync({
          id: target.id,
          patch: { tags: [...target.tags, tag] },
        });
        toast({ title: `Tagged #${tag}`, description: target.title });
      });
    },
    [curTask, runAndAdvance, session, toast, updateTask],
  );

  const keep = useCallback((): void => {
    session.record('keep');
  }, [session]);

  /* ----------------------------------------------------------------------- */
  /*  Search-to-jump                                                          */
  /* ----------------------------------------------------------------------- */

  const openSearch = useCallback((): void => {
    setSearchOpen(true);
    // Focus on the next frame once the input is mounted.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  const jumpToSearch = useCallback((): void => {
    const q = search.trim().toLowerCase();
    setSearchOpen(false);
    setSearch('');
    if (q.length === 0) return;
    const idx = session.queue.findIndex((id) => {
      const t = liveById.get(id);
      return t ? t.title.toLowerCase().includes(q) : false;
    });
    if (idx === -1) {
      toast({ title: 'No match in queue', description: q });
      return;
    }
    // Re-seek by setting index via back/advance deltas would be clumsy; use the
    // store's reconcile-free path: exit+restart is wrong. Instead nudge index
    // directly through the public surface by advancing/going back.
    seekTo(idx);
  }, [liveById, search, session.queue, toast]);

  // Move the cursor to an absolute index using only public store actions
  // (advance/back), so the store keeps a single source of truth for `index`.
  const seekTo = useCallback(
    (target: number): void => {
      const clamped = Math.max(0, Math.min(target, session.queue.length));
      let cursor = session.index;
      while (cursor < clamped) {
        session.advance();
        cursor += 1;
      }
      while (cursor > clamped) {
        session.back();
        cursor -= 1;
      }
    },
    [session],
  );

  /* ----------------------------------------------------------------------- */
  /*  Keyboard                                                                */
  /* ----------------------------------------------------------------------- */

  const handleHintAction = useCallback(
    (key: TriageHintKey): void => {
      switch (key) {
        case '1':
        case '2':
        case '3':
        case '4':
          setPriority(key);
          break;
        case 'd':
          doDelete();
          break;
        case 'a':
          doArchive();
          break;
        case 't':
          doTemplate();
          break;
        case 'r':
          doDerive();
          break;
        case 'e':
          doDone();
          break;
        case 'w':
          // Workspace + tag pickers are dropdowns; the hint chip can't open a
          // Radix menu programmatically, so clicking falls back to a toast nudge.
          toast({
            title: 'Press W',
            description: 'Use the keyboard for the workspace picker.',
          });
          break;
        case 'g':
          toast({
            title: 'Press G',
            description: 'Use the keyboard for the tag picker.',
          });
          break;
        case '/':
          openSearch();
          break;
        case 'enter':
          keep();
          break;
        case 'left':
          session.back();
          break;
        case 'right':
          session.advance();
          break;
        default:
          break;
      }
    },
    [
      doArchive,
      doDelete,
      doDerive,
      doDone,
      doTemplate,
      keep,
      openSearch,
      session,
      setPriority,
      toast,
    ],
  );

  // Picker open flags driven by the `w` / `g` keys.
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Never hijack typing inside the search / tag inputs or any field.
      const t = e.target;
      const editable =
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable);

      if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false);
          setSearch('');
          return;
        }
        if (tagOpen) {
          setTagOpen(false);
          setTagDraft('');
          return;
        }
        if (workspaceOpen) {
          setWorkspaceOpen(false);
          return;
        }
        e.preventDefault();
        exitToInbox();
        return;
      }

      if (editable) return; // let inputs handle their own keys
      if (complete || !curTask) return; // summary state: only Esc matters
      if (busy) return; // an action is mid-flight
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave shortcuts alone

      switch (e.key) {
        case '1':
        case '2':
        case '3':
        case '4':
          e.preventDefault();
          setPriority(e.key);
          break;
        case 'd':
          e.preventDefault();
          doDelete();
          break;
        case 'a':
          e.preventDefault();
          doArchive();
          break;
        case 't':
          e.preventDefault();
          doTemplate();
          break;
        case 'r':
          e.preventDefault();
          doDerive();
          break;
        case 'e':
          e.preventDefault();
          doDone();
          break;
        case 'w':
          e.preventDefault();
          setWorkspaceOpen(true);
          break;
        case 'g':
          e.preventDefault();
          setTagOpen(true);
          requestAnimationFrame(() => tagInputRef.current?.focus());
          break;
        case '/':
          e.preventDefault();
          openSearch();
          break;
        case 'Enter':
          e.preventDefault();
          keep();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          session.back();
          break;
        case 'ArrowRight':
          e.preventDefault();
          session.advance();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    busy,
    complete,
    curTask,
    doArchive,
    doDelete,
    doDerive,
    doDone,
    doTemplate,
    exitToInbox,
    keep,
    openSearch,
    searchOpen,
    session,
    setPriority,
    tagOpen,
    workspaceOpen,
  ]);

  /* ----------------------------------------------------------------------- */
  /*  Render                                                                  */
  /* ----------------------------------------------------------------------- */

  const restart = useCallback((): void => {
    const ordered = sortByPriority(liveTasks).map((t) => t.id);
    session.start(ordered);
  }, [liveTasks, session]);

  const breakdown = useMemo(
    () => decisionBreakdown(session.decisions),
    [session.decisions],
  );

  // Summary state — either everything reviewed, or the inbox was empty to begin.
  const emptyFromStart = session.active && total === 0;
  const showSummary = complete || emptyFromStart;

  return (
    <div
      className="flex h-screen w-screen flex-col bg-background text-foreground"
      aria-label="view-triage"
    >
      <header className="flex items-center justify-between gap-4 border-b border-border/60 px-8 py-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={exitToInbox}
            aria-label="triage-exit"
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Inbox
          </Button>
          <div className="text-sm font-semibold tracking-tight">
            Triage inbox
          </div>
        </div>
        <div className="w-64">
          {!showSummary && (
            <TriageProgress
              position={pos}
              total={total}
              reviewed={reviewed}
              elapsed={<TriageElapsed />}
            />
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={exitToInbox}
          aria-label="triage-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <main className="flex flex-1 items-center justify-center overflow-auto px-8 py-8">
        {showSummary ? (
          <TriageSummary
            reviewed={reviewed}
            elapsed={elapsed}
            breakdown={breakdown}
            onBackToInbox={exitToInbox}
            onRestart={restart}
            emptyInbox={emptyFromStart && reviewed === 0}
          />
        ) : curTask ? (
          <div className="flex w-full max-w-2xl flex-col gap-6">
            <TriageCard task={curTask} subTasks={subTasks} />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground" aria-label="triage-loading">
            Loading inbox…
          </div>
        )}
      </main>

      {!showSummary && curTask && (
        <footer className="flex flex-col gap-3 border-t border-border/60 px-8 py-4">
          {searchOpen && (
            <div className="mx-auto flex w-full max-w-md items-center gap-2">
              <Input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    jumpToSearch();
                  }
                }}
                placeholder="Jump to a task in the queue…"
                aria-label="triage-search"
                className="h-8"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={jumpToSearch}
                aria-label="triage-search-go"
              >
                Jump
              </Button>
            </div>
          )}

          {tagOpen && (
            <div className="mx-auto flex w-full max-w-md items-center gap-2">
              <Input
                ref={tagInputRef}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = tagDraft;
                    setTagOpen(false);
                    setTagDraft('');
                    applyTag(v);
                  }
                }}
                placeholder="Add a tag, then Enter…"
                aria-label="triage-tag-input"
                className="h-8"
              />
            </div>
          )}

          <TriageActionHint onAction={handleHintAction} disabled={busy} />
        </footer>
      )}

      {/* Hidden anchors driving the W / G picker dropdowns. The triggers are
          invisible buttons positioned over the footer; opening is keyboard-led
          via the `w` / `g` keys flipping the open state. */}
      <DropdownMenu open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
        <DropdownMenuTrigger asChild>
          <span className="sr-only" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" aria-label="triage-workspace-menu">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Move to workspace
          </DropdownMenuLabel>
          {workspaces.length === 0 && (
            <DropdownMenuItem disabled className="text-xs">
              No workspaces configured
            </DropdownMenuItem>
          )}
          {workspaces.map((ws) => (
            <DropdownMenuItem
              key={ws.id}
              onSelect={() => applyWorkspace(ws.id)}
              aria-label={`triage-workspace-${ws.id}`}
              className="cursor-pointer text-xs"
            >
              <span
                aria-hidden="true"
                className="mr-2 h-2 w-2 rounded-full"
                style={{ backgroundColor: ws.color ?? 'var(--muted-foreground)' }}
              />
              {ws.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
