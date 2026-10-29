/**
 * Inline migration runner.
 *
 * Fallback for when `drizzle-kit generate` hasn't produced a `./drizzle/`
 * folder yet (or in production builds that ship without it). Runs the raw
 * SQL from PRD §8 via `db.exec()`.
 *
 * Idempotency: every statement is `IF NOT EXISTS`, but in addition the runner
 * checks `sqlite_master` for the baseline `tasks` table before executing
 * anything. That keeps the noisy "table exists" warnings from firing on every
 * boot once drizzle has taken over — the inline runner becomes a true no-op
 * the moment `_schema_version` records version >= 1.
 */

import type Database from 'better-sqlite3';

import {
  CURRENT_SCHEMA_VERSION,
  ensureSchemaVersionTable,
  getCurrentVersion,
  setVersion,
} from './schema-version.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  priority TEXT NOT NULL DEFAULT 'p2',
  due TEXT,
  calendar_event_id TEXT,
  parent_id TEXT REFERENCES tasks(id),
  agent_executable INTEGER NOT NULL DEFAULT 0,
  agent_method TEXT NOT NULL DEFAULT 'human_only',
  agent_instructions TEXT,
  agent_status TEXT NOT NULL DEFAULT 'pending',
  context TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_executable ON tasks(agent_executable);
