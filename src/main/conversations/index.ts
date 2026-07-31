/**
 * Conversations subsystem entry — start/stop the ingestor + compactor as a
 * single unit. Mirrors the shape of the ambient monitor module so main.ts
 * can wire it the same way.
 */

import {
  reconcile,
  startConversationIngestor,
  type ConversationIngestorHandle,
} from './ingestor.js';
import { startCompactor, type CompactorHandle } from './compactor.js';

export interface ConversationsHandle {
  stop: () => Promise<void>;
  rescan: () => Promise<{ scanned: number }>;
  runCompactionNow: CompactorHandle['runNow'];
}

export async function startConversations(): Promise<ConversationsHandle> {
  // Catch up on existing files first so the watcher only fires on new diffs.
  try {
    await reconcile();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[conversations] initial reconcile failed', err);
  }
  const ingestor: ConversationIngestorHandle = startConversationIngestor();
  const compactor: CompactorHandle = startCompactor();

  return {
    stop: async () => {
      compactor.stop();
      await ingestor.stop();
    },
    rescan: () => ingestor.rescan(),
    runCompactionNow: compactor.runNow,
  };
}

export { reconcile } from './ingestor.js';
export { buildDigest } from './digest.js';
export { parseSessionFile } from './parser.js';
export { autoLinkConversation } from './linker.js';
