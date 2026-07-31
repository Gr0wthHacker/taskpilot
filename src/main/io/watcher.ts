import fs from 'node:fs/promises';
import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import {
  DerivationResponseSchema,
  ExecutionResultSchema,
  TaskSchema,
  deliberationResultSchema,
  inboxDropSchema,
  normalizeInboxDrop,
  statusUpdateSchema,
} from '@/shared/io-schemas';
import type { DeliberationResult, StatusUpdateDrop } from '@/shared/io-schemas';
import type {
  DerivationResponse,
  ExecutionResult,
  Task,
} from '@/shared/types';

import {
  IO_DONE_ARCHIVE_DERIVED,
  IO_DONE_ARCHIVE_INBOX,
  IO_DONE_ARCHIVE_MEMORY_ENRICHED,
  IO_DONE_ARCHIVE_STATUS_UPDATE,
  IO_MEMORY_ENRICHED,
  IO_STATUS_UPDATE,
} from '@/shared/constants';
import { safeParseMemoryEnrichResponse } from '@/shared/io-schemas';

import { ioEvents } from './events';
import {
  IO_DELIBERATED,
  IO_DERIVED,
  IO_INBOX,
  IO_RESULTS,
  ensureIoDirs,
  invalidPath,
} from './paths';

/**
 * Handler bundle passed to {@link startWatcher}. Each handler is invoked
 * after the watcher has validated the file against the appropriate schema.
 */
export interface IoEventHandlers {
  onDerivedFound: (taskId: string, response: DerivationResponse) => void | Promise<void>;
  onResultFound: (
    taskId: string,
    result: ExecutionResult,
    outputFiles: string[],
  ) => void | Promise<void>;
  onInboxFound: (taskId: string, task: Task) => void | Promise<void>;
  /**
   * Optional: invoked when a deliberation verdict lands in
   * `IO_DELIBERATED/<batch_id>.json`. Wired by the server boot to the
   * deliberation ingestion module. Omitted in test contexts that don't
   * exercise the deliberation flow.
   */
  onDeliberatedFound?: (
    batchId: string,
    result: DeliberationResult,
  ) => void | Promise<void>;
  /**
   * Optional: invoked when a memory enrichment response lands in
   * `IO_MEMORY_ENRICHED/<memory_id>.json`. Wired by the server boot to
   * `ingestEnrichResponse()`.
   */
  onMemoryEnrichedFound?: (
    memoryId: string,
    response: import('@/shared/io-schemas').MemoryEnrichResponse,
  ) => void | Promise<void>;
  /**
   * Optional: invoked when a per-business status delta lands in
   * `IO_STATUS_UPDATE/<id>.json`. Wired by the server boot to
   * `recordUpdate()` in the businesses module.
   */
  onStatusUpdateFound?: (
    dropId: string,
    payload: StatusUpdateDrop,
  ) => void | Promise<void>;
  onError?: (info: WatcherErrorInfo) => void;
}

/**
 * Context payload supplied to {@link IoEventHandlers.onError}. Includes
 * enough information to log and (if desired) requeue the failing file.
 */
export interface WatcherErrorInfo {
  scope:
    | 'derived'
    | 'result'
    | 'inbox'
    | 'deliberated'
    | 'memory'
    | 'status_update'
    | 'watcher';
  message: string;
  path?: string;
  error?: unknown;
}

/**
 * Handle returned by {@link startWatcher} so callers can shut the watcher
 * down cleanly.
 */
export interface WatcherHandle {
  stop: () => Promise<void>;
  rescan: () => Promise<void>;
}

let activeRescan: (() => Promise<void>) | null = null;

/**
 * Force the active watcher to re-dispatch every existing file under its
 * watched roots. Used by the `/api/io/ingest` endpoint and the
 * `tp:ingest` IPC channel. Safe to call when no watcher is running — it
 * resolves immediately.
 */
export async function triggerRescan(): Promise<void> {
  if (activeRescan) await activeRescan();
}

