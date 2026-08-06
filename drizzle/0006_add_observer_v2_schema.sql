-- TaskPilot v2 Schema Migration
-- Adds tables for observation events, context state, suggestions, research threads, auto-approvals, briefing history

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

-- Auto-prune events older than 30 days
-- Run via: sqlite3 taskpilot.db
-- DELETE FROM observation_events WHERE created_at < date('now', '-30 days');

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
