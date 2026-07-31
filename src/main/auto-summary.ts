/**
 * Auto completion summary (Wave 16).
 *
 * When a task transitions to `done`, ingestion fires
 * {@link generateAndStoreCompletionSummary}, which collects the task's
 * {@link OutputBundle} (Wave 15B) and runs the PURE heuristic
 * {@link summarizeTaskCompletion} to produce a single one-liner. The result
 * lands at `task.context.completion_summary` and is rendered as an italic
 * subtitle on the TaskCard.
 *
 * There is NO LLM here — this is deterministic string assembly over the data
 * the task already produced. The output is capped at ~140 chars so it fits a
 * card subtitle.
 *
 * Variants, in priority order:
 *   1. failure   — "Failed: <error>" (when the bundle/journal says it failed)
 *   2. artifacts — "Done: opened PR #N…" / "linked calendar event" / etc.
 *   3. files     — "Done: produced N files — X"
 *   4. default   — "Done in {time}, {cost}" / "Done."
 */

import type { JournalEvent } from '@/shared/api-contract';
import type { OutputArtifact, OutputBundle, Task } from '@/shared/types';

/** Max length of a stored / displayed summary. */
export const MAX_SUMMARY_CHARS = 140;

/**
 * Clamp a string to `MAX_SUMMARY_CHARS`, appending an ellipsis when it had to
 * be cut. Collapses internal whitespace so multi-line summaries stay single
 * line on a card.
 */
