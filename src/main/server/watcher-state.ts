/**
 * Local snapshot of the I/O watcher's lifecycle.
 *
 * `src/main/io/watcher.ts` doesn't expose a `getWatcherState()` accessor, so
 * the server tracks the state itself: `setWatcherState()` is called from
 * `server/index.ts` around `startWatcher()` and `stop()`.
 */

import type { IoStatusResponse } from '@/shared/api-contract';

type WatcherState = IoStatusResponse['watcher'];

let state: WatcherState = 'stopped';

export function setWatcherState(next: WatcherState): void {
  state = next;
}

export function getWatcherState(): WatcherState {
  return state;
}
