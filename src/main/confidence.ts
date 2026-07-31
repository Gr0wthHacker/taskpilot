/**
 * Confidence scoring helpers.
 *
 * Claude can include `confidence: 0-1` on an `ExecutionResult`. When the
 * value falls below the configured threshold (default 0.7), ingestion
 * auto-routes the result to /review even when `review_required` is false.
 * The threshold is exposed in Settings → Agent.
 */

import { settingsRepository } from '@/main/db/repositories/settings';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Read the user-configured confidence threshold. Falls back to
 * {@link DEFAULT_CONFIDENCE_THRESHOLD} when the setting is missing, malformed,
 * or out of range. Threshold is always clamped to [0, 1].
 */
export function getConfidenceThreshold(): number {
  try {
    const raw = settingsRepository.get<unknown>('confidence_threshold');
    if (raw === null || raw === undefined) return DEFAULT_CONFIDENCE_THRESHOLD;
    let value: number;
    if (typeof raw === 'number') {
      value = raw;
    } else if (typeof raw === 'string') {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return DEFAULT_CONFIDENCE_THRESHOLD;
      value = parsed;
    } else {
      return DEFAULT_CONFIDENCE_THRESHOLD;
    }
    if (!Number.isFinite(value)) return DEFAULT_CONFIDENCE_THRESHOLD;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  } catch {
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }
}

/**
 * True when the supplied confidence value is below the configured threshold.
 * Returns `false` when no value is supplied — missing data is NOT treated as
 * low confidence (Claude may simply have omitted the field on an older
 * client). The trust-by-default flow handles missing fields naturally.
 */
export function isBelowThreshold(
  confidence: number | undefined,
  threshold?: number,
): boolean {
  if (confidence === undefined || confidence === null) return false;
  if (!Number.isFinite(confidence)) return false;
  const t = threshold ?? getConfidenceThreshold();
  return confidence < t;
}

/**
 * Bucket a confidence value into a discrete band. Used by the badge UI and
 * the per-task feedback log. The thresholds are intentionally fixed (NOT
 * tied to the user's gate threshold) so the visual contract stays stable
 * regardless of how strict the user wants the auto-routing to be.
 */
export type ConfidenceBand = 'high' | 'medium' | 'low' | 'unknown';

export function confidenceBand(
  confidence: number | undefined,
): ConfidenceBand {
  if (
    confidence === undefined ||
    confidence === null ||
    !Number.isFinite(confidence)
  ) {
    return 'unknown';
  }
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

/**
 * Human-friendly label for a confidence band. Used by the UI badge.
 */
export function confidenceLabel(
  confidence: number | undefined,
): string {
  const band = confidenceBand(confidence);
  if (band === 'unknown') return 'No confidence reported';
  if (band === 'high') return 'High confidence';
  if (band === 'medium') return 'Medium confidence';
  return 'Low confidence';
}
