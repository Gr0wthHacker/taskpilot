/**
 * `/api/tasks/...` routes.
 *
 * Thin wrappers over the tasks repository plus the I/O protocol writers. The
 * server itself is stateless — every endpoint reads/writes the DB or filesystem
 * through the same APIs the CLI uses.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';
import { z } from 'zod';

import {
  agentMethodSchema,
  agentStatusSchema,
  derivativeProposalSchema,
  phaseIdSchema,
  tagSchema,
  taskIdSchema,
  taskPrioritySchema,
  taskStatusSchema,
} from '@/shared/io-schemas';
import {
  PHASE_CONTEXT_KEY,
  PIPELINE_CONTEXT_KEY,
  resolvePipelineForTask,
} from '@/main/phases';
import { isAgentPaused } from '@/main/auto-execute';
import { buildDerivationMemory, findSimilarDoneTasks } from '@/main/derive-memory';
import { summarizeRejections } from '@/main/feedback';
import {
  applyProfile,
  buildContextWithPermissions,
  resolvePermissions,
} from '@/main/permissions';
import {
  buildSkillsInstructionsBlock,
  skillHintsForTask,
} from '@/main/skill-binding';
import { buildKnowledgeBlock } from '@/main/knowledge';
import { settingsRepository } from '@/main/db/repositories/settings';
import type { PermissionProfileName } from '@/shared/types';
import {
  archiveTask,
  createTask,
  deleteTask,
  getChildren,
  getTask,
  listTasks,
  listTasksPage,
  MAX_PAGE_LIMIT,
  unarchiveTask,
  updateTask,
} from '@/main/db/repositories/tasks';
import { contextPath, outputDir, reviewPath } from '@/main/io/paths';
import {
  writeDeriveRequest,
  writeExecuteRequest,
} from '@/main/io/protocol';
import type {
  ApproveTaskResponse,
  CreateTaskResponse,
  DeleteTaskResponse,
  DeriveTaskResponse,
  ExecuteTaskResponse,
  GetTaskResponse,
  RejectTaskResponse,
  ScheduleTaskResponse,
  UpdateTaskResponse,
} from '@/shared/api-contract';
import type {
  AgentStatus,
  Task,
  TaskFilter,
  TaskStatus,
} from '@/shared/types';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Coerce a string-or-boolean query param into a boolean. Express stores all
 * query params as strings, so `agent_only=true` arrives as `"true"`.
 */
const booleanStringSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  parent: taskIdSchema.optional(),
  agent_only: booleanStringSchema.optional(),
  // Tag filter must match the strict tag alphabet so we never substring-match
  // arbitrary LIKE patterns into the JSON-encoded tags column (see S4 in the
  // server fix-list and `tasksRepository.listTasks`).
  tag: tagSchema.optional(),
  include_archived: booleanStringSchema.optional(),
  include_cancelled: booleanStringSchema.optional(),
  // Pagination + projection (S-scale wave): keep callers honest about page
  // size so a misbehaving renderer can't ask for 30k rows in one shot.
  limit: z
    .union([z.number(), z.string().regex(/^\d{1,6}$/)])
    .transform((v) => (typeof v === 'string' ? parseInt(v, 10) : v))
    .optional(),
  // Opaque cursor — base64-url decoded inside the repo. We let any string
  // through here and treat unparseable values as "no cursor" rather than 400,
  // so a stale link doesn't break the renderer.
  cursor: z.string().min(1).max(200).optional(),
  fields: z.enum(['full', 'summary']).optional(),
});

/**
 * Recurrence rule schema — matches `RecurrenceRule` in `shared/types.ts`.
 * Used to validate the embedded rule inside `context.recurrence` on
 * create/update; we don't store this as a separate field, but we do want to
 * 400 if the client sends garbage shape.
 */
