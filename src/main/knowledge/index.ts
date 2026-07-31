/**
 * Public surface for the knowledge base.
 *
 * - Boot: `ensureKnowledgeDirs()` + `startKnowledgeWatcher()` + an initial
 *   `reindexAll()` sweep (call once at app start).
 * - Injection seam (sync): `buildKnowledgeBlock(task)` and
 *   `resolveKnowledgePaths(task)` from `./sync`.
 * - HTTP API: `knowledgeOverview()`, `extractorStatus()`, `reindexAll`,
 *   `reindexBusiness`, `matchKnowledgeForTask`.
 */

import fs from 'node:fs/promises';

import type {
  KnowledgeBusinessSummary,
  KnowledgeExtractorStatus,
} from '@/shared/types';

import { KNOWLEDGE_DIR } from './paths';
import { probePython } from './extract';
import { readCatalog } from './catalog';
import { listBusinesses, reindexAll, toSummary } from './indexer';

export { KNOWLEDGE_DIR } from './paths';
export {
  listBusinesses,
  reindexAll,
  reindexBusiness,
} from './indexer';
export { matchKnowledgeForTask, businessesForTask } from './match';
export {
  buildKnowledgeBlock,
  resolveKnowledgePaths,
  matchKnowledgeForTaskSync,
} from './sync';
export { startKnowledgeWatcher } from './watcher';
export type { KnowledgeWatcherHandle } from './watcher';

/** Create the knowledge root if it doesn't exist yet. */
export async function ensureKnowledgeDirs(): Promise<void> {
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });
}

/** Per-business rollup for the management view (reads catalogs, no re-extract). */
export async function knowledgeOverview(): Promise<KnowledgeBusinessSummary[]> {
  const businesses = await listBusinesses();
  const out: KnowledgeBusinessSummary[] = [];
  for (const business of businesses) {
    out.push(toSummary(business, await readCatalog(business)));
  }
  return out;
}

/** Is the extraction toolchain available? Surfaced in the UI as a banner. */
export async function extractorStatus(): Promise<KnowledgeExtractorStatus> {
  const { available } = await probePython();
  return {
    python_available: available,
    missing_deps: [],
  };
}

/**
 * Boot the knowledge subsystem: ensure dirs, run an initial sweep (so catalogs
 * reflect any files dropped while the app was closed), and start the watcher.
 * Best-effort — never throws into app startup.
 */
export async function startKnowledge(): Promise<{ stop: () => Promise<void> }> {
  const { startKnowledgeWatcher } = await import('./watcher');
  try {
    await ensureKnowledgeDirs();
    await reindexAll();
  } catch {
    /* non-fatal — watcher will still pick up changes */
  }
  const handle = startKnowledgeWatcher();
  return { stop: handle.stop };
}
