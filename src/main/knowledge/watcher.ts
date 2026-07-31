/**
 * Watches the knowledge root and keeps catalogs in sync as the user drops,
 * edits, or removes files. Mirrors the debounced, polling-friendly approach
 * of `src/main/io/watcher.ts` (chokidar misses ~20% of events from
 * non-Electron writers on Windows).
 *
 * Only top-level files inside a business folder are indexed
 * (`knowledge/<business>/<file>`); the `.index/` tree and nested dirs are
 * ignored.
 */

import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { INDEX_DIRNAME, KNOWLEDGE_DIR } from './paths';
import { removeFile, upsertFile } from './indexer';

export interface KnowledgeWatcherHandle {
  stop: () => Promise<void>;
}

/** Map an absolute path to `{ business, file }`, or null if not indexable. */
function locate(filePath: string): { business: string; file: string } | null {
  const rel = path.relative(KNOWLEDGE_DIR, path.normalize(filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length !== 2) return null; // only <business>/<file>
  const [business, file] = parts;
  if (business.startsWith('.') || file.startsWith('.')) return null;
  if (business === INDEX_DIRNAME || file === INDEX_DIRNAME) return null;
  return { business, file };
}

export function startKnowledgeWatcher(): KnowledgeWatcherHandle {
  let watcher: FSWatcher | null = null;
  let stopped = false;

  const onUpsert = (filePath: string): void => {
    const loc = locate(filePath);
    if (!loc) return;
    void upsertFile(loc.business, loc.file).catch(() => {
      /* best-effort */
    });
  };
  const onRemove = (filePath: string): void => {
    const loc = locate(filePath);
    if (!loc) return;
    void removeFile(loc.business, loc.file).catch(() => {
      /* best-effort */
    });
  };

  watcher = chokidar.watch(path.join(KNOWLEDGE_DIR, '*', '*'), {
    ignoreInitial: true, // initial sweep handled by reindexAll() at boot
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    followSymlinks: false,
    depth: 0,
    ignored: (p: string) => p.includes(`${path.sep}${INDEX_DIRNAME}${path.sep}`),
  });

  watcher.on('add', onUpsert);
  watcher.on('change', onUpsert);
  watcher.on('unlink', onRemove);

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },
  };
}
