/**
 * Cost tracking entry point.
 *
 * Two responsibilities:
 *   1. Record a cost event for a task — pricing-aware insert that fills in
 *      `cost_usd` from the hardcoded table if Claude didn't supply one.
 *   2. Aggregate cost rows by tag, workspace, or time window for the Reports
 *      view.
 *
 * Persisted row history is immutable — successive pricing-table changes do
 * NOT mutate prior rows. {@link aggregateCost} just sums whatever's on disk.
 */

import {
  costEventsRepository,
  type CreateCostEventInput,
  type ListCostEventsFilter,
} from '@/main/db/repositories/cost-events';
import { tasksRepository } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import type { CostEvent, CostTokens, Workspace } from '@/shared/types';

import { computeCost, lookupPricing, normalizeModel } from './pricing';

/* -------------------------------------------------------------------------- */
/*  Record                                                                    */
/* -------------------------------------------------------------------------- */

export interface RecordCostInput {
  task_id: string;
  tokens?: CostTokens;
  source?: string;
  third_party_label?: string;
  third_party_cost_usd?: number;
  at?: string;
}

/**
 * Persist a cost event. When `tokens.model` is supplied and the pricing
 * table knows it, USD is computed automatically. Third-party charges
 * (`third_party_cost_usd`) are summed into `cost_usd` so a single row can
 * carry both LLM and non-LLM spend if needed.
 *
 * Returns the persisted row (with `cost_usd` filled in).
 */
export function recordCost(input: RecordCostInput): CostEvent | null {
  if (!input.task_id) return null;
  // Skip empty rows — no tokens, no third-party charge → nothing to track.
  const hasTokens =
    !!input.tokens &&
    Object.values(input.tokens).some(
      (v) => typeof v === 'number' && v > 0,
    );
  const hasThirdParty =
    typeof input.third_party_cost_usd === 'number' &&
    input.third_party_cost_usd > 0;
  if (!hasTokens && !hasThirdParty) return null;

  const llmUsd = computeCost(input.tokens);
  const tpUsd = input.third_party_cost_usd ?? 0;
  const totalUsd = Math.round((llmUsd + tpUsd) * 1_000_000) / 1_000_000;

  const row: CreateCostEventInput = {
    task_id: input.task_id,
    model: input.tokens?.model ?? null,
    input_tokens: input.tokens?.input ?? null,
    output_tokens: input.tokens?.output ?? null,
    cache_read_tokens: input.tokens?.cache_read ?? null,
    cache_creation_tokens: input.tokens?.cache_creation ?? null,
    cost_usd: totalUsd === 0 ? null : totalUsd,
    source: input.source ?? null,
    third_party_label: input.third_party_label ?? null,
    third_party_cost_usd:
      input.third_party_cost_usd !== undefined
        ? input.third_party_cost_usd
        : null,
  };
  if (input.at) row.at = input.at;
  return costEventsRepository.create(row);
}

/* -------------------------------------------------------------------------- */
/*  Aggregations                                                              */
/* -------------------------------------------------------------------------- */

export interface CostBreakdownEntry {
  /** Group key — a tag name, workspace id, or model name. */
  key: string;
  /** Total USD across the matching cost events. */
  total_usd: number;
  /** Number of cost events that fell into this bucket. */
  events: number;
  /** Token totals — useful for showing "you spent N input tokens on X". */
  input_tokens: number;
  output_tokens: number;
}

export interface CostSummary {
  /** Total USD across all events in the window. */
  total_usd: number;
  /** Token totals across all events. */
  input_tokens: number;
  output_tokens: number;
  /** Number of cost events in the window. */
  events: number;
  /** Per-tag breakdown, sorted by `total_usd` descending. */
  by_tag: CostBreakdownEntry[];
  /** Per-workspace breakdown when workspaces are configured. */
  by_workspace: CostBreakdownEntry[];
  /** Per-model breakdown, sorted by `total_usd` descending. */
  by_model: CostBreakdownEntry[];
  /** ISO timestamps describing the window. */
  window: { from: string | null; to: string | null };
}

const EMPTY_ENTRY = (): Omit<CostBreakdownEntry, 'key'> => ({
  total_usd: 0,
  events: 0,
  input_tokens: 0,
  output_tokens: 0,
});

/**
 * Convert a window string (`"30d"`, `"7d"`, `"all"`, or a custom ISO range)
 * into a `from` / `to` pair. `to` is always `now`. Unknown windows fall back
 * to the all-time view.
 */
