/**
 * Triage session logic — exercises the pure Zustand store + helper functions
 * that drive the `/triage` walkthrough. The store is framework-agnostic
 * (Zustand works fine under the node-only vitest environment), so we drive it
 * directly via getState()/actions and never render React. This deliberately
 * skips component-level testing, which would require a DOM environment the
 * suite doesn't configure.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  currentTaskId,
  decisionBreakdown,
  elapsedMs,
  formatElapsed,
  isComplete,
  position,
  reviewedCount,
  totalCount,
  useTriageStore,
  type TriageDecision,
} from '@/renderer/store/triage';

function reset(): void {
  useTriageStore.getState().exit();
}

afterEach(reset);

describe('triage store — session lifecycle', () => {
  it('starts a frozen, deduped, ordered snapshot', () => {
    useTriageStore.getState().start(['a', 'b', 'b', 'c']);
    const s = useTriageStore.getState();
    expect(s.active).toBe(true);
    expect(s.queue).toEqual(['a', 'b', 'c']); // dedup, order preserved
    expect(s.index).toBe(0);
    expect(s.startedAt).not.toBeNull();
    expect(s.finishedAt).toBeNull();
    expect(currentTaskId(s)).toBe('a');
    expect(totalCount(s)).toBe(3);
    expect(position(s)).toBe(1);
  });

  it('record() logs a decision for the current task and advances', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b']);
    store.record('priority');
    let s = useTriageStore.getState();
    expect(s.index).toBe(1);
    expect(currentTaskId(s)).toBe('b');
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]).toMatchObject({ taskId: 'a', action: 'priority' });
    expect(s.finishedAt).toBeNull();

    useTriageStore.getState().record('done');
    s = useTriageStore.getState();
    expect(s.index).toBe(2);
    expect(isComplete(s)).toBe(true);
    expect(s.finishedAt).not.toBeNull();
    expect(currentTaskId(s)).toBeNull();
  });

  it('advance() moves forward without recording a decision', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b']);
    store.advance();
    const s = useTriageStore.getState();
    expect(s.index).toBe(1);
    expect(s.decisions).toHaveLength(0);
  });

  it('back() steps backward and clamps at zero', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b', 'c']);
    store.advance();
    store.advance();
    expect(useTriageStore.getState().index).toBe(2);
    useTriageStore.getState().back();
    expect(useTriageStore.getState().index).toBe(1);
    useTriageStore.getState().back();
    useTriageStore.getState().back();
    useTriageStore.getState().back();
    expect(useTriageStore.getState().index).toBe(0);
  });

  it('back() out of the complete state re-opens the session', () => {
    const store = useTriageStore.getState();
    store.start(['a']);
    store.record('keep');
    expect(isComplete(useTriageStore.getState())).toBe(true);
    useTriageStore.getState().back();
    const s = useTriageStore.getState();
    expect(s.index).toBe(0);
    expect(s.finishedAt).toBeNull();
    expect(isComplete(s)).toBe(false);
  });

  it('exit() resets everything', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b']);
    store.record('archive');
    useTriageStore.getState().exit();
    const s = useTriageStore.getState();
    expect(s.active).toBe(false);
    expect(s.queue).toEqual([]);
    expect(s.index).toBe(0);
    expect(s.decisions).toEqual([]);
    expect(s.startedAt).toBeNull();
  });

  it('ignores record/advance/back when no session is active', () => {
    const store = useTriageStore.getState();
    store.record('keep');
    store.advance();
    store.back();
    const s = useTriageStore.getState();
    expect(s.active).toBe(false);
    expect(s.decisions).toHaveLength(0);
    expect(s.index).toBe(0);
  });
});

describe('triage store — empty + single-task edges', () => {
  it('handles an empty inbox snapshot', () => {
    useTriageStore.getState().start([]);
    const s = useTriageStore.getState();
    expect(s.active).toBe(true);
    expect(totalCount(s)).toBe(0);
    expect(position(s)).toBe(0);
    expect(currentTaskId(s)).toBeNull();
    // An empty queue is never "complete" (nothing to review) — the view shows
    // the already-clear summary based on total === 0, not isComplete.
    expect(isComplete(s)).toBe(false);
  });

  it('completes immediately after the single task is decided', () => {
    const store = useTriageStore.getState();
    store.start(['only']);
    expect(isComplete(useTriageStore.getState())).toBe(false);
    store.record('done');
    expect(isComplete(useTriageStore.getState())).toBe(true);
    expect(reviewedCount(useTriageStore.getState())).toBe(1);
  });
});

describe('triage store — reconcile (deleted by another surface)', () => {
  it('drops vanished tasks and keeps the cursor on the current task', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b', 'c', 'd']);
    store.advance(); // now on 'b' (index 1)
    expect(currentTaskId(useTriageStore.getState())).toBe('b');
    // 'a' deleted elsewhere — queue shrinks, cursor stays on 'b'.
    useTriageStore.getState().reconcile(new Set(['b', 'c', 'd']));
    const s = useTriageStore.getState();
    expect(s.queue).toEqual(['b', 'c', 'd']);
    expect(currentTaskId(s)).toBe('b');
    expect(s.index).toBe(0);
  });

  it('anchors to the next surviving task when the current one vanishes', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b', 'c', 'd']);
    store.advance(); // on 'b'
    // 'b' itself is deleted while under review.
    useTriageStore.getState().reconcile(new Set(['a', 'c', 'd']));
    const s = useTriageStore.getState();
    expect(s.queue).toEqual(['a', 'c', 'd']);
    // 'a' came before 'b' and survived → cursor lands on 'c' (index 1).
    expect(currentTaskId(s)).toBe('c');
    expect(s.index).toBe(1);
  });

  it('marks complete when reconcile drains the remaining queue', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b']);
    store.advance(); // on 'b' (index 1)
    // 'b' (the only remaining task) is deleted; 'a' was already reviewed.
    useTriageStore.getState().reconcile(new Set(['a']));
    const s = useTriageStore.getState();
    expect(s.queue).toEqual(['a']);
    expect(isComplete(s)).toBe(true);
    expect(s.finishedAt).not.toBeNull();
  });

  it('is a no-op when nothing vanished', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b']);
    const before = useTriageStore.getState().queue;
    useTriageStore.getState().reconcile(new Set(['a', 'b']));
    expect(useTriageStore.getState().queue).toBe(before); // same reference
  });
});

describe('triage helpers — counts + breakdown', () => {
  it('reviewedCount + position clamp to the queue length', () => {
    const store = useTriageStore.getState();
    store.start(['a', 'b']);
    store.record('keep');
    store.record('keep');
    const s = useTriageStore.getState();
    expect(reviewedCount(s)).toBe(2);
    expect(position(s)).toBe(2); // clamped, not 3
  });

  it('decisionBreakdown tallies the latest decision per task', () => {
    const decisions: TriageDecision[] = [
      { taskId: 'a', action: 'priority', at: 1 },
      { taskId: 'b', action: 'delete', at: 2 },
      { taskId: 'c', action: 'derive', at: 3 },
      // Re-decide 'a' after stepping back — only the latest should count.
      { taskId: 'a', action: 'done', at: 4 },
    ];
    const b = decisionBreakdown(decisions);
    expect(b.priority).toBe(0); // superseded by 'done'
    expect(b.done).toBe(1);
    expect(b.delete).toBe(1);
    expect(b.derive).toBe(1);
    expect(b.keep).toBe(0);
  });
});

describe('triage helpers — elapsed formatting', () => {
  it('formats sub-hour durations as M:SS', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5_000)).toBe('0:05');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(9 * 60_000 + 7_000)).toBe('9:07');
  });

  it('formats hour-plus durations as H:MM:SS', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });

  it('elapsedMs uses finishedAt when set, otherwise now', () => {
    expect(elapsedMs({ startedAt: null, finishedAt: null })).toBe(0);
    expect(
      elapsedMs({ startedAt: 1_000, finishedAt: 4_000 }),
    ).toBe(3_000);
    expect(
      elapsedMs({ startedAt: 1_000, finishedAt: null }, 6_000),
    ).toBe(5_000);
    // Never negative even if clocks are weird.
    expect(
      elapsedMs({ startedAt: 9_000, finishedAt: 1_000 }),
    ).toBe(0);
  });
});
