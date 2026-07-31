/**
 * Trailing-debounce coalescer used by the notification system to fold a burst
 * of events into a single summary toast. Kept dependency-free (no electron, no
 * db) so it's trivially unit-testable with fake timers.
 */

export interface Batcher<T> {
  /** Queue an item; (re)arms the flush timer. */
  push: (item: T) => void;
  /** Flush immediately if anything is queued. */
  flushNow: () => void;
  /** Drop the timer and any queued items. */
  cancel: () => void;
}

/**
 * Collect items and flush them as one batch after `windowMs` of quiet. Each
 * `push` resets the timer (trailing debounce), so a steady burst coalesces
 * into a single flush once it settles.
 */
export function createBatcher<T>(
  windowMs: number,
  flush: (items: T[]) => void,
): Batcher<T> {
  let items: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const doFlush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (items.length === 0) return;
    const batch = items;
    items = [];
    flush(batch);
  };

  return {
    push: (item: T): void => {
      items.push(item);
      if (timer) clearTimeout(timer);
      timer = setTimeout(doFlush, windowMs);
    },
    flushNow: doFlush,
    cancel: (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      items = [];
    },
  };
}
