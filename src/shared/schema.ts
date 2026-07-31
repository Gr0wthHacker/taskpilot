/**
 * Drizzle schema for TaskPilot's local SQLite database.
 *
 * Mirrors the SQL in PRD §8. Two notable storage conventions:
 *   - Booleans are stored as integers (0/1) via `{ mode: 'boolean' }`.
 *   - `tasks.context` and `tasks.tags` are TEXT columns holding JSON-stringified
 *     payloads. Repositories handle (de)serialization — the Drizzle types here
 *     surface them as `string | null` so callers cannot accidentally write a
 *     raw object.
 */

import { relations, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

import type {
  AgentMethod,
  AgentStatus,
  DecisionCategory,
  ExecutionMethod,
  ExecutionStatus,
  FeedbackKind,
  GoalStatus,
  SyncDirection,
  TaskPriority,
  TaskStatus,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  tasks                                                                     */
/* -------------------------------------------------------------------------- */

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').$type<TaskStatus>().notNull().default('inbox'),
  priority: text('priority').$type<TaskPriority>().notNull().default('p2'),
  due: text('due'),
  calendar_event_id: text('calendar_event_id'),
  parent_id: text('parent_id').references((): AnySQLiteColumn => tasks.id),
  agent_executable: integer('agent_executable', { mode: 'boolean' })
    .notNull()
    .default(false),
  agent_method: text('agent_method')
    .$type<AgentMethod>()
    .notNull()
    .default('human_only'),
  agent_instructions: text('agent_instructions'),
  agent_status: text('agent_status')
    .$type<AgentStatus>()
    .notNull()
    .default('pending'),
  /** JSON-stringified Record<string, unknown>. */
  context: text('context'),
  /** JSON-stringified string[]. */
  tags: text('tags'),
  created_at: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updated_at: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* -------------------------------------------------------------------------- */
/*  execution_logs                                                            */
/* -------------------------------------------------------------------------- */

export const executionLogs = sqliteTable('execution_logs', {
  id: text('id').primaryKey(),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  started_at: text('started_at'),
  completed_at: text('completed_at'),
  method: text('method').$type<ExecutionMethod>(),
  status: text('status').$type<ExecutionStatus>(),
  output: text('output'),
  error: text('error'),
  log_path: text('log_path'),
});

/* -------------------------------------------------------------------------- */
/*  calendar_sync                                                             */
/* -------------------------------------------------------------------------- */

export const calendarSync = sqliteTable('calendar_sync', {
  task_id: text('task_id')
    .primaryKey()
    .references(() => tasks.id),
  event_id: text('event_id').notNull(),
  calendar_id: text('calendar_id').notNull(),
  last_synced: text('last_synced').notNull(),
  sync_direction: text('sync_direction').$type<SyncDirection>().notNull(),
});

/* -------------------------------------------------------------------------- */
/*  settings                                                                  */
/* -------------------------------------------------------------------------- */

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/* -------------------------------------------------------------------------- */
/*  task_templates                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reusable task blueprints. `tags` and `context` follow the same JSON-encoded
 * convention as the `tasks` table — repositories own the (de)serialization.
 */
export const taskTemplates = sqliteTable('task_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  task_title: text('task_title').notNull(),
  task_description: text('task_description'),
  priority: text('priority').$type<TaskPriority>(),
  agent_method: text('agent_method').$type<AgentMethod>(),
  agent_instructions: text('agent_instructions'),
  /** JSON-stringified string[]. */
  tags: text('tags'),
  /** JSON-stringified Record<string, unknown>. */
  context: text('context'),
  created_at: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updated_at: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* -------------------------------------------------------------------------- */
/*  cost_events (Wave 13)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One LLM / third-party cost row tied to a task. Pricing is computed by
 * `@/main/cost-tracking/pricing` at insert time; both the raw token counts
 * AND the resolved USD live on the row so a later pricing change doesn't
 * silently mutate history.
 */
export const costEvents = sqliteTable('cost_events', {
  id: text('id').primaryKey(),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  model: text('model'),
  input_tokens: integer('input_tokens'),
  output_tokens: integer('output_tokens'),
  cache_read_tokens: integer('cache_read_tokens'),
  cache_creation_tokens: integer('cache_creation_tokens'),
  cost_usd: real('cost_usd'),
  source: text('source'),
  third_party_label: text('third_party_label'),
  third_party_cost_usd: real('third_party_cost_usd'),
  at: text('at').notNull(),
});

/* -------------------------------------------------------------------------- */
/*  feedback (Wave 13)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Rejections and other human feedback signals against a task. The derive
 * flow surfaces rejections from similar prior tasks as "Past rejections"
 * guidance so Claude can avoid repeating mistakes.
 */
export const feedback = sqliteTable('feedback', {
  id: text('id').primaryKey(),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  kind: text('kind').$type<FeedbackKind>().notNull(),
  reason: text('reason'),
  details: text('details'),
  at: text('at').notNull(),
});

/* -------------------------------------------------------------------------- */
/*  decisions (Wave 16)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Append-only categorized notes tied to a task — the "decision log". Claude
 * writes entries during execute; the user adds them on TaskDetail. Rows are
 * never updated in place (corrections append a new row), so there is no
 * `updated_at`.
 */
export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  category: text('category').$type<DecisionCategory>().notNull().default('note'),
  text: text('text').notNull(),
  author: text('author').notNull().default('user'),
  link: text('link'),
  created_at: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* -------------------------------------------------------------------------- */
/*  goals (Wave 17 — goals / initiatives tier)                                */
/* -------------------------------------------------------------------------- */

/**
 * A tier above tasks. Tasks roll up to a goal via `context.goal_id` (explicit)
 * or by carrying any tag in `goals.tags` (soft membership). `tags` follows the
 * same JSON-encoded convention as the `tasks` table — the repository owns the
 * (de)serialization. Goals do NOT FK to tasks: deleting a goal detaches its
 * members (clears `context.goal_id`) but never deletes a task.
 */
export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').$type<GoalStatus>().notNull().default('active'),
  /** ISO date. */
  target_date: text('target_date'),
  /** Optional workspace id slug. */
  workspace: text('workspace'),
  /** JSON-stringified string[]. */
  tags: text('tags'),
  created_at: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updated_at: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* -------------------------------------------------------------------------- */
/*  recurring_schedules (v5 — time-driven scheduled fan-out)                  */
/* -------------------------------------------------------------------------- */

/**
 * Time-driven recurring schedule. Different from `task.context.recurrence`
 * (which is completion-driven — marking done spawns next). A schedule fires
 * on a wall-clock cadence regardless of whether any prior fire's tasks were
 * completed, and CAN fan out: one fire creates one task per child template
 * × per repo in the linked goal (if `fan_out_goal_id` is set).
 *
 * Encoded text columns:
 *   - `child_templates` is a JSON-stringified `ChildTemplate[]`
 *     (`{ title_template, instructions_template?, priority?, tags? }`)
 *
 * Time fields are ISO 8601 strings (UTC) — same convention as `tasks.due`.
 */
export const recurringSchedules = sqliteTable('recurring_schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** One of: 'daily' | 'weekdays' | 'weekly' | 'monthly'. */
  recurrence_kind: text('recurrence_kind').notNull(),
  recurrence_interval: integer('recurrence_interval').notNull().default(1),
  /** When the scheduler should next fire this rule. */
  next_fire_at: text('next_fire_at').notNull(),
  /** Last successful fire timestamp, or null when never fired. */
  last_fired_at: text('last_fired_at'),
  /** When set, fan out one child per repo in this goal. */
  fan_out_goal_id: text('fan_out_goal_id'),
  /** JSON-stringified ChildTemplate[]. */
  child_templates: text('child_templates').notNull(),
  created_at: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updated_at: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* -------------------------------------------------------------------------- */
/*  context_observations (v6 — ambient monitor)                               */
/* -------------------------------------------------------------------------- */

/**
 * Append-only log of every ambient capture (active window poll, periodic
 * screenshot, browser tab capture, explicit hotkey capture). Drives the
 * monitor's batching logic and the Watch view; cleared via retention
 * sweeps governed by `ambient_observation_retention_days`.
 *
 * Booleans are stored as integers, JSON payloads as TEXT — same conventions
 * as the rest of the schema. `metadata` is JSON-stringified
 * `Record<string, unknown>`.
 */
export const contextObservations = sqliteTable('context_observations', {
  id: text('id').primaryKey(),
  /** 'window' | 'screenshot' | 'browser' | 'manual' */
  source: text('source').notNull(),
  /** ISO 8601 timestamp. */
  captured_at: text('captured_at').notNull(),
  app_name: text('app_name'),
  window_title: text('window_title'),
  url: text('url'),
  page_title: text('page_title'),
  h1: text('h1'),
  meta_description: text('meta_description'),
  selection: text('selection'),
  screenshot_path: text('screenshot_path'),
  /** Nullable batch id — set when the row was bundled into a deliberation. */
  batch_id: text('batch_id'),
  /** JSON-stringified Record<string, unknown>. */
  metadata: text('metadata'),
  workspace_id: text('workspace_id'),
});

/* -------------------------------------------------------------------------- */
/*  deliberations (v6 — ambient monitor)                                      */
/* -------------------------------------------------------------------------- */

/**
 * One row per deliberation request issued to Claude via the io protocol.
 * Tracks the interrupter-vs-waiter outcome and the surfaced artifact (if any).
 * Powers the deliberation-history pane in the Watch view.
 *
 * `observation_ids` is JSON-stringified `string[]`. `raw_result` is the full
 * JSON dump of the deliberated result file for diagnostics. The
 * `surfaced_id` column is a soft FK to `tasks.id` (only when
 * `surfaced_as = 'task'`) — we don't enforce it at the DB layer because the
 * surfaced task may be archived/deleted independently.
 */
export const deliberations = sqliteTable('deliberations', {
  id: text('id').primaryKey(),
  /** Matches the file written to `~/.taskpilot/io/deliberate/<batch_id>.json`. */
  batch_id: text('batch_id').notNull(),
  requested_at: text('requested_at').notNull(),
  /** JSON-stringified context_observation IDs. */
  observation_ids: text('observation_ids').notNull(),
  /** 'batch_size' | 'context_shift' | 'manual' | 'hotkey' */
  trigger_reason: text('trigger_reason').notNull(),
  /** 'pending' | 'completed' | 'failed' | 'skipped' */
  status: text('status').notNull(),
  result_at: text('result_at'),
  interrupter_score: real('interrupter_score'),
  waiter_score: real('waiter_score'),
  /** 'interrupt' | 'wait' | 'skipped' */
  decision: text('decision'),
  /** 'task' | 'notification' | 'none' */
  surfaced_as: text('surfaced_as'),
  surfaced_id: text('surfaced_id'),
  summary: text('summary'),
  /** Full JSON dump of the deliberated result file. */
  raw_result: text('raw_result'),
});

/* -------------------------------------------------------------------------- */
/*  conversations (v7 — Claude Code session catalogue)                        */
/* -------------------------------------------------------------------------- */

/**
 * One row per ingested Claude Code (or other agent) session. The source of
 * truth for full transcripts is the on-disk JSONL file at `source_path`; this
 * row carries the metadata + a derived digest so the catalogue is searchable
 * without re-parsing every file on every query.
 *
 * Lifecycle:
 *   - On first ingest a row lands with `compressed_at = null` and `digest`
 *     holding a deterministic snippet (user prompts + code blocks + decisions).
 *   - When the conversation is >= `conversation_compression_days` old (default
 *     30), the compactor writes a `summarize_request` and Claude's response
 *     replaces `digest` with a real summary, sets `compressed_at`, and (if
 *     `conversation_retention_days` is non-null and exceeded) clears
 *     `source_path` so the JSONL can be deleted from disk.
 *
 * Topics (a string[]) and key_decisions (a string[]) are JSON-encoded TEXT
 * columns — same convention as `tasks.tags`. Token totals are nullable
 * because older JSONL formats don't carry them.
 */
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  /** 'claude_code' | 'claude_desktop' | 'manual' | other future source. */
  source: text('source').notNull().default('claude_code'),
  /** Stable id from the source (e.g. session_id from the JSONL). */
  source_id: text('source_id').notNull(),
  /** Absolute path to the on-disk transcript. Cleared on retention. */
  source_path: text('source_path'),
  /** Path of the project the session ran in (e.g. C:/Users/Jack/taskpilot). */
  project_path: text('project_path'),
  /** Short human title — derived from the first user message. */
  title: text('title'),
  /** ISO timestamp of the first message. */
  started_at: text('started_at').notNull(),
  /** ISO timestamp of the last message. */
  ended_at: text('ended_at').notNull(),
  /** Best-known model id (last seen wins). */
  model: text('model'),
  message_count: integer('message_count').notNull().default(0),
  input_tokens: integer('input_tokens'),
  output_tokens: integer('output_tokens'),
  cache_read_tokens: integer('cache_read_tokens'),
  cache_creation_tokens: integer('cache_creation_tokens'),
  cost_usd: real('cost_usd'),
  /**
   * Searchable digest. Pre-compression: concat of user prompts + code blocks +
   * extracted decisions. Post-compression: Claude-generated summary.
   */
  digest: text('digest'),
  /** JSON-stringified string[]. Topic tags extracted from the conversation. */
  topics: text('topics'),
  /** JSON-stringified string[]. Decision-shaped statements. */
  key_decisions: text('key_decisions'),
  /** JSON-stringified string[]. File paths touched/discussed. */
  files_touched: text('files_touched'),
  /** ISO timestamp; set when the rolling summarization replaced digest. */
  compressed_at: text('compressed_at'),
  /** ISO timestamp; set when source_path was cleared (retention). */
  archived_at: text('archived_at'),
  /** Hash of last-seen JSONL contents — skip re-ingest when unchanged. */
  content_hash: text('content_hash'),
  created_at: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updated_at: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * Many-to-many between conversations and tasks. A conversation can be linked
 * to multiple tasks (it was the execute step for two tasks, or the user
 * discussed multiple in one session). A task can have multiple conversations.
 *
 * `kind` distinguishes how the link was established so the UI can show
 * confidence ("auto-matched on cwd+time" vs "Claude pinned via session_id"
 * vs "human linked").
 */
export const conversationTaskLinks = sqliteTable('conversation_task_links', {
  id: text('id').primaryKey(),
  conversation_id: text('conversation_id')
    .notNull()
    .references(() => conversations.id),
  task_id: text('task_id')
    .notNull()
    .references(() => tasks.id),
  /** 'session_pin' | 'cwd_match' | 'tag_match' | 'manual' | 'execute_result'. */
  kind: text('kind').notNull().default('manual'),
  /** 0..1 — how confident we are the link is right. */
  confidence: real('confidence').notNull().default(1.0),
  created_at: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* -------------------------------------------------------------------------- */
/*  Relations                                                                 */
/* -------------------------------------------------------------------------- */

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  parent: one(tasks, {
    fields: [tasks.parent_id],
    references: [tasks.id],
    relationName: 'task_parent',
  }),
  children: many(tasks, { relationName: 'task_parent' }),
  executionLogs: many(executionLogs),
  calendarSync: one(calendarSync, {
    fields: [tasks.id],
    references: [calendarSync.task_id],
  }),
}));

export const executionLogsRelations = relations(executionLogs, ({ one }) => ({
  task: one(tasks, {
    fields: [executionLogs.task_id],
    references: [tasks.id],
  }),
}));

export const calendarSyncRelations = relations(calendarSync, ({ one }) => ({
  task: one(tasks, {
    fields: [calendarSync.task_id],
    references: [tasks.id],
  }),
}));

/* -------------------------------------------------------------------------- */
/*  Inferred row types                                                        */
/* -------------------------------------------------------------------------- */

export type TaskRow = typeof tasks.$inferSelect;
export type TaskRowInsert = typeof tasks.$inferInsert;

export type ExecutionLogRow = typeof executionLogs.$inferSelect;
export type ExecutionLogRowInsert = typeof executionLogs.$inferInsert;

export type CalendarSyncRowDb = typeof calendarSync.$inferSelect;
export type CalendarSyncRowInsert = typeof calendarSync.$inferInsert;

export type SettingsRow = typeof settings.$inferSelect;
export type SettingsRowInsert = typeof settings.$inferInsert;

export type TaskTemplateRow = typeof taskTemplates.$inferSelect;
export type TaskTemplateRowInsert = typeof taskTemplates.$inferInsert;

export type CostEventRow = typeof costEvents.$inferSelect;
export type CostEventRowInsert = typeof costEvents.$inferInsert;

export type FeedbackRow = typeof feedback.$inferSelect;
export type FeedbackRowInsert = typeof feedback.$inferInsert;

export type DecisionRow = typeof decisions.$inferSelect;
export type DecisionRowInsert = typeof decisions.$inferInsert;

export type GoalRow = typeof goals.$inferSelect;
export type GoalRowInsert = typeof goals.$inferInsert;

export type RecurringScheduleRow = typeof recurringSchedules.$inferSelect;
export type RecurringScheduleRowInsert =
  typeof recurringSchedules.$inferInsert;

export type ContextObservationRow = typeof contextObservations.$inferSelect;
export type ContextObservationRowInsert =
  typeof contextObservations.$inferInsert;

export type DeliberationRow = typeof deliberations.$inferSelect;
export type DeliberationRowInsert = typeof deliberations.$inferInsert;

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationRowInsert = typeof conversations.$inferInsert;

export type ConversationTaskLinkRow = typeof conversationTaskLinks.$inferSelect;
export type ConversationTaskLinkRowInsert =
  typeof conversationTaskLinks.$inferInsert;

/* -------------------------------------------------------------------------- */
/*  Database handle type                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Convenience alias for the drizzle DB handle bound to this schema.
 * Other modules should import this rather than re-deriving it.
 */
export const schema = {
  tasks,
  executionLogs,
  calendarSync,
  settings,
  taskTemplates,
  costEvents,
  feedback,
  decisions,
  goals,
  contextObservations,
  deliberations,
  conversations,
  conversationTaskLinks,
  tasksRelations,
  executionLogsRelations,
  calendarSyncRelations,
};

export type Schema = typeof schema;
export type DB = BetterSQLite3Database<Schema>;
