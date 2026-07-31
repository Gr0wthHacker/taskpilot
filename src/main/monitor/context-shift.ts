/**
 * Context-shift detector.
 *
 * Pure function that scores how much the user's foreground context changed
 * between two consecutive observations. The score is `1 - Jaccard(tokens(a),
 * tokens(b))` over a small bag of tokens drawn from app name + window title
 * + URL + page title. A score above the monitor's threshold setting
 * force-flushes the current batch even if the size threshold hasn't tripped.
 *
 * Why Jaccard: cheap (no LLM, no heavy NLP), language-independent enough for
 * a 95th-percentile English/Latin user, and well-behaved on the
 * short-string inputs we feed it. We tokenize aggressively — lowercase,
 * strip punctuation, drop tokens shorter than 2 chars and a small stopword
 * list — so a single-word title change doesn't artificially dominate.
 *
 * No imports, no I/O — trivially unit-testable.
 */

/**
 * Observation slice this module cares about. Keeping it structural avoids a
 * dependency on the full `ContextObservation` shape so tests can pass plain
 * objects.
 */
export interface ContextShiftObservation {
  app_name?: string | null;
  window_title?: string | null;
  url?: string | null;
  page_title?: string | null;
}

const STOPWORDS = new Set<string>([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'is',
  'are',
  'was',
  'were',
  'be',
  'this',
  'that',
  'with',
  'from',
  'as',
  'by',
  'it',
  'its',
  'http',
  'https',
  'www',
  'com',
  'org',
  'net',
  'io',
  'html',
  'php',
]);

/**
 * Lowercase + strip non-alphanumeric. Splits on every other character so
 * `Inbox - Gmail` → `['inbox', 'gmail']`. URL hosts are tokenized by their
 * path segments too: `https://github.com/jack/taskpilot` →
 * `['github', 'jack', 'taskpilot']`.
 */
function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const split = lowered.split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const token of split) {
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Build a token set from the observation's text-bearing fields. Empty
 * strings, nulls, and whitespace-only values are skipped.
 */
function collectTokens(obs: ContextShiftObservation): Set<string> {
  const fields = [obs.app_name, obs.window_title, obs.url, obs.page_title];
  const bag = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string') continue;
    const trimmed = field.trim();
    if (trimmed.length === 0) continue;
    for (const token of tokenize(trimmed)) {
      bag.add(token);
    }
  }
  return bag;
}

/**
 * Jaccard similarity between two sets. `|A ∩ B| / |A ∪ B|`. Returns 1 when
 * both sets are empty (vacuously identical) so the shift score is 0 in that
 * case — we don't want an empty-vs-empty pair to flag as "shifted".
 */
function jaccardSimilarity<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const t of a) {
    if (b.has(t)) intersect++;
  }
  const union = a.size + b.size - intersect;
  if (union === 0) return 1;
  return intersect / union;
}

/**
 * Score the shift between two observations in `[0, 1]`. `0` means
 * "identical context"; `1` means "no token overlap at all". Comparing an
 * observation to itself yields `0`.
 *
 * @param previous The earlier observation. `null` returns `1` since there is
 *   no prior context to compare against (treat as max shift so the very
 *   first interesting observation can flush a tiny batch if the user wants).
 * @param next The new observation.
 */
export function contextShiftScore(
  previous: ContextShiftObservation | null,
  next: ContextShiftObservation,
): number {
  if (previous === null) return 1;
  const before = collectTokens(previous);
  const after = collectTokens(next);
  const sim = jaccardSimilarity(before, after);
  // Clamp into [0, 1] defensively; floating-point can land at 1.0000000002.
  const shift = 1 - sim;
  if (shift < 0) return 0;
  if (shift > 1) return 1;
  return shift;
}

/**
 * Convenience: returns true when the shift between `previous` and `next`
 * exceeds `threshold`. `threshold` is clamped to `[0, 1]`.
 */
export function isContextShift(
  previous: ContextShiftObservation | null,
  next: ContextShiftObservation,
  threshold: number,
): boolean {
  const clamped = Math.min(1, Math.max(0, threshold));
  return contextShiftScore(previous, next) > clamped;
}
