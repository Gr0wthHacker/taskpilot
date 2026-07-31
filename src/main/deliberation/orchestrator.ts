/**
 * Deliberation orchestrator — the producer side of the ambient monitor's
 * two-agent (interrupter vs waiter) protocol.
 *
 * Called by the ambient batcher or the `POST /api/context/deliberate` route
 * with a set of `observation_ids` + a `trigger_reason`. The orchestrator:
 *
 *   1. Generates a `batch_id` (nanoid).
 *   2. Stamps that `batch_id` onto every observation it bundles (so they
 *      stop showing up in the "unbatched" pool).
 *   3. Pulls a thin context bundle: recent tasks, active workspace, quiet-
 *      hours flag — enough for Claude to score interrupter vs waiter without
 *      callbacks.
 *   4. Writes the request to `~/.taskpilot/io/deliberate/<batch_id>.json`.
 *   5. Inserts a `deliberations` row in `status='pending'`.
 *   6. Emits `deliberation_requested` on the ioEvents bus.
 *
 * Mirrors the shape of `writeDeriveRequest()` in `@/main/io/protocol` — the
 * caller never sees raw JSON, just the public DTO.
 *
 * Zero LLM calls. The actual two-agent scoring runs inside Claude Code via
 * the `ambient-deliberate` skill; the app only writes the request.
 */

import { nanoid } from 'nanoid';

import { appendAuditEventSafe } from '@/main/audit/log';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { settingsRepository } from '@/main/db/repositories/settings';
import { tasksRepository } from '@/main/db/repositories/tasks';
import { ioEvents } from '@/main/io/events';
import type {
  DeliberationRequest,
  DeliberationRequestObservation,
  DeliberationRequestRecentTask,
} from '@/shared/io-schemas';
import type {
  ContextObservation,
  Deliberation,
  DeliberationTriggerReason,
} from '@/shared/types';

import {
  INTERRUPTER_ROLE_PROMPT,
  SCORING_RUBRIC_PROMPT,
  WAITER_ROLE_PROMPT,
} from './prompts';
import { writeDeliberationRequest } from './protocol';

/* -------------------------------------------------------------------------- */
/*  Type bridges                                                              */
/* -------------------------------------------------------------------------- */

// The schema types are inferred from zod but the explicit type aliases here
// keep the public surface readable. They have to match the schema 1:1 or the
// `.parse()` in protocol.ts will reject.
type RequestObservation = DeliberationRequestObservation;
type RequestRecentTask = DeliberationRequestRecentTask;

/**
 * Public input to {@link requestDeliberation}. `observation_ids` may be empty;
 * if so, the orchestrator pulls the most recent unbatched observations up to
 * `max_observations` (default 50). `trigger_reason` is recorded verbatim on
 * the resulting `deliberations` row.
 */
export interface RequestDeliberationInput {
  observation_ids?: string[];
  trigger_reason: DeliberationTriggerReason;
  /** Cap on how many observations to bundle. Default 50. */
  max_observations?: number;
  /** Cap on how many recent tasks to embed. Default 10. */
  max_recent_tasks?: number;
}

/**
 * Public return shape from {@link requestDeliberation}.
 */
export interface RequestDeliberationOutput {
  batch_id: string;
  deliberation: Deliberation;
  request_path: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers — pure                                                            */
/* -------------------------------------------------------------------------- */

function newBatchId(): string {
  return nanoid(12);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Map a stored {@link ContextObservation} to the wire shape Claude reads.
 * The wire shape drops nullable fields when absent so the JSON stays small.
 */
function observationToRequestShape(obs: ContextObservation): RequestObservation {
  const out: RequestObservation = {
    id: obs.id,
    source: obs.source,
    captured_at: obs.captured_at,
  };
  if (obs.app_name) out.app_name = obs.app_name;
  if (obs.window_title) out.window_title = obs.window_title;
  if (obs.url) out.url = obs.url;
  if (obs.page_title) out.page_title = obs.page_title;
  if (obs.h1) out.h1 = obs.h1;
  if (obs.meta_description) out.meta_description = obs.meta_description;
  if (obs.selection) out.selection = obs.selection;
  if (obs.screenshot_path) out.screenshot_path = obs.screenshot_path;
  return out;
}

/**
 * Pull up to `limit` recent tasks (in_progress + queued first) for context.
 * Trimmed to the schema's bounded shape.
 */
function loadRecentTasks(limit: number): RequestRecentTask[] {
  let tasks;
  try {
    tasks = tasksRepository.list({
      status: ['in_progress', 'queued'],
      limit,
    });
  } catch {
    return [];
  }
  return tasks.slice(0, limit).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
  }));
}

