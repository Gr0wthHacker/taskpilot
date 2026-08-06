/**
 * TaskPilot v2 Schema: Observation, Context, Suggestions
 *
 * Extends the base schema with tables for ambient intelligence.
 * All timestaps are ISO 8601. All JSON is TEXT columns (callers deserialize).
 */

import { relations, sql } from 'drizzle-orm';
import {
  integer,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/* -------------------------------------------------------------------------- */
/*  Observation Events (Phase 1)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rolling 30-day window of observation events from all sources.
 * Events are immutable once inserted (no updates).
 */
export const observationEvents = sqliteTable('observation_events', {
  id: text('id').primaryKey(), // nanoid(12)
  timestamp: text('timestamp').notNull(), // ISO 8601
  source: text('source')
    .notNull() // 'browser' | 'github' | 'code' | 'search' | 'notes' | 'terminal'
    .$type<'browser' | 'github' | 'code' | 'search' | 'notes' | 'terminal'>(),
  type: text('type').notNull(), // e.g., 'page_visit', 'search_query', 'file_change'
  data: text('data').notNull(), // JSON stringified
  raw: text('raw'), // Original text (for search queries, notes)
  tags: text('tags'), // JSON array ['react', 'api', ...]
  confidence: real('confidence').default(1.0), // 0-1
  created_at: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export type ObservationEvent = typeof observationEvents.$inferSelect;
export type CreateObservationEvent = typeof observationEvents.$inferInsert;

/* -------------------------------------------------------------------------- */
/*  Context State (Phase 2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Single row, constantly updated. Snapshot of "what is Jack working on now?"
 * Includes current project, active research threads, blockers, candidate next steps.
 */
export const contextState = sqliteTable('context_state', {
  id: text('id').primaryKey().default('singleton'), // Always 'singleton'
  current_project_name: text('current_project_name'),
  current_project_repo: text('current_project_repo'),
  current_project_goal: text('current_project_goal'),
  current_project_started_at: text('current_project_started_at'),
  current_project_confidence: real('current_project_confidence').default(0),
  research_threads: text('research_threads'), // JSON array (denormalized)
  blockers: text('blockers'), // JSON array
  candidate_threads: text('candidate_threads'), // JSON array
  updated_at: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export type ContextState = typeof contextState.$inferSelect;
export type UpdateContextState = Partial<typeof contextState.$inferInsert>;

/**
 * Normalized research threads. One row per thread.
 * Linked from observation_events via observation_event_ids JSON array.
 */
export const researchThreads = sqliteTable('research_threads', {
  id: text('id').primaryKey(), // nanoid(12)
  query: text('query').notNull(), // e.g., "React render optimization"
  started_at: text('started_at').notNull(), // ISO 8601
  last_active: text('last_active').notNull(), // ISO 8601, updated on every event
  status: text('status')
    .notNull()
    .$type<'active' | 'paused' | 'concluded'>()
    .default('active'),
  findings: text('findings'), // JSON array of {link, text, source, timestamp}
  observation_event_ids: text('observation_event_ids'), // JSON array
  created_at: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export type ResearchThread = typeof researchThreads.$inferSelect;
export type CreateResearchThread = typeof researchThreads.$inferInsert;

/* -------------------------------------------------------------------------- */
/*  Suggestions (Phase 3)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Suggestions ranked and displayed to the user.
 * Each row is one suggestion. Used for history, dismissals, analytics.
 */
export const suggestions = sqliteTable('suggestions', {
  id: text('id').primaryKey(), // nanoid(12)
  rank: integer('rank'), // 1-5
  type: text('type')
    .notNull()
    .$type<'next_step' | 'related_research' | 'risk' | 'connection'>(),
  title: text('title').notNull(),
  description: text('description'),
  urgency: text('urgency')
    .notNull()
    .$type<'high' | 'medium' | 'low'>()
    .default('medium'),
  action: text('action'), // e.g., "Review PR #42"
  estimated_minutes: integer('estimated_minutes'),
  confidence: real('confidence').default(0.7), // 0-1
  evidence: text('evidence'), // JSON array of strings
  dismissed_at: text('dismissed_at'), // ISO 8601, null if not dismissed
  actioned_at: text('actioned_at'), // ISO 8601, null if not acted on
  created_at: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export type Suggestion = typeof suggestions.$inferSelect;
export type CreateSuggestion = typeof suggestions.$inferInsert;

/* -------------------------------------------------------------------------- */
/*  Auto-Approval Audit Log (Phase 5)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every auto-approved task is logged here for traceability and learning.
 * If user reverses an auto-approval, user_reversed_at is set.
 */
export const autoApprovals = sqliteTable('auto_approvals', {
  id: text('id').primaryKey(), // nanoid(12)
  task_id: text('task_id').notNull(),
  suggestion_id: text('suggestion_id'),
  reason: text('reason').notNull(), // e.g., "suggestion-derived, low-risk, 10 min"
  risk_level: text('risk_level')
    .notNull()
    .$type<'low' | 'medium' | 'high'>(),
  operation_type: text('operation_type')
    .notNull()
    .$type<'read_only' | 'local_execute' | 'api_call' | 'code_push'>(),
  auto_approved_at: text('auto_approved_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  user_reversed_at: text('user_reversed_at'), // null if not reversed
  created_at: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export type AutoApproval = typeof autoApprovals.$inferSelect;
export type CreateAutoApproval = typeof autoApprovals.$inferInsert;

/* -------------------------------------------------------------------------- */
/*  Briefing History (Phase 4)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Historical record of morning briefings generated.
 * Used for analytics: which suggestions did you act on, which were ignored?
 */
export const briefingHistories = sqliteTable('briefing_histories', {
  id: text('id').primaryKey(), // nanoid(12)
  generated_at: text('generated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  content: text('content').notNull(), // JSON: { summary, tasks_completed, suggestions, changes }
  suggestion_ids: text('suggestion_ids'), // JSON array of suggestions shown
  created_at: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export type BriefingHistory = typeof briefingHistories.$inferSelect;
export type CreateBriefingHistory = typeof briefingHistories.$inferInsert;
