/**
 * MCP tools for the ambient monitor layer (v6).
 *
 * Exposes context observations + deliberations to MCP clients so Claude Code
 * (and any other MCP consumer) can query the ambient pool without shelling
 * out to the local HTTP API. Every tool calls repositories directly — no
 * network hop, no bearer-token handshake.
 *
 * Surface:
 *
 *   - `taskpilot_list_observations`   — paginated list of context observations
 *   - `taskpilot_get_observation`     — single observation by id
 *   - `taskpilot_list_deliberations`  — paginated list of deliberation rows
 *   - `taskpilot_get_deliberation`    — single deliberation + joined observations
 *   - `taskpilot_request_deliberation`— manually queue a deliberation batch
 *   - `taskpilot_ambient_status`      — composed status (mirrors GET /api/context/status)
 *
 * Mirrors the response shapes of `src/main/server/routes/context.ts` so
 * MCP and HTTP clients see the same payloads.
 */

import { z } from 'zod';

import { CAPTURES_DIR } from '@/shared/constants';
import {
  contextObservationSourceSchema,
  deliberationTriggerReasonSchema,
  taskIdSchema,
} from '@/shared/io-schemas';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { settingsRepository } from '@/main/db/repositories/settings';
import { requestDeliberation } from '@/main/deliberation/orchestrator';
import type {
  ContextMonitorStatusResponse,
} from '@/shared/api-contract';
import type {
  ContextObservation,
  ContextObservationSource,
  Deliberation,
  DeliberationStatus,
  DeliberationTriggerReason,
} from '@/shared/types';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const listObservationsInput = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  source: contextObservationSourceSchema.optional(),
  since: z.string().max(64).optional(),
});

const getObservationInput = z.object({
  id: taskIdSchema,
});

const deliberationStatusSchema = z.enum([
  'pending',
  'completed',
  'failed',
  'skipped',
]);

const deliberationDecisionSchema = z.enum([
  'interrupt',
  'wait',
  'skipped',
]);

const listDeliberationsInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  status: deliberationStatusSchema.optional(),
  decision: deliberationDecisionSchema.optional(),
});

const getDeliberationInput = z.object({
  id: taskIdSchema,
});

/**
 * `request_deliberation` mirrors `POST /api/context/deliberate`. Observation
 * ids are optional — when omitted the orchestrator pulls the newest unbatched
 * rows. `reason` is constrained to the human-driven trigger values; ambient
 * automatic triggers (`batch_size`, `context_shift`) come from the batcher
 * only, never from a manual MCP call.
 */
const requestDeliberationInput = z.object({
  observation_ids: z.array(taskIdSchema).max(200).optional(),
  reason: z.enum(['manual', 'hotkey']).optional(),
});

const ambientStatusInput = z.object({});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read a boolean setting with a safe default. Mirrors `settingBool()` from
 * `src/main/server/routes/context.ts`; lifted here so the MCP tool isn't
 * coupled to the HTTP route module.
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
 * Today (local clock) as the ISO timestamp of midnight, suitable for the
 * `since` filter on `count()`. We use local time so the "observations today"
 * counter matches the user's wall clock.
 */
function startOfTodayIso(): string {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return midnight.toISOString();
}

/**
 * Hydrate the observations covered by a deliberation. The deliberation row
 * stores `observation_ids` as a JSON-encoded array; the repository parses it
 * back into `string[]`. We then fetch each row individually — there's no
 * batched `listByIds` helper, and the typical batch is ≤ 50 rows.
 */