/**
 * Quiet-hours check. `ambient_deliberation_quiet_hours` is a freeform string
 * like `'22:00-07:00'`. Empty string / missing → never quiet. Out-of-range or
 * malformed → never quiet (fail-safe). The check uses local clock time.
 */
export function isQuietHoursActive(now: Date = new Date()): boolean {
  let raw: unknown = '';
  try {
    raw = settingsRepository.get('ambient_deliberation_quiet_hours') ?? '';
  } catch {
    return false;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return false;
  const [, sH, sM, eH, eM] = match;
  const startMin = Number(sH) * 60 + Number(sM);
  const endMin = Number(eH) * 60 + Number(eM);
  if (
    !Number.isFinite(startMin) ||
    !Number.isFinite(endMin) ||
    startMin < 0 ||
    startMin > 24 * 60 ||
    endMin < 0 ||
    endMin > 24 * 60
  ) {
    return false;
  }
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin === endMin) return false;
  // Window may wrap midnight (e.g. 22:00-07:00).
  return startMin < endMin
    ? nowMin >= startMin && nowMin < endMin
    : nowMin >= startMin || nowMin < endMin;
}

/**
 * Resolve the observations to bundle for this deliberation. Explicit ids win;
 * otherwise pull the newest unbatched rows up to `max`.
 */
function resolveObservations(
  input: RequestDeliberationInput,
  max: number,
): ContextObservation[] {
  const explicit = input.observation_ids ?? [];
  if (explicit.length > 0) {
    const out: ContextObservation[] = [];
    for (const id of explicit.slice(0, max)) {
      const obs = contextObservationsRepository.get(id);
      if (obs) out.push(obs);
    }
    return out;
  }
  return contextObservationsRepository.list({
    unbatched_only: true,
    limit: max,
  });
}

/**
 * Read the active workspace id from settings (string) or return undefined.
 */
function readActiveWorkspace(): string | undefined {
  let raw: unknown;
  try {
    raw = settingsRepository.get('active_workspace_id');
  } catch {
    return undefined;
  }
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Write a deliberation request and persist the pending row. See module-level
 * doc for the full sequence. Throws when no observations could be resolved —
 * an empty deliberation is meaningless and a likely caller bug.
 */
/**
 * Soft cost cap. Each deliberation is two Claude calls (interrupter + waiter);
 * we approximate per-deliberation USD via a setting so the gate is tunable
 * without plumbing real token usage through the deliberation result. Defaults
 * align with Opus 4.7 at ~2k input + 1k output per agent.
 *
 * Returns true when the day's projected spend (today's deliberations + 1)
 * would exceed `ambient_daily_budget_usd`. The orchestrator skips dispatch
 * in that case — the user can manually trigger via the /api/context/deliberate
 * endpoint, which bypasses this gate intentionally.
 */
function isBudgetExceeded(): { exceeded: boolean; spent: number; budget: number } {
  const budgetRaw = settingsRepository.get<number>('ambient_daily_budget_usd');
  const budget =
    typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) && budgetRaw > 0
      ? budgetRaw
      : 5;
  const perDelibRaw = settingsRepository.get<number>(
    'ambient_estimated_cost_per_deliberation_usd',
  );
  const perDelib =
    typeof perDelibRaw === 'number' &&
    Number.isFinite(perDelibRaw) &&
    perDelibRaw > 0
      ? perDelibRaw
      : 0.1;

  const sinceMidnight = new Date();
  sinceMidnight.setUTCHours(0, 0, 0, 0);
  const todayCount = deliberationsRepository.count({
    since: sinceMidnight.toISOString(),
  });
  const projected = (todayCount + 1) * perDelib;
  return { exceeded: projected > budget, spent: projected, budget };
}

