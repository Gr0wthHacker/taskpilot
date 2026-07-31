/**
 * `/api/io/...` routes.
 *
 * Surfaces the on-disk state of the agent I/O pipeline:
 *   - `pending`  → requests the app has written (waiting on Claude)
 *   - `results`  → files Claude has written (waiting on the watcher / ingestion)
 *   - `ingest`   → forces a re-scan (and optionally refreshes context snapshots)
 *   - `status`   → counts per directory + watcher health
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';
import { z } from 'zod';

import {
  IO_DERIVE,
  IO_DERIVED,
  IO_EXECUTE,
  IO_INBOX,
  IO_INVALID,
  IO_RESULTS,
  IO_REVIEW,
} from '@/shared/constants';
import { ingestResult } from '@/main/io/ingestion';
import { isValidTaskId, outputDir, resultPath } from '@/main/io/paths';
import { triggerRescan } from '@/main/io/watcher';
import {
  executionResultSchema,
  taskIdSchema,
} from '@/shared/io-schemas';
import type {
  IoFileRef,
  IoIngestResponse,
  IoPendingResponse,
  IoResultsResponse,
  IoStatusResponse,
  SubmitResultResponse,
} from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { getWatcherState } from '../watcher-state';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  FS helpers                                                                */
/* -------------------------------------------------------------------------- */

interface DirEntry {
  taskId: string;
  filePath: string;
  mtimeMs: number;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function safeStatMs(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Enumerate `<dir>/<taskId>.json` flat files.
 *
 * Filters out any entry whose stem isn't a valid task id — a manually-created
 * `..json` (yes really) or anything outside the canonical alphabet is
 * silently ignored rather than emitted into the response.
 */
async function listJsonFiles(dir: string): Promise<DirEntry[]> {
  const entries = await safeReadDir(dir);
  const out: DirEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry.endsWith('.tmp.json') || entry.endsWith('.json.tmp')) continue;
    const taskId = entry.slice(0, -'.json'.length);
    if (!isValidTaskId(taskId)) continue;
    const filePath = path.join(dir, entry);
    const mtimeMs = await safeStatMs(filePath);
    out.push({ taskId, filePath, mtimeMs });
  }
  return out;
}

/**
 * Enumerate `<IO_RESULTS>/<taskId>/result.json` two-level layout.
 *
 * Same filter: only directories whose name is a valid task id are emitted.
 */
async function listResultFiles(): Promise<DirEntry[]> {
  const taskDirs = await safeReadDir(IO_RESULTS);
  const out: DirEntry[] = [];
  for (const taskId of taskDirs) {
    if (!isValidTaskId(taskId)) continue;
    let candidate: string;
    try {
      candidate = resultPath(taskId);
    } catch {
      continue;
    }
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) {
        out.push({ taskId, filePath: candidate, mtimeMs: st.mtimeMs });
      }
    } catch {
      // No result.json in this dir yet — fine.
    }
  }
  return out;
}

function toFileRef(entry: DirEntry): IoFileRef {
  return {
    task_id: entry.taskId,
    path: entry.filePath,
    written_at: new Date(entry.mtimeMs).toISOString(),
  };
}

/**
 * Atomic JSON write — same pattern the protocol layer uses for derive/execute
 * payloads. Keeps result.json from being read mid-write.
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

/* -------------------------------------------------------------------------- */
/*  Soft import of context-refresh                                            */
/* -------------------------------------------------------------------------- */

