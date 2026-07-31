/**
 * Triage session store.
 *
 * Drives the email-style zero-inbox triage mode (`/triage`). When the user
 * enters triage we freeze a snapshot of the inbox task IDs at that moment so
 * the walkthrough is stable even if the live task list churns underneath
 * (Claude ingesting new tasks, another tab editing, SSE pushes). The user
 * walks the snapshot one task at a time, applying an action per task.
 *
 * Design notes:
 *  - The snapshot is an ordered list of task *IDs*, not full Task objects.
 *    The Triage view resolves each id against the live React Query cache so
 *    the card always shows current data, and a task deleted by another tab
 *    resolves to `null` (handled as the "deleted elsewhere" edge case).
 *  - All session math (advance, prev, count tallies, elapsed) lives in pure
 *    helper functions exported alongside the store so they're unit-testable
 *    under the node-only vitest environment without rendering React.
 *  - State persists to the store (not localStorage) so a soft refresh that
 *    keeps the renderer alive can resume; a hard relaunch starts clean, which
 *    matches the "frozen at start" contract — a stale snapshot across relaunch
 *    would point at tasks that may have moved on.
 */

import { create } from 'zustand';

/** The discrete actions a user can take on a single triaged task. */
export type TriageAction =
  | 'keep' // Enter — kept as-is, advanced past
  | 'priority' // 1/2/3/4 — set priority and advanced
  | 'delete' // d
  | 'archive' // a
  | 'template' // t — saved as template
  | 'derive' // r — derivation requested
  | 'done' // e — marked done
  | 'workspace' // w — moved to a workspace (tag applied)
  | 'tag' // g — tagged
  | 'skipped'; // advanced without an explicit decision (→ at end-of-list edge)

/** One recorded decision in the running session log. */
export interface TriageDecision {
  taskId: string;
  action: TriageAction;
  at: number; // epoch ms
}

export interface TriageState {
  /** Whether a session is active. */
  active: boolean;
  /** Frozen, ordered snapshot of inbox task IDs captured at session start. */
  queue: string[];
  /** Index of the task currently under review within `queue`. */
  index: number;
  /** When the session started (epoch ms) — basis for the elapsed timer. */
  startedAt: number | null;
  /** When the session finished (epoch ms), or null while in progress. */
  finishedAt: number | null;
  /** Ordered log of every decision the user made this session. */
  decisions: TriageDecision[];

  /** Begin a session over the given ordered inbox task IDs. */
  start: (taskIds: string[]) => void;
  /**
   * Record a decision for the *current* task and advance to the next.
   * No-op when no session is active. When the recorded task is the last in
   * the queue, the session is marked complete (`finishedAt` set).
   */
  record: (action: TriageAction) => void;
  /** Advance without recording a decision (e.g. the `→` keep-position key). */
  advance: () => void;
  /** Step back to the previous task (clamped at 0). Does not undo decisions. */
  back: () => void;
  /** Tear down the session and reset all fields. */
  exit: () => void;
  /**
   * Reconcile the queue against the live set of still-existing task IDs.
   * Removes ids that vanished (deleted by another surface) but preserves the
   * current task's relative position so the user isn't yanked around. Used by
   * the view on each render to keep the snapshot honest without restarting.
   */
  reconcile: (existingIds: Set<string>) => void;
}

/* -------------------------------------------------------------------------- */
/*  Pure session helpers (unit-tested directly)                                */
/* -------------------------------------------------------------------------- */

/** Total tasks in the frozen queue. */
export function totalCount(state: Pick<TriageState, 'queue'>): number {
  return state.queue.length;
}

/** 1-based position of the current task (clamped to [1, total]). */
export function position(
  state: Pick<TriageState, 'index' | 'queue'>,
): number {
  if (state.queue.length === 0) return 0;
  return Math.min(state.index + 1, state.queue.length);
}

/** How many tasks have been advanced past (i.e. reviewed). */
export function reviewedCount(
  state: Pick<TriageState, 'index' | 'queue'>,
): number {
  return Math.min(state.index, state.queue.length);
}

/** True once every task in the queue has been reviewed. */
export function isComplete(
  state: Pick<TriageState, 'index' | 'queue' | 'active'>,
): boolean {
  if (!state.active) return false;
  return state.queue.length > 0 && state.index >= state.queue.length;
}

