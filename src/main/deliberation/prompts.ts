/**
 * Static prompt strings embedded in every deliberation request. These mirror
 * the templates under `.claude/skills/ambient-deliberate/templates/` — the
 * skill reads the canonical copies, the request inlines a brief redundant
 * copy so Claude has the same rubric to score against whether or not the
 * skill is loaded.
 *
 * Keep both copies in sync. The templates have richer formatting and examples
 * for the skill prompt; this module is plain text the request payload
 * embeds as one-block strings.
 *
 * Pure module — no I/O, safe to import anywhere.
 */

/**
 * Interrupter role. Argues this batch should surface to Jack RIGHT NOW. Looks
 * for high-signal context shifts, time-sensitive cues, or alignment with a
 * task already in progress.
 */
export const INTERRUPTER_ROLE_PROMPT = [
  'You are the INTERRUPTER. Argue this batch warrants breaking the user\'s focus.',
  'Output a JSON object with: { "score": number in [0,1], "reasoning": string (<=400 chars), "proposed_action": { "type": "create_task"|"notify"|"none", "title"?: string, "body"?: string, "priority"?: "low"|"med"|"high", "due"?: string } }.',
  'Bias TOWARD acting only when the observation contains a fresh deadline, an explicit ask, an in-flight task at risk, or a multi-source convergence within the last 10 minutes.',
  'Be ruthless about false positives — every interrupt costs the user a context switch.',
].join(' ');

/**
 * Waiter role. Argues the batch can stay queued. Catches the routine browsing,
 * the repeated-app churn, the obvious-noise patterns.
 */
export const WAITER_ROLE_PROMPT = [
  'You are the WAITER. Argue this batch can stay queued and be reviewed later (or never).',
  'Output a JSON object with: { "score": number in [0,1], "reasoning": string (<=400 chars) }.',
  'Bias TOWARD waiting when observations are routine browsing, app-switching churn, content the user is consuming (not acting on), or anything already represented by an in-progress task.',
  'Default to waiting unless there is unambiguous evidence the user wants action now.',
].join(' ');

/**
 * Scoring rubric. The decision rule + tiebreakers Claude applies after both
 * roles report. Mirrors `templates/scoring-rubric.md`.
 */
export const SCORING_RUBRIC_PROMPT = [
  'DECISION RULE: decision = "interrupt" iff interrupter.score > waiter.score AND interrupter.score >= 0.6. Otherwise decision = "wait".',
  'CONFIDENCE: confidence = max(interrupter.score, waiter.score). When confidence < 0.6 and the decision was "interrupt", downgrade proposed_action.type to "notify" (a passive nudge instead of a new task).',
  'During quiet hours (quiet_hours_active === true), even an "interrupt" decision downgrades to a "notify" action.',
  'Write a one-line summary (<=200 chars) capturing the winning side\'s case.',
  'DO NOT call any external LLM API. Your judgment IS the deliberation.',
].join(' ');