async function tryRefreshContext(): Promise<boolean> {
  try {
    const mod = (await import('@/main/io/context-refresh')) as {
      refreshContext?: () => Promise<void>;
    };
    if (typeof mod.refreshContext === 'function') {
      await mod.refreshContext();
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const ingestBodySchema = z
  .object({
    refresh_context: z.boolean().optional(),
  })
  .partial();

/**
 * Body schema for `POST /api/io/results`. Mirrors `SubmitResultBody` in the
 * shared API contract; the file content written is exactly `result` (validated
 * against `executionResultSchema`).
 */
const submitResultBodySchema = z.object({
  task_id: taskIdSchema,
  result: executionResultSchema,
  output_files: z.array(z.string().max(4_096)).max(1_024).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function ioRouter(): Router {
  const router = Router();

  // GET /api/io/pending ----------------------------------------------------
  router.get(
    '/pending',
    asyncHandler(async (_req, res) => {
      const [derive, execute] = await Promise.all([
        listJsonFiles(IO_DERIVE),
        listJsonFiles(IO_EXECUTE),
      ]);
      const body: IoPendingResponse = {
        derive: derive.map(toFileRef),
        execute: execute.map(toFileRef),
      };
      res.json(body);
    }),
  );

  // GET /api/io/results ----------------------------------------------------
  router.get(
    '/results',
    asyncHandler(async (_req, res) => {
      const [derived, results] = await Promise.all([
        listJsonFiles(IO_DERIVED),
        listResultFiles(),
      ]);
      const body: IoResultsResponse = {
        derived: derived.map(toFileRef),
        results: results.map(toFileRef),
      };
      res.json(body);
    }),
  );

  // POST /api/io/ingest ----------------------------------------------------
  // Force the active watcher to re-dispatch every file under its watched
  // roots. We delegate to the watcher (single source of truth for ingestion
  // wiring) rather than duplicating the scan-and-dispatch logic here.
  router.post(
    '/ingest',
    validateBody(ingestBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof ingestBodySchema>;

      // Count files before / after as best-effort instrumentation. We can't
      // get an exact "ingested" count out of the watcher without further
      // wiring (its handlers don't return per-file results), so we report
      // total files seen as both scanned and ingested. The numbers exist
      // mostly so the UI can render a "did anything happen?" message.
      const [derivedBefore, resultBefore, inboxBefore] = await Promise.all([
        listJsonFiles(IO_DERIVED),
        listResultFiles(),
        listJsonFiles(IO_INBOX),
      ]);
      const scanned =
        derivedBefore.length + resultBefore.length + inboxBefore.length;

      try {
        await triggerRescan();
      } catch (err: unknown) {
        // If the watcher isn't running, surface a clean error rather than
        // crashing — the UI can retry later.
        throw new ApiHttpError(
          503,
          'watcher_unavailable',
          err instanceof Error ? err.message : 'watcher rescan failed',
        );
      }

      if (body.refresh_context) {
        await tryRefreshContext();
      }

      const response: IoIngestResponse = {
        ok: true,
        scanned,
        ingested: scanned,
      };
      res.json(response);
    }),
  );

  // POST /api/io/results ---------------------------------------------------
  // Accept an ExecutionResult from a non-filesystem client (the renderer's
  // Execution view, MCP-over-HTTP, future tools). The request body MUST be
  // validated against `executionResultSchema`; the task id is validated
  // separately so we get a clean 400 on a malformed id.
  router.post(
    '/results',
    validateBody(submitResultBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof submitResultBodySchema>;

      // Double-check the body.task_id matches result.task_id so the file we
      // write can never disagree with the directory it lands in.
      if (body.result.task_id !== body.task_id) {
        throw new ApiHttpError(
          400,
          'task_id_mismatch',
          'body.task_id and body.result.task_id must match',
        );
      }

      // Write atomically to the per-task results directory. `outputDir`
      // validates the task id via `safeJoin`.
      const dest = resultPath(body.task_id);
      const outDir = outputDir(body.task_id);
      await fs.mkdir(outDir, { recursive: true });
      await writeJsonAtomic(dest, body.result);

      // Ingest synchronously. This is cleaner than firing-and-hoping the
      // watcher picks it up — the caller gets a deterministic response with
      // the task in its post-ingest state.
      const outputs = await listOutputFiles(body.task_id);
      try {
        await ingestResult(body.task_id, body.result, outputs);
      } catch (err: unknown) {
        // Ingestion failures shouldn't lose the file (already on disk), but
        // they should be visible to the caller.
        throw new ApiHttpError(
          500,
          'ingest_failed',
          err instanceof Error ? err.message : 'ingestion failed',
        );
      }

      const response: SubmitResultResponse = {
        ok: true,
        task_id: body.task_id,
        result_path: dest,
      };
      res.status(201).json(response);
    }),
  );

  // GET /api/io/status -----------------------------------------------------
  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const [inbox, derive, derived, execute, results, review, invalid] =
        await Promise.all([
          countDir(IO_INBOX),
          countDir(IO_DERIVE),
          countDir(IO_DERIVED),
          countDir(IO_EXECUTE),
          countResults(),
          countDir(IO_REVIEW),
          countDir(IO_INVALID),
        ]);

      const body: IoStatusResponse = {
        watcher: getWatcherState(),
        counts: { inbox, derive, derived, execute, results, review, invalid },
      };
      res.json(body);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Helpers used inside the router                                            */
/* -------------------------------------------------------------------------- */

async function countDir(dir: string): Promise<number> {
  const entries = await safeReadDir(dir);
  return entries.filter((e) => e.endsWith('.json') && !e.endsWith('.tmp')).length;
}

async function countResults(): Promise<number> {
  const taskDirs = await safeReadDir(IO_RESULTS);
  let count = 0;
  for (const taskId of taskDirs) {
    if (!isValidTaskId(taskId)) continue;
    let candidate: string;
    try {
      candidate = resultPath(taskId);
    } catch {
      continue;
    }
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) count += 1;
    } catch {
      // skip
    }
  }
  return count;
}

async function listOutputFiles(taskId: string): Promise<string[]> {
  let dir: string;
  try {
    dir = outputDir(taskId);
  } catch {
    // Invalid task id — no output files by definition.
    return [];
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}
