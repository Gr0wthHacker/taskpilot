/**
 * Core types contract for TaskPilot.
 *
 * These shapes are consumed by every layer (DB repos, HTTP API, CLI, renderer,
 * MCP server). Names and field shapes must NOT change without coordinating
 * with all waves.
 */

export type TaskStatus =
  | 'inbox'
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'archived';

export type TaskPriority = 'p0' | 'p1' | 'p2' | 'p3';

export type AgentMethod = 'cowork' | 'cli' | 'either' | 'human_only';

export type AgentStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'needs_review';

export type ExecutionMethod = 'cowork' | 'cli';

export type ExecutionStatus = 'succeeded' | 'failed' | 'needs_review';

export type SyncDirection = 'task_to_cal' | 'cal_to_task';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null; // ISO 8601
  calendar_event_id: string | null;
  parent_id: string | null;
  agent_executable: boolean;
  agent_method: AgentMethod;
  agent_instructions: string | null;
  agent_status: AgentStatus;
  context: Record<string, unknown> | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ExecutionLog {
  id: string;
  task_id: string;
  started_at: string;
  completed_at: string | null;
  method: ExecutionMethod;
  status: ExecutionStatus;
  output: string | null;
  error: string | null;
  log_path: string | null;
}

export interface CalendarSyncRow {
  task_id: string;
  event_id: string;
  calendar_id: string;
  last_synced: string;
  sync_direction: SyncDirection;
}

/* -------------------------------------------------------------------------- */
/*  Agent I/O JSON shapes                                                     */
/* -------------------------------------------------------------------------- */

export interface DerivationRequest {
  request_type: 'derive';
  task: Pick<Task, 'id' | 'title' | 'description' | 'priority' | 'due' | 'tags'>;
  context: {
    calendar_snapshot: string;
    related_tasks: string[];
    available_tools: string[];
    execution_modes: ExecutionMethod[];
  };
  instructions: string;
}

export interface DerivativeProposal {
  title: string;
  agent_executable: boolean;
  agent_method: AgentMethod;
  agent_instructions: string | null;
  estimated_minutes: number;
  depends_on: string[];
  review_required: boolean;
}

export interface DerivationResponse {
  task_id: string;
  derived_at: string;
  derivatives: DerivativeProposal[];
}

export interface ExecutionRequest {
  request_type: 'execute';
  task: Task;
  parent_outputs: Record<string, string[]>; // parent task id → output file paths
  context: Record<string, unknown>;
  instructions: string;
}

export interface CostTokens {
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
}

export interface ExecutionResult {
  task_id: string;
  status: ExecutionStatus;
  completed_at: string;
  summary: string;
  output_files: string[];
  notes?: string;
  error?: string;
  /**
   * Self-reported confidence in [0, 1]. When below the configured
   * `confidence_threshold` (default 0.7), ingestion auto-routes to /review.
   */
  confidence?: number;
  /**
   * Optional token usage. The cost-tracking module computes USD via the
   * hardcoded pricing table.
   */
  cost_tokens?: CostTokens;
}

/* -------------------------------------------------------------------------- */
/*  Cost tracking (Wave 13)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One cost event — a single LLM call or third-party API charge tied to a
 * task. Aggregations roll up by tag/workspace/window. `source` is a free
 * label (e.g. "execution", "derive", "lovable") so the cost view can group
 * by where the spend happened.
 */
export interface CostEvent {
  id: string;
  task_id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  /** USD; pricing table is hardcoded with optional override. */
  cost_usd: number | null;
  /** Freeform label — e.g. "execution", "derive", "lovable_api". */
  source: string | null;
  /** Optional human-readable label for a third-party charge. */
  third_party_label: string | null;
  /** Charge amount when this row represents a non-LLM cost. */
  third_party_cost_usd: number | null;
  at: string;
}

/* -------------------------------------------------------------------------- */
/*  Feedback loop (Wave 13)                                                   */
/* -------------------------------------------------------------------------- */