export async function requestDeliberation(
  input: RequestDeliberationInput,
): Promise<RequestDeliberationOutput> {
  const maxObs = input.max_observations ?? 50;
  const maxTasks = input.max_recent_tasks ?? 10;

  // Daily budget guard. The orchestrator is called by the batcher on a
  // hot path; refusing to dispatch when the day's projected spend exceeds
  // the configured budget keeps a runaway monitor from racking up cost.
  // We skip this for manual triggers — they're user-initiated so the user
  // accepts the cost. trigger_reason='manual' is the explicit override.
  if (input.trigger_reason !== 'manual') {
    const budget = isBudgetExceeded();
    if (budget.exceeded) {
      appendAuditEventSafe({
        kind: 'deliberation_skipped_budget',
        payload: {
          trigger_reason: input.trigger_reason,
          projected_usd: budget.spent,
          budget_usd: budget.budget,
        },
      });
      throw new Error(
        `requestDeliberation: daily budget exceeded ($${budget.spent.toFixed(2)} of $${budget.budget.toFixed(2)}). ` +
          `Set 'ambient_daily_budget_usd' higher, lower 'ambient_estimated_cost_per_deliberation_usd', or wait until midnight UTC.`,
      );
    }

    // Optional hard stop during quiet hours. By default quiet hours only
    // suppress surfacing (interrupt → notify); when
    // `quiet_hours_stops_deliberation=true` we skip the dispatch entirely
    // so captures stop generating Claude requests instead of merely going
    // silent at the surface. Manual triggers still bypass.
    const hardStop =
      settingsRepository.get<boolean>('quiet_hours_stops_deliberation') === true;
    if (hardStop && isQuietHoursActive()) {
      appendAuditEventSafe({
        kind: 'deliberation_skipped_quiet_hours',
        payload: { trigger_reason: input.trigger_reason },
      });
      throw new Error(
        'requestDeliberation: quiet hours active and ' +
          'quiet_hours_stops_deliberation=true. ' +
          'Set the flag to false to keep dispatching during quiet hours.',
      );
    }
  }

  const observations = resolveObservations(input, maxObs);
  if (observations.length === 0) {
    throw new Error('requestDeliberation: no observations resolved');
  }

  const batchId = newBatchId();
  const observationIds = observations.map((o) => o.id);
  const activeWorkspace = readActiveWorkspace();

  const request: DeliberationRequest = {
    id: batchId,
    requested_at: nowIso(),
    trigger_reason: input.trigger_reason,
    observations: observations.map(observationToRequestShape),
    recent_tasks: loadRecentTasks(maxTasks),
    quiet_hours_active: isQuietHoursActive(),
    instructions: {
      interrupter_role: INTERRUPTER_ROLE_PROMPT,
      waiter_role: WAITER_ROLE_PROMPT,
      scoring_rubric: SCORING_RUBRIC_PROMPT,
    },
    ...(activeWorkspace !== undefined
      ? { active_workspace_id: activeWorkspace }
      : {}),
  };

  const requestPath = await writeDeliberationRequest(request);

  // Tag observations as batched BEFORE inserting the row — if the insert
  // fails we'd rather have leaked a batch_id reference than spawn a duplicate
  // row from a later batch swallowing the same observations.
  contextObservationsRepository.markBatched(observationIds, batchId);

  const deliberation = deliberationsRepository.create({
    batch_id: batchId,
    requested_at: request.requested_at,
    observation_ids: observationIds,
    trigger_reason: input.trigger_reason,
    status: 'pending',
  });

  ioEvents.emit('deliberation_requested', {
    deliberationId: deliberation.id,
    batchId,
    observationIds,
  });

  appendAuditEventSafe({
    kind: 'deliberation_requested',
    payload: {
      batch_id: batchId,
      deliberation_id: deliberation.id,
      observation_count: observationIds.length,
      trigger_reason: input.trigger_reason,
    },
  });

  return { batch_id: batchId, deliberation, request_path: requestPath };
}
