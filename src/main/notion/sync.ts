/**
 * One-way TaskPilot → Notion mirror.
 *
 * On a configurable cadence (default 5 minutes) the sync pushes every
 * task that:
 *
 *   - was updated since the last successful sync
 *   - belongs to the active Notion workspace filter (`notion_sync_workspace`,
 *     optional — empty means "all workspaces")
 *   - has `notion_sync_enabled` true (default false)
 *
 * Each task is upserted into the configured database. The Notion page
 * id is stashed back onto `task.context.notion_page_id` so subsequent
 * syncs patch instead of duplicating.
 *
 * Status / priority strings are mapped from TaskPilot canonicals to
 * the user's Notion select labels. The mapping is the obvious 1:1
 * (inbox → Inbox, queued → Queued, ...). If the user's DB doesn't
 * have those exact options Notion will reject the property write —
 * we swallow per-task errors so one bad task can't poison the run.
 */

import { settingsRepository } from '@/main/db/repositories/settings';
import { listTasks, updateTask } from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

import {
  NotionApiError,
  NotionAuthError,
  NotionNotConfiguredError,
  upsertPage,
} from './index';
import { hasToken } from './storage';

/* -------------------------------------------------------------------------- */
/*  Settings keys                                                             */
/* -------------------------------------------------------------------------- */

const ENABLED_KEY = 'notion_sync_enabled';
const DATABASE_ID_KEY = 'notion_database_id';
const WORKSPACE_FILTER_KEY = 'notion_sync_workspace';
const LAST_SYNC_KEY = 'notion_last_sync_at';

/** Default polling interval — 5 minutes. */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1_000;

/* -------------------------------------------------------------------------- */
/*  Public helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Is the mirror enabled? */
export function isSyncEnabled(): boolean {
  const raw = settingsRepository.get<unknown>(ENABLED_KEY);
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  if (typeof raw === 'number') return raw === 1;
  return false;
}