-- v8 composite indexes for cursor-paginated lists and parent/agent queries
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_status ON tasks(parent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created ON tasks(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status_created ON tasks(agent_executable, status, created_at DESC);

CREATE TABLE IF NOT EXISTS execution_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  started_at TEXT,
  completed_at TEXT,
  method TEXT,
  status TEXT,
  output TEXT,
  error TEXT,
  log_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_task ON execution_logs(task_id);

CREATE TABLE IF NOT EXISTS calendar_sync (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  event_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  last_synced TEXT NOT NULL,
  sync_direction TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_event ON calendar_sync(event_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  task_title TEXT NOT NULL,
  task_description TEXT,
  priority TEXT,
  agent_method TEXT,
  agent_instructions TEXT,
  tags TEXT,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_templates_name ON task_templates(name);

CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  source TEXT,
  third_party_label TEXT,
  third_party_cost_usd REAL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_events_task ON cost_events(task_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_at ON cost_events(at);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  reason TEXT,
  details TEXT,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_task ON feedback(task_id);
CREATE INDEX IF NOT EXISTS idx_feedback_kind ON feedback(kind);
CREATE INDEX IF NOT EXISTS idx_feedback_at ON feedback(at);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  category TEXT NOT NULL DEFAULT 'note',
  text TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user',
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  target_date TEXT,
  workspace TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_workspace ON goals(workspace);

CREATE TABLE IF NOT EXISTS recurring_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  recurrence_kind TEXT NOT NULL,
  recurrence_interval INTEGER NOT NULL DEFAULT 1,
  next_fire_at TEXT NOT NULL,
  last_fired_at TEXT,
  fan_out_goal_id TEXT,
  child_templates TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recurring_schedules_enabled ON recurring_schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_next_fire ON recurring_schedules(next_fire_at);

CREATE TABLE IF NOT EXISTS context_observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  app_name TEXT,
  window_title TEXT,
  url TEXT,
  page_title TEXT,
  h1 TEXT,
  meta_description TEXT,
  selection TEXT,
  screenshot_path TEXT,
  batch_id TEXT,
  metadata TEXT,
  workspace_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_context_observations_captured_at ON context_observations(captured_at);
CREATE INDEX IF NOT EXISTS idx_context_observations_source ON context_observations(source);
CREATE INDEX IF NOT EXISTS idx_context_observations_batch_id ON context_observations(batch_id);
CREATE INDEX IF NOT EXISTS idx_context_observations_workspace_id ON context_observations(workspace_id);

CREATE TABLE IF NOT EXISTS deliberations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  observation_ids TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  status TEXT NOT NULL,
  result_at TEXT,
  interrupter_score REAL,
  waiter_score REAL,
  decision TEXT,
  surfaced_as TEXT,
  surfaced_id TEXT,
  summary TEXT,
  raw_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliberations_status ON deliberations(status);
CREATE INDEX IF NOT EXISTS idx_deliberations_requested_at ON deliberations(requested_at);
CREATE INDEX IF NOT EXISTS idx_deliberations_batch_id ON deliberations(batch_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'claude_code',
  source_id TEXT NOT NULL,
  source_path TEXT,
  project_path TEXT,
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  model TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  digest TEXT,
  topics TEXT,
  key_decisions TEXT,
  files_touched TEXT,
  compressed_at TEXT,
  archived_at TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source, source_id);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_path);
CREATE INDEX IF NOT EXISTS idx_conversations_started ON conversations(started_at);
CREATE INDEX IF NOT EXISTS idx_conversations_ended ON conversations(ended_at);
CREATE INDEX IF NOT EXISTS idx_conversations_compressed ON conversations(compressed_at);

CREATE TABLE IF NOT EXISTS conversation_task_links (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_task_links_pair ON conversation_task_links(conversation_id, task_id);
CREATE INDEX IF NOT EXISTS idx_conv_task_links_task ON conversation_task_links(task_id);

CREATE TABLE IF NOT EXISTS task_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total INTEGER NOT NULL DEFAULT 0,
  inbox INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  in_progress INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  review_pending INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  agent_executable_open INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO task_stats (id) VALUES (1);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('text','url','file')),
  raw_content TEXT NOT NULL,
  summary TEXT,
  tags TEXT,
  entities TEXT,
  title TEXT,
  source_url TEXT,
  source_path TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'raw' CHECK (status IN ('raw','enriched','failed')),
  enrichment_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  enriched_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_items_status_created ON memory_items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_kind_created ON memory_items(kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_hash ON memory_items(content_hash);

CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('memory','task','goal')),
  target_id TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('related','refers_to','duplicate_of')),
  score REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_kind, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_unique ON memory_links(source_id, target_kind, target_id, link_kind);

CREATE TABLE IF NOT EXISTS memory_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total INTEGER NOT NULL DEFAULT 0,
  raw INTEGER NOT NULL DEFAULT 0,
  enriched INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  kind_text INTEGER NOT NULL DEFAULT 0,
  kind_url INTEGER NOT NULL DEFAULT 0,
  kind_file INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO memory_stats (id) VALUES (1);
`;

/**
 * Schema v2 additions — `cost_events` and `feedback`. Idempotent so it runs
 * on every boot for installs that pre-date v2 without needing to know if the
 * baseline ran or not.
 *
 * Defined separately from the main baseline because the baseline runner
 * short-circuits when `tasks` already exists — and we need these tables to
 * also land on databases that were created at v1 (where the baseline tables
 * already exist but cost/feedback do not).
 */
const V2_SQL = `
CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  source TEXT,
  third_party_label TEXT,
  third_party_cost_usd REAL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_events_task ON cost_events(task_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_at ON cost_events(at);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  reason TEXT,
  details TEXT,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_task ON feedback(task_id);
CREATE INDEX IF NOT EXISTS idx_feedback_kind ON feedback(kind);
CREATE INDEX IF NOT EXISTS idx_feedback_at ON feedback(at);
`;

/**
 * Schema v3 additions — the `decisions` table (Wave 16 decision log).
 * Idempotent so it can run on every boot for installs that pre-date v3
 * without needing to know which prior add-ons already ran. Mirrors the
 * baseline `decisions` block in {@link SCHEMA_SQL}.
 */
const V3_SQL = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  category TEXT NOT NULL DEFAULT 'note',
  text TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user',
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
`;

/**
 * Schema v4 additions — the `goals` table (Wave 17 goals / initiatives tier).
 * Idempotent so it can run on every boot for installs that pre-date v4 without
 * needing to know which prior add-ons already ran. Mirrors the baseline
 * `goals` block in {@link SCHEMA_SQL}.
 */
const V4_SQL = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  target_date TEXT,
  workspace TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_workspace ON goals(workspace);
`;

/**
 * Schema v5 additions — `recurring_schedules`. Time-driven scheduled
 * fan-out: one fire creates N×M tasks (per repo in linked goal × per child
 * template). Distinct from `task.context.recurrence` which is
 * completion-driven. Idempotent so older installs auto-upgrade.
 */
const V5_SQL = `
CREATE TABLE IF NOT EXISTS recurring_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  recurrence_kind TEXT NOT NULL,
  recurrence_interval INTEGER NOT NULL DEFAULT 1,
  next_fire_at TEXT NOT NULL,
  last_fired_at TEXT,
  fan_out_goal_id TEXT,
  child_templates TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recurring_schedules_enabled ON recurring_schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_next_fire ON recurring_schedules(next_fire_at);
`;

/**
 * Schema v6 additions — `context_observations` + `deliberations` (ambient
 * monitor). Idempotent so it can run on every boot for installs that pre-date
 * v6 without needing to know which prior add-ons already ran. Mirrors the
 * baseline blocks for these tables (added to {@link SCHEMA_SQL} below).
 */
const V6_SQL = `
CREATE TABLE IF NOT EXISTS context_observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  app_name TEXT,
  window_title TEXT,
  url TEXT,
  page_title TEXT,
  h1 TEXT,
  meta_description TEXT,
  selection TEXT,
  screenshot_path TEXT,
  batch_id TEXT,
  metadata TEXT,
  workspace_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_context_observations_captured_at ON context_observations(captured_at);
CREATE INDEX IF NOT EXISTS idx_context_observations_source ON context_observations(source);
CREATE INDEX IF NOT EXISTS idx_context_observations_batch_id ON context_observations(batch_id);
CREATE INDEX IF NOT EXISTS idx_context_observations_workspace_id ON context_observations(workspace_id);

CREATE TABLE IF NOT EXISTS deliberations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  observation_ids TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  status TEXT NOT NULL,
  result_at TEXT,
  interrupter_score REAL,
  waiter_score REAL,
  decision TEXT,
  surfaced_as TEXT,
  surfaced_id TEXT,
  summary TEXT,
  raw_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliberations_status ON deliberations(status);
CREATE INDEX IF NOT EXISTS idx_deliberations_requested_at ON deliberations(requested_at);
CREATE INDEX IF NOT EXISTS idx_deliberations_batch_id ON deliberations(batch_id);
`;

/**
 * Schema v7 additions — `conversations` + `conversation_task_links` (Claude
 * Code session catalogue). Mirrors the baseline blocks for these tables.
 */
const V7_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'claude_code',
  source_id TEXT NOT NULL,
  source_path TEXT,
  project_path TEXT,
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  model TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,
  digest TEXT,
  topics TEXT,
  key_decisions TEXT,
  files_touched TEXT,
  compressed_at TEXT,
  archived_at TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source, source_id);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_path);
CREATE INDEX IF NOT EXISTS idx_conversations_started ON conversations(started_at);
CREATE INDEX IF NOT EXISTS idx_conversations_ended ON conversations(ended_at);
CREATE INDEX IF NOT EXISTS idx_conversations_compressed ON conversations(compressed_at);

CREATE TABLE IF NOT EXISTS conversation_task_links (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_task_links_pair ON conversation_task_links(conversation_id, task_id);
CREATE INDEX IF NOT EXISTS idx_conv_task_links_task ON conversation_task_links(task_id);
`;

/**
 * Schema v8 — scalability wave.
 *
 * Two pieces:
 *  1. Composite indexes that match the actual ORDER BY clauses used in
 *     list/page queries. At ~33k rows the single-column indexes still
 *     resolve, but the engine has to read all matching rows out of order
 *     and sort them. With (status, created_at DESC) the scan is in
 *     index-order, which is what cursor pagination needs to stay sub-ms
 *     at 1M rows.
 *  2. `task_stats` — a tiny single-row materialization of counts by status.
 *     Sidebar badges, command-palette hints, and the daily-plan view all
 *     call `SELECT COUNT(*) FROM tasks WHERE status=?` on every refetch;
 *     this table lets them read pre-computed numbers.
 *
 * All statements are idempotent.
 */
const V8_SQL = `
CREATE INDEX IF NOT EXISTS idx_tasks_status_created
  ON tasks(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_parent_status
  ON tasks(parent_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created
  ON tasks(status, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_agent_status_created
  ON tasks(agent_executable, status, created_at DESC);

CREATE TABLE IF NOT EXISTS task_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total INTEGER NOT NULL DEFAULT 0,
  inbox INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  in_progress INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  review_pending INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  agent_executable_open INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO task_stats (id) VALUES (1);
`;

/**
 * Schema v9 — memory subsystem.
 *
 * Three pieces:
 *  1. `memory_items` — the dumped artifacts. Each row is one drop (text snippet,
 *     URL, file) that the user wants to remember. `raw_content` is the source
 *     (the pasted text, the fetched HTML→md, the extracted file text);
 *     `summary` / `tags` / `entities` are written by the AI enrichment loop.
 *     `status='raw'` until enrichment lands; `'enriched'` after.
 *  2. `memory_links` — graph edges between memory items, or from memory items
 *     to tasks/goals. Lets the detail view surface "related" without re-running
 *     similarity at read time.
 *  3. `memory_stats` — singleton counts row (raw vs enriched, by-kind). Same
 *     materialization pattern as `task_stats`.
 *
 * All blocks idempotent — `CREATE … IF NOT EXISTS` everywhere.
 */
const V9_SQL = `
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('text','url','file')),
  -- For text: the pasted body. For url: HTML→markdown of the fetched page.
  -- For file: extracted plain text. Capped at ~1 MB so a runaway paste can't
  -- balloon the DB.
  raw_content TEXT NOT NULL,
  -- AI-written one-paragraph summary. Null until enrichment lands.
  summary TEXT,
  -- AI-suggested tags. JSON array; null until enrichment lands.
  tags TEXT,
  -- Extracted entities (people, orgs, URLs). JSON object; null until enrichment.
  entities TEXT,
  -- Caller-supplied or auto-set:
  title TEXT,
  -- For kind='url' the source URL; for 'file' the relative path under
  -- ~/.taskpilot/memory/files/. Null for plain text drops.
  source_url TEXT,
  source_path TEXT,
  -- sha256 of the trimmed raw_content for dedup on capture.
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'raw' CHECK (status IN ('raw','enriched','failed')),
  enrichment_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  enriched_at TEXT
);

-- Hot paths: list by created_at desc, filter by status, lookup by hash for dedup.
CREATE INDEX IF NOT EXISTS idx_memory_items_status_created
  ON memory_items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_kind_created
  ON memory_items(kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_hash
  ON memory_items(content_hash);

CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  -- One of: 'memory:<id>' | 'task:<id>' | 'goal:<id>'.
  target_kind TEXT NOT NULL CHECK (target_kind IN ('memory','task','goal')),
  target_id TEXT NOT NULL,
  -- 'related' (similarity), 'refers_to' (explicit mention), 'duplicate_of'.
  link_kind TEXT NOT NULL CHECK (link_kind IN ('related','refers_to','duplicate_of')),
  score REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_target
  ON memory_links(target_kind, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_unique
  ON memory_links(source_id, target_kind, target_id, link_kind);

CREATE TABLE IF NOT EXISTS memory_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total INTEGER NOT NULL DEFAULT 0,
  raw INTEGER NOT NULL DEFAULT 0,
  enriched INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  kind_text INTEGER NOT NULL DEFAULT 0,
  kind_url INTEGER NOT NULL DEFAULT 0,
  kind_file INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO memory_stats (id) VALUES (1);
`;

const V10_SQL = `
CREATE TABLE IF NOT EXISTS observation_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  raw TEXT,
  tags TEXT,
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_observation_events_timestamp_source
  ON observation_events(timestamp DESC, source);
CREATE INDEX IF NOT EXISTS idx_observation_events_source
  ON observation_events(source);

CREATE TABLE IF NOT EXISTS context_state (
  id TEXT PRIMARY KEY,
  current_project_name TEXT,
  current_project_repo TEXT,
  current_project_goal TEXT,
  current_project_started_at TEXT,
  current_project_confidence REAL DEFAULT 0,
  research_threads TEXT,
  blockers TEXT,
  candidate_threads TEXT,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS research_threads (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_active TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  findings TEXT,
  observation_event_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_research_threads_status_last_active
  ON research_threads(status, last_active DESC);
CREATE INDEX IF NOT EXISTS idx_research_threads_query
  ON research_threads(query);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  rank INTEGER,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  urgency TEXT DEFAULT 'medium',
  action TEXT,
  estimated_minutes INTEGER,
  confidence REAL DEFAULT 0.7,
  evidence TEXT,
  dismissed_at TEXT,
  actioned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_suggestions_created_at_dismissed_actioned
  ON suggestions(created_at DESC, dismissed_at, actioned_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_active
  ON suggestions(dismissed_at, actioned_at)
  WHERE dismissed_at IS NULL AND actioned_at IS NULL;

CREATE TABLE IF NOT EXISTS auto_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  suggestion_id TEXT,
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  auto_approved_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  user_reversed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_auto_approvals_task_id
  ON auto_approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_auto_approvals_auto_approved_at
  ON auto_approvals(auto_approved_at DESC);

CREATE TABLE IF NOT EXISTS briefing_histories (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  content TEXT NOT NULL,
  suggestion_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_briefing_histories_generated_at
  ON briefing_histories(generated_at DESC);
`;

/**
 * Schema v11 — delivery queue (T693) and delivery templates (T694).
 *
 * Client delivery work lives in its own tables, separate from Jack's personal
 * `tasks`: every row carries an owner role (jack / contractor / offshore), a
 * client, a venture and an SLA clock. Templates are named step lists with a
 * default owner role and SLA per step; instantiating one for a client writes
 * `delivery_items`. All statements are idempotent.
 */
const V11_SQL = `
CREATE TABLE IF NOT EXISTS delivery_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  venture TEXT,
  sop_url TEXT,
  source_ref TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery_template_steps (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES delivery_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  section TEXT,
  title TEXT NOT NULL,
  description TEXT,
  owner_role TEXT NOT NULL CHECK (owner_role IN ('jack','contractor','offshore')),
  sla_hours REAL,
  sla_confirmed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_delivery_template_steps_template
  ON delivery_template_steps(template_id, position);

CREATE TABLE IF NOT EXISTS delivery_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('jack','contractor','offshore')),
  owner_name TEXT,
  client TEXT NOT NULL,
  venture TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','in_progress','waiting_on_client','blocked','done','cancelled')),
  deadline TEXT,
  sla_hours REAL,
  sla_started_at TEXT NOT NULL,
  sla_due_at TEXT,
  completed_at TEXT,
  template_id TEXT REFERENCES delivery_templates(id) ON DELETE SET NULL,
  template_step_id TEXT REFERENCES delivery_template_steps(id) ON DELETE SET NULL,
  instance_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_items_status_due
  ON delivery_items(status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_delivery_items_owner
  ON delivery_items(owner_type, owner_name);
CREATE INDEX IF NOT EXISTS idx_delivery_items_client
  ON delivery_items(client);
CREATE INDEX IF NOT EXISTS idx_delivery_items_instance
  ON delivery_items(instance_id, position);
`;

/**
 * Schema v12: renewal engine (T704) and client portal (T707).
 *
 *  - `renewals`: dated, recurring client obligations with lead times.
 *  - `renewal_reminders`: one row per (renewal, cycle due date, lead time),
 *    so the engine never fires the same reminder twice.
 *  - `portal_entries`: findings, deliverable links, next steps and monthly
 *    notes Jack writes per client. Hidden from the portal until published.
 *  - `portal_links`: signed share links per client, with expiry and revoke.
 *  - `delivery_items.client_visible` / `deliverable_url`: per-item publish
 *    flag and an optional link shown on the portal.
 *
 * CREATE statements are idempotent; the two ALTERs are guarded by
 * `addColumnIfMissing` because SQLite has no ADD COLUMN IF NOT EXISTS.
 */
const V12_SQL = `
CREATE TABLE IF NOT EXISTS renewals (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN
    ('state_license','caqh_attestation','dea','risk_assessment','baa','site_rescan','custom')),
  label TEXT NOT NULL,
  due_date TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none',
  lead_times TEXT NOT NULL DEFAULT '[90,60,30]',
  owner_type TEXT NOT NULL DEFAULT 'jack' CHECK (owner_type IN ('jack','contractor','offshore')),
  owner_name TEXT,
  venture TEXT,
  notes TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_renewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_renewals_client ON renewals(client);
CREATE INDEX IF NOT EXISTS idx_renewals_active_due ON renewals(active, due_date);

CREATE TABLE IF NOT EXISTS renewal_reminders (
  id TEXT PRIMARY KEY,
  renewal_id TEXT NOT NULL REFERENCES renewals(id) ON DELETE CASCADE,
  cycle_due_date TEXT NOT NULL,
  lead_days INTEGER NOT NULL,
  trigger_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','skipped')),
  delivery_item_id TEXT REFERENCES delivery_items(id) ON DELETE SET NULL,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (renewal_id, cycle_due_date, lead_days)
);

CREATE INDEX IF NOT EXISTS idx_renewal_reminders_open
  ON renewal_reminders(status, acknowledged_at);

CREATE TABLE IF NOT EXISTS portal_entries (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('finding','deliverable','next_step','monthly_note')),
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  month TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_portal_entries_client ON portal_entries(client, kind, month);

CREATE TABLE IF NOT EXISTS portal_links (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  label TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_portal_links_client ON portal_links(client);
`;

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function applyV12(db: Database.Database): void {
  db.exec(V12_SQL);
  addColumnIfMissing(db, 'delivery_items', 'client_visible', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'delivery_items', 'deliverable_url', 'TEXT');
}

/**
 * Schema v13: SLA pauses (D39). `delivery_items.sla_pauses` holds a JSON
 * array of `{ started_at, ended_at }` intervals the item spent waiting on the
 * client; the shared SLA math leaves them out of elapsed time. Items already
 * waiting on the client when this runs start a pause at their last update.
 */
function applyV13(db: Database.Database): void {
  addColumnIfMissing(db, 'delivery_items', 'sla_pauses', "TEXT NOT NULL DEFAULT '[]'");
  db.exec(`UPDATE delivery_items
    SET sla_pauses = json_array(json_object('started_at', updated_at, 'ended_at', NULL))
    WHERE status = 'waiting_on_client' AND sla_pauses = '[]'`);
}

/**
 * Returns true when `sqlite_master` already contains the baseline `tasks`
 * table. Used to short-circuit the inline runner so drizzle owns the schema
 * lifecycle once it's been run at least once.
 */
function baselineExists(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
    )
    .get();
  return row !== undefined;
}

/**
 * Full-text search index (Wave 17 — search). A single FTS5 virtual table
 * holds one row per searchable entity (task / decision / execution /
 * attachment). We can't gate this behind the version ledger the same way as
 * the regular tables because:
 *   - FTS5 may not be compiled into the better-sqlite3 build (rare, but we
 *     refuse to crash boot over it), and
 *   - virtual tables are rebuilt rather than migrated.
 *
 * So creation is best-effort and idempotent (`IF NOT EXISTS`). The caller
 * (`ensureSearchIndex`) returns whether FTS5 is available; the search engine
 * falls back to a LIKE scan over the source tables when it isn't. We
 * deliberately do NOT bump `CURRENT_SCHEMA_VERSION` for this — the index is
 * derived data that can be rebuilt from the source tables at any time.
 *
 * Stored text (not contentless) so `snippet()` can produce highlights without
 * joining back to the source row. `entity_id` / `task_id` / `matched_field`
 * are UNINDEXED columns: stored alongside the row but never tokenized, since
 * they're identifiers and metadata rather than searchable text.
 */
const SEARCH_INDEX_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  entity_type,
  entity_id UNINDEXED,
  task_id UNINDEXED,
  title,
  body,
  matched_field UNINDEXED,
  tokenize = 'porter unicode61'
);
`;

/**
 * Create the `search_index` FTS5 virtual table if it doesn't already exist.
 * Returns `true` when FTS5 is available (table exists after the call),
 * `false` when the SQLite build lacks FTS5 (the CREATE throws). Never throws —
 * an unavailable FTS5 is a supported, degraded mode (LIKE fallback).
 */
export function ensureSearchIndex(db: Database.Database): boolean {
  try {
    db.exec(SEARCH_INDEX_SQL);
    // Double-check the table actually exists — guards against any silent no-op.
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE name='search_index'")
      .get();
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Apply the baseline schema. Idempotent — safe to call on every boot. After
 * a successful run, stamps `_schema_version` with `CURRENT_SCHEMA_VERSION` so
 * subsequent boots can skip the `db.exec` round-trip.
 *
 * Returns true if SQL ran, false if the baseline already existed.
 */
export function runInlineMigrations(db: Database.Database): boolean {
  // Make sure the version table is around even before we touch the rest of
  // the schema — `getCurrentVersion` would return 0 either way, but creating
  // the table early lets drizzle migrations also stamp the ledger.
  ensureSchemaVersionTable(db);

  const currentVersion = getCurrentVersion(db);
  if (currentVersion >= CURRENT_SCHEMA_VERSION && baselineExists(db)) {
    // The DB has been migrated past the baseline already. Trust drizzle from
    // here on out.
    return false;
  }

  // The baseline tables already exist (legacy install or a DB created at a
  // prior version). Walk the add-on migrations in order, applying each one
  // whose version the DB hasn't reached yet. Every add-on statement is
  // idempotent (`IF NOT EXISTS`) so running them is always safe; the version
  // guards just avoid the redundant `db.exec` round-trips. We stamp the
  // ledger once at the end with a note listing what ran.
  if (baselineExists(db)) {
    const applied: string[] = [];
    // Wave 13 (v2): cost_events + feedback.
    if (currentVersion < 2) {
      db.exec(V2_SQL);
      applied.push('cost_events + feedback');
    }
    // Wave 16 (v3): decisions (decision log).
    if (currentVersion < 3) {
      db.exec(V3_SQL);
      applied.push('decisions');
    }
    // Wave 17 (v4): goals (goals / initiatives tier).
    if (currentVersion < 4) {
      db.exec(V4_SQL);
      applied.push('goals');
    }
    // v5: recurring_schedules (time-driven fan-out).
    if (currentVersion < 5) {
      db.exec(V5_SQL);
      applied.push('recurring_schedules');
    }
    // v6: context_observations + deliberations (ambient monitor).
    if (currentVersion < 6) {
      db.exec(V6_SQL);
      applied.push('context_observations + deliberations');
    }
    // v7: conversations + conversation_task_links (Claude Code catalogue).
    if (currentVersion < 7) {
      db.exec(V7_SQL);
      applied.push('conversations + conversation_task_links');
    }
    // v8: composite indexes + task_stats materialization.
    if (currentVersion < 8) {
      db.exec(V8_SQL);
      applied.push('composite indexes + task_stats');
    }
    // v9: memory_items + memory_links + memory_stats.
    if (currentVersion < 9) {
      db.exec(V9_SQL);
      applied.push('memory_items + memory_links + memory_stats');
    }
    // v10: observation_events + context_state + research_threads + suggestions + auto_approvals + briefing_histories (observer v2).
    if (currentVersion < 10) {
      db.exec(V10_SQL);
      applied.push('observer v2 (observation_events + context_state + research_threads + suggestions + auto_approvals + briefing_histories)');
    }
    // v11: delivery_items + delivery_templates + delivery_template_steps.
    if (currentVersion < 11) {
      db.exec(V11_SQL);
      applied.push('delivery queue + templates');
    }
    // v12: renewals + renewal_reminders + portal_entries + portal_links.
    if (currentVersion < 12) {
      applyV12(db);
      applied.push('renewals + client portal');
    }
    // v13: delivery_items.sla_pauses.
    if (currentVersion < 13) {
      applyV13(db);
      applied.push('delivery SLA pauses');
    }
    if (applied.length > 0) {
      setVersion(
        db,
        CURRENT_SCHEMA_VERSION,
        `add-on (${applied.join(' + ')})`,
      );
      return true;
    }
    // First boot under the new versioned scheme — the legacy schema is on
    // disk but `_schema_version` is empty (currentVersion === 0) yet somehow
    // all tables already exist, OR the DB is current. Stamp the ledger and
    // return.
    setVersion(db, CURRENT_SCHEMA_VERSION, 'baseline (already present)');
    return false;
  }

  db.exec(SCHEMA_SQL);
  db.exec(V11_SQL);
  applyV12(db);
  applyV13(db);
  setVersion(db, CURRENT_SCHEMA_VERSION, 'inline baseline');
  return true;
}