const recurrenceRuleSchema = z.object({
  kind: z.enum(['daily', 'weekdays', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(366).optional(),
  end_after_count: z.number().int().min(1).max(10_000).optional(),
  end_on: z.string().max(64).optional(),
  occurrences_completed: z.number().int().min(0).max(10_000).optional(),
});

/**
 * Body schema for `POST /api/tasks`. Mirrors `CreateTaskInput` but as a Zod
 * shape so we get 400s on bad payloads.
 *
 * String fields are capped so an unbounded payload can't blow up SQLite or
 * the renderer. Task ids are constrained to the nanoid alphabet so they
 * never escape their parent directory when joined into a path.
 */
const createTaskBodySchema = z.object({
  id: taskIdSchema.optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  due: z.string().max(64).nullable().optional(),
  calendar_event_id: z.string().max(256).nullable().optional(),
  parent_id: taskIdSchema.nullable().optional(),
  agent_executable: z.boolean().optional(),
  agent_method: agentMethodSchema.optional(),
  agent_instructions: z.string().max(50_000).nullable().optional(),
  agent_status: agentStatusSchema.optional(),
  context: z.record(z.string().max(128), z.unknown()).nullable().optional(),
  tags: z.array(tagSchema).max(64).optional(),
  /**
   * Optional convenience field — if supplied, the recurrence rule is folded
   * into `context.recurrence` before insertion. The repository doesn't have
   * a dedicated column; this keeps the wire format ergonomic without
   * changing storage.
   */
  recurrence: recurrenceRuleSchema.nullable().optional(),
  /**
   * Optional phase id (Wave 15). When provided, stamped onto
   * `context.phase`. The phase isn't validated against a specific pipeline
   * at create time — the resolver picks the right pipeline on read.
   */
  phase: phaseIdSchema.nullable().optional(),
  /**
   * Optional explicit pipeline binding (Wave 15). When provided, stamped
   * onto `context.pipeline_id` so the resolver pins this task to that
   * pipeline regardless of tag/workspace matching.
   */
  pipeline_id: phaseIdSchema.nullable().optional(),
});

const updateTaskBodySchema = createTaskBodySchema.partial().extend({
  title: z.string().min(1).max(500).optional(),
});

const approveBodySchema = z.object({
  kind: z.enum(['derivation', 'result']),
  edits: z.array(derivativeProposalSchema).optional(),
});

const rejectBodySchema = z.object({
  kind: z.enum(['derivation', 'result']),
  reason: z.string().max(2_000).optional(),
  requeue: z.boolean().optional(),
});

/**
 * Body schema for `POST /api/tasks/:id/schedule`. Every field is optional —
 * with no body the handler auto-picks via `proposeSchedule`.
 *
 * `start` accepts any ISO 8601 string; we re-parse and validate in the
 * handler so we can return a helpful 400 rather than a generic Zod failure.
 */
const scheduleBodySchema = z
  .object({
    start: z.string().min(1).max(64).optional(),
    duration_minutes: z.number().int().min(5).max(24 * 60).optional(),
    calendar_id: z.string().min(1).max(256).optional(),
  })
  .partial();

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reject any path param that doesn't match the canonical task-id regex.
 * Returns a 400 rather than a 404 so the caller knows it's a malformed
 * request, not a missing resource. Defense in depth against path-traversal
 * tokens like `../../../tokens`.
 */
function assertValidId(id: string): void {
  const parsed = taskIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${id}`);
  }
}

function requireTask(id: string): Task {
  assertValidId(id);
  const task = getTask(id);
  if (!task) {
    throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
  }
  return task;
}

/**
 * Read the `default_permission_profile` setting and coerce to a known
 * profile name. Returns `null` when the setting is missing or invalid so
 * callers can skip seeding rather than fail loudly.
 */
function readDefaultPermissionProfile(): PermissionProfileName | null {
  try {
    const raw = settingsRepository.get('default_permission_profile');
    if (typeof raw !== 'string') return null;
    if (
      raw === 'trusted-local' ||
      raw === 'sandboxed' ||
      raw === 'read-only-research' ||
      raw === 'github-pr'
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Coerce a setting value (which may be stored as a real boolean, the string
 * `"true"`/`"false"`, or a 0/1 number) into a typed boolean with a default.
 */
function settingBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = settingsRepository.get(key);
    if (raw === null || raw === undefined) return defaultValue;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
    }
    if (typeof raw === 'number') return raw !== 0;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Append a `PERMISSIONS` block to the instructions string Claude reads so
 * the resolved permission set rides alongside the human-authored guidance.
 * We use the existing `instructions` slot (rather than a new schema field)
 * to keep the I/O contract backward-compatible. Format:
 *
 *   <existing instructions...>
 *
 *   ---PERMISSIONS---
 *   { ...resolved PermissionSet as JSON... }
 *
 * The resolved set is ALSO mirrored into `context.permissions` on execute
 * requests (see the execute handler), so an agent that ignores the
 * instructions block can still find it programmatically.
 */
function appendPermissionsBlock(
  base: string | undefined,
  permissions: import('@/shared/types').PermissionSet,
): string {
  const head = base?.trim() ?? '';
  const block = [
    '---PERMISSIONS---',
    'Before any Read/Write/Bash/network call, check this resolved permission',
    'set and refuse anything that would violate it. Surface the conflict to',
    'the user rather than escalating.',
    JSON.stringify(permissions, null, 2),
  ].join('\n');
  return head.length === 0 ? block : `${head}\n\n${block}`;
}

/**
 * Append the intelligence-layer instruction blocks to a base instructions
 * string: bound skills, suggested skills, and (for derive requests only)
 * memory of similar past derivations. All best-effort — any failure here
 * returns the base string unchanged so we never break a request.
 *
 * @param base - existing instruction text, may be empty
 * @param task - source task; used to look up bindings + suggestions
 * @param includeMemory - when true (derive flow), also fold in
 *   {@link buildDerivationMemory}; we skip it on execute because the
 *   memory is about decomposition, not action.
 */
function appendIntelligenceBlocks(
  base: string,
  task: import('@/shared/types').Task,
  includeMemory: boolean,
): {
  instructions: string;
  memoryCount: number;
  skillHintsCount: number;
  rejectionsCount: number;
} {
  let out = base.trim();
  let memoryCount = 0;
  let skillHintsCount = 0;
  let rejectionsCount = 0;

  try {
    const skillsBlock = buildSkillsInstructionsBlock(task);
    if (skillsBlock.length > 0) {
      out = out.length === 0 ? skillsBlock : `${out}\n\n${skillsBlock}`;
      skillHintsCount = skillHintsForTask(task).length;
    }
  } catch {
    /* non-fatal */
  }

  // Knowledge base: semantically-matched local resources (decks, PDFs, docs)
  // scoped to the task's business. Works for both derive + execute.
  try {
    const knowledgeBlock = buildKnowledgeBlock(task);
    if (knowledgeBlock.length > 0) {
      out = out.length === 0 ? knowledgeBlock : `${out}\n\n${knowledgeBlock}`;
    }
  } catch {
    /* non-fatal */
  }

  if (includeMemory) {
    try {
      const memory = buildDerivationMemory(task, 5);
      memoryCount = memory.count;
      if (memory.block.length > 0) {
        const wrapper = [
          '---DERIVATION-MEMORY---',
          'Previously you decomposed similar tasks like this — here are examples.',
          'Reuse what worked. Adapt the decomposition pattern to this task.',
          '',
          memory.block,
        ].join('\n');
        out = out.length === 0 ? wrapper : `${out}\n\n${wrapper}`;
      }
    } catch {
      /* non-fatal */
    }

    // Wave 13: past rejections from similar tasks. Pulled separately from
    // the memory block because rejections live in a different table and
    // we want the prompt to call them out as "things to avoid" not "things
    // to mimic".
    try {
      const matches = findSimilarDoneTasks(task, 5);
      const block = summarizeRejections(matches.map((m) => m.task));
      if (block.length > 0) {
        const wrapper = ['---PAST-REJECTIONS---', '', block].join('\n');
        out = out.length === 0 ? wrapper : `${out}\n\n${wrapper}`;
        // Count bullet lines in the block as a proxy for surfaced rejections.
        rejectionsCount = (block.match(/^- "/gm) ?? []).length;
      }
    } catch {
      /* non-fatal */
    }
  }

  return {
    instructions: out,
    memoryCount,
    skillHintsCount,
    rejectionsCount,
  };
}

/**
 * Fire a derive request automatically when a top-level agent-capable task is
 * created. Best-effort — never throws into the create-task response. Skip
 * conditions are documented at the call site.
 *
 * Special case (ambient monitor): when `task.context.deliberation_target` is
 * `true`, the task represents a "watch what I'm doing" capture — instead of
 * a normal derive we route to the deliberation orchestrator and stamp the
 * resulting `batch_id` back onto the task so the renderer can link the row.
 */
async function maybeAutoDerive(task: Task): Promise<void> {
  if (task.parent_id) return;                        // never derive a child
  if (isAgentPaused()) return;                       // global kill switch
  if (!settingBool('auto_derive_enabled', true)) return;

  // Watch-observation task — divert to deliberation. Checked BEFORE the
  // `human_only` skip so the ambient monitor can create deliberation-target
  // tasks without having to know about `agent_method`. The context flag rides
  // inside the freeform context bag, not a column on the task.
  if (isDeliberationTarget(task)) {
    await routeToDeliberation(task);
    return;
  }

  if (task.agent_method === 'human_only') return;    // user explicitly opts out

  const calendar_snapshot = await readCalendarSnapshot();
  const related_tasks = findRelatedTasks(task);
  const permissions = resolvePermissions(task);
  const baseInstructions = appendPermissionsBlock(undefined, permissions);
  const enriched = appendIntelligenceBlocks(baseInstructions, task, true);
  const skillNames = skillHintsForTask(task);
  await writeDeriveRequest(task, {
    calendar_snapshot,
    related_tasks,
    available_tools: ['cowork', 'cli', ...skillNames],
    execution_modes: ['cowork', 'cli'],
    instructions: enriched.instructions,
  });
  updateTask(task.id, { agent_status: 'assigned' });
}

/**
 * Identify a watch-observation task. The ambient monitor (and the renderer)
 * marks the task with `context.deliberation_target === true` plus, optionally,
 * the `observation_ids` array to bundle.
 */
function isDeliberationTarget(task: Task): boolean {
  const ctx = task.context;
  if (!ctx || typeof ctx !== 'object') return false;
  return (
    (ctx as Record<string, unknown>)['deliberation_target'] === true
  );
}

/**
 * Extract `observation_ids` (string[]) from `task.context` defensively. Returns
 * an empty array when the field is absent or malformed — the orchestrator will
 * then pull the most recent unbatched observations.
 */
function readObservationIds(task: Task): string[] {
  const ctx = task.context;
  if (!ctx || typeof ctx !== 'object') return [];
  const raw = (ctx as Record<string, unknown>)['observation_ids'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Route a watch-observation task into the deliberation orchestrator and stamp
 * the resulting batch id back onto the task's context bag.
 */
async function routeToDeliberation(task: Task): Promise<void> {
  // Lazy import so the auto-derive path stays loosely coupled to the
  // deliberation module (the rest of the tasks route doesn't pull it in).
  const { requestDeliberation } = await import('@/main/deliberation/orchestrator');
  const observation_ids = readObservationIds(task);
  try {
    const outcome = await requestDeliberation({
      observation_ids: observation_ids.length > 0 ? observation_ids : undefined,
      trigger_reason: 'manual',
    });
    const baseCtx =
      task.context && typeof task.context === 'object'
        ? (task.context as Record<string, unknown>)
        : {};
    updateTask(task.id, {
      context: {
        ...baseCtx,
        deliberation_batch_id: outcome.batch_id,
      },
      agent_status: 'assigned',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[taskpilot:api] watch-observation deliberation failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Read the cached calendar snapshot from disk. The context-refresh subsystem
 * writes this every few minutes; if it hasn't run yet we fall back to a stub
 * so derivations still go out the door.
 */
async function readCalendarSnapshot(): Promise<string> {
  try {
    const raw = await fs.readFile(contextPath('calendar'), 'utf8');
    return raw;
  } catch {
    return JSON.stringify({ events: [], note: 'calendar snapshot unavailable' });
  }
}

/**
 * Find tasks that share at least one tag with the source task. Used to build
 * the `related_tasks` field of a derivation request without making Claude
 * guess what else is in flight.
 */
function findRelatedTasks(task: Task): string[] {
  if (task.tags.length === 0) return [];
  const all = listTasks({ limit: 200 });
  const related: string[] = [];
  for (const candidate of all) {
    if (candidate.id === task.id) continue;
    if (candidate.tags.some((t) => task.tags.includes(t))) {
      related.push(candidate.id);
    }
  }
  return related;
}

/**
 * Resolve the parent outputs map for an execution request. Each direct parent
 * (and any task listed in `context.depends_on`) contributes the list of files
 * inside its `output/` directory.
 */
async function resolveParentOutputs(
  task: Task,
): Promise<Record<string, string[]>> {
  const parentIds = new Set<string>();
  if (task.parent_id) parentIds.add(task.parent_id);

  if (task.context && typeof task.context === 'object') {
    const dependsOn = (task.context as Record<string, unknown>)['depends_on'];
    if (Array.isArray(dependsOn)) {
      for (const dep of dependsOn) {
        if (typeof dep === 'string' && dep.length > 0) parentIds.add(dep);
      }
    }
  }

  const out: Record<string, string[]> = {};
  for (const parentId of parentIds) {
    const dir = outputDir(parentId);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      out[parentId] = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      out[parentId] = [];
    }
  }
  return out;
}

/**
 * Best-effort removal of the per-task review marker file. Non-fatal —
 * the DB is the source of truth.
 */
async function clearReviewMarker(taskId: string): Promise<void> {
  try {
    await fs.unlink(reviewPath(taskId));
  } catch {
    /* missing is fine */
  }
}

/**
 * Apply approval semantics for a derivation. The ingestion layer has already
 * created the child rows in `pending` state; approval flips them to `queued`
 * and marks the parent's `agent_status` as `succeeded` so it disappears from
 * the review queue.
 */
function approveDerivation(task: Task): Task {
  // Children were created by ingestion in `queued` + `pending` state already.
  // We re-affirm queued here (and only here — terminal states like done/failed
  // are left alone) so a partially-applied prior approval/rejection cycle
  // doesn't leave anything stranded.
  const children = getChildren(task.id);
  const promotable: ReadonlyArray<TaskStatus> = ['inbox', 'queued', 'blocked'];
  for (const child of children) {
    if (promotable.includes(child.status)) {
      updateTask(child.id, { status: 'queued' });
    }
  }
  const updated = updateTask(task.id, { agent_status: 'succeeded' });
  return updated ?? task;
}

/**
 * Apply approval semantics for an execution result: the work is accepted and
 * the task is marked done.
 */
function approveResult(task: Task): Task {
  const updated = updateTask(task.id, {
    status: 'done',
    agent_status: 'succeeded',
  });
  return updated ?? task;
}

/**
 * Reject a pending derivation: delete every child created by ingestion and
 * reset the parent back to `inbox` so the user can re-derive (or take it
 * over by hand) without recreating the task.
 */
function rejectDerivation(task: Task): Task {
  const children = getChildren(task.id);
  for (const child of children) {
    deleteTask(child.id);
  }
  const updated = updateTask(task.id, {
    status: 'inbox',
    agent_status: 'pending',
  });
  return updated ?? task;
}

/**
 * Apply rejection semantics for a result/failure review. `requeue=true`
 * resets `agent_status` to `pending` so the user can re-execute without
 * recreating the task; otherwise the task is marked failed permanently.
 */
function rejectTask(
  task: Task,
  requeue: boolean | undefined,
): Task {
  if (requeue) {
    const updated = updateTask(task.id, { agent_status: 'pending' });
    return updated ?? task;
  }
  const failedStatus: TaskStatus = 'failed';
  const failedAgent: AgentStatus = 'failed';
  const updated = updateTask(task.id, {
    status: failedStatus,
    agent_status: failedAgent,
  });
  return updated ?? task;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function tasksRouter(): Router {
  const router = Router();

  // GET /api/tasks ----------------------------------------------------------
  router.get(
    '/',
    validateQuery(listTasksQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof listTasksQuerySchema>;
      const filter: TaskFilter = {};
      if (q.status !== undefined) filter.status = q.status;
      if (q.priority !== undefined) filter.priority = q.priority;
      if (q.parent !== undefined) filter.parent = q.parent;
      if (q.agent_only !== undefined) filter.agent_only = q.agent_only;
      if (q.tag !== undefined) filter.tag = q.tag;
      if (q.include_archived !== undefined) {
        filter.include_archived = q.include_archived;
      }
      if (q.include_cancelled !== undefined) {
        filter.include_cancelled = q.include_cancelled;
      }
      if (q.limit !== undefined) {
        // Hard ceiling: requesting more than MAX_PAGE_LIMIT is silently
        // clamped (the repo also clamps). We don't 400 so existing CLI
        // scripts that pass `?limit=2000` still work — they just get 200.
        filter.limit = Math.min(q.limit, MAX_PAGE_LIMIT);
      }
      if (q.cursor !== undefined) filter.cursor = q.cursor;
      if (q.fields !== undefined) filter.fields = q.fields;

      const page = listTasksPage(filter);
      // Both shapes serialize identically — the runtime payload either
      // includes the heavy columns or doesn't, and TypeScript discriminates
      // at the consumer based on the `fields` it requested.
      res.json({
        tasks: page.tasks,
        next_cursor: page.next_cursor,
      });
    }),
  );

  // GET /api/tasks/stats ---------------------------------------------------
  // Materialized counts by status. O(1) read off the singleton task_stats
  // row; refreshed by a slow background tick. See @/main/task-stats.
  router.get(
    '/stats',
    asyncHandler(async (_req, res) => {
      const { getTaskStats, recomputeTaskStats } = await import(
        '@/main/task-stats'
      );
      const stats = getTaskStats();
      // If the materialized row is stale (older than ~5s) recompute inline.
      // Reading the stale row is fine for the badge case, but a renderer
      // that just mutated something benefits from up-to-the-tick numbers.
      const ageMs = Date.now() - new Date(stats.updated_at).getTime();
      const fresh = ageMs < 5_000 ? stats : recomputeTaskStats();
      res.json({ stats: fresh });
    }),
  );

  // POST /api/tasks ---------------------------------------------------------
  router.post(
    '/',
    validateBody(createTaskBodySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof createTaskBodySchema>;
      // Fold the convenience `recurrence`, `phase`, and `pipeline_id` fields
      // into context. We strip them from the input we pass to the repo since
      // the repo doesn't model them separately.
      const { recurrence, phase, pipeline_id, ...rest } = input;
      const createInput: Parameters<typeof createTask>[0] = { ...rest };

      // Start with whatever context the caller supplied (or an empty object).
      const baseCtx = (rest.context && typeof rest.context === 'object'
        ? { ...(rest.context as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      let ctxDirty = rest.context !== undefined;

      if (recurrence !== undefined) {
        ctxDirty = true;
        if (recurrence === null) {
          delete baseCtx.recurrence;
        } else {
          baseCtx.recurrence = recurrence;
        }
      }

      // Wave 15: fold phase + pipeline_id into context. `null` clears.
      if (phase !== undefined) {
        ctxDirty = true;
        if (phase === null) {
          delete baseCtx[PHASE_CONTEXT_KEY];
        } else {
          baseCtx[PHASE_CONTEXT_KEY] = phase;
        }
      }
      if (pipeline_id !== undefined) {
        ctxDirty = true;
        if (pipeline_id === null) {
          delete baseCtx[PIPELINE_CONTEXT_KEY];
        } else {
          baseCtx[PIPELINE_CONTEXT_KEY] = pipeline_id;
        }
      }

      if (ctxDirty) {
        createInput.context =
          Object.keys(baseCtx).length === 0 ? null : baseCtx;
      }

      let task = createTask(createInput);

      // Wave 15: when no phase was supplied but a pipeline auto-matches
      // (by tag), seed the first phase. This makes the board's "group by
      // phase" view useful immediately for new tasks without forcing the
      // user to pick a phase by hand.
      try {
        if (phase === undefined) {
          const pipeline = resolvePipelineForTask(task);
          if (pipeline && pipeline.phases.length > 0 && !pipeline.default) {
            const seedPhase = pipeline.phases[0]!.id;
            const seededCtx =
              task.context && typeof task.context === 'object'
                ? { ...(task.context as Record<string, unknown>) }
                : {};
            seededCtx[PHASE_CONTEXT_KEY] = seedPhase;
            const updated = updateTask(task.id, { context: seededCtx });
            if (updated) task = updated;
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[taskpilot:api] phase seed failed:', err);
      }

      // Seed default permission profile when the user has one configured
      // and this task didn't ship explicit permissions of its own. Only
      // applies to top-level tasks — children inherit naturally via the
      // resolver. Best-effort: any failure here is logged and ignored.
      try {
        if (!task.parent_id) {
          const existingPerms =
            task.context &&
            typeof task.context === 'object' &&
            'permissions' in (task.context as Record<string, unknown>);
          if (!existingPerms) {
            const profile = readDefaultPermissionProfile();
            if (profile) {
              const seeded = applyProfile(profile, task.id);
              const nextCtx = buildContextWithPermissions(task.context, seeded);
              const updated = updateTask(task.id, { context: nextCtx });
              if (updated) task = updated;
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[taskpilot:api] permission seed failed:', err);
      }

      // Auto-derive: when a top-level task is created with an agent-capable
      // method, immediately drop a derive request so Claude (via MCP or the
      // io watcher) can propose sub-tasks without the user clicking through.
      // Skipped when:
      //   - the task has a parent_id (it IS a derivative — would infinite-loop)
      //   - agent_method is 'human_only' (user explicitly wants to do it)
      //   - the kill switch (`agent_paused`) is on
      //   - the user has opted out via the `auto_derive_enabled` setting
      try {
        await maybeAutoDerive(task);
      } catch (err) {
        // Never let auto-derive break the create response. Log and continue.
        // eslint-disable-next-line no-console
        console.warn('[taskpilot:api] auto-derive failed:', err);
      }

      const body: CreateTaskResponse = { task };
      res.status(201).json(body);
    }),
  );

  // GET /api/tasks/:id ------------------------------------------------------
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const task = requireTask(String(req.params.id));
      const body: GetTaskResponse = { task };
      res.json(body);
    }),
  );

  // PATCH /api/tasks/:id ----------------------------------------------------
  router.patch(
    '/:id',
    validateBody(updateTaskBodySchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const patch = req.body as z.infer<typeof updateTaskBodySchema>;
      const { recurrence, ...rest } = patch;
      const updateInput: Parameters<typeof updateTask>[1] = { ...rest };
      if (recurrence !== undefined) {
        // Merge against the existing task's context so we don't blow away
        // unrelated keys when the client only touches recurrence.
        const existing = getTask(id);
        const baseCtx = (rest.context !== undefined
          ? rest.context
          : existing?.context) ?? {};
        const ctxObj =
          baseCtx && typeof baseCtx === 'object'
            ? (baseCtx as Record<string, unknown>)
            : {};
        if (recurrence === null) {
          const { recurrence: _omit, ...remaining } = ctxObj;
          void _omit;
          updateInput.context =
            Object.keys(remaining).length === 0 ? null : remaining;
        } else {
          updateInput.context = { ...ctxObj, recurrence };
        }
      }
      const task = updateTask(id, updateInput);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body: UpdateTaskResponse = { task };
      res.json(body);
    }),
  );

  // POST /api/tasks/:id/archive ---------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const task = archiveTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      res.json({ ok: true, task });
    }),
  );

  // POST /api/tasks/:id/unarchive -------------------------------------------
  router.post(
    '/:id/unarchive',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const task = unarchiveTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      res.json({ ok: true, task });
    }),
  );

  // DELETE /api/tasks/:id ---------------------------------------------------
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      assertValidId(id);
      const removed = deleteTask(id);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body: DeleteTaskResponse = { ok: true, id };
      res.json(body);
    }),
  );

  // POST /api/tasks/:id/derive ----------------------------------------------
  router.post(
    '/:id/derive',
    asyncHandler(async (req, res) => {
      if (isAgentPaused()) {
        throw new ApiHttpError(
          403,
          'agent_paused',
          'Agent work is paused. Toggle "Pause all agent work" off in Settings to continue.',
        );
      }
      const task = requireTask(String(req.params.id));
      // Guard against re-derive duplication. `ingestDerived` always mints
      // fresh child ids — calling /derive twice on the same parent leaves
      // two batches behind. Refuse when any non-cancelled descendant
      // exists; the caller should reject-with-requeue via /api/review
      // (which deletes children first) or delete children manually.
      const liveChildren = getChildren(task.id).filter(
        (c) => c.status !== 'cancelled',
      );
      if (liveChildren.length > 0) {
        throw new ApiHttpError(
          409,
          'already_has_children',
          `Task ${task.id} already has ${liveChildren.length} non-cancelled descendant(s). Re-deriving would create duplicates. Reject the existing derivation via /api/review/${task.id}/reject (which deletes children first) or delete them individually, then re-derive.`,
        );
      }
      const calendar_snapshot = await readCalendarSnapshot();
      const related_tasks = findRelatedTasks(task);
      // Resolve permissions so the request file Claude reads carries the
      // effective set. We pass through the DeriveContext's `instructions`
      // hook to surface it as a JSON-shaped block at the bottom of the
      // existing instructions string so the schema doesn't need a new field.
      const permissions = resolvePermissions(task);
      const baseInstructions = appendPermissionsBlock(undefined, permissions);
      // Intelligence layer (Wave 12): fold in bound + suggested skills and
      // memory of similar past derivations so Claude can mimic prior
      // structure. Both blocks are appended via marker headers so they're
      // easy to parse out client-side.
      const enriched = appendIntelligenceBlocks(baseInstructions, task, true);
      const skillNames = skillHintsForTask(task);
      const filePath = await writeDeriveRequest(task, {
        calendar_snapshot,
        related_tasks,
        available_tools: ['cowork', 'cli', ...skillNames],
        execution_modes: ['cowork', 'cli'],
        instructions: enriched.instructions,
      });
      updateTask(task.id, { agent_status: 'assigned' });
      const body: DeriveTaskResponse = { ok: true, request_path: filePath };
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:api] derive ${task.id}: memory=${enriched.memoryCount} skills=${enriched.skillHintsCount} rejections=${enriched.rejectionsCount}`,
      );
      res.json(body);
    }),
  );

  // POST /api/tasks/:id/execute ---------------------------------------------
  router.post(
    '/:id/execute',
    asyncHandler(async (req, res) => {
      if (isAgentPaused()) {
        throw new ApiHttpError(
          403,
          'agent_paused',
          'Agent work is paused. Toggle "Pause all agent work" off in Settings to continue.',
        );
      }
      const task = requireTask(String(req.params.id));
      const parent_outputs = await resolveParentOutputs(task);
      const permissions = resolvePermissions(task);
      const baseInstructions = appendPermissionsBlock(
        task.agent_instructions ?? undefined,
        permissions,
      );
      // Intelligence layer: surface bound + suggested skills on the execute
      // request so Claude routes through the right specialized prompts.
      // Memory is derive-only — at execute time the work is decided.
      const enriched = appendIntelligenceBlocks(baseInstructions, task, false);
      const skillNames = skillHintsForTask(task);
      const filePath = await writeExecuteRequest(
        task,
        parent_outputs,
        {
          tags: task.tags,
          permissions,
          ...(skillNames.length > 0 ? { skills: skillNames } : {}),
        },
        enriched.instructions,
      );
      updateTask(task.id, { agent_status: 'assigned' });
      const body: ExecuteTaskResponse = { ok: true, request_path: filePath };
      res.json(body);
    }),
  );

  // POST /api/tasks/:id/approve ---------------------------------------------
  router.post(
    '/:id/approve',
    validateBody(approveBodySchema),
    asyncHandler(async (req, res) => {
      const task = requireTask(String(req.params.id));
      const payload = req.body as z.infer<typeof approveBodySchema>;
      let updated: Task;
      if (payload.kind === 'derivation') {
        updated = approveDerivation(task);
      } else {
        updated = approveResult(task);
      }
      await clearReviewMarker(task.id);
      const body: ApproveTaskResponse = { ok: true, task: updated };
      res.json(body);
    }),
  );

  // POST /api/tasks/:id/schedule --------------------------------------------
  router.post(
    '/:id/schedule',
    validateBody(scheduleBodySchema),
    asyncHandler(async (req, res) => {
      const task = requireTask(String(req.params.id));
      const body = req.body as z.infer<typeof scheduleBodySchema>;

      // Defer-import the calendar module so the API stays usable even when
      // the calendar subsystem isn't initialized (mirrors the soft-load
      // pattern in `routes/calendar.ts`).
      let scheduleTaskFn: typeof import('@/main/calendar/schedule-task').scheduleTask;
      let calendarErrors: typeof import('@/main/calendar/errors');
      try {
        const [calMod, errMod] = await Promise.all([
          import('@/main/calendar/schedule-task') as Promise<
            typeof import('@/main/calendar/schedule-task')
          >,
          import('@/main/calendar/errors') as Promise<
            typeof import('@/main/calendar/errors')
          >,
        ]);
        scheduleTaskFn = calMod.scheduleTask;
        calendarErrors = errMod;
      } catch (err) {
        throw new ApiHttpError(
          503,
          'calendar_not_initialized',
          err instanceof Error ? err.message : 'Calendar module unavailable',
        );
      }

      try {
        const options: import('@/main/calendar/schedule-task').ScheduleTaskOptions = {};
        if (body.start !== undefined) options.start = body.start;
        if (body.duration_minutes !== undefined) {
          options.duration_minutes = body.duration_minutes;
        }
        if (body.calendar_id !== undefined) {
          options.calendar_id = body.calendar_id;
        }
        const result = await scheduleTaskFn(task, options);

        // Persist the linkage. If the column was already set we overwrite —
        // user intent is "schedule (or re-schedule) this task".
        updateTask(task.id, { calendar_event_id: result.event.id });

        const response: ScheduleTaskResponse = {
          ok: true,
          event_id: result.event.id,
          start: result.start,
          end: result.end,
          calendar_url: result.calendar_url,
        };
        res.json(response);
      } catch (err) {
        if (err instanceof calendarErrors.CalendarNotConfiguredError) {
          throw new ApiHttpError(
            503,
            'calendar_not_configured',
            err.message,
          );
        }
        if (err instanceof calendarErrors.CalendarAuthError) {
          throw new ApiHttpError(401, 'calendar_auth', err.message);
        }
        if (err instanceof calendarErrors.CalendarApiError) {
          throw new ApiHttpError(
            err.status && err.status >= 400 && err.status < 600 ? err.status : 502,
            'calendar_api_error',
            err.message,
          );
        }
        throw err;
      }
    }),
  );

  // POST /api/tasks/:id/reject ----------------------------------------------
  router.post(
    '/:id/reject',
    validateBody(rejectBodySchema),
    asyncHandler(async (req, res) => {
      const task = requireTask(String(req.params.id));
      const payload = req.body as z.infer<typeof rejectBodySchema>;
      const updated =
        payload.kind === 'derivation'
          ? rejectDerivation(task)
          : rejectTask(task, payload.requeue);
      await clearReviewMarker(task.id);
      const body: RejectTaskResponse = { ok: true, task: updated };
      res.json(body);
    }),
  );

  return router;
}
