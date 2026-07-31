/**
 * Phases / pipelines (Wave 15 — phase/stage model).
 *
 * Beyond the broad `status` lifecycle (inbox/queued/in_progress/done), each
 * task can have an optional `phase` that names where it sits in a richer,
 * configurable workflow. Pipelines bundle an ordered list of phases plus an
 * `applies_to` matcher (tags + workspaces) so the right one auto-applies
 * based on a task's identity.
 *
 * Storage:
 *   - Pipelines live as a single JSON array under the `pipelines` setting
 *     key. First read seeds the defaults (code / content / meeting / deal /
 *     research / launch / personal). Same pattern as workspaces — keeps the
 *     schema flat.
 *   - Per-task phase lives at `task.context.phase: string` (the phase id).
 *     Optional `task.context.pipeline_id` pins a task to one pipeline
 *     regardless of the auto-matcher.
 *
 * Public surface:
 *   - `listPipelines()` — read the persisted set, seeding defaults if missing.
 *   - `getPipeline(id)` / `upsertPipeline(p)` / `deletePipeline(id)` — CRUD.
 *   - `resetPipelines()` — reseed defaults.
 *   - `resolvePipelineForTask(task)` — pick the active pipeline for a row.
 *   - `getPhaseAssignment(taskId)` — full resolved view for the UI.
 *   - `setTaskPhase(taskId, phase, pipelineId?)` — persist a phase choice.
 *   - `advancePhase(taskId)` / `regressPhase(taskId)` — step through pipeline.
 *
 * Module is pure-synchronous (no async) — the settings repo and the tasks
 * repo are both sync against better-sqlite3.
 */

import { pipelinesArraySchema } from '@/shared/io-schemas';
import type {
  PhaseAssignment,
  PhaseDefinition,
  Pipeline,
  Task,
} from '@/shared/types';

import { settingsRepository } from '@/main/db/repositories/settings';
import {
  getTask,
  updateTask,
} from '@/main/db/repositories/tasks';
import { ioEvents } from '@/main/io/events';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Path key on a task's `context` where the assigned phase id lives. */
export const PHASE_CONTEXT_KEY = 'phase';
/** Path key on a task's `context` for an explicit pipeline override. */
export const PIPELINE_CONTEXT_KEY = 'pipeline_id';
/** Settings key that stores the user's full pipeline catalog. */
export const PIPELINES_SETTING_KEY = 'pipelines';

/* -------------------------------------------------------------------------- */
/*  Default pipeline catalog                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Defaults seeded on first read. Covers Jack's most common shapes of work:
 *
 *   - **code** — feature dev pipeline (research → spec → implement → review
 *     → deploy → verify). Matches anything tagged `code` / `dev` / `bug`.
 *   - **content** — long-form writing pipeline. Matches anything tagged
 *     `content`, `writing`, `blog`, `article`, `newsletter`.
 *   - **meeting** — meeting prep + follow-up. Matches `meeting`, `prep`.
 *   - **deal** — sales / client deal flow. Matches `sales`, `deal`,
 *     `prospect`, `client`.
 *   - **research** — investigation pipeline. Matches `research`, `analysis`.
 *   - **launch** — product / campaign launch. Matches `launch`, `campaign`.
 *   - **personal** — generic todo flow for unstructured work. Marked
 *     `default: true` so the resolver falls through to it.
 */
