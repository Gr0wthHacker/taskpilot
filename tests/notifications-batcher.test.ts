/**
 * Tests for the notification coalescing batcher
 * (`createBatcher` in `src/main/notification-batcher.ts`).
 *
 * Uses fake timers to assert the trailing-debounce behaviour: a burst of
 * pushes flushes exactly once, after the quiet window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBatcher } from '@/main/notification-batcher';

describe('createBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst into a single flush after the window', () => {
    const flush = vi.fn();
    const b = createBatcher<number>(5_000, flush);

    b.push(1);
    b.push(2);
    b.push(3);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('resets the timer on each push (trailing debounce)', () => {
    const flush = vi.fn();
    const b = createBatcher<string>(1_000, flush);

    b.push('a');
    vi.advanceTimersByTime(900);
    b.push('b'); // re-arms — should NOT have flushed yet
    vi.advanceTimersByTime(900);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a', 'b']);
  });

  it('flushNow flushes immediately and clears the queue', () => {
    const flush = vi.fn();
    const b = createBatcher<number>(5_000, flush);

    b.push(1);
    b.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1]);

    // Timer already cleared — advancing must not double-flush.
    vi.advanceTimersByTime(5_000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('cancel drops queued items and the timer', () => {
    const flush = vi.fn();
    const b = createBatcher<number>(5_000, flush);

    b.push(1);
    b.cancel();
    vi.advanceTimersByTime(5_000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('does not flush when nothing was queued', () => {
    const flush = vi.fn();
    const b = createBatcher<number>(5_000, flush);
    b.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });

  it('starts a fresh batch after a flush', () => {
    const flush = vi.fn();
    const b = createBatcher<number>(1_000, flush);

    b.push(1);
    vi.advanceTimersByTime(1_000);
    b.push(2);
    vi.advanceTimersByTime(1_000);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(1, [1]);
    expect(flush).toHaveBeenNthCalledWith(2, [2]);
  });
});