export type FeedbackKind =
  | 'rejection_derivation'
  | 'rejection_result'
  | 'low_confidence'
  | 'edit_after_run'
  | 'note';

export interface FeedbackEntry {
  id: string;
  task_id: string;
  kind: FeedbackKind;
  reason: string | null;
  details: string | null;
  at: string;
}

/* -------------------------------------------------------------------------- */
/*  Decision log (Wave 16)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Category of a {@link DecisionEntry}. Drives the icon + color in the
 * renderer's DecisionLog. Add new kinds at the end; never repurpose one.
 *
 * - `decision`  — a choice that was made ("went with Supabase over Firebase").
 * - `context`   — situational background worth remembering.
 * - `reference` — a link or pointer to an external resource.
 * - `rationale` — the *why* behind a decision.
 * - `risk`      — a known hazard / thing to watch.
 * - `note`      — anything else.
 */
export type DecisionCategory =
  | 'decision'
  | 'context'
  | 'reference'
  | 'rationale'
  | 'risk'
  | 'note';

/**
 * One append-only entry in a task's decision log. Claude writes these during
 * execute (via MCP / direct repo) and the user writes them on TaskDetail.
 * Entries are never edited in place — corrections append a new row.
 *
 * `author` is a freeform short label ("claude", "jack", "system"); the
 * renderer keys a subtle style off `'claude'` vs anything else but does not
 * constrain the value. `link` is an optional URL or on-disk ref.
 */
export interface DecisionEntry {
  id: string;
  task_id: string;
  category: DecisionCategory;
  text: string;
  author: string;
  link: string | null;
  created_at: string;
}

/* -------------------------------------------------------------------------- */
/*  Goals / Initiatives (Wave 17 — goals tier)                                */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle of a {@link Goal}. A goal starts `active`; reaching its outcome
 * flips it to `achieved`; `abandoned` retires it without success; `on_hold`
 * parks it. Add new states at the end — never repurpose one.
 */
export type GoalStatus = 'active' | 'achieved' | 'abandoned' | 'on_hold';

/**
 * A tier above tasks — an Initiative that many tasks roll up to. Jack runs
 * several businesses, so goals look like "Hit $X MRR at Actually Health" or
 * "Ship Leal v2 deck". Tasks attach two ways:
 *
 *   1. Explicit: `task.context.goal_id === goal.id`.
 *   2. Soft membership: the task carries any tag in this goal's `tags` list.
 *
 * `description` is free-form prose — typically the success criteria. `tags`
 * are the auto-include set (and double as the workspace-ish scoping signal).
 */
export interface Goal {
  id: string;
  name: string;
  description: string | null;
  status: GoalStatus;
  /** ISO date (YYYY-MM-DD) or full ISO timestamp. Null when undated. */
  target_date: string | null;
  /** Optional workspace binding (a workspace id slug). */
  workspace: string | null;
  /** Tags that auto-include matching tasks as soft members. */
  tags: string[];
  created_at: string;
  updated_at: string;
}

/**
 * Rolled-up progress for a single goal, computed over its member tasks
 * (explicit `context.goal_id` + tag membership, de-duplicated). `percent` is
 * `done / total * 100` rounded to an integer (0 when there are no members).
 * `overdue_tasks` counts members past their `due` that aren't done; `next_due`
 * is the earliest upcoming (or overdue) member due date, or null.
 */
export interface GoalProgress {
  goal_id: string;
  total: number;
  done: number;
  in_progress: number;
  blocked: number;
  percent: number;
  overdue_tasks: number;
  next_due: string | null;
}

/**
 * A goal bundled with its computed progress. Returned by the list endpoint.
 */
export interface GoalWithProgress extends Goal {
  progress: GoalProgress;
}

/**
 * Minimal shape to create a goal. `name` is required; everything else falls
 * back to defaults (`status='active'`, empty tags, null elsewhere). Callers
 * may supply `id`/timestamps when mirroring an external goal.
 */
export type CreateGoalInput = Partial<Goal> & Pick<Goal, 'name'>;

