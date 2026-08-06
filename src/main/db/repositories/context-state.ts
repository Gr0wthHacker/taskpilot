/**
 * Context state repository.
 * Always 'singleton' row — represents current work context.
 * Constantly updated by the context engine.
 */

import { eq } from 'drizzle-orm';

import { contextState, type ContextState, type UpdateContextState } from '@/shared/schema-v2';
import { getDb } from '../index';

const SINGLETON_ID = 'singleton';

/**
 * Get the current context state. Creates a default if not found.
 */
export function getContextState(): ContextState {
  const db = getDb();
  let row = db
    .select()
    .from(contextState)
    .where(eq(contextState.id, SINGLETON_ID))
    .get();

  if (!row) {
    // Initialize with empty state
    const now = new Date().toISOString();
    db.insert(contextState)
      .values({
        id: SINGLETON_ID,
        current_project_name: null,
        current_project_repo: null,
        current_project_goal: null,
        current_project_started_at: null,
        current_project_confidence: 0,
        research_threads: '[]',
        blockers: '[]',
        candidate_threads: '[]',
        updated_at: now,
      })
      .run();

    row = db
      .select()
      .from(contextState)
      .where(eq(contextState.id, SINGLETON_ID))
      .get()!;
  }

  return row;
}

/**
 * Update the context state. Only changed fields are updated.
 */
export function updateContextState(updates: UpdateContextState): ContextState {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(contextState)
    .set({
      ...updates,
      updated_at: now,
    })
    .where(eq(contextState.id, SINGLETON_ID))
    .run();

  return getContextState();
}

/**
 * Parse JSON fields from context state (for convenience).
 */
export function getContextStateDecoded() {
  const state = getContextState();
  return {
    ...state,
    research_threads: JSON.parse(state.research_threads ?? '[]') as unknown[],
    blockers: JSON.parse(state.blockers ?? '[]') as unknown[],
    candidate_threads: JSON.parse(state.candidate_threads ?? '[]') as unknown[],
  };
}
