/**
 * Public surface for the ambient-monitor deliberation harness.
 *
 * Two roles:
 *
 *   - {@link requestDeliberation} — producer. Writes a deliberation request
 *     into `~/.taskpilot/io/deliberate/<batch_id>.json`, tags observations,
 *     and inserts a pending `deliberations` row. Called by the ambient
 *     batcher and `POST /api/context/deliberate`.
 *
 *   - {@link ingestDeliberation} — consumer. Dispatched by the IO watcher
 *     when a verdict lands in `~/.taskpilot/io/deliberated/<batch_id>.json`.
 *     Routes the proposed action to either a new task, a notification, or
 *     no surfacing — and completes the row.
 *
 * Neither half makes an LLM call. The two-agent scoring runs inside Claude
 * Code via the `ambient-deliberate` skill (see
 * `.claude/skills/ambient-deliberate/SKILL.md`).
 */

export { requestDeliberation, isQuietHoursActive } from './orchestrator';
export type {
  RequestDeliberationInput,
  RequestDeliberationOutput,
} from './orchestrator';

export { ingestDeliberation } from './ingestion';

export {
  writeDeliberationRequest,
  readDeliberationResult,
  cleanupDeliberation,
} from './protocol';

export {
  INTERRUPTER_ROLE_PROMPT,
  WAITER_ROLE_PROMPT,
  SCORING_RUBRIC_PROMPT,
} from './prompts';
