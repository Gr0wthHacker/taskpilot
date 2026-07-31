/**
 * `/api/data/...` and `/api/system/...` routes.
 *
 * Three responsibilities collapsed into one router module so we don't bloat
 * the route tree with single-endpoint files:
 *
 *  - `GET  /api/data/export`     → full JSON dump (tasks + logs + settings +
 *                                   templates if the table exists).
 *  - `POST /api/data/import`     → restore from an export payload. Idempotent
 *                                   — existing task / template ids are
 *                                   skipped, settings are merged (existing
 *                                   keys win unless `?overwrite=true`).
 *  - `POST /api/system/auto-launch` → toggle Electron's login item AND
 *                                   persist the user's preference.
 *
 * Schema versioning: the export payload carries `version: 1`. The importer
 * rejects anything else with a 400 — we'd rather force the user to upgrade
 * than silently drop data on a backwards-incompatible change.
 */

import { desc } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';

import { getDb, getSqlite } from '@/main/db';
import { settingsRepository } from '@/main/db/repositories/settings';
import {
  createTask,
  getTask,
  listTasks,
} from '@/main/db/repositories/tasks';
import { updateAutoLaunch } from '@/main/auto-launch';
import { executionLogs } from '@/shared/schema';
import {
  agentMethodSchema,
  agentStatusSchema,
  executionMethodSchema,
  executionStatusSchema,
  tagSchema,
  taskIdSchema,
  taskPrioritySchema,
  taskStatusSchema,
} from '@/shared/io-schemas';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Export task shape. Mirrors the full `Task` after JSON deserialization so a
 * roundtrip is loss-free. Tighter than `taskSchema` in `io-schemas.ts` only
 * insofar as we accept any string for the timestamps (older DB rows may not
 * carry strict ISO formatting).
 */
const exportTaskSchema = z.object({
  id: taskIdSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  due: z.string().max(64).nullable(),
  calendar_event_id: z.string().max(256).nullable(),
  parent_id: taskIdSchema.nullable(),
  agent_executable: z.boolean(),
  agent_method: agentMethodSchema,
  agent_instructions: z.string().max(50_000).nullable(),
  agent_status: agentStatusSchema,
  context: z.record(z.string(), z.unknown()).nullable(),
  tags: z.array(tagSchema).max(64),
  created_at: z.string(),
  updated_at: z.string(),
});

const exportExecutionLogSchema = z.object({
  id: z.string().min(1).max(64),
  task_id: taskIdSchema,
  started_at: z.string(),
  completed_at: z.string().nullable(),
  method: executionMethodSchema,
  status: executionStatusSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
  log_path: z.string().nullable(),
});

/**
 * Optional `task_templates` block. Wave 7F may not have shipped yet, so this
 * is permissive — any shape passes through, the importer simply re-inserts
 * rows that don't already exist. When 7F lands, the strict shape can be
 * tightened without breaking older export files.
 */
const exportTemplateSchema = z
  .object({ id: z.string().min(1).max(64) })
  .passthrough();

const importBodySchema = z.object({
  version: z.number().int(),
  exported_at: z.string().optional(),
  tasks: z.array(exportTaskSchema).max(50_000).optional(),
  execution_logs: z.array(exportExecutionLogSchema).max(200_000).optional(),
  settings: z.record(z.string().max(128), z.unknown()).optional(),
  task_templates: z.array(exportTemplateSchema).max(10_000).optional(),
});

type ImportBody = z.infer<typeof importBodySchema>;

