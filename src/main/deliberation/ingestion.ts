/**
 * Deliberation result ingestion — the consumer side of the ambient monitor's
 * two-agent protocol.
 *
 * Called by the IO watcher whenever a JSON file lands in
 * `~/.taskpilot/io/deliberated/<batch_id>.json`. The flow:
 *
 *   1. Validate against {@link deliberationResultSchema}. Bad payloads are
 *      already quarantined by the watcher, so we can assume validity here.
 *   2. Find the matching pending `deliberations` row by `batch_id`. Missing
 *      row → mark a synthetic terminal entry and bail (the request file may
 *      have been hand-crafted; we still want a paper trail).
 *   3. Route by `decision` + `proposed_action.type`:
 *        - decision='wait'           → record + no side effect
 *        - confidence < threshold    → downgrade to notify
 *        - quiet hours active        → downgrade interrupt→notify
 *        - 'create_task'             → tasksRepository.create(...) with
 *                                       origin='ambient_deliberation' tag and a
 *                                       context.deliberation_id back-ref
 *        - 'notify'                  → fire an Electron Notification via
 *                                       notifications.notify(...)
 *        - 'none'                    → just record the row
 *   4. Complete the row with the scoring outcome + surfaced artifact (if any).
 *   5. Emit `deliberation_ingested` on the ioEvents bus.
 *
 * Zero LLM calls.
 */

import { appendAuditEventSafe } from '@/main/audit/log';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { settingsRepository } from '@/main/db/repositories/settings';
import { tasksRepository } from '@/main/db/repositories/tasks';
import { ioEvents } from '@/main/io/events';
import type {
  DeliberationProposedAction,
  DeliberationResult,
} from '@/shared/io-schemas';
import type {
  CreateTaskInput,
  Deliberation,
  DeliberationDecision,
  DeliberationSurfaceKind,
} from '@/shared/types';

import { isQuietHoursActive } from './orchestrator';
// Namespace import so `vi.spyOn(deliberationProtocol, 'archiveDeliberationRequest')`
// in tests can intercept the call site. Direct named imports would bind early
// and bypass the spy.
import * as deliberationProtocol from './protocol';

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const SETTING_CONFIDENCE_THRESHOLD = 'ambient_deliberation_confidence_threshold';

function readConfidenceThreshold(): number {
  try {
    const raw = settingsRepository.get(SETTING_CONFIDENCE_THRESHOLD);
    if (raw === null || raw === undefined) return DEFAULT_CONFIDENCE_THRESHOLD;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_CONFIDENCE_THRESHOLD;
    return n;
  } catch {
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }
}

/* -------------------------------------------------------------------------- */
/*  Notification surface — lazy import so tests can stub                      */
/* -------------------------------------------------------------------------- */

/**
 * Show an Electron toast. Lazy-loaded so non-Electron callers (tests, MCP)
 * don't pull in the Electron module at import time. Failures are non-fatal —
 * the row is still recorded.
 */
async function fireNotification(title: string, body: string): Promise<void> {
  try {
    const mod = (await import('@/main/notifications')) as {
      notify?: (opts: { title: string; body: string }) => void;
    };
    if (typeof mod.notify === 'function') {
      mod.notify({ title, body });
    }
  } catch {
    /* non-fatal */
  }
}

/* -------------------------------------------------------------------------- */
/*  Action routing                                                            */
/* -------------------------------------------------------------------------- */

interface SurfacingOutcome {
  decision: DeliberationDecision;
  surfaced_as: DeliberationSurfaceKind;
  surfaced_id: string | null;
}

/**
 * Resolve the final action type given the raw proposed action, the result's
 * decision, the active confidence threshold, and the quiet-hours flag.
 *
 * Decision rules:
 *   - decision === 'wait'  → 'none', no surfacing
 *   - confidence < threshold → 'none' (drop noisy nudges)
 *   - quiet hours + 'create_task' → downgrade to 'notify'
 *   - otherwise, honor the proposed action type
 */
function resolveActionType(
  result: DeliberationResult,
  proposed: DeliberationProposedAction | undefined,
  threshold: number,
): 'create_task' | 'notify' | 'none' {
  if (result.decision === 'wait') return 'none';
  if (result.confidence < threshold) return 'none';
  const raw = proposed?.type ?? 'none';
  if (raw === 'create_task' && isQuietHoursActive()) return 'notify';
  return raw;
}

/**
 * Spawn a task from the deliberation's proposed action. Returns the new task
 * id, or null when the proposed action lacked a title.
 */