function clampSummary(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_SUMMARY_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

/**
 * Render a duration in hours as a compact human label. `12.7` → "12.7h",
 * `0.4` → "24m", `48` → "2d". Returns null for non-finite / non-positive.
 */
function formatDuration(hours: number | null | undefined): string | null {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
    return null;
  }
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `${mins}m`;
  }
  if (hours < 48) {
    // One decimal, dropping a trailing ".0".
    const rounded = Math.round(hours * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}

/**
 * Render a USD cost as a compact label. Sub-cent costs round up to "<$0.01";
 * anything else gets two decimals. Returns null for zero / negative.
 */
function formatCost(usd: number | null | undefined): string | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Describe a single artifact as a short clause. The most actionable artifact
 * (a PR) leads; the rest get a generic clause. Returns null for shapes we
 * don't have a phrase for.
 */
function describeArtifact(a: OutputArtifact): string | null {
  switch (a.kind) {
    case 'github_pr':
      return `opened PR #${a.number}`;
    case 'github_issue':
      return `filed issue #${a.number}`;
    case 'calendar_event':
      return a.summary ? `scheduled "${a.summary}"` : 'scheduled a calendar event';
    case 'notion_page':
      return 'synced a Notion page';
    case 'slack_thread':
      return 'posted to Slack';
    case 'gmail_draft':
      return a.subject ? `drafted email "${a.subject}"` : 'drafted an email';
    default:
      return null;
  }
}

/**
 * Pick the "headline" artifact for the summary. PRs win, then issues, then
 * whatever the collector listed first. Returns null when there are none.
 */
function pickHeadlineArtifact(artifacts: OutputArtifact[]): OutputArtifact | null {
  if (artifacts.length === 0) return null;
  const pr = artifacts.find((a) => a.kind === 'github_pr');
  if (pr) return pr;
  const issue = artifacts.find((a) => a.kind === 'github_issue');
  if (issue) return issue;
  return artifacts[0] ?? null;
}

/**
 * Short label for a file — its basename. Strips any directory prefix from
 * the absolute path the collector hands back.
 */
function fileBasename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * Did this task end in failure? We trust, in order: an explicit failure in
 * the journal's most recent execution/result event, then the task status.
 * The first matching error string is returned so the summary can quote it.
 */
function detectFailure(
  task: Task,
  bundle: OutputBundle,
  journal: JournalEvent[],
): { failed: boolean; error: string | null } {
  // Journal carries the richest signal — walk newest-first for a failed
  // execution/result event and pull its error/summary.
  for (const ev of journal) {
    if (ev.kind === 'execution_completed' || ev.kind === 'result_ingested') {
      const status = ev.details?.['status'];
      if (status === 'failed') {
        const err =
          (typeof ev.details?.['error'] === 'string'
            ? (ev.details['error'] as string)
            : null) ??
          (typeof ev.details?.['summary'] === 'string'
            ? (ev.details['summary'] as string)
            : null);
        return { failed: true, error: err };
      }
      // A non-failed terminal event means the task did not fail; stop.
      if (status === 'succeeded') break;
    }
  }
  if (task.status === 'failed') {
    // Fall back to the bundle summary as the error blurb.
    return { failed: true, error: bundle.summary };
  }
  return { failed: false, error: null };
}

/* -------------------------------------------------------------------------- */
/*  Pure heuristic                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Produce a one-line completion summary from a task plus the data it
 * produced. PURE — no I/O, no LLM, no clock reads beyond what's in the
 * arguments. Always returns a non-empty, clamped string.
 *
 * @param task    The task at completion time.
 * @param bundle  The {@link OutputBundle} from the Wave 15B collector.
 * @param journal Optional journal events (newest-first). Used to detect
 *                failure and read the result error precisely. Pass `[]` when
 *                unavailable — the function degrades to the bundle alone.
 */
export function summarizeTaskCompletion(
  task: Task,
  bundle: OutputBundle,
  journal: JournalEvent[] = [],
): string {
  // 1. Failure variant ----------------------------------------------------
  const failure = detectFailure(task, bundle, journal);
  if (failure.failed) {
    const err = (failure.error ?? '').trim();
    return clampSummary(err ? `Failed: ${err}` : 'Failed.');
  }

  // 2. Artifact variant ---------------------------------------------------
  const headline = pickHeadlineArtifact(bundle.artifacts);
  if (headline) {
    const clause = describeArtifact(headline);
    if (clause) {
      const extra = bundle.artifacts.length - 1;
      const tail = extra > 0 ? ` (+${extra} more)` : '';
      return clampSummary(`Done: ${clause}${tail}.`);
    }
  }

  // 3. Files-only variant -------------------------------------------------
  const files = bundle.files ?? [];
  if (files.length > 0) {
    const n = files.length;
    const names = files
      .slice(0, 2)
      .map((f) => fileBasename(f.path))
      .filter((s) => s.length > 0);
    const sample = names.length > 0 ? ` — ${names.join(', ')}` : '';
    return clampSummary(
      `Done: produced ${n} file${n === 1 ? '' : 's'}${sample}.`,
    );
  }

  // 4. Default variant ----------------------------------------------------
  const duration = formatDuration(bundle.metrics?.time_to_done_hours);
  const cost = formatCost(bundle.metrics?.total_cost_usd);
  const bits: string[] = [];
  if (duration) bits.push(`in ${duration}`);
  if (cost) bits.push(cost);
  if (bits.length > 0) {
    return clampSummary(`Done ${bits.join(', ')}.`);
  }
  // Nothing measurable — fall back to the result summary, then a bare "Done."
  const fallback = (bundle.summary ?? '').trim();
  return clampSummary(fallback ? `Done: ${fallback}` : 'Done.');
}

/* -------------------------------------------------------------------------- */
/*  Store-side helper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Defensively collect a task's {@link OutputBundle} via the Wave 15B
 * collector. The import is dynamic + try/caught so a missing collector (or a
 * task with no outputs at all) degrades to "no bundle" rather than throwing.
 * Returns null on any failure.
 */
async function collectBundleDefensively(
  taskId: string,
): Promise<OutputBundle | null> {
  try {
    const mod = await import('@/main/outputs/collector');
    if (typeof mod.collectOutputs !== 'function') return null;
    const out = await mod.collectOutputs(taskId);
    return out ?? null;
  } catch {
    return null;
  }
}

/**
 * Defensively collect a task's journal (newest-first) so failure detection
 * has the richest signal. Returns `[]` on any failure.
 */
async function collectJournalDefensively(
  taskId: string,
): Promise<JournalEvent[]> {
  try {
    const mod = await import('@/main/journal/aggregator');
    if (typeof mod.getTaskJournal !== 'function') return [];
    const out = await mod.getTaskJournal(taskId);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * Generate the completion summary for a task and persist it onto
 * `task.context.completion_summary`. Best-effort: NEVER throws, NEVER blocks
 * the caller on failure. Returns the stored summary string, or null when it
 * couldn't produce / store one.
 *
 * Called from ingestion right after a task is marked `done`. Because it does
 * its own DB read + write through the tasks repository (also via a defensive
 * dynamic import so a partial build can't break ingestion), it's safe to
 * fire-and-forget.
 */
export async function generateAndStoreCompletionSummary(
  taskId: string,
): Promise<string | null> {
  try {
    const tasksMod = await import('@/main/db/repositories/tasks');
    const getTask = tasksMod.getTask;
    const updateTask = tasksMod.updateTask;
    if (typeof getTask !== 'function' || typeof updateTask !== 'function') {
      return null;
    }

    const task = getTask(taskId);
    if (!task) return null;
    // Only summarize completed work. `succeeded` results that route to
    // /review land the task in `blocked`, not `done` — we don't want a
    // "Done…" subtitle on something still awaiting review. Failures are the
    // one exception: a `failed` task gets a "Failed: …" summary.
    if (task.status !== 'done' && task.status !== 'failed') return null;

    const [bundle, journal] = await Promise.all([
      collectBundleDefensively(taskId),
      collectJournalDefensively(taskId),
    ]);
    // Without a bundle we still want a usable default — synthesize an empty
    // one so the heuristic can lean on task status / journal alone.
    const effectiveBundle: OutputBundle =
      bundle ??
      ({
        task_id: taskId,
        generated_at: new Date().toISOString(),
        summary: null,
        files: [],
        artifacts: [],
        attachments: [],
        metrics: {
          total_cost_usd: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          time_to_done_hours: null,
          last_confidence: null,
          execution_count: 0,
        },
      } satisfies OutputBundle);

    const summary = summarizeTaskCompletion(task, effectiveBundle, journal);
    if (!summary) return null;

    const baseContext =
      task.context && typeof task.context === 'object'
        ? (task.context as Record<string, unknown>)
        : {};
    updateTask(taskId, {
      context: {
        ...baseContext,
        completion_summary: summary,
        completion_summary_at: new Date().toISOString(),
      },
    });
    return summary;
  } catch {
    // Best-effort — swallow everything.
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Test re-exports                                                           */
/* -------------------------------------------------------------------------- */

export const __internals = {
  clampSummary,
  formatDuration,
  formatCost,
  describeArtifact,
  pickHeadlineArtifact,
  fileBasename,
  detectFailure,
};