export const DEFAULT_PIPELINES: readonly Pipeline[] = Object.freeze([
  {
    id: 'code',
    name: 'Code pipeline',
    description:
      'Feature development from spec through deploy. Use for engineering tasks.',
    phases: [
      { id: 'research', name: 'Research', color: 'bg-violet-500' },
      { id: 'spec', name: 'Spec', color: 'bg-indigo-500' },
      { id: 'implement', name: 'Implement', color: 'bg-sky-500' },
      { id: 'review', name: 'Review', color: 'bg-amber-500' },
      { id: 'deploy', name: 'Deploy', color: 'bg-emerald-500' },
      { id: 'verify', name: 'Verify', color: 'bg-emerald-600', is_terminal: true },
    ],
    applies_to: {
      tags: ['code', 'dev', 'engineering', 'bug', 'feature'],
    },
  },
  {
    id: 'content',
    name: 'Content pipeline',
    description:
      'Long-form writing from outline through distribution. Use for posts, papers, newsletters.',
    phases: [
      { id: 'outline', name: 'Outline', color: 'bg-violet-500' },
      { id: 'draft', name: 'Draft', color: 'bg-blue-500' },
      { id: 'revise', name: 'Revise', color: 'bg-amber-500' },
      { id: 'publish', name: 'Publish', color: 'bg-emerald-500' },
      { id: 'distribute', name: 'Distribute', color: 'bg-emerald-600', is_terminal: true },
    ],
    applies_to: {
      tags: ['content', 'writing', 'blog', 'article', 'newsletter', 'post'],
    },
  },
  {
    id: 'meeting',
    name: 'Meeting pipeline',
    description: 'Prep, conduct, and follow up on a meeting.',
    phases: [
      { id: 'schedule', name: 'Schedule', color: 'bg-violet-500' },
      { id: 'prepare', name: 'Prepare', color: 'bg-blue-500' },
      { id: 'conduct', name: 'Conduct', color: 'bg-amber-500' },
      { id: 'follow-up', name: 'Follow-up', color: 'bg-emerald-500', is_terminal: true },
    ],
    applies_to: {
      tags: ['meeting', 'prep', 'call', 'standup'],
    },
  },
  {
    id: 'deal',
    name: 'Deal pipeline',
    description: 'Sales and client deal flow from prospect through close.',
    phases: [
      { id: 'prospect', name: 'Prospect', color: 'bg-zinc-500' },
      { id: 'contact', name: 'Contact', color: 'bg-violet-500' },
      { id: 'qualify', name: 'Qualify', color: 'bg-blue-500' },
      { id: 'propose', name: 'Propose', color: 'bg-amber-500' },
      { id: 'negotiate', name: 'Negotiate', color: 'bg-orange-500' },
      { id: 'close', name: 'Close', color: 'bg-emerald-500', is_terminal: true },
    ],
    applies_to: {
      tags: ['sales', 'deal', 'prospect', 'client', 'pipeline'],
    },
  },
  {
    id: 'research',
    name: 'Research pipeline',
    description: 'Investigate, synthesize, and ship a finding.',
    phases: [
      { id: 'scope', name: 'Scope', color: 'bg-violet-500' },
      { id: 'gather', name: 'Gather', color: 'bg-blue-500' },
      { id: 'synthesize', name: 'Synthesize', color: 'bg-amber-500' },
      { id: 'share', name: 'Share', color: 'bg-emerald-500', is_terminal: true },
    ],
    applies_to: {
      tags: ['research', 'analysis', 'study', 'brief'],
    },
  },
  {
    id: 'launch',
    name: 'Launch pipeline',
    description: 'Product or campaign launch — plan, build, ship, measure.',
    phases: [
      { id: 'plan', name: 'Plan', color: 'bg-violet-500' },
      { id: 'build', name: 'Build', color: 'bg-blue-500' },
      { id: 'launch', name: 'Launch', color: 'bg-orange-500' },
      { id: 'measure', name: 'Measure', color: 'bg-emerald-500', is_terminal: true },
    ],
    applies_to: {
      tags: ['launch', 'campaign', 'release', 'go-live'],
    },
  },
  {
    id: 'personal',
    name: 'Personal todo',
    description: 'Generic three-step flow for everything else. Default fallback.',
    phases: [
      { id: 'todo', name: 'Todo', color: 'bg-zinc-500' },
      { id: 'doing', name: 'Doing', color: 'bg-blue-500' },
      { id: 'done', name: 'Done', color: 'bg-emerald-500', is_terminal: true },
    ],
    default: true,
  },
]);