/** The id of the task currently under review, or null at end-of-queue. */
export function currentTaskId(
  state: Pick<TriageState, 'index' | 'queue'>,
): string | null {
  return state.queue[state.index] ?? null;
}

/**
 * Tally decisions by action type. Drives the summary view's breakdown. Only
 * the most recent decision per task counts — re-reviewing a task (via `back`)
 * and re-deciding shouldn't double-count, so we collapse by taskId keeping the
 * last entry.
 */
export function decisionBreakdown(
  decisions: TriageDecision[],
): Record<TriageAction, number> {
  const latest = new Map<string, TriageAction>();
  for (const d of decisions) latest.set(d.taskId, d.action);
  const out: Record<TriageAction, number> = {
    keep: 0,
    priority: 0,
    delete: 0,
    archive: 0,
    template: 0,
    derive: 0,
    done: 0,
    workspace: 0,
    tag: 0,
    skipped: 0,
  };
  for (const action of latest.values()) out[action] += 1;
  return out;
}

/** Elapsed wall-clock ms between start and finish (or `now` while running). */
export function elapsedMs(
  state: Pick<TriageState, 'startedAt' | 'finishedAt'>,
  now: number = Date.now(),
): number {
  if (state.startedAt === null) return 0;
  const end = state.finishedAt ?? now;
  return Math.max(0, end - state.startedAt);
}

/** Format an elapsed duration as `M:SS` (or `H:MM:SS` past an hour). */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                      */
/* -------------------------------------------------------------------------- */

const INITIAL: Omit<
  TriageState,
  'start' | 'record' | 'advance' | 'back' | 'exit' | 'reconcile'
> = {
  active: false,
  queue: [],
  index: 0,
  startedAt: null,
  finishedAt: null,
  decisions: [],
};

export const useTriageStore = create<TriageState>((set) => ({
  ...INITIAL,

  start: (taskIds) =>
    set(() => ({
      active: true,
      // Dedupe defensively — an upstream filter bug shouldn't double-list a
      // task. Order is preserved (first occurrence wins).
      queue: Array.from(new Set(taskIds)),
      index: 0,
      startedAt: Date.now(),
      finishedAt: null,
      decisions: [],
    })),

  record: (action) =>
    set((state) => {
      if (!state.active) return state;
      const taskId = state.queue[state.index];
      if (taskId === undefined) return state;
      const nextIndex = state.index + 1;
      const done = nextIndex >= state.queue.length;
      return {
        decisions: [...state.decisions, { taskId, action, at: Date.now() }],
        index: nextIndex,
        finishedAt: done ? Date.now() : state.finishedAt,
      };
    }),

  advance: () =>
    set((state) => {
      if (!state.active) return state;
      const nextIndex = state.index + 1;
      const done = nextIndex >= state.queue.length;
      return {
        index: nextIndex,
        finishedAt: done ? Date.now() : state.finishedAt,
      };
    }),

  back: () =>
    set((state) => {
      if (!state.active) return state;
      const prevIndex = Math.max(0, state.index - 1);
      return {
        index: prevIndex,
        // Stepping back out of the "complete" state re-opens the session.
        finishedAt: prevIndex < state.queue.length ? null : state.finishedAt,
      };
    }),

  exit: () => set(() => ({ ...INITIAL })),

  reconcile: (existingIds) =>
    set((state) => {
      if (!state.active || state.queue.length === 0) return state;
      const currentId = state.queue[state.index] ?? null;
      const nextQueue = state.queue.filter((id) => existingIds.has(id));
      if (nextQueue.length === state.queue.length) return state;
      // Recompute the index so the user stays anchored to the same task when
      // possible. If the current task itself vanished, anchor to the count of
      // surviving tasks that came before it (i.e. the next surviving task).
      let nextIndex: number;
      if (currentId !== null && existingIds.has(currentId)) {
        nextIndex = nextQueue.indexOf(currentId);
      } else {
        const survivingBefore = state.queue
          .slice(0, state.index)
          .filter((id) => existingIds.has(id)).length;
        nextIndex = survivingBefore;
      }
      const done = nextQueue.length > 0 && nextIndex >= nextQueue.length;
      return {
        queue: nextQueue,
        index: Math.min(nextIndex, nextQueue.length),
        finishedAt: done ? (state.finishedAt ?? Date.now()) : state.finishedAt,
      };
    }),
}));