export function windowToRange(
  window: string | undefined,
): { from: string | null; to: string | null } {
  if (!window || window === 'all') return { from: null, to: null };
  const match = /^(\d+)d$/.exec(window);
  if (!match || !match[1]) return { from: null, to: null };
  const days = Number.parseInt(match[1], 10);
  if (!Number.isFinite(days) || days <= 0) return { from: null, to: null };
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Compute the cost summary for a window. We pull all events in the window
 * once and bucket them in memory — for a single-user TaskPilot install the
 * cardinality is tiny (hundreds, not millions). This keeps the SQL simple.
 */
export function aggregateCost(window?: string): CostSummary {
  const range = windowToRange(window);
  const filter: ListCostEventsFilter = { limit: 50_000 };
  if (range.from) filter.from = range.from;
  if (range.to) filter.to = range.to;
  const events = costEventsRepository.list(filter);

  const summary: CostSummary = {
    total_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    events: events.length,
    by_tag: [],
    by_workspace: [],
    by_model: [],
    window: range,
  };

  // Build lookup maps once so we don't re-fetch the task per event.
  const taskCache = new Map<string, ReturnType<typeof tasksRepository.findById>>();
  const workspaces = readWorkspaces();

  const tagBuckets = new Map<string, Omit<CostBreakdownEntry, 'key'>>();
  const wsBuckets = new Map<string, Omit<CostBreakdownEntry, 'key'>>();
  const modelBuckets = new Map<string, Omit<CostBreakdownEntry, 'key'>>();

  for (const evt of events) {
    const usd = evt.cost_usd ?? 0;
    const input = evt.input_tokens ?? 0;
    const output = evt.output_tokens ?? 0;
    summary.total_usd += usd;
    summary.input_tokens += input;
    summary.output_tokens += output;

    // Per-tag rollup.
    let task = taskCache.get(evt.task_id);
    if (task === undefined) {
      task = tasksRepository.findById(evt.task_id);
      taskCache.set(evt.task_id, task);
    }
    const tags = task?.tags ?? [];
    if (tags.length === 0) {
      bumpBucket(tagBuckets, '(untagged)', usd, input, output);
    } else {
      for (const tag of tags) {
        bumpBucket(tagBuckets, tag, usd, input, output);
      }
    }

    // Per-workspace rollup — a task belongs to a workspace if its tag set
    // intersects the workspace's tag set.
    let matchedWorkspace = false;
    for (const ws of workspaces) {
      if (tags.some((t) => ws.tags.includes(t))) {
        bumpBucket(wsBuckets, ws.id, usd, input, output);
        matchedWorkspace = true;
      }
    }
    if (!matchedWorkspace && workspaces.length > 0) {
      bumpBucket(wsBuckets, '(unscoped)', usd, input, output);
    }

    // Per-model rollup.
    const modelKey = evt.model ? normalizeModel(evt.model) : '(unknown)';
    bumpBucket(modelBuckets, modelKey, usd, input, output);
  }

  summary.by_tag = bucketToSortedEntries(tagBuckets);
  summary.by_workspace = bucketToSortedEntries(wsBuckets);
  summary.by_model = bucketToSortedEntries(modelBuckets);

  // Round the global totals so the renderer doesn't see floating-point noise.
  summary.total_usd = Math.round(summary.total_usd * 1_000_000) / 1_000_000;

  return summary;
}

function bumpBucket(
  map: Map<string, Omit<CostBreakdownEntry, 'key'>>,
  key: string,
  usd: number,
  input: number,
  output: number,
): void {
  const entry = map.get(key) ?? EMPTY_ENTRY();
  entry.total_usd += usd;
  entry.input_tokens += input;
  entry.output_tokens += output;
  entry.events += 1;
  map.set(key, entry);
}

function bucketToSortedEntries(
  map: Map<string, Omit<CostBreakdownEntry, 'key'>>,
): CostBreakdownEntry[] {
  return [...map.entries()]
    .map(([key, val]) => ({
      key,
      total_usd: Math.round(val.total_usd * 1_000_000) / 1_000_000,
      events: val.events,
      input_tokens: val.input_tokens,
      output_tokens: val.output_tokens,
    }))
    .sort((a, b) => b.total_usd - a.total_usd);
}

/**
 * Pull workspace definitions from the settings repository (stored as a JSON
 * array under the `workspaces` key). Returns an empty array when nothing is
 * configured so the rollup just skips the workspace breakdown.
 */
function readWorkspaces(): Workspace[] {
  try {
    const raw = settingsRepository.get<unknown>('workspaces');
    if (!Array.isArray(raw)) return [];
    const out: Workspace[] = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Workspace).id === 'string' &&
        Array.isArray((entry as Workspace).tags)
      ) {
        const w = entry as Workspace;
        out.push({
          id: w.id,
          name: w.name ?? w.id,
          tags: w.tags.filter((t) => typeof t === 'string'),
          ...(w.color !== undefined ? { color: w.color } : {}),
          ...(w.icon !== undefined ? { icon: w.icon } : {}),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Re-exports                                                                */
/* -------------------------------------------------------------------------- */

export { computeCost, lookupPricing, normalizeModel };
export type { CostTokens };