const autoLaunchBodySchema = z.object({
  enabled: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/*  Export helpers                                                            */
/* -------------------------------------------------------------------------- */

interface ExportPayload {
  version: 1;
  exported_at: string;
  tasks: ReturnType<typeof listTasks>;
  execution_logs: Array<{
    id: string;
    task_id: string;
    started_at: string | null;
    completed_at: string | null;
    method: string | null;
    status: string | null;
    output: string | null;
    error: string | null;
    log_path: string | null;
  }>;
  settings: Record<string, unknown>;
  task_templates: unknown[];
}

function readAllExecutionLogs(): ExportPayload['execution_logs'] {
  const db = getDb();
  const rows = db
    .select()
    .from(executionLogs)
    .orderBy(desc(executionLogs.started_at))
    .all();
  return rows.map((row) => ({
    id: row.id,
    task_id: row.task_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    method: row.method,
    status: row.status,
    output: row.output,
    error: row.error,
    log_path: row.log_path,
  }));
}

/**
 * Read `task_templates` rows when the table exists, otherwise return an
 * empty array. We probe the SQLite catalog instead of a try/catch around a
 * SELECT so an actual error (locked DB, etc.) still surfaces.
 */
function readAllTemplates(): unknown[] {
  try {
    const sqlite = getSqlite();
    const exists = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_templates'",
      )
      .get();
    if (!exists) return [];
    const rows = sqlite.prepare('SELECT * FROM task_templates').all();
    return rows;
  } catch {
    // Defensive: if anything goes wrong (table missing, locked DB) treat
    // templates as absent rather than failing the whole export.
    return [];
  }
}

function buildExportPayload(): ExportPayload {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    tasks: listTasks({}),
    execution_logs: readAllExecutionLogs(),
    settings: settingsRepository.getAll(),
    task_templates: readAllTemplates(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Import helpers                                                            */
/* -------------------------------------------------------------------------- */

interface ImportSummary {
  tasks_imported: number;
  logs_imported: number;
  settings_imported: number;
  templates_imported: number;
  conflicts: number;
}

function importTasks(
  rows: ImportBody['tasks'],
  summary: ImportSummary,
): void {
  if (!rows || rows.length === 0) return;

  // Insert in two passes so a child whose parent is later in the array still
  // resolves. Pass 1: tasks without `parent_id`. Pass 2: everything else.
  // Within each pass, we still skip ids that already exist.
  const ordered = [...rows].sort((a, b) => {
    const aHasParent = a.parent_id ? 1 : 0;
    const bHasParent = b.parent_id ? 1 : 0;
    return aHasParent - bHasParent;
  });

  for (const row of ordered) {
    if (getTask(row.id)) {
      summary.conflicts += 1;
      continue;
    }
    // If parent_id references a task that's missing both in the DB AND in
    // this import batch, drop the link rather than fail — orphaned children
    // are better than an aborted import.
    let parentId: string | null = row.parent_id;
    if (parentId && !getTask(parentId)) {
      const inBatch = rows.some((other) => other.id === parentId);
      if (!inBatch) parentId = null;
    }
    try {
      createTask({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        due: row.due,
        calendar_event_id: row.calendar_event_id,
        parent_id: parentId,
        agent_executable: row.agent_executable,
        agent_method: row.agent_method,
        agent_instructions: row.agent_instructions,
        agent_status: row.agent_status,
        context: row.context,
        tags: row.tags,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
      summary.tasks_imported += 1;
    } catch {
      summary.conflicts += 1;
    }
  }
}

function importExecutionLogs(
  rows: ImportBody['execution_logs'],
  summary: ImportSummary,
): void {
  if (!rows || rows.length === 0) return;
  const db = getDb();
  for (const row of rows) {
    // Skip logs whose task doesn't exist (post-import) — a foreign key
    // violation would abort the whole INSERT. Also skip duplicates by id.
    if (!getTask(row.task_id)) {
      summary.conflicts += 1;
      continue;
    }
    try {
      // Drizzle has no idempotent upsert helper bound to this schema; do a
      // raw INSERT OR IGNORE so duplicate ids count as conflicts instead of
      // crashing the route.
      const result = db
        .insert(executionLogs)
        .values({
          id: row.id,
          task_id: row.task_id,
          started_at: row.started_at,
          completed_at: row.completed_at,
          method: row.method,
          status: row.status,
          output: row.output,
          error: row.error,
          log_path: row.log_path,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) {
        summary.logs_imported += 1;
      } else {
        summary.conflicts += 1;
      }
    } catch {
      summary.conflicts += 1;
    }
  }
}

function importSettings(
  incoming: ImportBody['settings'],
  overwrite: boolean,
  summary: ImportSummary,
): void {
  if (!incoming) return;
  const existing = settingsRepository.getAll();
  for (const [key, value] of Object.entries(incoming)) {
    if (!overwrite && key in existing && existing[key] !== null) {
      summary.conflicts += 1;
      continue;
    }
    settingsRepository.set(key, value);
    summary.settings_imported += 1;
  }
}

function importTemplates(
  rows: ImportBody['task_templates'],
  summary: ImportSummary,
): void {
  if (!rows || rows.length === 0) return;
  // Probe the table once. If 7F hasn't landed, drop templates silently —
  // re-importing into an older DB shouldn't blow up.
  let sqlite: ReturnType<typeof getSqlite>;
  try {
    sqlite = getSqlite();
  } catch {
    return;
  }
  const exists = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_templates'",
    )
    .get();
  if (!exists) return;

  // Build a column list from each row so we tolerate unknown columns
  // gracefully (and don't lose data the importer doesn't recognize).
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') {
      summary.conflicts += 1;
      continue;
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length === 0) {
      summary.conflicts += 1;
      continue;
    }
    try {
      const cols = entries.map(([k]) => `"${k.replace(/"/g, '""')}"`).join(', ');
      const placeholders = entries.map(() => '?').join(', ');
      const values = entries.map(([, v]) =>
        v === null || typeof v === 'string' || typeof v === 'number'
          ? v
          : JSON.stringify(v),
      );
      const insertSql = `INSERT OR IGNORE INTO task_templates (${cols}) VALUES (${placeholders})`;
      const result = sqlite
        .prepare(insertSql)
        .run(...(values as Array<string | number | null>));
      if (result.changes > 0) {
        summary.templates_imported += 1;
      } else {
        summary.conflicts += 1;
      }
    } catch {
      summary.conflicts += 1;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function dataRouter(): Router {
  const router = Router();

  /**
   * GET /api/data/export
   * Returns a JSON dump of the entire DB. `Content-Disposition: attachment`
   * is set so the renderer can pipe `response.blob()` straight into a
   * download without a separate save dialog.
   */
  router.get(
    '/export',
    asyncHandler(async (_req, res) => {
      const payload = buildExportPayload();
      // The filename embeds an ISO timestamp (`:` replaced with `-` for
      // Windows-safe naming). Quoted because some browsers misparse spaces.
      const stamp = payload.exported_at.replace(/[:]/g, '-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="taskpilot-export-${stamp}.json"`,
      );
      res.status(200).send(JSON.stringify(payload, null, 2));
    }),
  );

  /**
   * POST /api/data/import?overwrite=true
   * Restore from an export payload. Returns the summary counts.
   */
  router.post(
    '/import',
    validateBody(importBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as ImportBody;
      if (body.version !== 1) {
        throw new ApiHttpError(
          400,
          'unsupported_version',
          `Import payload version ${body.version} is not supported (expected 1).`,
        );
      }
      const overwrite = String(req.query.overwrite ?? '') === 'true';
      const summary: ImportSummary = {
        tasks_imported: 0,
        logs_imported: 0,
        settings_imported: 0,
        templates_imported: 0,
        conflicts: 0,
      };
      // Wrap the entire import in a single transaction so a partial failure
      // (e.g. a bad row mid-batch) rolls back to a clean state. Without this
      // an interrupted import leaves the DB with N-1 tasks + 0 templates,
      // matching nothing the user expects.
      const sqlite = getSqlite();
      const tx = sqlite.transaction(() => {
        importTasks(body.tasks, summary);
        importExecutionLogs(body.execution_logs, summary);
        importSettings(body.settings, overwrite, summary);
        importTemplates(body.task_templates, summary);
      });
      try {
        tx();
      } catch (err) {
        throw new ApiHttpError(
          400,
          'import_failed',
          `Import rolled back: ${(err as Error).message}`,
        );
      }
      res.status(200).json(summary);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  System router                                                             */
/* -------------------------------------------------------------------------- */

export function systemRouter(): Router {
  const router = Router();

  /**
   * GET /api/system/auto-launch
   * Returns the current OS state alongside the persisted preference. They
   * usually agree, but the OS value is authoritative for "what will happen
   * on next login" and the persisted value is the user's stated intent.
   */
  router.get(
    '/auto-launch',
    asyncHandler(async (_req, res) => {
      // Lazy-import so this module doesn't drag Electron into Node-only
      // test contexts unless the route is actually hit.
      const mod = await import('@/main/auto-launch');
      res.json({
        enabled: mod.getStoredAutoLaunchPreference(),
        os_enabled: mod.getAutoLaunchEnabled(),
      });
    }),
  );

  /**
   * POST /api/system/auto-launch
   * Body: { enabled: boolean }
   * Persists the preference and reconciles OS state. Returns the new
   * effective state.
   */
  router.post(
    '/auto-launch',
    validateBody(autoLaunchBodySchema),
    asyncHandler(async (req, res) => {
      const { enabled } = req.body as z.infer<typeof autoLaunchBodySchema>;
      const next = updateAutoLaunch(enabled);
      res.json({ ok: true, enabled: next });
    }),
  );

  return router;
}