function surfaceAsTask(
  deliberationId: string,
  batchId: string,
  proposed: DeliberationProposedAction,
): string | null {
  const title = proposed.title?.trim();
  if (!title) return null;
  const priority =
    proposed.priority === 'high'
      ? 'p1'
      : proposed.priority === 'low'
        ? 'p3'
        : 'p2';
  // SECURITY INVARIANT: ambient-deliberation-created tasks are ALWAYS
  // human-reviewed before any execution. We force agent_method='human_only'
  // and agent_executable=false here regardless of what `proposed` carries.
  // The deliberation pipeline doesn't currently feed permission scopes
  // through, so we refuse to create anything Claude could auto-execute —
  // closing the gap raised in the system audit (permissions not consulted
  // in ambient ingestion). If you ever extend ambient to auto-execute,
  // wire @/main/permissions#resolvePermissions here first.
  const input: CreateTaskInput = {
    title,
    description: proposed.body ?? null,
    priority,
    status: 'inbox',
    due: proposed.due ?? null,
    agent_method: 'human_only',
    agent_executable: false,
    tags: ['ambient_deliberation'],
    context: {
      origin: 'ambient_deliberation',
      deliberation_id: deliberationId,
      batch_id: batchId,
    },
  };
  // Defense-in-depth: if a future refactor accidentally flips either field
  // through `proposed`, fail loudly rather than silently create something
  // executable.
  if (input.agent_method !== 'human_only' || input.agent_executable !== false) {
    throw new Error(
      'ambient surfaceAsTask invariant violated: tasks must be human_only + not executable',
    );
  }
  const created = tasksRepository.create(input);
  appendAuditEventSafe({
    kind: 'ambient_task_created',
    payload: {
      task_id: created.id,
      deliberation_id: deliberationId,
      batch_id: batchId,
      priority,
    },
  });
  return created.id;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ingest a verified deliberation result. Returns the updated row or `null`
 * when no pending row matched the `batch_id` (no-op — caller may quarantine).
 */
/**
 * Best-effort archive of the consumed request file. Lives at module scope so
 * it can be invoked from BOTH the success path and every early-return — we
 * never want a file lingering in `io/deliberate/` after it's been seen,
 * because the watcher's polling fallback will re-dispatch it on every tick.
 * Idempotent — archiveDeliberationRequest returns silently if the file is
 * already gone.
 */
async function archiveQuietly(batchId: string): Promise<void> {
  try {
    await deliberationProtocol.archiveDeliberationRequest(batchId);
  } catch (err) {
    console.warn(
      '[deliberation] archive request failed (non-fatal):',
      (err as Error).message,
    );
  }
}

export async function ingestDeliberation(
  result: DeliberationResult,
): Promise<Deliberation | null> {
  const pending = deliberationsRepository.findByBatchId(result.batch_id);
  if (!pending) {
    // No matching row — archive the request anyway so we don't re-dispatch
    // forever on every polling tick. Quarantine handling is the caller's
    // responsibility; this just keeps the queue tidy.
    await archiveQuietly(result.batch_id);
    return null;
  }
  // Idempotency: the watcher may re-dispatch a deliberated file (manual
  // /api/io/ingest rescan, chokidar re-trigger on mtime touch, double-fire
  // race). Without this gate every redelivery would call surfaceAsTask
  // again and spawn duplicate inbox tasks. We refuse to re-process any
  // row that already has a terminal status — return it as-is so the caller
  // can still log success. Always archive the request file in this branch
  // too — otherwise the same already-completed deliberation keeps re-firing.
  if (pending.status !== 'pending') {
    await archiveQuietly(result.batch_id);
    return pending;
  }

  const threshold = readConfidenceThreshold();
  const proposed = result.interrupter.proposed_action;
  const actionType = resolveActionType(result, proposed, threshold);

  const outcome = await applyAction({
    actionType,
    deliberationId: pending.id,
    batchId: result.batch_id,
    proposed,
    result,
  });

  const completed = deliberationsRepository.complete(pending.id, {
    result_at: result.completed_at,
    interrupter_score: result.interrupter.score,
    waiter_score: result.waiter.score,
    decision: outcome.decision,
    surfaced_as: outcome.surfaced_as,
    surfaced_id: outcome.surfaced_id,
    summary: result.summary,
    raw_result: result as unknown as Record<string, unknown>,
  });

  if (completed) {
    ioEvents.emit('deliberation_ingested', {
      deliberationId: completed.id,
      batchId: result.batch_id,
      result,
      deliberation: completed,
    });
    appendAuditEventSafe({
      kind: 'deliberation_completed',
      payload: {
        deliberation_id: completed.id,
        batch_id: result.batch_id,
        decision: outcome.decision,
        surfaced_as: outcome.surfaced_as,
        surfaced_id: outcome.surfaced_id,
        confidence: result.confidence,
      },
    });
  }

  // Move the consumed request file into the archive AFTER the DB commit so a
  // filesystem failure here can never roll back the row.
  await archiveQuietly(result.batch_id);

  return completed;
}

interface ApplyActionInput {
  actionType: 'create_task' | 'notify' | 'none';
  deliberationId: string;
  batchId: string;
  proposed: DeliberationProposedAction | undefined;
  result: DeliberationResult;
}

/**
 * Side-effect side of {@link ingestDeliberation}. Kept in its own function so
 * the orchestration above stays under the project's 50-line house rule.
 */
async function applyAction(input: ApplyActionInput): Promise<SurfacingOutcome> {
  const { actionType, deliberationId, batchId, proposed, result } = input;
  if (actionType === 'create_task' && proposed) {
    const taskId = surfaceAsTask(deliberationId, batchId, proposed);
    if (taskId !== null) {
      return { decision: 'interrupt', surfaced_as: 'task', surfaced_id: taskId };
    }
  }
  if (actionType === 'notify') {
    const title = proposed?.title?.trim() || 'TaskPilot context update';
    const body = proposed?.body?.trim() || result.summary;
    await fireNotification(title, body);
    return { decision: 'interrupt', surfaced_as: 'notification', surfaced_id: null };
  }
  // No surfacing — either explicit 'none' or wait/threshold-gated.
  const decision: DeliberationDecision =
    result.decision === 'interrupt' ? 'interrupt' : 'wait';
  return { decision, surfaced_as: 'none', surfaced_id: null };
}