/**
 * How long (ms) we suppress duplicate error emissions on the same path.
 * Prevents tight loops when a file resists quarantine (e.g. on Windows
 * with a lingering file lock).
 */
const ERROR_DEBOUNCE_MS = 2_000;

/**
 * How long (ms) chokidar waits for a file's size to stabilise before
 * emitting `add`. Matches the value in {@link ../../../BUILD_CONTRACTS.md}.
 */
const STABILITY_THRESHOLD_MS = 200;
const POLL_INTERVAL_MS = 50;

/**
 * Cadence (ms) of the belt-and-suspenders polling pass. chokidar misses
 * ~20% of file events from non-Electron processes on Windows (e.g. files
 * dropped in by Claude Code's `Write` tool); the polling pass catches the
 * stragglers without ever stepping on chokidar's primary event stream.
 */
const POLLING_FALLBACK_INTERVAL_MS = 3_000;

/**
 * TTL (ms) for an entry in the polling-pass dedupe map. Once a file's last
 * dispatch is older than this, the polling pass will re-dispatch it. The TTL
 * has to be longer than the longest reasonable ingestion latency (so we don't
 * double-fire while the app is still working through a file) but shorter than
 * any meaningful retry window. 30s is comfortably both.
 */
const POLLING_DEDUPE_TTL_MS = 30_000;

/**
 * Hard cap on entries in the dispatch-dedupe map. The polling pass only ever
 * inserts paths it observes on disk, so the realistic ceiling is bounded by
 * the size of the IO tree, but a runaway producer or a directory full of
 * orphaned files could grow the map indefinitely. Cap at 1000 entries and
 * evict oldest-first when full.
 */
const POLLING_DEDUPE_MAX_ENTRIES = 1_000;

/**
 * Start the I/O watcher.
 *
 * Watches three directories:
 *   - `IO_DERIVED/<id>.json` — Claude's derivation responses
 *   - `IO_RESULTS/<id>/result.json` — Claude's execution results
 *   - `IO_INBOX/<id>.json` — new tasks dropped in by Claude
 *
 * Each `add` event is read, validated, and dispatched. Files that fail
 * schema validation are moved to `IO_ROOT/_invalid/` so they don't trigger
 * the watcher again on every restart.
 */
