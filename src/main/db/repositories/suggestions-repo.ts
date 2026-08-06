/**
 * Suggestions repository.
 * Tracks generated suggestions and user interactions.
 */

import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { suggestions, type CreateSuggestion, type Suggestion } from '@/shared/schema-v2';
import { getDb } from '../index';

export function createSuggestion(input: Omit<CreateSuggestion, 'id' | 'created_at'>): Suggestion {
  const db = getDb();
  const id = nanoid(12);

  const row = db
    .insert(suggestions)
    .values({
      id,
      rank: input.rank,
      type: input.type,
      title: input.title,
      description: input.description,
      urgency: input.urgency ?? 'medium',
      action: input.action,
      estimated_minutes: input.estimated_minutes,
      confidence: input.confidence ?? 0.7,
      evidence: input.evidence,
      dismissed_at: null,
      actioned_at: null,
      created_at: new Date().toISOString(),
    })
    .returning()
    .get();

  return row;
}

export function getSuggestion(id: string): Suggestion | null {
  const db = getDb();
  return db
    .select()
    .from(suggestions)
    .where(eq(suggestions.id, id))
    .get() ?? null;
}

/**
 * Get active suggestions (not dismissed, not acted on).
 */
export function getActiveSuggestions(limit: number = 5): Suggestion[] {
  const db = getDb();

  return db
    .select()
    .from(suggestions)
    .where(and(isNull(suggestions.dismissed_at), isNull(suggestions.actioned_at)))
    .orderBy(desc(suggestions.rank))
    .limit(limit)
    .all();
}

/**
 * Dismiss a suggestion for 24 hours.
 */
export function dismissSuggestion(id: string): Suggestion | null {
  const db = getDb();

  db.update(suggestions)
    .set({ dismissed_at: new Date().toISOString() })
    .where(eq(suggestions.id, id))
    .run();

  return getSuggestion(id);
}

/**
 * Mark a suggestion as actioned (user converted it to a task or clicked "Do it").
 */
export function actionSuggestion(id: string): Suggestion | null {
  const db = getDb();

  db.update(suggestions)
    .set({ actioned_at: new Date().toISOString() })
    .where(eq(suggestions.id, id))
    .run();

  return getSuggestion(id);
}

/**
 * Un-dismiss a suggestion (user wants to see it again).
 */
export function undismissSuggestion(id: string): Suggestion | null {
  const db = getDb();

  db.update(suggestions)
    .set({ dismissed_at: null })
    .where(eq(suggestions.id, id))
    .run();

  return getSuggestion(id);
}

/**
 * Delete old dismissed suggestions (older than 30 days, already dismissed).
 */
export function pruneOldDismissedSuggestions(): number {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffIso = cutoff.toISOString();

  const result = db
    .delete(suggestions)
    .where(
      and(
        lte(suggestions.created_at, cutoffIso),
        isNull(suggestions.actioned_at)
      )
    )
    .run();

  return result.changes;
}

/**
 * Parse JSON fields from suggestion.
 */
export function getSuggestionDecoded(suggestion: Suggestion) {
  return {
    ...suggestion,
    evidence: JSON.parse(suggestion.evidence ?? '[]') as string[],
  };
}