/**
 * Patch shape for goal updates. `id`/`created_at` are immutable; `updated_at`
 * is managed by the repository.
 */
export type UpdateGoalInput = Partial<
  Omit<Goal, 'id' | 'created_at' | 'updated_at'>
>;

/**
 * Optional filter for `listGoals`.
 */
export interface GoalFilter {
  status?: GoalStatus | GoalStatus[];
  workspace?: string;
}

/* -------------------------------------------------------------------------- */
/*  Conversations (Wave 18 — Claude Code session catalogue)                   */
/* -------------------------------------------------------------------------- */

export type ConversationSource = 'claude_code' | 'claude_desktop' | 'manual';

export type ConversationLinkKind =
  | 'session_pin'
  | 'cwd_match'
  | 'tag_match'
  | 'manual'
  | 'execute_result';

export interface Conversation {
  id: string;
  source: ConversationSource;
  source_id: string;
  source_path: string | null;
  project_path: string | null;
  title: string | null;
  started_at: string;
  ended_at: string;
  model: string | null;
  message_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  digest: string | null;
  topics: string[];
  key_decisions: string[];
  files_touched: string[];
  compressed_at: string | null;
  archived_at: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationTaskLink {
  id: string;
  conversation_id: string;
  task_id: string;
  kind: ConversationLinkKind;
  confidence: number;
  created_at: string;
}

export interface ConversationFilter {
  source?: ConversationSource;
  project_path?: string;
  topic?: string;
  task_id?: string;
  compressed?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export type CreateConversationInput = Omit<
  Conversation,
  'created_at' | 'updated_at'
> &
  Partial<Pick<Conversation, 'created_at' | 'updated_at'>>;

export type UpdateConversationInput = Partial<
  Omit<Conversation, 'id' | 'source' | 'source_id' | 'created_at' | 'updated_at'>
>;

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

export interface SettingRow {
  key: string;
  value: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Workspaces                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A user-defined collection of tags that scopes the UI to a single business
 * (or other slice of work). Workspaces are NOT stored in their own table —
 * they live as a single JSON array under the `workspaces` setting key, which
 * keeps the schema flat and lets the Settings → Workspaces editor save the
 * entire list in one round trip.
 *
 * - `id` is a stable slug (used to remember the active selection).
 * - `tags` is a flat list — a task matches a workspace if its tag list
 *   intersects this one.
 * - `color` / `icon` are optional UI hints rendered by the WorkspacePicker.
 */
export interface Workspace {
  id: string;
  name: string;
  tags: string[];
  color?: string;
  icon?: string;
}

/* -------------------------------------------------------------------------- */
/*  Repository input shapes                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Minimal shape required to create a new task. Anything not provided falls back
 * to the schema/DB defaults (`status='inbox'`, `priority='p2'`, etc.).
 *
 * Callers may supply `id`, `created_at`, and `updated_at` explicitly (e.g.
 * when mirroring a task that originated outside the DB) — they're optional.
 */
export type CreateTaskInput = Partial<Task> & Pick<Task, 'title'>;

/**
 * Patch shape for updates. `id`, `created_at` are immutable; `updated_at` is
 * managed by the repository.
 */
export type UpdateTaskInput = Partial<
  Omit<Task, 'id' | 'created_at' | 'updated_at'>
>;

/**
 * Optional filter for `listTasks`.
 *
 * `include_archived` defaults to `false` — archived tasks are excluded from
 * standard listings unless the caller opts in. This keeps the inbox, board,
 * etc. tidy without forcing every site to filter manually.
 */
export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  parent?: string | null;
  agent_only?: boolean;
  tag?: string;
  /**
   * Restrict to tasks explicitly attached to this goal via
   * `context.goal_id`. Matched with a quoted LIKE on the JSON-encoded
   * `context` column, same defense-in-depth alphabet check as `tag`.
   * NOTE: this only catches the EXPLICIT attachment — soft tag-membership
   * is resolved in the goals domain layer (`@/main/goals`).
   */
  goal_id?: string;
  include_archived?: boolean;
  /**
   * By default list endpoints hide `cancelled` rows for the same reason they
   * hide `archived` — they're not part of normal workflow and overwhelm the
   * top of the recency sort after a bulk dedup. Pass `true` to see them, or
   * pass `status: 'cancelled'` directly.
   */
  include_cancelled?: boolean;
  limit?: number;
  offset?: number;
  /**
   * Opaque keyset cursor for forward pagination over the
   * `ORDER BY created_at DESC, id ASC` sort. When set, returns rows strictly
   * after the cursor's row. Format is opaque to callers — produced by
   * `listTasksPage()` and consumed verbatim on the next call.
   */
  cursor?: string;
  /**
   * Column projection for list responses. `summary` drops the heavy
   * `description` and `agent_instructions` blobs — typically ~10x payload
   * shrink for inbox/board views.
   */
  fields?: 'full' | 'summary';
}

/**
 * Lighter-weight projection of a Task for list views. Omits the two large
 * text columns (`description`, `agent_instructions`) plus the `context`
 * blob, which list views rarely need. Detail views fetch the full Task.
 */
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  parent_id: string | null;
  agent_executable: boolean;
  agent_method: AgentMethod;
  agent_status: AgentStatus;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/* -------------------------------------------------------------------------- */
/*  Recurrence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Opinionated, RRULE-lite recurrence rule. Stored as JSON inside
 * `tasks.context.recurrence` — no schema change required.
 *
 * `interval` is the gap between occurrences in the rule's natural unit
 * (days for daily/weekdays, weeks for weekly, months for monthly). Defaults
 * to 1. `weekdays` always advances day-by-day but skips Saturday/Sunday.
 */
export type RecurrenceKind = 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface RecurrenceRule {
  kind: RecurrenceKind;
  interval?: number;
  end_after_count?: number;
  end_on?: string; // ISO date
  /** Bookkeeping — how many instances have completed so far. */
  occurrences_completed?: number;
}

/* -------------------------------------------------------------------------- */
/*  Task templates                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A reusable task blueprint. Materializing a template produces a regular
 * `Task` row; templates themselves never appear in tasks lists.
 *
 * `task_title` and `task_description` may contain `{{variable}}` placeholders
 * that callers substitute at materialize time.
 */
export interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  task_title: string;
  task_description: string | null;
  priority: TaskPriority | null;
  agent_method: AgentMethod | null;
  agent_instructions: string | null;
  tags: string[];
  context: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type CreateTaskTemplateInput = Partial<TaskTemplate> &
  Pick<TaskTemplate, 'name' | 'task_title'>;

export type UpdateTaskTemplateInput = Partial<
  Omit<TaskTemplate, 'id' | 'created_at' | 'updated_at'>
>;

export interface MaterializeTemplateOverrides {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  due?: string | null;
  tags?: string[];
  agent_method?: AgentMethod;
  agent_instructions?: string | null;
  context?: Record<string, unknown> | null;
  /**
   * Map of `{{variable}}` -> replacement value. Substitution runs against the
   * template's `task_title` and `task_description` (and the override `title`
   * / `description` if supplied) before insertion.
   */
  variables?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/*  Approval / rejection                                                       */
/* -------------------------------------------------------------------------- */

export type ApprovalKind = 'derivation' | 'result';

export interface ApprovalPayload {
  kind: ApprovalKind;
  edits?: DerivativeProposal[];
}

export interface RejectionPayload {
  kind: ApprovalKind;
  reason?: string;
  requeue?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Permissions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Network access level granted to an agent while executing a task.
 *
 * - `off` — no outbound network at all.
 * - `restricted` — only the host-allowlisted set (e.g. github, npm registry).
 * - `open` — anything goes.
 */
export type NetworkAccess = 'off' | 'restricted' | 'open';

/**
 * GitHub operation granularity. Pairs with `PermissionSet.github_repo`.
 * - `read` — clone / fetch / read files.
 * - `branch` — create branches.
 * - `commit` — push commits.
 * - `pr` — open pull requests.
 */
export type GithubOperation = 'read' | 'branch' | 'commit' | 'pr';

/**
 * Permissions envelope attached to a task. Stored at `task.context.permissions`.
 *
 * Every field is optional. A blank `PermissionSet` means "inherit everything
 * from the parent task; if no parent, fall back to the workspace default".
 * Resolution walks the parent chain merging field-by-field — the closest
 * non-undefined value wins.
 *
 * Agents (Claude Code, runners) MUST consult the resolved set before any
 * Read/Write/Bash/network call and refuse anything that violates it. See
 * `~/.claude/skills/taskpilot/references/PERMISSIONS.md` for the full model.
 */
export interface PermissionSet {
  /** Absolute path. Agent may only read/write inside this directory. */
  workspace?: string;
  /**
   * Allowed tool names. Bash entries may include allowlists in parens:
   *   "Bash(git*,npm*,python*)"
   * means git, npm, and python invocations are allowed; anything else is
   * refused. A bare "Bash" entry means all Bash is allowed (use with care).
   */
  allowed_tools?: string[];
  /** Glob patterns relative to (or inside) workspace that are always denied. */
  denied_patterns?: string[];
  network_access?: NetworkAccess;
  max_runtime_minutes?: number;
  /** Require human confirm for rm / send / publish actions. Default true. */
  confirm_destructive?: boolean;
  /** "org/name" — pairs with the GitHub integration. */
  github_repo?: string;
  /** e.g. "agent/{task_id}" — newly created branches must match this pattern. */
  github_branch_policy?: string;
  github_operations?: GithubOperation[];
}

/* -------------------------------------------------------------------------- */
/*  Task links + skill bindings (Wave 12 intelligence layer)                  */
/* -------------------------------------------------------------------------- */

/**
 * Cross-task relationships stored at `task.context.links`. Independent of
 * `parent_id` (which is reserved for derivation hierarchy). All ids reference
 * other tasks in the same DB.
 *
 * - `blocks` — this task blocks the listed tasks. UI shows the reverse
 *   "blocked_by" by walking other tasks' `blocks` arrays at query time.
 * - `related` — bidirectional general relation. We don't auto-mirror; the
 *   route writes both ends when the user creates a "related" edge.
 * - `duplicate_of` — marks this task as a duplicate of another. At most one.
 */
export interface TaskLinks {
  blocks: string[];
  related: string[];
  duplicate_of: string | null;
}

/**
 * `task.context.skills` — explicit Claude skill bindings declared on a task.
 * Each entry is a skill identifier (e.g. `"anthropic-skills:pptx"`). Used by
 * the derivation + execution flow to tell Claude which skills to route
 * through.
 */
export type TaskSkillBindings = string[];

/**
 * Descriptor for a known Claude skill. Sourced from a hardcoded registry of
 * Jack's installed skills (plus user-registered customs). Keyword-matched
 * against a task's title/tags/description by {@link suggestSkillsForTask}.
 */
export interface SkillDescriptor {
  /** Canonical id (e.g. `"anthropic-skills:pptx"`). */
  name: string;
  /** One-line human label. */
  label: string;
  /** One-paragraph description. Used both for display and keyword matching. */
  description: string;
  /** Extra keyword tokens for matching. Lowercase. */
  keywords?: string[];
  /** True when the user registered this skill manually (not a built-in). */
  custom?: boolean;
}

/**
 * Built-in permission profile name. Used by the Settings "default profile"
 * picker and the `applyProfile` helper.
 */
export type PermissionProfileName =
  | 'trusted-local'
  | 'sandboxed'
  | 'read-only-research'
  | 'github-pr';

export interface PermissionProfileDescriptor {
  name: PermissionProfileName;
  label: string;
  description: string;
  permissions: PermissionSet;
}

/* -------------------------------------------------------------------------- */
/*  File attachments (Wave 13)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Metadata for a file dropped onto a task. Stored in
 * `task.context.attachments`; the actual bytes live at
 * `~/.taskpilot/attachments/<task-id>/<filename>`.
 *
 * `filename` is the sanitized on-disk name — already safe to join into the
 * attachments root via `safeJoin`. `size_bytes` is the byte length at upload
 * time; `content_type` is the client-declared MIME or a best-effort guess
 * when none was provided.
 */
export interface Attachment {
  filename: string;
  size_bytes: number;
  content_type: string;
  added_at: string; // ISO 8601
}

/* -------------------------------------------------------------------------- */
/*  Phases / pipelines (Wave 15 — phase/stage model)                          */
/* -------------------------------------------------------------------------- */

/**
 * One named phase inside a {@link Pipeline}. The id is a slug (e.g.
 * `'research'`, `'spec'`) that gets stored on `task.context.phase`; the
 * `name` is the human-readable label rendered in badges and the editor.
 *
 * `is_terminal` flags a phase that means "the work is done" — reaching it
 * implies the task is at the end of its lifecycle. `color` is a tailwind
 * class fragment (e.g. `'bg-blue-500'`) used by the badge component.
 */
export interface PhaseDefinition {
  id: string;
  name: string;
  description?: string;
  color?: string;
  is_terminal?: boolean;
}

/**
 * Ordered set of phases representing a task workflow. Pipelines are stored
 * as a single JSON array under the `pipelines` setting key — same pattern as
 * workspaces. `applies_to` is an opt-in matcher: when a task has any of the
 * listed tags or sits in any of the listed workspaces, this pipeline is the
 * default match. The resolver walks the list in order and picks the first
 * match; `default: true` is a final fallback when nothing else matches.
 *
 * Phase assignment lives at `task.context.phase: string` (the phase id) plus
 * an optional `task.context.pipeline_id` override that pins this task to a
 * specific pipeline. No schema change is required — phase is a soft signal
 * layered on top of the existing flexible context.
 */
export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  phases: PhaseDefinition[];
  applies_to?: {
    tags?: string[];
    workspaces?: string[];
  };
  default?: boolean;
}

/**
 * Resolved per-task phase + pipeline reference. Returned by the read endpoint
 * and used by the renderer to render the picker / badge. `phase_definition`
 * is `null` when the task has no phase assigned OR when the assigned phase
 * id isn't present in the resolved pipeline (stale binding — the editor may
 * have dropped that phase since assignment).
 */
export interface PhaseAssignment {
  task_id: string;
  pipeline: Pipeline | null;
  phase: string | null;
  phase_definition: PhaseDefinition | null;
}

/* -------------------------------------------------------------------------- */
/*  Outputs (Wave 15 — Outputs panel + briefing-pack export)                  */
/* -------------------------------------------------------------------------- */

/**
 * One file produced by a task — either authored by Claude during execute
 * (under `~/.taskpilot/io/results/<task-id>/output/`) or attached by the
 * user (`~/.taskpilot/attachments/<task-id>/`).
 *
 * `path` is the absolute on-disk path so the renderer can hand it to
 * `shell.openExternal('file://…')`. `preview` is populated only for files
 * sniffed as text and is capped at ~200 chars.
 */
export interface OutputFile {
  path: string;
  size_bytes: number;
  content_type: string;
  preview?: string;
  added_at: string;
}

/**
 * Full (or capped) content of a single output/attachment file, served by
 * `GET /api/tasks/:id/outputs/file?path=...` for the in-app viewer. `content`
 * is empty for binary files (`is_text: false`); `truncated` is true when the
 * file exceeded the viewer's byte cap and only the leading portion is sent.
 */
export interface OutputFileContent {
  path: string;
  content_type: string;
  size_bytes: number;
  content: string;
  truncated: boolean;
  is_text: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Knowledge base                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One indexed resource in the local knowledge base. Files live at
 * `~/.taskpilot/knowledge/<business>/<file>`; extracted plain text (for
 * PPTX/PDF/DOCX) lands in a `.index/<file>.txt` sidecar. Catalog metadata is
 * persisted at `~/.taskpilot/knowledge/<business>/.index/catalog.json`.
 */
export interface KnowledgeResource {
  /** Business folder slug, e.g. `leal-health`. */
  business: string;
  /** Filename relative to the business folder. */
  file: string;
  /** Absolute path to the original dropped file. */
  source_path: string;
  /** Absolute path to the extracted-text sidecar, or null if not extracted. */
  sidecar_path: string | null;
  /** Human title derived from the filename. */
  title: string;
  /** Short heuristic summary (leading text), for the candidate menu. */
  summary: string;
  /** Top keywords pulled from the extracted text + title. */
  keywords: string[];
  size_bytes: number;
  /** Whether plain text was successfully extracted. */
  extracted: boolean;
  /** ISO timestamp of the last index pass. */
  indexed_at: string;
}

/** A knowledge resource matched to a task, with its relevance score. */
export interface KnowledgeMatch {
  resource: KnowledgeResource;
  score: number;
}

/** Per-business rollup for the Knowledge management view. */
export interface KnowledgeBusinessSummary {
  business: string;
  file_count: number;
  extracted_count: number;
  /** Files present on disk but not yet text-extracted (e.g. missing deps). */
  unextracted_count: number;
  last_indexed_at: string | null;
}

/** Whether the text-extraction toolchain (Python + libs) is available. */
export interface KnowledgeExtractorStatus {
  python_available: boolean;
  /** Names of parser libs that failed to import, if detected. */
  missing_deps: string[];
}

/**
 * External reference produced by (or linked to) a task — GitHub PR, calendar
 * event, Notion page, Slack thread, Gmail draft, GitHub issue. Sourced from
 * `task.context.*` fields written by integrations.
 */
export type OutputArtifact =
  | {
      kind: 'github_pr';
      url: string;
      number: number;
      state: string;
    }
  | {
      kind: 'github_issue';
      url: string;
      number: number;
      state: string;
    }
  | {
      kind: 'calendar_event';
      event_id: string;
      summary?: string;
    }
  | {
      kind: 'notion_page';
      page_id: string;
      url?: string;
      last_synced?: string;
    }
  | {
      kind: 'slack_thread';
      permalink: string;
      channel?: string;
      thread_ts?: string;
    }
  | {
      kind: 'gmail_draft';
      message_id: string;
      thread_id?: string;
      subject?: string;
    };

/**
 * Aggregate of everything a task produced. Built by
 * `@/main/outputs/collector` and returned by `GET /api/tasks/:id/outputs`.
 *
 * Defensive shape: every list is always present (possibly empty), so the
 * renderer can iterate without null checks. `summary` is the latest
 * `result.json` summary string, or null when the task has never been
 * executed.
 */
export interface OutputBundle {
  task_id: string;
  generated_at: string; // ISO
  summary: string | null;
  files: OutputFile[];
  artifacts: OutputArtifact[];
  attachments: OutputFile[];
  metrics: {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    time_to_done_hours: number | null;
    last_confidence: number | null;
    execution_count: number;
  };
}

/* -------------------------------------------------------------------------- */
/*  Ambient monitor — v6 (context observations + deliberations)               */
/* -------------------------------------------------------------------------- */

/**
 * Where an ambient capture came from. `window` is the active-window poller,
 * `screenshot` is the periodic primary-monitor capture, `browser` is the
 * Chrome extension submitting tab/page info, `manual` is an explicit hotkey
 * or API capture.
 */
export type ContextObservationSource =
  | 'window'
  | 'screenshot'
  | 'browser'
  | 'manual';

/**
 * One row in the `context_observations` table. The append-only feed the
 * monitor batches into deliberation requests. Every field except `id`,
 * `source`, and `captured_at` is nullable — different sources fill different
 * fields (a `window` row has no `url`; a `browser` row has no
 * `screenshot_path`).
 */
export interface ContextObservation {
  id: string;
  source: ContextObservationSource;
  captured_at: string; // ISO 8601
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  page_title: string | null;
  h1: string | null;
  meta_description: string | null;
  selection: string | null;
  screenshot_path: string | null;
  /** When set, the row was bundled into this deliberation batch. */
  batch_id: string | null;
  /** Freeform extra fields the source wants to record. */
  metadata: Record<string, unknown> | null;
  workspace_id: string | null;
}

/** Why the monitor emitted a deliberation request. */
export type DeliberationTriggerReason =
  | 'batch_size'
  | 'context_shift'
  | 'manual'
  | 'hotkey';

/** Lifecycle status of a deliberation row. */
export type DeliberationStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'skipped';

/** What the deliberation finally decided once Claude scored it. */
export type DeliberationDecision = 'interrupt' | 'wait' | 'skipped';

/** What artifact the deliberation surfaced (if any). */
export type DeliberationSurfaceKind = 'task' | 'notification' | 'none';

/**
 * One row in the `deliberations` table. Tracks the interrupter-vs-waiter
 * scoring outcome and what artifact (if any) was produced. Powers the Watch
 * view's deliberation-history pane.
 *
 * `observation_ids` is materialized from the JSON-encoded column by the
 * repository. `raw_result` is the full deliberated result file's JSON, kept
 * for diagnostics — not all callers need it.
 */
export interface Deliberation {
  id: string;
  batch_id: string;
  requested_at: string;
  observation_ids: string[];
  trigger_reason: DeliberationTriggerReason;
  status: DeliberationStatus;
  result_at: string | null;
  interrupter_score: number | null;
  waiter_score: number | null;
  decision: DeliberationDecision | null;
  surfaced_as: DeliberationSurfaceKind | null;
  surfaced_id: string | null;
  summary: string | null;
  raw_result: Record<string, unknown> | null;
}

/* -------------------------------------------------------------------------- */
/*  Memory subsystem (v9)                                                     */
/* -------------------------------------------------------------------------- */

export type MemoryKind = 'text' | 'url' | 'file';
export type MemoryStatus = 'raw' | 'enriched' | 'failed';
export type MemoryLinkTargetKind = 'memory' | 'task' | 'goal';
export type MemoryLinkKind = 'related' | 'refers_to' | 'duplicate_of';

/**
 * One captured artifact in the memory inbox. `raw_content` is the source
 * (pasted text, fetched markdown, extracted file text); the AI enrichment
 * loop fills in `summary` + `tags` + `entities`.
 */
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  title: string | null;
  raw_content: string;
  summary: string | null;
  tags: string[];
  entities: Record<string, unknown> | null;
  source_url: string | null;
  source_path: string | null;
  content_hash: string;
  status: MemoryStatus;
  enrichment_error: string | null;
  created_at: string;
  updated_at: string;
  enriched_at: string | null;
}

/**
 * Lighter projection for list views — drops the heavy `raw_content` and
 * `entities` blobs. The detail view fetches the full item.
 */
export interface MemoryItemSummary {
  id: string;
  kind: MemoryKind;
  title: string | null;
  summary: string | null;
  tags: string[];
  source_url: string | null;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  enriched_at: string | null;
}

export interface MemoryLink {
  id: string;
  source_id: string;
  target_kind: MemoryLinkTargetKind;
  target_id: string;
  link_kind: MemoryLinkKind;
  score: number;
  created_at: string;
}

export interface MemoryFilter {
  status?: MemoryStatus | MemoryStatus[];
  kind?: MemoryKind | MemoryKind[];
  tag?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  fields?: 'full' | 'summary';
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  /** Raw body (text), URL, or filesystem-relative path for `kind='file'`. */
  raw_content: string;
  title?: string | null;
  source_url?: string | null;
  source_path?: string | null;
  tags?: string[];
}

export interface UpdateMemoryInput {
  title?: string | null;
  summary?: string | null;
  tags?: string[];
  entities?: Record<string, unknown> | null;
  status?: MemoryStatus;
  enrichment_error?: string | null;
}

export interface MemoryStats {
  total: number;
  raw: number;
  enriched: number;
  failed: number;
  kind_text: number;
  kind_url: number;
  kind_file: number;
  updated_at: string;
}