function resolveObservationsForDeliberation(
  ids: string[],
): ContextObservation[] {
  const out: ContextObservation[] = [];
  for (const id of ids) {
    const row = contextObservationsRepository.get(id);
    if (row) out.push(row);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const listObservationsTool: McpTool<typeof listObservationsInput> = {
  name: 'taskpilot_list_observations',
  description:
    "List context observations from the ambient monitor (active-window snapshots, periodic screenshots, browser pages, manual captures). Ordered newest-first. Use to answer 'what has TaskPilot been watching?' or to inspect the observation pool before requesting a deliberation. Filter by source (window|screenshot|browser|manual), an ISO timestamp via `since`, or limit (max 200, default 50).",
  inputSchema: listObservationsInput,
  async handler(input) {
    const limit = input.limit ?? 50;
    const filter: Parameters<typeof contextObservationsRepository.list>[0] = {
      limit,
    };
    if (input.source !== undefined) {
      filter.source = input.source as ContextObservationSource;
    }
    if (input.since !== undefined) {
      filter.since = input.since;
    }
    const observations = contextObservationsRepository.list(filter);
    const total = contextObservationsRepository.count({
      source: filter.source,
      since: filter.since,
    });
    return { observations, total, count: observations.length };
  },
};

const getObservationTool: McpTool<typeof getObservationInput> = {
  name: 'taskpilot_get_observation',
  description:
    'Fetch a single context observation by id. Returns the full row including `screenshot_path` (when source=screenshot) and the JSON metadata blob. Use after `list_observations` to drill into a specific capture.',
  inputSchema: getObservationInput,
  async handler(input) {
    const observation = contextObservationsRepository.get(input.id);
    if (!observation) {
      throw new Error(`Observation ${input.id} not found`);
    }
    return { observation };
  },
};

const listDeliberationsTool: McpTool<typeof listDeliberationsInput> = {
  name: 'taskpilot_list_deliberations',
  description:
    "List deliberation rows — each one is a batch of observations scored by Claude's interrupter-vs-waiter protocol. Ordered newest-first. Use to inspect what surfaced (task, notification, or nothing) and why. Filter by status (pending|completed|failed|skipped) or decision (interrupt|wait|skipped). Limit defaults to 50, max 100.",
  inputSchema: listDeliberationsInput,
  async handler(input) {
    const limit = input.limit ?? 50;
    const filter: Parameters<typeof deliberationsRepository.list>[0] = {
      limit,
    };
    if (input.status !== undefined) {
      filter.status = input.status as DeliberationStatus;
    }
    // The repository filter doesn't support `decision` directly; we apply it
    // in-memory below. We fetch with a generous cap so post-filtering still
    // returns a meaningful page when decision is supplied.
    const fetchLimit = input.decision !== undefined ? Math.max(limit * 4, 200) : limit;
    const list = deliberationsRepository.list({ ...filter, limit: fetchLimit });
    const filtered =
      input.decision !== undefined
        ? list.filter((row) => row.decision === input.decision).slice(0, limit)
        : list;
    const total =
      input.decision !== undefined
        ? filtered.length
        : deliberationsRepository.count({ status: filter.status });
    return { deliberations: filtered, total, count: filtered.length };
  },
};

const getDeliberationTool: McpTool<typeof getDeliberationInput> = {
  name: 'taskpilot_get_deliberation',
  description:
    "Fetch a single deliberation row plus the observations it covered (hydrated from the row's observation_ids). Returns { deliberation, observations }. Use to investigate why a deliberation surfaced (or didn't) — the scoring fields (interrupter_score, waiter_score, decision, summary) live on the deliberation, the raw context lives on the observations.",
  inputSchema: getDeliberationInput,
  async handler(input) {
    const deliberation = deliberationsRepository.get(input.id);
    if (!deliberation) {
      throw new Error(`Deliberation ${input.id} not found`);
    }
    const observations = resolveObservationsForDeliberation(
      deliberation.observation_ids,
    );
    return { deliberation, observations };
  },
};

const requestDeliberationTool: McpTool<typeof requestDeliberationInput> = {
  name: 'taskpilot_request_deliberation',
  description:
    "Manually queue a deliberation batch — writes an io/deliberate/<batch_id>.json request and inserts a pending deliberations row. Use when the user explicitly asks to 'think about what I've been doing' or when an external agent wants to force ambient scoring. Observation ids are optional; if omitted, the orchestrator bundles the newest unbatched observations. Reason defaults to 'manual'.",
  inputSchema: requestDeliberationInput,
  async handler(input) {
    const reason: DeliberationTriggerReason = input.reason ?? 'manual';
    // Validate via the shared schema so the wire-format contract matches the
    // HTTP route's enforcement.
    deliberationTriggerReasonSchema.parse(reason);
    try {
      const outcome = await requestDeliberation({
        observation_ids: input.observation_ids,
        trigger_reason: reason,
      });
      return {
        batch_id: outcome.batch_id,
        deliberation_id: outcome.deliberation.id,
        request_path: outcome.request_path,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'deliberation failed';
      if (message.includes('no observations')) {
        throw new Error(
          'No observations available to deliberate over — capture some context first or pass explicit observation_ids',
        );
      }
      throw err;
    }
  },
};

const ambientStatusTool: McpTool<typeof ambientStatusInput> = {
  name: 'taskpilot_ambient_status',
  description:
    "Composed status for the ambient monitor — mirrors GET /api/context/status. Returns flags for the active-window monitor, periodic screenshots, and the Chrome extension, plus the timestamp of the most recent observation, the count of pending deliberations, and today's observation count. Use to answer 'is the monitor running?' or 'how busy has the ambient layer been today?'.",
  inputSchema: ambientStatusInput,
  async handler() {
    const monitorEnabled = settingBool('ambient_monitor_enabled', false);
    const screenshotEnabled = settingBool('ambient_screenshot_enabled', false);
    const extensionEnabled = settingBool('ambient_extension_enabled', false);
    // Panic-mode mirror — pulled from the same setting the monitor reads on
    // every tick, so the MCP-level status reflects the latest hotkey/tray
    // toggle without any caching layer in between.
    const panicModeActive = settingBool('ambient_panic_mode', false);
    const last = contextObservationsRepository.getLast();
    const pending = deliberationsRepository.count({ status: 'pending' });
    const observationsToday = contextObservationsRepository.count({
      since: startOfTodayIso(),
    });
    const status: ContextMonitorStatusResponse = {
      monitor_enabled: monitorEnabled,
      screenshot_enabled: screenshotEnabled,
      extension_enabled: extensionEnabled,
      panic_mode_active: panicModeActive,
      last_observation_at: last ? last.captured_at : null,
      pending_deliberations: pending,
      observations_today: observationsToday,
      captures_dir: CAPTURES_DIR,
    };
    return status;
  },
};

/* -------------------------------------------------------------------------- */
/*  Re-exports so the tool list type-checks even when a single member's       */
/*  inferred schema differs from the registry's `McpTool` widened type.       */
/* -------------------------------------------------------------------------- */

// Surface the Deliberation type to keep TS happy when handler returns are
// inspected via the registry — without this, tree-shaken builds may drop the
// import.
export type { Deliberation };

export const ambientTools: McpTool[] = [
  listObservationsTool as unknown as McpTool,
  getObservationTool as unknown as McpTool,
  listDeliberationsTool as unknown as McpTool,
  getDeliberationTool as unknown as McpTool,
  requestDeliberationTool as unknown as McpTool,
  ambientStatusTool as unknown as McpTool,
];