/* -------------------------------------------------------------------------- */
/*  Read helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read the persisted pipeline list. Seeds the defaults on first call when the
 * setting is missing or empty so callers never see an empty catalog.
 *
 * Falls back to {@link DEFAULT_PIPELINES} when the stored value fails schema
 * validation — a corrupted blob shouldn't take down the whole feature.
 */
export function listPipelines(): Pipeline[] {
  const raw = settingsRepository.get(PIPELINES_SETTING_KEY);
  if (raw === null || raw === undefined) {
    // First run — seed defaults and persist so the editor has something to
    // show before the user touches anything.
    const seeded = clonePipelines(DEFAULT_PIPELINES);
    settingsRepository.set(PIPELINES_SETTING_KEY, seeded);
    return seeded;
  }
  const parsed = pipelinesArraySchema.safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) {
    return clonePipelines(DEFAULT_PIPELINES);
  }
  return parsed.data as Pipeline[];
}

export function getPipeline(id: string): Pipeline | null {
  const all = listPipelines();
  return all.find((p) => p.id === id) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  CRUD                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Insert or update a pipeline. Validates via the Zod schema and rejects on
 * duplicate phase ids inside the same pipeline. Returns the persisted value
 * (which may differ from the input — e.g. id may be re-slugged).
 */
export function upsertPipeline(pipeline: Pipeline): Pipeline {
  const validated = pipelinesArraySchema.element.parse(pipeline);
  ensureUniquePhaseIds(validated);
  const all = listPipelines();
  const idx = all.findIndex((p) => p.id === validated.id);
  let next: Pipeline[];
  if (idx === -1) {
    next = [...all, validated as Pipeline];
  } else {
    next = all.slice();
    next[idx] = validated as Pipeline;
  }
  settingsRepository.set(PIPELINES_SETTING_KEY, next);
  return validated as Pipeline;
}

export function deletePipeline(id: string): boolean {
  const all = listPipelines();
  const filtered = all.filter((p) => p.id !== id);
  if (filtered.length === all.length) return false;
  settingsRepository.set(PIPELINES_SETTING_KEY, filtered);
  return true;
}

/**
 * Wipe the persisted pipeline list and replace with the baked-in defaults.
 * Returns the new list for the convenience of the callsite.
 */
export function resetPipelines(): Pipeline[] {
  const seeded = clonePipelines(DEFAULT_PIPELINES);
  settingsRepository.set(PIPELINES_SETTING_KEY, seeded);
  return seeded;
}

/* -------------------------------------------------------------------------- */
/*  Resolver                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Determine which pipeline applies to a task, in priority order:
 *
 *   1. Explicit `task.context.pipeline_id` override.
 *   2. First pipeline whose `applies_to.tags` intersects the task's tags.
 *   3. First pipeline whose `applies_to.workspaces` matches a workspace
 *      that contains the task (workspace match is approximated via tag
 *      overlap — workspaces are tag groups in TaskPilot).
 *   4. First pipeline marked `default: true`.
 *   5. `null` (no pipeline — the task is unphased).
 */
export function resolvePipelineForTask(task: Task | null): Pipeline | null {
  if (!task) return null;
  const pipelines = listPipelines();
  if (pipelines.length === 0) return null;

  // 1. Explicit override.
  const explicitId = readTaskPipelineId(task);
  if (explicitId) {
    const found = pipelines.find((p) => p.id === explicitId);
    if (found) return found;
  }

  // 2. Tag match.
  const taskTags = task.tags ?? [];
  if (taskTags.length > 0) {
    for (const pipeline of pipelines) {
      const wantTags = pipeline.applies_to?.tags;
      if (!wantTags || wantTags.length === 0) continue;
      if (wantTags.some((t) => taskTags.includes(t))) return pipeline;
    }
  }

  // 3. Workspace match. We treat workspace ids as soft hints; if the user
  // configured `applies_to.workspaces: ['indexthread']`, the task matches
  // when its tags overlap the IndexThread workspace tag list. We don't pull
  // in the renderer workspace store here — the workspace id appears as a
  // tag too in most setups, so this falls back to the tag match. Kept as
  // a stub so the API contract stays stable.

  // 4. Default fallback.
  const fallback = pipelines.find((p) => p.default);
  return fallback ?? null;
}

/**
 * Look up the {@link PhaseDefinition} for the assigned phase, if any. Returns
 * null when the task has no phase, or when the assigned id is no longer in
 * the resolved pipeline (stale binding — the editor may have dropped it).
 */
export function resolvePhaseDefinition(
  task: Task | null,
  pipeline: Pipeline | null,
): PhaseDefinition | null {
  if (!task || !pipeline) return null;
  const phaseId = readTaskPhase(task);
  if (!phaseId) return null;
  return pipeline.phases.find((p) => p.id === phaseId) ?? null;
}

/**
 * Compute the next phase in the active pipeline. Returns null when the task
 * has no pipeline, when it's already at the terminal phase, or when the
 * assigned phase id isn't part of the resolved pipeline (stale).
 */
export function resolveNextPhase(
  task: Task | null,
  pipeline?: Pipeline | null,
): PhaseDefinition | null {
  if (!task) return null;
  const pl = pipeline ?? resolvePipelineForTask(task);
  if (!pl) return null;
  const phaseId = readTaskPhase(task);
  // No phase yet — "next" is the first phase. This makes auto-advance after
  // a successful execute behave sensibly for unphased tasks.
  if (!phaseId) return pl.phases[0] ?? null;
  const idx = pl.phases.findIndex((p) => p.id === phaseId);
  if (idx === -1) return null;
  return pl.phases[idx + 1] ?? null;
}

export function resolvePreviousPhase(
  task: Task | null,
  pipeline?: Pipeline | null,
): PhaseDefinition | null {
  if (!task) return null;
  const pl = pipeline ?? resolvePipelineForTask(task);
  if (!pl) return null;
  const phaseId = readTaskPhase(task);
  if (!phaseId) return null;
  const idx = pl.phases.findIndex((p) => p.id === phaseId);
  if (idx <= 0) return null;
  return pl.phases[idx - 1] ?? null;
}

/**
 * Bundle a task's current phase + pipeline into a single object for the UI.
 * Returns null when the task doesn't exist.
 */
export function getPhaseAssignment(taskId: string): PhaseAssignment | null {
  const task = getTask(taskId);
  if (!task) return null;
  const pipeline = resolvePipelineForTask(task);
  const phase = readTaskPhase(task);
  const phase_definition = resolvePhaseDefinition(task, pipeline);
  return {
    task_id: taskId,
    pipeline,
    phase,
    phase_definition,
  };
}

/* -------------------------------------------------------------------------- */
/*  Task phase writers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Persist a task's phase assignment. Pass `null` for `phase` to clear it.
 * When `pipelineId` is non-undefined it's written through too — `null`
 * removes the override, a string id pins the task to that pipeline.
 *
 * Returns the updated assignment view, or `null` when the task is missing.
 */
export function setTaskPhase(
  taskId: string,
  phase: string | null,
  pipelineId?: string | null,
): PhaseAssignment | null {
  const task = getTask(taskId);
  if (!task) return null;

  const baseCtx =
    task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : {};
  const nextCtx: Record<string, unknown> = { ...baseCtx };

  if (phase === null) {
    delete nextCtx[PHASE_CONTEXT_KEY];
  } else {
    nextCtx[PHASE_CONTEXT_KEY] = phase;
  }

  if (pipelineId !== undefined) {
    if (pipelineId === null) {
      delete nextCtx[PIPELINE_CONTEXT_KEY];
    } else {
      nextCtx[PIPELINE_CONTEXT_KEY] = pipelineId;
    }
  }

  const persistCtx = Object.keys(nextCtx).length === 0 ? null : nextCtx;
  updateTask(taskId, { context: persistCtx });
  return getPhaseAssignment(taskId);
}

/**
 * Move a task one phase forward. Returns the new assignment, or `null` when
 * the task is missing / has no pipeline / is already at the terminal phase.
 */
export function advancePhase(taskId: string): PhaseAssignment | null {
  const task = getTask(taskId);
  if (!task) return null;
  const pipeline = resolvePipelineForTask(task);
  if (!pipeline) return null;
  const next = resolveNextPhase(task, pipeline);
  if (!next) return null;
  return setTaskPhase(taskId, next.id);
}

/**
 * Move a task one phase backward. Returns the new assignment, or `null`
 * when the task is missing / has no phase / is already at the first phase.
 */
export function regressPhase(taskId: string): PhaseAssignment | null {
  const task = getTask(taskId);
  if (!task) return null;
  const pipeline = resolvePipelineForTask(task);
  if (!pipeline) return null;
  const prev = resolvePreviousPhase(task, pipeline);
  if (!prev) return null;
  return setTaskPhase(taskId, prev.id);
}

/* -------------------------------------------------------------------------- */
/*  Read helpers (lower-level)                                                */
/* -------------------------------------------------------------------------- */

/** Pull the phase id off a task's context (or null if absent / malformed). */
export function readTaskPhase(task: Task | null): string | null {
  if (!task || !task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)[PHASE_CONTEXT_KEY];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Pull the explicit pipeline override off a task's context, if any. */
export function readTaskPipelineId(task: Task | null): string | null {
  if (!task || !task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)[PIPELINE_CONTEXT_KEY];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function clonePipelines(source: ReadonlyArray<Pipeline>): Pipeline[] {
  return source.map((p) => ({
    ...p,
    phases: p.phases.map((ph) => ({ ...ph })),
    applies_to: p.applies_to
      ? {
          ...(p.applies_to.tags ? { tags: [...p.applies_to.tags] } : {}),
          ...(p.applies_to.workspaces
            ? { workspaces: [...p.applies_to.workspaces] }
            : {}),
        }
      : undefined,
  }));
}

function ensureUniquePhaseIds(pipeline: Pipeline): void {
  const seen = new Set<string>();
  for (const phase of pipeline.phases) {
    if (seen.has(phase.id)) {
      throw new Error(
        `Pipeline "${pipeline.id}" has duplicate phase id: ${phase.id}`,
      );
    }
    seen.add(phase.id);
  }
}

/* -------------------------------------------------------------------------- */
/*  Auto-advance on successful result                                         */
/* -------------------------------------------------------------------------- */

/**
 * Hook into the I/O subsystem: when a task completes successfully (the
 * watcher ingested a `succeeded` result), bump it one phase forward. Best-
 * effort — failures here never block ingestion.
 *
 * This is the bridge from the broad `status` lifecycle to the finer-grained
 * phase model. The journal layer (15A) will surface the transition; the
 * outputs panel (15B) will reflect new artifacts at the new phase.
 *
 * Listener is idempotent — wiring it up via side-effect import means it
 * registers exactly once at module load time.
 */
let autoAdvanceInstalled = false;
export function installAutoAdvanceHook(): void {
  if (autoAdvanceInstalled) return;
  autoAdvanceInstalled = true;
  ioEvents.on('result_ingested', ({ taskId, result }) => {
    if (result.status !== 'succeeded') return;
    try {
      const task = getTask(taskId);
      if (!task) return;
      const pipeline = resolvePipelineForTask(task);
      if (!pipeline) return;
      // If the task is already at a terminal phase, leave it alone — the
      // status flip to `done` handles the lifecycle. Auto-advance only
      // touches intermediate phases.
      const current = resolvePhaseDefinition(task, pipeline);
      if (current?.is_terminal) return;
      const next = resolveNextPhase(task, pipeline);
      if (!next) return;
      setTaskPhase(taskId, next.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:phases] auto-advance failed for ${taskId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

// Auto-install on module load — same pattern as `@/main/links` and
// `@/main/attachments`. Importing this module anywhere wires the hook.
installAutoAdvanceHook();