/** Configured database id, if any. */
export function getDatabaseId(): string | null {
  const raw = settingsRepository.get<unknown>(DATABASE_ID_KEY);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Configured workspace filter — empty string means "no filter". */
export function getWorkspaceFilter(): string | null {
  const raw = settingsRepository.get<unknown>(WORKSPACE_FILTER_KEY);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/* -------------------------------------------------------------------------- */
/*  Status / priority mapping                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Map TaskPilot's canonical status enum to a human-readable select
 * label. The user is expected to create matching options in their
 * Notion database; the mapping is the obvious title-case form.
 */
export function mapStatus(status: Task['status']): string {
  switch (status) {
    case 'inbox':
      return 'Inbox';
    case 'queued':
      return 'Queued';
    case 'in_progress':
      return 'In progress';
    case 'blocked':
      return 'Blocked';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'archived':
      return 'Archived';
    default:
      return String(status);
  }
}

export function mapPriority(priority: Task['priority']): string {
  return String(priority).toUpperCase();
}

/* -------------------------------------------------------------------------- */
/*  Eligibility                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Should we sync this task? Respects:
 *   - archived tasks are skipped
 *   - workspace filter (`context.workspace === <filter>` if set)
 */
export function shouldSyncTask(task: Task, workspaceFilter: string | null): boolean {
  if (task.status === 'archived') return false;
  if (!workspaceFilter) return true;
  const ctx = task.context as Record<string, unknown> | null;
  if (!ctx || typeof ctx !== 'object') return false;
  const ws = ctx['workspace'];
  return typeof ws === 'string' && ws === workspaceFilter;
}

/* -------------------------------------------------------------------------- */
/*  Page id persistence                                                       */
/* -------------------------------------------------------------------------- */

function readPageId(task: Task): string | null {
  if (!task.context || typeof task.context !== 'object') return null;
  const id = (task.context as Record<string, unknown>)['notion_page_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function persistPageId(
  task: Task,
  pageId: string,
  url: string | null,
  syncedAt: string,
): void {
  const baseCtx =
    task.context && typeof task.context === 'object'
      ? { ...(task.context as Record<string, unknown>) }
      : {};
  baseCtx['notion_page_id'] = pageId;
  if (url) baseCtx['notion_page_url'] = url;
  baseCtx['notion_synced_at'] = syncedAt;
  updateTask(task.id, { context: baseCtx });
}

/* -------------------------------------------------------------------------- */
/*  Sync run                                                                  */
/* -------------------------------------------------------------------------- */

export interface SyncResult {
  ok: boolean;
  pushed: number;
  skipped: number;
  failed: number;
  notConfigured?: boolean;
  reason?: string;
  errors?: Array<{ taskId: string; error: string }>;
}

/**
 * Run one full sync pass. Returns immediately when the mirror is
 * disabled / not configured. The caller is expected to swallow any
 * thrown error — this function only throws on programmer-error
 * (e.g. missing settings repo).
 */
export async function syncOnce(): Promise<SyncResult> {
  if (!isSyncEnabled()) {
    return {
      ok: true,
      pushed: 0,
      skipped: 0,
      failed: 0,
      reason: 'notion_sync_disabled',
    };
  }
  const databaseId = getDatabaseId();
  if (!databaseId) {
    return {
      ok: true,
      pushed: 0,
      skipped: 0,
      failed: 0,
      reason: 'database_not_selected',
    };
  }
  // Cheap pre-check — avoid loading the SDK + cache if no token exists.
  const tokenPresent = await hasToken();
  if (!tokenPresent) {
    return {
      ok: true,
      pushed: 0,
      skipped: 0,
      failed: 0,
      notConfigured: true,
      reason: 'notion_not_configured',
    };
  }

  const lastSyncAtRaw = settingsRepository.get<unknown>(LAST_SYNC_KEY);
  const lastSyncAt =
    typeof lastSyncAtRaw === 'string' && lastSyncAtRaw.length > 0
      ? lastSyncAtRaw
      : null;
  const workspaceFilter = getWorkspaceFilter();

  // Pull every active task (no upper bound — typical TaskPilot has
  // hundreds at most). The "recently changed" filter is applied in JS
  // because the tasks repo doesn't expose `updated_at >= X` natively
  // and the dataset is small enough that the post-filter is cheap.
  const allTasks = listTasks({});
  const candidates: Task[] = [];
  for (const task of allTasks) {
    if (!shouldSyncTask(task, workspaceFilter)) continue;
    if (lastSyncAt && task.updated_at < lastSyncAt && readPageId(task)) {
      // Already mirrored AND no change since the last sync — skip.
      continue;
    }
    candidates.push(task);
  }

  const errors: Array<{ taskId: string; error: string }> = [];
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();

  for (const task of candidates) {
    try {
      const pageId = readPageId(task);
      const res = await upsertPage({
        database_id: databaseId,
        page_id: pageId,
        title: task.title,
        status: mapStatus(task.status),
        priority: mapPriority(task.priority),
        tags: task.tags,
        description: task.description,
      });
      if (res.page_id) {
        persistPageId(task, res.page_id, res.url, nowIso);
        pushed += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      // Notion auth failure aborts the whole run — no point pushing
      // the rest with a dead token.
      if (
        err instanceof NotionAuthError ||
        err instanceof NotionNotConfiguredError
      ) {
        return {
          ok: false,
          pushed,
          skipped,
          failed,
          notConfigured: err instanceof NotionNotConfiguredError,
          reason: err.code,
          errors: [...errors, { taskId: task.id, error: err.message }],
        };
      }
      failed += 1;
      errors.push({
        taskId: task.id,
        error:
          err instanceof NotionApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'unknown error',
      });
    }
  }

  // Record the run timestamp regardless of per-task failures so the
  // next pass doesn't reprocess everything from scratch.
  settingsRepository.set(LAST_SYNC_KEY, nowIso);

  const result: SyncResult = { ok: true, pushed, skipped, failed };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Background job                                                            */
/* -------------------------------------------------------------------------- */

export interface SyncJobOptions {
  intervalMs?: number;
  /** Skip the immediate first tick (boot-time eager sync). */
  skipInitialTick?: boolean;
}

export interface SyncJobHandle {
  stop: () => void;
  tickNow: () => Promise<SyncResult>;
}

let activeJob: SyncJobHandle | null = null;

/**
 * Start the background mirror loop. Calling twice is a no-op — the
 * existing handle is returned. Each tick short-circuits cheaply when
 * the mirror is disabled, so the same boot call works whether the
 * user has connected Notion or not.
 */
export function startSyncJob(
  options: SyncJobOptions = {},
): SyncJobHandle {
  if (activeJob) return activeJob;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;

  const tickNow = async (): Promise<SyncResult> => {
    try {
      return await syncOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:notion-sync] tick failed:',
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false, pushed: 0, skipped: 0, failed: 0, reason: 'tick_error' };
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (stopped) return;
    void tickNow();
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  const handle: SyncJobHandle = {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      activeJob = null;
    },
    tickNow,
  };
  activeJob = handle;

  if (!options.skipInitialTick) {
    void tickNow();
  }
  return handle;
}

export function stopSyncJob(): void {
  if (activeJob) activeJob.stop();
}

export function isSyncJobRunning(): boolean {
  return activeJob !== null;
}

/**
 * Test-only escape hatch.
 */
export const __internals = {
  resetActiveJob(): void {
    if (activeJob) activeJob.stop();
    activeJob = null;
  },
  readPageId,
  persistPageId,
};