export function startWatcher(handlers: IoEventHandlers): WatcherHandle {
  let watcher: FSWatcher | null = null;
  let stopped = false;
  const lastErrorAt = new Map<string, number>();

  // Tracks the last time each file path was dispatched. Used by the polling
  // fallback to suppress duplicate dispatches for files chokidar has already
  // delivered. `dispatch()` itself is idempotent (ingestion checks for an
  // existing row by id; result re-ingestion is fine) — this map is purely a
  // cheap throttle so we don't re-read the same file every 3 seconds.
  const lastDispatchedMs = new Map<string, number>();
  let pollTimer: NodeJS.Timeout | null = null;

  function markDispatched(filePath: string): void {
    // Evict the oldest entry once we're at the cap. Map preserves insertion
    // order, so the first key is the oldest write — we delete it before
    // inserting so the new entry slots into the "most recent" position.
    if (lastDispatchedMs.size >= POLLING_DEDUPE_MAX_ENTRIES) {
      const firstKey = lastDispatchedMs.keys().next().value;
      if (firstKey !== undefined) lastDispatchedMs.delete(firstKey);
    }
    // Delete + reinsert so the LRU ordering reflects this dispatch.
    lastDispatchedMs.delete(filePath);
    lastDispatchedMs.set(filePath, Date.now());
  }

  function shouldPollDispatch(filePath: string): boolean {
    const last = lastDispatchedMs.get(filePath);
    if (last === undefined) return true;
    return Date.now() - last > POLLING_DEDUPE_TTL_MS;
  }

  void (async () => {
    await ensureIoDirs();
    if (stopped) return;

    watcher = chokidar.watch(
      [
        path.join(IO_DERIVED, '*.json'),
        path.join(IO_RESULTS, '*', 'result.json'),
        path.join(IO_INBOX, '*.json'),
        // Ambient monitor — deliberation verdicts. The request side
        // (IO_DELIBERATE) is deliberately NOT watched: the app writes those
        // and Claude reads them; if we watched it we'd ingest our own
        // requests.
        path.join(IO_DELIBERATED, '*.json'),
        // Memory subsystem — runner-written enrichment responses.
        // The request side (IO_MEMORY_ENRICH) is NOT watched for the same
        // reason as IO_DELIBERATE: we write those and runners consume them.
        path.join(IO_MEMORY_ENRICHED, '*.json'),
        // Per-business status delta drops. Any Claude session (typically the
        // SessionEnd hook) writes a row here; the watcher appends it into the
        // owning business's updates feed and re-renders STATUS.md.
        path.join(IO_STATUS_UPDATE, '*.json'),
      ],
      {
        awaitWriteFinish: {
          stabilityThreshold: STABILITY_THRESHOLD_MS,
          pollInterval: POLL_INTERVAL_MS,
        },
        ignoreInitial: false,
        usePolling: false,
        persistent: true,
        // Polling fallback. Chokidar will fall back automatically when fs
        // events are unreliable (e.g. networked drives, some Docker mounts);
        // we hint sane defaults so the fallback isn't pathologically slow.
        interval: 250,
        binaryInterval: 500,
        // SECURITY: refuse to follow symlinks. The I/O tree lives in the
        // user's home directory, but an attacker that can drop a symlink
        // there should not be able to coax us into reading or quarantining
        // arbitrary files. See also the per-file `lstat` check in
        // `dispatch()` below for defense in depth against a TOCTOU race.
        followSymlinks: false,
        // Skip the `.tmp` siblings the protocol layer writes during atomic
        // renames so we never read half-written files.
        ignored: (p: string) => p.endsWith('.tmp'),
      },
    );

    watcher.on('add', (filePath) => {
      markDispatched(filePath);
      void dispatch(filePath);
    });
    watcher.on('error', (err) => {
      emitError({ scope: 'watcher', message: 'chokidar error', error: err });
    });

    // Belt-and-suspenders polling pass. chokidar misses ~20% of file events
    // from non-Electron processes on Windows (notably files dropped in by
    // Claude Code's `Write` tool), so we run a periodic sweep over the
    // watched roots and dispatch anything chokidar didn't already deliver.
    // Dedupe via `lastDispatchedMs`; the underlying `dispatch()` is
    // idempotent regardless.
    pollTimer = setInterval(() => {
      void pollOnce();
    }, POLLING_FALLBACK_INTERVAL_MS);
    // Don't hold the Electron main process open just for the poll timer.
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  })().catch((err) => {
    emitError({ scope: 'watcher', message: 'failed to start watcher', error: err });
  });

  /**
   * Single sweep of the polling fallback. Walks each watched root, gates
   * dispatch through the dedupe map, and skips `.tmp` files (chokidar's
   * `ignored` filter already drops them, but the poll sees raw `readdir`
   * entries and has to filter for itself).
   */
  async function pollOnce(): Promise<void> {
    if (stopped) return;
    type Root = { dir: string; pattern: 'json' | 'result' };
    const roots: Root[] = [
      { dir: IO_DERIVED, pattern: 'json' },
      { dir: IO_INBOX, pattern: 'json' },
      { dir: IO_RESULTS, pattern: 'result' },
      { dir: IO_DELIBERATED, pattern: 'json' },
      { dir: IO_MEMORY_ENRICHED, pattern: 'json' },
      { dir: IO_STATUS_UPDATE, pattern: 'json' },
    ];
    for (const { dir, pattern } of roots) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: string }).code === 'ENOENT'
        ) {
          continue;
        }
        emitError({
          scope: 'watcher',
          path: dir,
          message: 'polling readdir failed',
          error: err,
        });
        continue;
      }
      for (const entry of entries) {
        if (pattern === 'json') {
          if (
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            !entry.name.endsWith('.tmp')
          ) {
            const filePath = path.join(dir, entry.name);
            if (!shouldPollDispatch(filePath)) continue;
            markDispatched(filePath);
            await dispatch(filePath);
          }
        } else if (pattern === 'result') {
          if (entry.isDirectory()) {
            const candidate = path.join(dir, entry.name, 'result.json');
            try {
              await fs.access(candidate);
            } catch {
              continue;
            }
            if (!shouldPollDispatch(candidate)) continue;
            markDispatched(candidate);
            await dispatch(candidate);
          }
        }
      }
    }
  }

  async function dispatch(filePath: string): Promise<void> {
    const norm = path.normalize(filePath);
    try {
      // SECURITY: reject symlinks even though chokidar is configured with
      // followSymlinks: false. The watcher emits raw filenames; a symlink
      // could have been created between the directory scan and this call.
      // Quarantine the symlink so it can't keep triggering events.
      try {
        const st = await fs.lstat(norm);
        if (st.isSymbolicLink()) {
          await quarantine(norm, 'watcher', 'symlink rejected');
          return;
        }
      } catch {
        // If lstat fails (race with delete, permissions), let downstream
        // readers surface the error.
      }
      if (isUnder(norm, IO_DERIVED) && norm.endsWith('.json')) {
        await handleDerived(norm);
        return;
      }
      if (isUnder(norm, IO_RESULTS) && path.basename(norm) === 'result.json') {
        await handleResult(norm);
        return;
      }
      if (isUnder(norm, IO_INBOX) && norm.endsWith('.json')) {
        await handleInbox(norm);
        return;
      }
      if (isUnder(norm, IO_DELIBERATED) && norm.endsWith('.json')) {
        await handleDeliberated(norm);
        return;
      }
      if (isUnder(norm, IO_MEMORY_ENRICHED) && norm.endsWith('.json')) {
        await handleMemoryEnriched(norm);
        return;
      }
      if (isUnder(norm, IO_STATUS_UPDATE) && norm.endsWith('.json')) {
        await handleStatusUpdate(norm);
        return;
      }
    } catch (err: unknown) {
      emitError({
        scope: 'watcher',
        path: norm,
        message: err instanceof Error ? err.message : 'unknown dispatch error',
        error: err,
      });
    }
  }

  async function handleDerived(filePath: string): Promise<void> {
    const taskId = path.basename(filePath, '.json');
    const raw = await readJson(filePath);
    const parsed = DerivationResponseSchema.safeParse(raw);
    if (!parsed.success) {
      await quarantine(filePath, 'derived', parsed.error.message);
      return;
    }
    try {
      await handlers.onDerivedFound(taskId, parsed.data);
      // Move-on-ingest: once children are created, the source file must NOT
      // be re-dispatched on the next rescan — that re-spawns duplicates.
      // The 33k-task v8 cleanup was the fallout of skipping this step. We
      // archive rather than delete so a sysadmin can recover if ingestion
      // had a bug.
      await archive(filePath, IO_DONE_ARCHIVE_DERIVED, 'derived');
    } catch (err: unknown) {
      emitError({
        scope: 'derived',
        path: filePath,
        message: err instanceof Error ? err.message : 'handler threw',
        error: err,
      });
    }
  }

  async function handleResult(filePath: string): Promise<void> {
    // <IO_RESULTS>/<taskId>/result.json
    const taskId = path.basename(path.dirname(filePath));
    const raw = await readJson(filePath);
    const parsed = ExecutionResultSchema.safeParse(raw);
    if (!parsed.success) {
      await quarantine(filePath, 'result', parsed.error.message);
      return;
    }
    const outputFiles = await listOutputFiles(path.dirname(filePath));
    try {
      await handlers.onResultFound(taskId, parsed.data, outputFiles);
    } catch (err: unknown) {
      emitError({
        scope: 'result',
        path: filePath,
        message: err instanceof Error ? err.message : 'handler threw',
        error: err,
      });
    }
  }

  async function handleInbox(filePath: string): Promise<void> {
    const taskId = path.basename(filePath, '.json');
    const raw = await readJson(filePath);

    // --- Path 1: full Task shape (backward compat for tools that write complete tasks) ---
    const fullParse = TaskSchema.safeParse(raw);
    if (fullParse.success) {
      try {
        await handlers.onInboxFound(taskId, fullParse.data);
        await archive(filePath, IO_DONE_ARCHIVE_INBOX, 'inbox');
      } catch (err: unknown) {
        emitError({
          scope: 'inbox',
          path: filePath,
          message: err instanceof Error ? err.message : 'handler threw',
          error: err,
        });
      }
      return;
    }

    // --- Path 2: partial drop (what the skill, CLI, and Cowork write) ---
    // Only `title` is required; `normalizeInboxDrop` hydrates the rest with the
    // same defaults the MCP taskpilot_create_task tool applies. This schema is a
    // superset of the old inboxCreateSchema — it also accepts `id`, `context`,
    // and `agent_executable`, so a drop carrying a `context` block (e.g. for a
    // github_repo or goal_id) no longer silently fails.
    const dropParse = inboxDropSchema.safeParse(raw);
    if (!dropParse.success) {
      // Neither schema matched — quarantine with the simpler schema's error
      // (full-task errors are almost always noise about missing required fields).
      await quarantine(filePath, 'inbox', dropParse.error.message);
      return;
    }

    const hydrated = normalizeInboxDrop(taskId, dropParse.data);

    try {
      await handlers.onInboxFound(hydrated.id, hydrated);
      await archive(filePath, IO_DONE_ARCHIVE_INBOX, 'inbox');
    } catch (err: unknown) {
      emitError({
        scope: 'inbox',
        path: filePath,
        message: err instanceof Error ? err.message : 'handler threw',
        error: err,
      });
    }
  }

  async function handleDeliberated(filePath: string): Promise<void> {
    // No handler wired (test contexts, MCP-only boots) → silently ignore. The
    // file is left in place so a future boot with the handler wired can pick
    // it up via rescan.
    if (!handlers.onDeliberatedFound) return;
    const batchId = path.basename(filePath, '.json');
    const raw = await readJson(filePath);
    const parsed = deliberationResultSchema.safeParse(raw);
    if (!parsed.success) {
      await quarantine(filePath, 'deliberated', parsed.error.message);
      return;
    }
    try {
      await handlers.onDeliberatedFound(batchId, parsed.data);
    } catch (err: unknown) {
      emitError({
        scope: 'deliberated',
        path: filePath,
        message: err instanceof Error ? err.message : 'handler threw',
        error: err,
      });
    }
  }

  async function handleMemoryEnriched(filePath: string): Promise<void> {
    if (!handlers.onMemoryEnrichedFound) return;
    const memoryId = path.basename(filePath, '.json');
    const raw = await readJson(filePath);
    const parsed = safeParseMemoryEnrichResponse(raw);
    if (!parsed.success) {
      await quarantine(filePath, 'memory', parsed.error.message);
      return;
    }
    try {
      await handlers.onMemoryEnrichedFound(memoryId, parsed.data);
      // Move-on-ingest — same rationale as derived/inbox: keep the live dir
      // clean so a rescan never re-applies a payload that already landed.
      await archive(filePath, IO_DONE_ARCHIVE_MEMORY_ENRICHED, 'memory');
    } catch (err: unknown) {
      emitError({
        scope: 'memory',
        path: filePath,
        message: err instanceof Error ? err.message : 'handler threw',
        error: err,
      });
    }
  }

  async function handleStatusUpdate(filePath: string): Promise<void> {
    // No handler wired (test contexts) → leave the file in place so a future
    // boot picks it up.
    if (!handlers.onStatusUpdateFound) return;
    const dropId = path.basename(filePath, '.json');
    const raw = await readJson(filePath);
    const parsed = statusUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      await quarantine(filePath, 'status_update', parsed.error.message);
      return;
    }
    try {
      await handlers.onStatusUpdateFound(dropId, parsed.data);
      await archive(filePath, IO_DONE_ARCHIVE_STATUS_UPDATE, 'status_update');
    } catch (err: unknown) {
      emitError({
        scope: 'status_update',
        path: filePath,
        message: err instanceof Error ? err.message : 'handler threw',
        error: err,
      });
    }
  }

  /**
   * Move a successfully-ingested file into `_done-archive/<kind>/`. Unlike
   * `quarantine()` this is a SUCCESS path — the source file is moved out of
   * the watched dir so a rescan can't re-dispatch it, but the payload is
   * preserved for forensic recovery. Failures are non-fatal: if the move
   * fails the file stays in place, the watcher will see it again, and the
   * watcher's own dedup (already-dispatched paths) will skip it on the
   * second pass within a single session. The risk window is a process
   * restart between dispatch and move, which is acceptable because:
   *   - the ingestion side is idempotent on (task_id, derivative title);
   *   - the next move attempt the next rescan succeeds.
   */
  async function archive(
    src: string,
    destDir: string,
    scope: WatcherErrorInfo['scope'],
  ): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(destDir, `${stamp}-${path.basename(src)}`);
    try {
      await fs.mkdir(destDir, { recursive: true });
      await fs.rename(src, dest);
    } catch (renameErr: unknown) {
      try {
        await fs.copyFile(src, dest);
        await fs.unlink(src);
      } catch (copyErr: unknown) {
        emitError({
          scope,
          path: src,
          message: 'archive failed (left in place)',
          error: copyErr ?? renameErr,
        });
      }
    }
  }

  async function quarantine(
    src: string,
    scope: WatcherErrorInfo['scope'],
    reason: string,
  ): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = invalidPath(`${stamp}-${path.basename(src)}`);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
    } catch (err: unknown) {
      // If rename fails (cross-device on some setups), fall back to copy+unlink.
      try {
        await fs.copyFile(src, dest);
        await fs.unlink(src);
      } catch (copyErr: unknown) {
        emitError({
          scope,
          path: src,
          message: `quarantine failed: ${reason}`,
          error: copyErr ?? err,
        });
        return;
      }
    }
    emitError({ scope, path: src, message: `invalid payload: ${reason}` });
  }

  function emitError(info: WatcherErrorInfo): void {
    const key = `${info.scope}:${info.path ?? ''}`;
    const now = Date.now();
    const last = lastErrorAt.get(key) ?? 0;
    if (now - last < ERROR_DEBOUNCE_MS) return;
    lastErrorAt.set(key, now);

    ioEvents.emit('io_error', {
      scope: info.scope,
      message: info.message,
      ...(info.path !== undefined ? { path: info.path } : {}),
      ...(info.error !== undefined ? { error: info.error } : {}),
    });
    handlers.onError?.(info);
  }

  async function rescan(): Promise<void> {
    await ensureIoDirs();
    const roots: Array<{ dir: string; pattern: 'json' | 'result' }> = [
      { dir: IO_DERIVED, pattern: 'json' },
      { dir: IO_INBOX, pattern: 'json' },
      { dir: IO_RESULTS, pattern: 'result' },
      { dir: IO_DELIBERATED, pattern: 'json' },
      { dir: IO_STATUS_UPDATE, pattern: 'json' },
    ];
    for (const { dir, pattern } of roots) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (pattern === 'json') {
            if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
              await dispatch(path.join(dir, entry.name));
            }
          } else if (pattern === 'result') {
            if (entry.isDirectory()) {
              const candidate = path.join(dir, entry.name, 'result.json');
              try {
                await fs.access(candidate);
                await dispatch(candidate);
              } catch {
                // no result.json in this task dir yet
              }
            }
          }
        }
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: string }).code === 'ENOENT'
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  activeRescan = rescan;

  return {
    stop: async () => {
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      lastErrorAt.clear();
      lastDispatchedMs.clear();
      if (activeRescan === rescan) activeRescan = null;
    },
    rescan,
  };
}

async function readJson(filePath: string): Promise<unknown> {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text) as unknown;
}

async function listOutputFiles(taskResultsDir: string): Promise<string[]> {
  const dir = path.join(taskResultsDir, 'output');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name));
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw err;
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
