/**
 * HTTP API contract for the local TaskPilot server (default port 7847).
 *
 * Every endpoint listed in BUILD_CONTRACTS.md "API Contract" has a corresponding
 * request/response type here. The `Endpoints` map at the bottom is the single
 * source of truth — `src/main/server` implements it, the CLI and renderer
 * consume it via typed fetch helpers.
 */

import type {
  ApprovalKind,
  ApprovalPayload,
  Attachment,
  ContextObservation,
  ContextObservationSource,
  CostEvent,
  CostTokens,
  DecisionCategory,
  DecisionEntry,
  Deliberation,
  DeliberationStatus,
  DerivativeProposal,
  ExecutionLog,
  FeedbackEntry,
  FeedbackKind,
  Goal,
  GoalProgress,
  GoalStatus,
  GoalWithProgress,
  MaterializeTemplateOverrides,
  OutputArtifact,
  OutputBundle,
  KnowledgeBusinessSummary,
  KnowledgeExtractorStatus,
  KnowledgeMatch,
  KnowledgeResource,
  OutputFile,
  OutputFileContent,
  PermissionProfileDescriptor,
  PermissionProfileName,
  PermissionSet,
  PhaseAssignment,
  PhaseDefinition,
  Pipeline,
  RecurrenceRule,
  RejectionPayload,
  SkillDescriptor,
  Task,
  TaskLinks,
  TaskPriority,
  TaskStatus,
  TaskSummary,
  TaskTemplate,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Shared response envelopes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Canonical error envelope returned by every server route on a non-2xx
 * response. The server builds this in `src/main/server/index.ts#errorHandler`
 * (see also `ApiHttpError`). Renderer and CLI clients should unwrap
 * `body.error.message` / `body.error.code` rather than reading `body.error`
 * as a string.
 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface OkResponse {
  ok: true;
}

/* -------------------------------------------------------------------------- */
/*  Calendar OAuth                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Response shape for `GET /api/calendar/status`. The renderer keys off
 * `connected` — keep the field name in sync.
 */
export interface CalendarStatusResponse {
  connected: boolean;
  email?: string;
}

/* -------------------------------------------------------------------------- */
/*  Health / config                                                           */
/* -------------------------------------------------------------------------- */

export interface HealthResponse {
  ok: true;
  version: string;
}

/* -------------------------------------------------------------------------- */
/*  Window focus                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Response shape for `POST /api/window/focus`. The Chrome-extension popup uses
 * this to restore + focus the main TaskPilot window. `focused: false` is NOT
 * an error — it just means the request was honored but there was no window to
 * focus (e.g. the server is running standalone via `npm run server`, not under
 * Electron). The optional `reason` discriminates the no-op cases:
 *
 *   - `'no_electron'` — the API server is not running inside Electron.
 *   - `'no_window'`   — Electron is up but every BrowserWindow has been
 *                       destroyed (rare; happens during shutdown).
 *   - `'focus_failed'` — Electron threw while restoring/focusing. Non-fatal;
 *                        the user can still alt-tab.
 */
export interface WindowFocusResponse {
  ok: true;
  focused: boolean;
  reason?: 'no_electron' | 'no_window' | 'focus_failed';
}

export interface ConfigResponse {
  version: string;
  api_port: number;
  paths: {
    home: string;
    db: string;
    logs: string;
    io: {
      root: string;
      inbox: string;
      derive: string;
      derived: string;
      execute: string;
      results: string;
      review: string;
      context: string;
    };
  };
}

/* -------------------------------------------------------------------------- */
/*  Tasks                                                                      */
/* -------------------------------------------------------------------------- */

export interface ListTasksQuery {
  status?: TaskStatus;
  priority?: TaskPriority;
  parent?: string;
  agent_only?: boolean;
  include_archived?: boolean;
  include_cancelled?: boolean;
  /**
   * Page size cap. Server enforces a hard ceiling (currently 200) regardless
   * of the requested value; defaults to 100 when omitted.
   */
  limit?: number;
  /**
   * Opaque cursor returned by a prior page. Pass verbatim to get the next
   * page. Omit on the first call.
   */
  cursor?: string;
  /**
   * Column projection. `summary` drops description + agent_instructions for
   * ~10x smaller list payloads. Default `full` preserves the legacy shape.
   */
  fields?: 'full' | 'summary';
}

export interface ListTasksResponse {
  tasks: Task[];
  /**
   * Cursor for the next page; null when the current page is the last.
   * `null` on every legacy response (no cursor support) — present for forward
   * compat without breaking existing consumers.
   */
  next_cursor: string | null;
}

/**
 * Summary-projection response — same shape as `ListTasksResponse` but with
 * the lighter `TaskSummary` rows. Used by the renderer's high-volume list
 * surfaces (inbox, board, search) to keep payloads under ~100KB even at
 * 200 rows.
 */
export interface ListTaskSummariesResponse {
  tasks: TaskSummary[];
  next_cursor: string | null;
}

export type CreateTaskBody = Partial<Task> & Pick<Task, 'title'>;
export interface CreateTaskResponse {
  task: Task;
}

export interface GetTaskResponse {
  task: Task;
}

export type UpdateTaskBody = Partial<Task>;
export interface UpdateTaskResponse {
  task: Task;
}

export interface DeleteTaskResponse extends OkResponse {
  id: string;
}

export interface DeriveTaskResponse extends OkResponse {
  request_path: string;
}

export interface ExecuteTaskResponse extends OkResponse {
  request_path: string;
}

export type ApproveTaskBody = ApprovalPayload;
export interface ApproveTaskResponse extends OkResponse {
  task: Task;
}

export type RejectTaskBody = RejectionPayload;
export interface RejectTaskResponse extends OkResponse {
  task: Task;
}

export interface ArchiveTaskResponse extends OkResponse {
  task: Task;
}

/* -------------------------------------------------------------------------- */
/*  Schedule a task on the calendar                                            */
/* -------------------------------------------------------------------------- */

export interface ScheduleTaskBody {
  /**
   * Explicit ISO 8601 start time. When omitted, the server auto-picks via
   * `proposeSchedule`.
   */
  start?: string;
  /** Duration in minutes. Defaults to the task's `context.estimated_minutes` or 30. */
  duration_minutes?: number;
  /** Target calendar id. Defaults to `'primary'`. */
  calendar_id?: string;
}

export interface ScheduleTaskResponse extends OkResponse {
  event_id: string;
  start: string;
  end: string;
  calendar_url: string;
}

export interface UnarchiveTaskResponse extends OkResponse {
  task: Task;
}

/* -------------------------------------------------------------------------- */
/*  Task templates                                                             */
/* -------------------------------------------------------------------------- */

export interface ListTemplatesResponse {
  templates: TaskTemplate[];
}

export interface GetTemplateResponse {
  template: TaskTemplate;
}

export type CreateTemplateBody = Partial<TaskTemplate> &
  Pick<TaskTemplate, 'name' | 'task_title'>;

export interface CreateTemplateResponse {
  template: TaskTemplate;
}

export type UpdateTemplateBody = Partial<TaskTemplate>;
export interface UpdateTemplateResponse {
  template: TaskTemplate;
}

export interface DeleteTemplateResponse extends OkResponse {
  id: string;
}

export interface MaterializeTemplateBody {
  overrides?: MaterializeTemplateOverrides;
  count?: number;
}

export interface MaterializeTemplateResponse {
  tasks: Task[];
}

/* -------------------------------------------------------------------------- */
/*  Calendar                                                                  */
/* -------------------------------------------------------------------------- */

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees?: string[];
  calendar_id?: string;
  task_id?: string | null;
}

export interface ListCalendarEventsQuery {
  from?: string;
  to?: string;
}
export interface ListCalendarEventsResponse {
  events: CalendarEvent[];
}

export interface CreateCalendarEventBody {
  summary: string;
  start: string;
  end: string;
  description?: string;
  attendees?: string[];
  task_id?: string | null;
}
export interface CreateCalendarEventResponse {
  event: CalendarEvent;
}

export type UpdateCalendarEventBody = Partial<CreateCalendarEventBody>;
export interface UpdateCalendarEventResponse {
  event: CalendarEvent;
}

export interface DeleteCalendarEventResponse extends OkResponse {
  id: string;
}

export interface CalendarSyncResponse extends OkResponse {
  synced: number;
  /**
   * Sync errors surfaced by `fullSync()`. Empty when everything succeeded.
   * NOTE: the prior `rows: CalendarSyncRow[]` field was dropped because the
   * underlying sync routine never populated it.
   */
  errors?: Array<{ taskId?: string; eventId?: string; error: string }>;
}

export interface AvailabilityQuery {
  from: string;
  to: string;
  duration: string;
}
export interface AvailabilityWindow {
  start: string;
  end: string;
}
export interface AvailabilityResponse {
  windows: AvailabilityWindow[];
}

/* -------------------------------------------------------------------------- */
/*  I/O                                                                       */
/* -------------------------------------------------------------------------- */

export interface IoFileRef {
  task_id: string;
  path: string;
  written_at: string;
}

export interface IoPendingResponse {
  derive: IoFileRef[];
  execute: IoFileRef[];
}

export interface IoResultsResponse {
  derived: IoFileRef[];
  results: IoFileRef[];
}

export interface IoIngestResponse extends OkResponse {
  scanned: number;
  ingested: number;
}

export interface IoStatusResponse {
  watcher: 'running' | 'stopped' | 'error';
  counts: {
    inbox: number;
    derive: number;
    derived: number;
    execute: number;
    results: number;
    review: number;
    invalid: number;
  };
}

/* -------------------------------------------------------------------------- */
/*  Execution result submission                                                */
/* -------------------------------------------------------------------------- */

/**
 * Body shape for `POST /api/io/results`. Lets the renderer (or any other
 * client) post an `ExecutionResult` for ingestion without writing the file
 * to disk directly. The server validates `task_id` against the canonical
 * task-id regex, writes `result.json` atomically into the per-task results
 * directory, and ingests it synchronously.
 *
 * `output_files` is informational only — it is recorded in the persisted
 * result for diagnostics; the canonical list of files lives on disk inside
 * the per-task `output/` directory.
 */
export interface SubmitResultBody {
  task_id: string;
  result: {
    task_id: string;
    status: 'succeeded' | 'failed' | 'needs_review';
    completed_at: string;
    summary: string;
    output_files: string[];
    notes?: string;
    error?: string;
  };
  output_files?: string[];
}

export interface SubmitResultResponse extends OkResponse {
  task_id: string;
  result_path: string;
}

/* -------------------------------------------------------------------------- */
/*  Execution logs (surfaced by tasks endpoints / future expansion)           */
/* -------------------------------------------------------------------------- */

export interface ListExecutionLogsResponse {
  logs: ExecutionLog[];
}

/* -------------------------------------------------------------------------- */
/*  Data export / import (Wave 7 power features)                              */
/* -------------------------------------------------------------------------- */

/**
 * Full backup payload. Versioned — the importer rejects mismatched versions
 * with 400 so a future breaking change can't silently corrupt a DB.
 */
export interface DataExportResponse {
  version: 1;
  exported_at: string;
  tasks: Task[];
  execution_logs: ExecutionLog[];
  settings: Record<string, unknown>;
  task_templates: unknown[];
}

/**
 * Importable shape — every section is optional so partial restores work
 * (e.g. settings-only re-import). The server still requires `version === 1`.
 */
export interface DataImportBody {
  version: number;
  exported_at?: string;
  tasks?: Task[];
  execution_logs?: ExecutionLog[];
  settings?: Record<string, unknown>;
  task_templates?: unknown[];
}

export interface DataImportQuery {
  /** When true, settings from the payload overwrite existing keys. */
  overwrite?: boolean;
}

export interface DataImportResponse {
  tasks_imported: number;
  logs_imported: number;
  settings_imported: number;
  templates_imported: number;
  /** Rows that were skipped (id collision / FK miss / settings already set). */
  conflicts: number;
}

/* -------------------------------------------------------------------------- */
/*  System routes                                                             */
/* -------------------------------------------------------------------------- */

export interface AutoLaunchGetResponse {
  /** User's persisted preference. */
  enabled: boolean;
  /** Live OS-level state. Usually identical to `enabled`. */
  os_enabled: boolean;
}

export interface AutoLaunchSetBody {
  enabled: boolean;
}

export interface AutoLaunchSetResponse extends OkResponse {
  enabled: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Permissions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/tasks/:id/permissions` response. `permissions` is the raw value
 * stored on `task.context.permissions` (may be empty). `resolved` is the
 * fully-merged effective set after walking the parent chain. `source` flags
 * whether any field on the task itself contributed.
 */
export interface GetTaskPermissionsResponse {
  permissions: PermissionSet | null;
  resolved: PermissionSet;
  source: 'self' | 'inherited' | 'default';
}

export interface UpdateTaskPermissionsBody {
  permissions: PermissionSet;
}

export interface UpdateTaskPermissionsResponse {
  task: Task;
  resolved: PermissionSet;
}

export interface ClearTaskPermissionsResponse extends OkResponse {
  task: Task;
  resolved: PermissionSet;
}

export interface ListPermissionProfilesResponse {
  profiles: PermissionProfileDescriptor[];
}

export interface ApplyPermissionProfileBody {
  task_id: string;
}

export interface ApplyPermissionProfileResponse {
  task: Task;
  profile: PermissionProfileName;
  resolved: PermissionSet;
}

/* -------------------------------------------------------------------------- */
/*  Task links (Wave 12 intelligence layer)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Response shape for `GET /api/tasks/:id/links`. `links` is the raw value
 * stored on `task.context.links` (always materialized to the full
 * {@link TaskLinks} shape even if absent on disk). `blocked_by` is computed
 * server-side by scanning other tasks' `blocks` arrays for this id.
 */
export interface GetTaskLinksResponse {
  links: TaskLinks;
  blocked_by: string[];
}

/**
 * Patch body — every field optional. Pass an empty array to clear a list;
 * pass `null` to clear `duplicate_of`.
 */
export interface UpdateTaskLinksBody {
  blocks?: string[];
  related?: string[];
  duplicate_of?: string | null;
}

export interface UpdateTaskLinksResponse {
  task: Task;
  links: TaskLinks;
  blocked_by: string[];
}

export interface AddTaskBlockResponse extends OkResponse {
  links: TaskLinks;
}

export interface RemoveTaskBlockResponse extends OkResponse {
  links: TaskLinks;
}

/* -------------------------------------------------------------------------- */
/*  Skill registry                                                            */
/* -------------------------------------------------------------------------- */

export interface ListSkillsResponse {
  skills: SkillDescriptor[];
}

export interface SuggestSkillsForTaskResponse {
  task_id: string;
  skills: SkillDescriptor[];
}

export interface RegisterSkillBody {
  name: string;
  label: string;
  description: string;
  keywords?: string[];
}

export interface RegisterSkillResponse extends OkResponse {
  skill: SkillDescriptor;
}

/* -------------------------------------------------------------------------- */
/*  GitHub                                                                    */
/* -------------------------------------------------------------------------- */

export interface GitHubUserSummary {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GitHubStatusResponse {
  connected: boolean;
  user?: GitHubUserSummary;
}

export interface GitHubConnectBody {
  /** Fine-grained or classic PAT. Never returned in any response. */
  token: string;
}

export interface GitHubConnectResponse {
  connected: true;
  user: GitHubUserSummary;
}

export interface GitHubRepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  html_url: string;
  updated_at: string | null;
}

export interface ListGitHubReposResponse {
  repos: GitHubRepoSummary[];
  /** True when the response was served from the 5-minute cache. */
  cached?: boolean;
}

export interface GetGitHubRepoResponse {
  repo: GitHubRepoSummary;
}

export interface CreateGitHubBranchBody {
  owner: string;
  repo: string;
  branch: string;
  /** Source ref (branch name or full `refs/...`). Defaults to default branch. */
  fromRef?: string;
}

export interface CreateGitHubBranchResponse extends OkResponse {
  ref: string;
  sha: string;
}

export interface GitHubCommitFile {
  /** Repo-relative path. Must not start with `/` or contain `..` segments. */
  path: string;
  /** UTF-8 file contents (base64-encoded on the wire by the server). */
  content: string;
}

export interface CommitGitHubFilesBody {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: GitHubCommitFile[];
}

export interface CommitGitHubFilesResponse extends OkResponse {
  /** SHA of the last commit produced. */
  sha: string;
  commits: Array<{ path: string; sha: string }>;
}

export interface OpenGitHubPullBody {
  owner: string;
  repo: string;
  head: string;
  /** Defaults to the repo's default branch. */
  base?: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface OpenGitHubPullResponse extends OkResponse {
  number: number;
  url: string;
}

export interface GitHubPullSummary {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head_ref: string;
  base_ref: string;
  merged: boolean;
  draft: boolean;
  created_at: string;
  updated_at: string;
  user_login: string | null;
}

export interface GetGitHubPullResponse {
  pull: GitHubPullSummary;
}

export interface ListGitHubIssuesQuery {
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user_login: string | null;
  created_at: string;
  updated_at: string;
  labels: string[];
}

export interface ListGitHubIssuesResponse {
  issues: GitHubIssueSummary[];
}

export interface CreateGitHubIssueBody {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}

export interface CreateGitHubIssueResponse extends OkResponse {
  number: number;
  html_url: string;
}

/* -------------------------------------------------------------------------- */
/*  Slack                                                                     */
/* -------------------------------------------------------------------------- */

export interface SlackTeamSummary {
  id: string;
  name: string;
  domain: string;
}

export interface SlackStatusResponse {
  connected: boolean;
  team?: SlackTeamSummary;
  bot_user_id?: string;
}

export interface SlackConnectBody {
  /** Slack bot token (`xoxb-…`). Never returned in any response. */
  token: string;
}

export interface SlackConnectResponse {
  connected: true;
  team: SlackTeamSummary;
  bot_user_id: string;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  is_archived: boolean;
}

export interface ListSlackChannelsResponse {
  channels: SlackChannelSummary[];
  /** True when the response was served from the 5-minute cache. */
  cached?: boolean;
}

export interface PostSlackMessageBody {
  /** Channel id (`C…`/`G…`/`D…`) or `#channel-name`. */
  channel: string;
  text: string;
  /** When set, the message lands in this thread (parent `ts`). */
  thread_ts?: string;
}

export interface PostSlackMessageResponse extends OkResponse {
  channel: string;
  ts: string;
  permalink: string | null;
}

export interface SlackCaptureNowResponse extends OkResponse {
  created: number;
  skipped: number;
  notConfigured?: boolean;
  paused?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Notion                                                                    */
/* -------------------------------------------------------------------------- */

export interface NotionStatusResponse {
  connected: boolean;
  workspace_name?: string;
  workspace_icon?: string | null;
  database_id?: string;
}

export interface NotionConnectBody {
  /** Internal-integration token. Never returned in any response. */
  token: string;
}

export interface NotionConnectResponse {
  connected: true;
  workspace_name: string;
  workspace_icon?: string | null;
}

export interface NotionDatabaseSummary {
  id: string;
  title: string;
  url: string;
}

export interface ListNotionDatabasesResponse {
  databases: NotionDatabaseSummary[];
}

export interface SelectNotionDatabaseBody {
  database_id: string;
}

export interface SelectNotionDatabaseResponse extends OkResponse {
  database_id: string;
}

export interface NotionSyncNowResponse {
  ok: boolean;
  pushed: number;
  skipped: number;
  failed: number;
  notConfigured?: boolean;
  reason?: string;
  errors?: Array<{ taskId: string; error: string }>;
}

/* -------------------------------------------------------------------------- */
/*  Gmail                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Response from `GET /api/gmail/status`. `scopes_granted` lists only the
 * Gmail-related scopes that Google echoed back in the stored token (the
 * Calendar grants are intentionally hidden — they're surfaced by
 * `/api/calendar/status`). `send_enabled` is true only when BOTH the
 * `gmail.send` OAuth scope is granted AND the user toggled "Enable send"
 * in Settings.
 */
export interface GmailStatusResponse {
  connected: boolean;
  email?: string;
  scopes_granted: string[];
  send_enabled: boolean;
}

export interface GmailConnectStartBody {
  /**
   * When true, the requested scope set includes `gmail.send`. Defaults
   * to whatever `gmail_send_enabled` is currently set to in settings.
   */
  include_send?: boolean;
}

export interface GmailConnectStartResponse {
  auth_url: string;
  redirect_uri: string;
  state: string;
}

export interface GmailConnectCompleteBody {
  code: string;
  state?: string;
}

export interface GmailConnectCompleteResponse extends OkResponse {
  status?: GmailStatusResponse;
}

export interface GmailDraftBody {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  /**
   * When set, the draft is threaded as a reply to this message id.
   * The server fetches Message-ID + References from the source and
   * stitches the headers so Gmail collapses the conversation.
   */
  in_reply_to_message_id?: string;
}

export interface GmailDraftResponse extends OkResponse {
  draft_id: string;
  message_id: string;
}

export interface GmailSendBody {
  /** Send a draft that was previously staged via /messages/draft. */
  draft_id?: string;
  /** Or send in-flight. All three (to/subject/body) are required if so. */
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  in_reply_to_message_id?: string;
}

export interface GmailSendResponse extends OkResponse {
  message_id: string;
  thread_id: string;
}

export interface GmailLabelBody {
  /** Label ids OR human-readable names. Names get auto-created if missing. */
  add?: string[];
  remove?: string[];
}

export interface GmailCaptureNowResponse extends OkResponse {
  imported: number;
  skipped: number;
  errors: Array<{ messageId?: string; error: string }>;
}

/* -------------------------------------------------------------------------- */
/*  Daily plan                                                                */
/* -------------------------------------------------------------------------- */

export type PlanBlockKind = 'meeting' | 'task' | 'focus' | 'break';

/**
 * One time-block in a generated plan. Meetings come from the calendar
 * (`event_id` set), tasks come from the slotting pass (`task_id` set),
 * breaks are interleaved by the generator (neither field set).
 */
export interface PlanBlock {
  start: string;
  end: string;
  kind: PlanBlockKind;
  title: string;
  task_id?: string;
  event_id?: string;
  notes?: string;
}

/**
 * Response from `POST/GET /api/plan/today`. The renderer consumes
 * `markdown` for the headline view and `blocks` for the clickable
 * time-block list.
 */
export interface DailyPlanResponse {
  date: string;
  blocks: PlanBlock[];
  markdown: string;
  overdue: Task[];
  due_today: Task[];
  top_priority: Task[];
}

export interface GenerateDailyPlanBody {
  /** YYYY-MM-DD anchor; defaults to today. */
  date?: string;
}

export interface GenerateDailyPlanQuery {
  date?: string;
}

/* -------------------------------------------------------------------------- */
/*  Reddit                                                                     */
/* -------------------------------------------------------------------------- */

export type RedditSort = 'hot' | 'new' | 'top' | 'rising';
export type RedditTimeWindow =
  | 'all'
  | 'year'
  | 'month'
  | 'week'
  | 'day'
  | 'hour';

export interface RedditPostSummary {
  id: string;
  name: string;
  subreddit: string;
  title: string;
  author: string | null;
  permalink: string;
  url: string;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  created_utc: number;
  is_self: boolean;
  selftext: string;
  link_flair_text: string | null;
  over_18: boolean;
  stickied: boolean;
}

export interface RedditCommentNode {
  id: string;
  author: string | null;
  body: string;
  score: number;
  created_utc: number;
  depth: number;
  replies: RedditCommentNode[];
}

export interface RedditPostDetail {
  post: RedditPostSummary;
  comments: RedditCommentNode[];
}

export interface ListSubredditPostsQuery {
  sort?: RedditSort;
  limit?: number;
  t?: RedditTimeWindow;
  after?: string;
}

export interface ListSubredditPostsResponse {
  posts: RedditPostSummary[];
  after: string | null;
}

export interface GetSubredditPostQuery {
  limit?: number;
}

export type GetSubredditPostResponse = RedditPostDetail;

export interface SearchSubredditQuery {
  q: string;
  sort?: 'relevance' | 'top' | 'new' | 'comments';
  limit?: number;
  restrict_sr?: boolean;
}

export type SearchSubredditResponse = ListSubredditPostsResponse;

/* -------------------------------------------------------------------------- */
/*  Reports                                                                    */
/* -------------------------------------------------------------------------- */

export type ReportWindow = '7d' | '30d' | '90d' | 'all';

export interface ThroughputPoint {
  date: string; // YYYY-MM-DD
  closed: number;
}

export interface AgentSuccessRate {
  succeeded: number;
  failed: number;
  needs_review: number;
  total: number;
}

export interface TimeToDoneBucket {
  median_hours: number | null;
  count: number;
}

export interface TimeToDoneByPriority {
  p0: TimeToDoneBucket;
  p1: TimeToDoneBucket;
  p2: TimeToDoneBucket;
  p3: TimeToDoneBucket;
}

export interface TimeToDoneByTagRow {
  tag: string;
  count: number;
  median_hours: number | null;
}

export type TaskStatusForHeatMap =
  | 'inbox'
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'archived';

export type TagHeatStatusCounts = Record<TaskStatusForHeatMap, number>;

export interface TagHeatMapRow {
  tag: string;
  total: number;
  by_status: TagHeatStatusCounts;
}

export interface RecentFailureRow {
  task_id: string;
  title: string;
  priority: TaskPriority;
  failed_at: string;
  error: string | null;
  tags: string[];
}

export interface ReviewQueueTrendPoint {
  date: string;
  count: number;
}

export interface ThroughputResponse {
  days: number;
  points: ThroughputPoint[];
}

export interface SuccessRateResponse {
  window: ReportWindow;
  rate: AgentSuccessRate;
}

export interface TimeToDoneResponse {
  window: ReportWindow;
  by_priority: TimeToDoneByPriority;
  by_tag: TimeToDoneByTagRow[];
}

export interface TagHeatMapResponse {
  window: ReportWindow;
  rows: TagHeatMapRow[];
}

export interface RecentFailuresResponse {
  failures: RecentFailureRow[];
}

export interface ReviewTrendResponse {
  days: number;
  points: ReviewQueueTrendPoint[];
}

export interface ReportsAllResponse {
  throughput: ThroughputPoint[];
  success_rate: AgentSuccessRate;
  time_to_done_priority: TimeToDoneByPriority;
  time_to_done_tags: TimeToDoneByTagRow[];
  tag_heat_map: TagHeatMapRow[];
  recent_failures: RecentFailureRow[];
  review_queue_trend: ReviewQueueTrendPoint[];
  window: ReportWindow;
  days: number;
}

export interface ReportsThroughputQuery {
  days?: number;
}

export interface ReportsWindowQuery {
  window?: ReportWindow;
}

export interface ReportsTagsQuery {
  window?: ReportWindow;
  limit?: number;
}

export interface ReportsFailuresQuery {
  limit?: number;
}

export interface ReportsAllQuery {
  window?: ReportWindow;
  days?: number;
}

/* -------------------------------------------------------------------------- */
/*  Status report (Wave 16E)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Named windows the status report understands. Distinct from `ReportWindow`
 * (the analytics dashboard's set) — the status report defaults to a 7-day
 * "what got done this week" view and also offers a 24h and 30d/90d window.
 */
export type StatusReportWindow = '24h' | '7d' | '30d' | '90d';

/** Where a generated report can be published. */
export type StatusReportDestination = 'slack' | 'notion' | 'gmail' | 'disk';

export interface StatusReportMetrics {
  done: number;
  in_progress: number;
  blocked: number;
  failed: number;
  overdue: number;
  cost_usd: number;
}

export interface StatusReportTagRow {
  tag: string;
  done: number;
  total: number;
}

export interface StatusReportWorkspaceRow {
  workspace: string;
  done: number;
  total: number;
}

export interface StatusReportHighlight {
  task_id: string;
  title: string;
  /** First output URL surfaced by the outputs collector, when present. */
  url: string | null;
}

export interface StatusReport {
  window: { from: string; to: string };
  generated_at: string;
  markdown: string;
  metrics: StatusReportMetrics;
  by_tag: StatusReportTagRow[];
  by_workspace: StatusReportWorkspaceRow[];
  highlights: StatusReportHighlight[];
}

/** Per-destination result of a publish attempt. */
export interface StatusReportPublishResult {
  destination: StatusReportDestination;
  ok: boolean;
  /** Human-readable detail (URL on success, reason on skip/failure). */
  detail: string;
  /** True when the destination was skipped because its integration is not
   * connected — distinct from an outright failure. */
  skipped: boolean;
}

export interface GenerateStatusReportBody {
  /** Named window. Mutually exclusive with explicit `from`/`to`. */
  window?: StatusReportWindow;
  /** Explicit ISO window bounds. When set, override `window`. */
  from?: string;
  to?: string;
  /** Destinations to publish to. Empty / omitted = generate + persist only. */
  destinations?: StatusReportDestination[];
}

export interface GenerateStatusReportResponse {
  report: StatusReport;
  published: StatusReportPublishResult[];
}

export interface StatusReportPreviewQuery {
  window?: StatusReportWindow;
  from?: string;
  to?: string;
}

export type StatusReportPreviewResponse = StatusReport;

export interface StatusReportHistoryQuery {
  limit?: number;
}

export interface StatusReportHistoryEntry {
  filename: string;
  generated_at: string;
  /** Window the report covered, parsed from the persisted JSON sidecar. */
  window: { from: string; to: string } | null;
  metrics: StatusReportMetrics | null;
}

export interface StatusReportHistoryResponse {
  reports: StatusReportHistoryEntry[];
}

export interface StatusReportSchedule {
  enabled: boolean;
  /** 5-field cron expression (minute hour day-of-month month day-of-week). */
  cron: string;
  destinations: StatusReportDestination[];
  /** ISO timestamp of the last automated fire, or null if never. */
  last_run_at: string | null;
}

export type StatusReportScheduleResponse = StatusReportSchedule;

export interface UpdateStatusReportScheduleBody {
  enabled?: boolean;
  cron?: string;
  destinations?: StatusReportDestination[];
}

/* -------------------------------------------------------------------------- */
/*  Lovable                                                                    */
/* -------------------------------------------------------------------------- */

export interface LovableProjectRef {
  project_id: string;
  url: string | null;
}

export interface GetTaskLovableResponse {
  lovable: LovableProjectRef | null;
}

export interface AttachTaskLovableBody {
  project_id: string;
  url?: string;
}

export interface AttachTaskLovableResponse extends OkResponse {
  task: Task;
  lovable: LovableProjectRef | null;
}

export interface DetachTaskLovableResponse extends OkResponse {
  task: Task;
}

/* -------------------------------------------------------------------------- */
/*  Backups (Wave 12 — operational hardening)                                 */
/* -------------------------------------------------------------------------- */

export interface BackupSummary {
  path: string;
  filename: string;
  size_bytes: number;
  created_at: string;
}

export interface ListBackupsResponse {
  backups: BackupSummary[];
}

export interface CreateBackupResponse {
  backup: BackupSummary;
}

export interface DeleteBackupResponse extends OkResponse {
  filename: string;
}

export interface RestoreBackupResponse extends OkResponse {
  source: string;
  pre_restore_path: string;
  requires_restart: boolean;
}

export interface BackupsStatusResponse {
  retain_count: number;
  next_run_at: string | null;
  last_run_at: string | null;
  count: number;
}

/* -------------------------------------------------------------------------- */
/*  Telemetry (Wave 12 — opt-in anonymous usage reporting)                    */
/* -------------------------------------------------------------------------- */

export type TelemetryEventKind =
  | 'launch'
  | 'task_created'
  | 'task_done'
  | 'task_failed'
  | 'error'
  | 'derive'
  | 'execute';

export interface TelemetryStatusResponse {
  enabled: boolean;
  endpoint: string;
  log_path: string;
  total_events: number;
  pending: number;
}

export interface TelemetryFlushResponse extends OkResponse {
  uploaded: number;
  errors: number;
}

export interface RecordTelemetryEventBody {
  kind: TelemetryEventKind;
  payload?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*  Cost tracking (Wave 13)                                                   */
/* -------------------------------------------------------------------------- */

export interface RecordCostEventBody {
  task_id: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  source?: string;
  third_party_label?: string;
  third_party_cost_usd?: number;
  /** Optional override — server computes from the model if unset. */
  cost_usd?: number;
  /** Optional ISO timestamp; server stamps `now` when missing. */
  at?: string;
}

export interface RecordCostEventResponse {
  event: CostEvent;
}

export interface ListCostEventsQuery {
  task_id?: string;
  limit?: number;
  from?: string;
  to?: string;
}

export interface ListCostEventsResponse {
  events: CostEvent[];
}

export interface CostBreakdownEntry {
  key: string;
  total_usd: number;
  events: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CostSummaryResponse {
  total_usd: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
  by_tag: CostBreakdownEntry[];
  by_workspace: CostBreakdownEntry[];
  by_model: CostBreakdownEntry[];
  window: { from: string | null; to: string | null };
}

export interface CostSummaryQuery {
  /** `"7d"`, `"30d"`, `"90d"`, or `"all"`. Defaults to `"30d"`. */
  window?: string;
}

/* -------------------------------------------------------------------------- */
/*  Feedback (Wave 13)                                                        */
/* -------------------------------------------------------------------------- */

export interface RecordFeedbackBody {
  task_id: string;
  kind: FeedbackKind;
  reason?: string;
  details?: string;
}

export interface RecordFeedbackResponse {
  entry: FeedbackEntry;
}

export interface ListFeedbackQuery {
  task_id?: string;
  limit?: number;
}

export interface ListFeedbackResponse {
  entries: FeedbackEntry[];
}

/* -------------------------------------------------------------------------- */
/*  Decision log (Wave 16)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Response from `GET /api/tasks/:id/decisions`. Entries are newest-first.
 */
export interface ListDecisionsResponse {
  decisions: DecisionEntry[];
}

/**
 * Body for `POST /api/tasks/:id/decisions`. `text` is required; `category`
 * defaults to `note`; `author` defaults to `user` server-side when omitted.
 */
export interface CreateDecisionBody {
  category?: DecisionCategory;
  text: string;
  author?: string;
  link?: string;
}

export interface CreateDecisionResponse {
  decision: DecisionEntry;
}

export interface DeleteDecisionResponse extends OkResponse {
  id: string;
}

/* -------------------------------------------------------------------------- */
/*  Full-text search (Wave 17)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Entity kinds the search engine indexes. Every result navigates to a task
 * (`task_id`); the kind tells the UI which badge + icon to render and which
 * field the match came from.
 */
export type SearchEntityType =
  | 'task'
  | 'decision'
  | 'execution'
  | 'attachment'
  | 'memory';

/**
 * One search hit. `task_id` is always the task to navigate to (for a decision
 * / execution / attachment it's the owning task). `snippet` carries `<mark>`
 * tags around the matched terms — the renderer dangerously-sets it after the
 * server has HTML-escaped the surrounding text. `score` is normalized so a
 * higher value is a better match (FTS path flips bm25's sign; LIKE path uses
 * an occurrence count).
 */
export interface SearchResult {
  entity_type: SearchEntityType;
  entity_id: string;
  task_id: string;
  title: string;
  snippet: string;
  score: number;
  matched_field: string;
}

/**
 * Query for `GET /api/search`. `types` is a comma-separated list of
 * {@link SearchEntityType} (omit / empty → all). `limit` defaults to 50,
 * capped at 200 server-side.
 */
export interface SearchQuery {
  q: string;
  types?: string;
  limit?: number;
}

/**
 * Response from `GET /api/search`. `fts_available` is `false` when the SQLite
 * build lacks FTS5 and the engine fell back to a LIKE scan — results are still
 * valid, just ranked by a simpler heuristic.
 */
export interface SearchResponse {
  results: SearchResult[];
  total: number;
  fts_available: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Generic webhooks (Wave 13)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Mapping rule that translates an inbound webhook payload into a task
 * action. `match` is optional — a rule without it always fires.
 */
export interface WebhookMappingRule {
  match?: { path: string; equals: unknown };
  action: 'create_task' | 'update_task' | 'comment_task';
  template: {
    title?: string;
    description?: string;
    priority?: TaskPriority;
    tags?: string[];
    task_id?: string;
    note?: string;
    agent_method?: 'cowork' | 'cli' | 'either' | 'human_only';
  };
}

/**
 * Webhook config as returned by the CRUD endpoints. The shared secret
 * is never echoed back — `has_secret` reports whether one is stored.
 */
export interface WebhookConfigPublic {
  id: string;
  name: string;
  has_secret: boolean;
  signature_header?: string;
  signature_algorithm: 'sha256' | 'sha1' | 'none';
  mapping_rules: WebhookMappingRule[];
  enabled: boolean;
  created_at: string;
}

export interface ListWebhookConfigsResponse {
  configs: WebhookConfigPublic[];
}

export interface CreateWebhookConfigBody {
  name: string;
  secret?: string;
  signature_header?: string;
  signature_algorithm?: 'sha256' | 'sha1' | 'none';
  mapping_rules?: WebhookMappingRule[];
  enabled?: boolean;
}

export interface CreateWebhookConfigResponse {
  config: WebhookConfigPublic;
}

export interface UpdateWebhookConfigBody {
  name?: string;
  /** Pass null to clear the stored secret. */
  secret?: string | null;
  signature_header?: string;
  signature_algorithm?: 'sha256' | 'sha1' | 'none';
  mapping_rules?: WebhookMappingRule[];
  enabled?: boolean;
}

export interface UpdateWebhookConfigResponse {
  config: WebhookConfigPublic;
}

export interface DeleteWebhookConfigResponse extends OkResponse {
  id: string;
}

export interface TestWebhookConfigBody {
  payload: unknown;
}

export interface TestWebhookConfigResponse {
  triggered_rules: number;
  rule_outcomes: Array<{
    matched: boolean;
    action?: WebhookMappingRule['action'];
    task_id?: string;
    error?: string;
  }>;
}

/* -------------------------------------------------------------------------- */
/*  Bulk import (Wave 13)                                                     */
/* -------------------------------------------------------------------------- */

export interface ImportMappingConfig {
  title_column: string;
  description_column?: string;
  priority_column?: string;
  priority_map?: Record<string, TaskPriority>;
  tag_columns?: string[];
  skip_duplicates_by?: string;
  agent_method?: 'cowork' | 'cli' | 'either' | 'human_only';
  default_priority?: TaskPriority;
}

export type ImportFormat = 'csv' | 'notion';

export interface ImportSuggestBody {
  format: ImportFormat;
  content: string;
}

export interface ImportSuggestResponse {
  headers: string[];
  row_count: number;
  suggestion: Partial<ImportMappingConfig>;
}

export interface ImportPreviewBody {
  format: ImportFormat;
  content: string;
  mapping: ImportMappingConfig;
  markdowns?: Record<string, string>;
}

export interface ImportPreviewRow {
  row_number: number;
  task: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    tags?: string[];
  };
  errors: string[];
  duplicate: boolean;
}

export interface ImportPreviewResponse {
  headers: string[];
  total_rows: number;
  preview: ImportPreviewRow[];
  summary: {
    valid: number;
    errors: number;
    duplicates: number;
  };
}

export interface ImportCommitOptions {
  import_tag?: string;
  source?: string;
}

export interface ImportCommitBody {
  format: ImportFormat;
  content: string;
  mapping: ImportMappingConfig;
  markdowns?: Record<string, string>;
  options?: ImportCommitOptions;
}

export interface ImportCommitResponse {
  created: number;
  skipped: number;
  errored: number;
  task_ids: string[];
  errors: Array<{ row_number: number; message: string }>;
}

/* -------------------------------------------------------------------------- */
/*  Outputs panel + briefing-pack export (Wave 15)                            */
/* -------------------------------------------------------------------------- */

/**
 * Response from `GET /api/tasks/:id/outputs`. The full aggregate of files,
 * artifacts, attachments, summary, and metrics for a single task. See
 * `OutputBundle` in `@/shared/types` for shape.
 */
export type GetTaskOutputsResponse = OutputBundle;

/**
 * Response from `GET /api/tasks/:id/outputs/file?path=...`. Full (or capped)
 * content of a single output/attachment file for the in-app viewer. See
 * `OutputFileContent` in `@/shared/types`.
 */
export type GetOutputFileContentResponse = OutputFileContent;

/* -------------------------------------------------------------------------- */
/*  Knowledge base                                                            */
/* -------------------------------------------------------------------------- */

/** `GET /api/knowledge` — overview of the knowledge base. */
export interface GetKnowledgeOverviewResponse {
  root: string;
  businesses: KnowledgeBusinessSummary[];
  extractor: KnowledgeExtractorStatus;
}

/** `POST /api/knowledge/reindex` — reindex all or one business. */
export interface ReindexKnowledgeResponse {
  ok: true;
  businesses: KnowledgeBusinessSummary[];
}

/** `GET /api/knowledge/resources/:business` — full catalog for one business. */
export interface GetKnowledgeResourcesResponse {
  business: string;
  resources: KnowledgeResource[];
}

/** `GET /api/knowledge/task/:id` — resources matched to a task. */
export interface GetTaskKnowledgeResponse {
  task_id: string;
  matches: KnowledgeMatch[];
}

/**
 * `GET /api/tasks/:id/briefing-pack` returns a ZIP stream rather than a JSON
 * envelope — the response is `application/zip` with a
 * `Content-Disposition: attachment; filename="task-<id>-briefing.zip"`
 * header. Declared as `unknown` here so consumers know not to JSON-parse.
 */
export type GetTaskBriefingPackResponse = unknown;

/* -------------------------------------------------------------------------- */
/*  Task journal (Wave 15A)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One chronological event in a task's journal. Aggregated from many sources
 * (DB tables, on-disk JSON, task context) by `src/main/journal/aggregator.ts`.
 *
 * Stable wire format — new kinds may be added but never repurposed. The
 * renderer keys icons/labels off `kind` and falls back to a generic icon
 * when it sees an unknown one.
 */
export type JournalEventKind =
  | 'created'
  | 'edited'
  | 'status_changed'
  | 'agent_status_changed'
  | 'derived'
  | 'execution_started'
  | 'execution_completed'
  | 'result_ingested'
  | 'attachment_added'
  | 'attachment_removed'
  | 'feedback'
  | 'cost'
  | 'pr_event'
  | 'issue_event'
  | 'calendar_linked'
  | 'notion_synced'
  | 'slack_linked'
  | 'gmail_linked'
  | 'child_completed'
  | 'archived'
  | 'unarchived'
  | 'scheduled'
  | 'decision';

export interface JournalEventLink {
  kind: 'task' | 'pr' | 'event' | 'page' | 'thread' | 'file';
  url?: string;
  ref?: string;
}

export interface JournalEvent {
  at: string; // ISO 8601
  kind: JournalEventKind;
  title: string;
  details?: Record<string, unknown>;
  actor?: 'user' | 'claude' | 'system';
  link?: JournalEventLink;
}

export interface JournalQuery {
  /** Drop events older than this ISO timestamp. */
  since?: string;
  /** Cap number of events returned (server clamps 1..500, default 100). */
  limit?: number;
}

export interface JournalResponse {
  events: JournalEvent[];
}

/* -------------------------------------------------------------------------- */
/*  Cross-task knowledge graph (Wave 17)                                      */
/* -------------------------------------------------------------------------- */

/**
 * One node in the cross-task knowledge graph. Tasks carry their id directly;
 * external artifacts use a synthetic id of the form `artifact:<kind>:<ref>`
 * (e.g. `artifact:pr:42`, `artifact:event:abc123`) so the same PR referenced
 * by two tasks collapses to a single node. Goal nodes (optional, only when the
 * goals module is present) use `goal:<id>`.
 *
 * `status` / `priority` are populated for task nodes only and drive the node
 * color in the renderer. `url` is set for artifact nodes that have a clickable
 * destination (PR/issue links); clicking a task node navigates to its detail
 * view instead.
 */
export interface GraphNode {
  id: string;
  kind: 'task' | 'pr' | 'issue' | 'event' | 'goal';
  label: string;
  status?: string;
  priority?: string;
  url?: string;
}

/**
 * One directed edge between two {@link GraphNode}s. `kind` drives the edge
 * styling (parent=solid, blocks=red dashed, related=gray dotted, etc.).
 *
 *   - `parent`    — `source` is the parent of `target` (parent_id chain).
 *   - `blocks`    — `source` blocks `target` (context.links.blocks).
 *   - `related`   — bidirectional general relation (context.links.related).
 *   - `duplicate` — `source` is a duplicate of `target` (duplicate_of).
 *   - `produces`  — `source` task produced the `target` artifact node.
 *   - `member_of` — `source` task belongs to the `target` goal node.
 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: 'parent' | 'blocks' | 'related' | 'duplicate' | 'produces' | 'member_of';
}

/**
 * The scope a graph was built for. Echoed back so the renderer can label the
 * view and keep its picker in sync.
 */
export interface GraphScope {
  kind: 'all' | 'workspace' | 'tag' | 'root';
  value?: string;
}

/**
 * Response from `GET /api/graph`. `truncated` is true when the `all` scope
 * exceeded the node cap (200) and the result was clipped; the renderer shows a
 * banner in that case. `node_cap` is the cap that was applied.
 */
export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  scope: GraphScope;
  truncated: boolean;
  node_cap: number;
}

export interface GraphQuery {
  scope?: 'all' | 'workspace' | 'tag' | 'root';
  value?: string;
}

/* -------------------------------------------------------------------------- */
/*  Businesses — per-business status surface                                  */
/* -------------------------------------------------------------------------- */

/** Re-export of the on-disk status delta shape stored in updates.jsonl. */
export interface StatusUpdate {
  at: string;
  headline: string;
  what_changed?: string;
  source?: string;
  links?: Array<{ label: string; url: string }>;
}

export interface BusinessTaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  updated_at: string;
}

export interface BusinessDecisionSummary {
  id: string;
  task_id: string;
  category: string;
  text: string;
  created_at: string;
}

export interface BusinessConversationSummary {
  id: string;
  title: string | null;
  project_path: string | null;
  topics: string[];
  ended_at: string;
}

export interface BusinessNextStep {
  text: string;
  source: 'open_task' | 'overdue_task' | 'recent_delta' | 'no_activity';
  task_id?: string;
}

export type LastInteractionKind =
  | 'chat'
  | 'code'
  | 'status_delta'
  | 'decision'
  | 'task'
  | 'none';

export interface BusinessSnapshot {
  tag: string;
  name: string;
  goal_id: string | null;
  repos: string[];
  headline: string;
  last_touched_at: string | null;
  last_interaction_kind: LastInteractionKind;
  computed_at: string;
  task_counts: {
    total: number;
    inbox: number;
    queued: number;
    in_progress: number;
    blocked: number;
    done: number;
    overdue: number;
  };
  open_tasks: BusinessTaskSummary[];
  recent_decisions: BusinessDecisionSummary[];
  recent_conversations: BusinessConversationSummary[];
  recent_updates: StatusUpdate[];
  next_steps: BusinessNextStep[];
}

export interface BusinessOverviewEntry {
  tag: string;
  name: string;
  goal_id: string | null;
  headline: string;
  last_touched_at: string | null;
  last_interaction_kind: LastInteractionKind;
  open_task_count: number;
  overdue_task_count: number;
  recent_update_count: number;
  latest_update_headline: string | null;
}

export interface ListBusinessesResponse {
  businesses: BusinessOverviewEntry[];
}

export interface GetBusinessResponse {
  snapshot: BusinessSnapshot;
}

export interface PostBusinessUpdateBody {
  at?: string;
  headline: string;
  what_changed?: string;
  source?: string;
  links?: Array<{ label: string; url: string }>;
}

export interface PostBusinessUpdateResponse {
  ok: true;
  snapshot: BusinessSnapshot;
}

/* -------------------------------------------------------------------------- */
/*  Content pipeline                                                           */
/* -------------------------------------------------------------------------- */

export type ContentState =
  | 'draft'
  | 'deai_checked'
  | 'atomized'
  | 'scheduled'
  | 'published'
  | 'tracked'
  | 'skipped';

export type ContentChannel =
  | 'linkedin'
  | 'reddit'
  | 'newsletter'
  | 'twitter'
  | 'blog';

export interface ContentDerivative {
  channel: ContentChannel;
  markdown: string;
  scheduled_at: string | null;
  published_at: string | null;
  published_url: string | null;
}

export interface ContentPiece {
  id: string;
  title: string;
  business: string | null;
  state: ContentState;
  draft_markdown: string;
  derivatives: ContentDerivative[];
  hypothesis: string | null;
  notes: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ListContentResponse {
  pieces: ContentPiece[];
}
export interface GetContentResponse {
  piece: ContentPiece;
}
export interface CreateContentBody {
  title: string;
  business?: string | null;
  draft_markdown?: string;
  hypothesis?: string | null;
  notes?: string | null;
  tags?: string[];
}
export interface CreateContentResponse {
  piece: ContentPiece;
}
export interface UpdateContentBody {
  title?: string;
  business?: string | null;
  draft_markdown?: string;
  hypothesis?: string | null;
  notes?: string | null;
  tags?: string[];
}
export interface UpdateContentResponse {
  piece: ContentPiece;
}
export interface AdvanceContentBody {
  to: ContentState;
}
export interface AdvanceContentResponse {
  piece: ContentPiece;
}
export interface SetDerivativeBody {
  channel: ContentChannel;
  markdown: string;
  scheduled_at?: string | null;
  published_at?: string | null;
  published_url?: string | null;
}
export interface SetDerivativeResponse {
  piece: ContentPiece;
}
export interface DeleteContentResponse {
  ok: true;
  id: string;
}

/* -------------------------------------------------------------------------- */
/*  Goals / Initiatives (Wave 17 — goals tier)                                */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/goals` — list goals, each bundled with its rolled-up progress.
 */
export interface ListGoalsQuery {
  status?: GoalStatus;
  workspace?: string;
}

export interface ListGoalsResponse {
  goals: GoalWithProgress[];
}

export type CreateGoalBody = Partial<Goal> & Pick<Goal, 'name'>;

export interface CreateGoalResponse {
  goal: Goal;
}

/**
 * `GET /api/goals/:id` — the goal, its progress, and its member tasks.
 */
export interface GetGoalResponse {
  goal: Goal;
  progress: GoalProgress;
  tasks: Task[];
}

export type UpdateGoalBody = Partial<Omit<Goal, 'id' | 'created_at' | 'updated_at'>>;

export interface UpdateGoalResponse {
  goal: Goal;
}

export interface DeleteGoalResponse extends OkResponse {
  id: string;
  /** Number of tasks that were detached (had their `context.goal_id` cleared). */
  detached: number;
}

export interface ListGoalTasksResponse {
  tasks: Task[];
}

/**
 * `POST /api/tasks/:id/goal` — attach (`goal_id` set) or detach
 * (`goal_id: null`) a task. Returns the updated task.
 */
export interface AttachTaskGoalBody {
  goal_id: string | null;
}

export interface AttachTaskGoalResponse extends OkResponse {
  task: Task;
}

/* -------------------------------------------------------------------------- */
/*  Ambient monitor — v6 (context observations + deliberations)               */
/* -------------------------------------------------------------------------- */

/**
 * Body for `POST /api/context/capture`. Source is `'browser'` (extension) or
 * `'manual'` (explicit hotkey / API). The server stamps `captured_at` and
 * generates `id`. The `metadata` bag is freeform — the capturer can stash
 * anything JSON-serializable.
 */
export interface CaptureContextObservationBody {
  source: 'browser' | 'manual';
  url?: string;
  page_title?: string;
  h1?: string;
  meta_description?: string;
  selection?: string;
  workspace_id?: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureContextObservationResponse {
  id: string;
  captured_at: string;
}

/**
 * Body for `POST /api/context/capture/batch`. Submitted by the Chrome
 * extension when it flushed queued events under a single HTTP call. The
 * server inserts everything in one SQLite transaction.
 */
export interface CaptureContextObservationBatchBody {
  source: 'browser';
  observations: CaptureContextObservationBody[];
}

export interface CaptureContextObservationBatchResponse {
  ids: string[];
  captured_at: string;
}

/**
 * Query for `GET /api/context/observations` — used by the Watch view list.
 */
export interface ListContextObservationsQuery {
  limit?: number;
  source?: ContextObservationSource;
  since?: string;
  batch_id?: string;
  workspace_id?: string;
}

export interface ListContextObservationsResponse {
  observations: ContextObservation[];
  total: number;
}

export interface DeleteContextObservationResponse extends OkResponse {
  id: string;
}

/**
 * Query for `GET /api/context/deliberations` — powers the Watch view's
 * deliberation-history pane.
 */
export interface ListDeliberationsQuery {
  limit?: number;
  status?: DeliberationStatus;
  since?: string;
}

export interface ListDeliberationsResponse {
  deliberations: Deliberation[];
  total: number;
}

/**
 * Response for `GET /api/context/deliberations/:id`. Joins the deliberation
 * row with the full {@link ContextObservation} records named in its
 * `observation_ids` JSON column.
 */
export interface GetDeliberationResponse {
  deliberation: Deliberation;
  observations: ContextObservation[];
}

/**
 * Body for `POST /api/context/deliberate`. Forces a deliberation request
 * without waiting for the batch threshold. If `observation_ids` is omitted
 * the server picks the last N unbatched observations.
 */
export interface RequestDeliberationBody {
  reason?: 'manual' | 'hotkey';
  observation_ids?: string[];
}

export interface RequestDeliberationResponse {
  batch_id: string;
  deliberation_id: string;
}

/**
 * Response for `GET /api/context/status` — used by Watch view header and
 * Settings status pill. All counts are server-side cheap aggregates.
 *
 * `panic_mode_active` mirrors the `ambient_panic_mode` setting. When true
 * the monitor's window + screenshot ticks short-circuit AND the Watch view
 * renders observation cards as `████` placeholders. Toggled via
 * `Ctrl+Shift+\`, the tray menu, or `PUT /api/settings/ambient_panic_mode`.
 */
export interface ContextMonitorStatusResponse {
  monitor_enabled: boolean;
  screenshot_enabled: boolean;
  extension_enabled: boolean;
  panic_mode_active: boolean;
  last_observation_at: string | null;
  pending_deliberations: number;
  observations_today: number;
  captures_dir: string;
}

/**
 * Response for `POST /api/context/panic/wipe`. Always returns 200 with
 * `ok: true`; any sub-step failure shows up in `warnings` so the caller
 * can surface it without inheriting exception semantics. See
 * `src/main/monitor/panic-wipe.ts` for the operation flow.
 */
export interface PanicWipeResponse {
  ok: true;
  files_deleted: number;
  rows_skipped: number;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Endpoint map                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Single endpoint descriptor. `Query` and `Body` are `void` when not applicable.
 */
export interface EndpointShape<Query, Body, Response> {
  query: Query;
  body: Body;
  response: Response;
}

/**
 * Keys are `METHOD path` exactly as in BUILD_CONTRACTS.md.
 *
 * Path params are kept as `:id` placeholders — consumers substitute at call time.
 */
export interface Endpoints {
  'GET /api/health': EndpointShape<void, void, HealthResponse>;
  'GET /api/config': EndpointShape<void, void, ConfigResponse>;

  'GET /api/tasks': EndpointShape<ListTasksQuery, void, ListTasksResponse>;
  'POST /api/tasks': EndpointShape<void, CreateTaskBody, CreateTaskResponse>;
  'GET /api/tasks/:id': EndpointShape<void, void, GetTaskResponse>;
  'PATCH /api/tasks/:id': EndpointShape<void, UpdateTaskBody, UpdateTaskResponse>;
  'DELETE /api/tasks/:id': EndpointShape<void, void, DeleteTaskResponse>;
  'POST /api/tasks/:id/derive': EndpointShape<void, void, DeriveTaskResponse>;
  'POST /api/tasks/:id/execute': EndpointShape<void, void, ExecuteTaskResponse>;
  'POST /api/tasks/:id/approve': EndpointShape<
    void,
    ApproveTaskBody,
    ApproveTaskResponse
  >;
  'POST /api/tasks/:id/reject': EndpointShape<
    void,
    RejectTaskBody,
    RejectTaskResponse
  >;
  'POST /api/tasks/:id/archive': EndpointShape<void, void, ArchiveTaskResponse>;
  'POST /api/tasks/:id/unarchive': EndpointShape<
    void,
    void,
    UnarchiveTaskResponse
  >;
  'POST /api/tasks/:id/schedule': EndpointShape<
    void,
    ScheduleTaskBody,
    ScheduleTaskResponse
  >;

  'GET /api/templates': EndpointShape<void, void, ListTemplatesResponse>;
  'POST /api/templates': EndpointShape<
    void,
    CreateTemplateBody,
    CreateTemplateResponse
  >;
  'GET /api/templates/:id': EndpointShape<void, void, GetTemplateResponse>;
  'PATCH /api/templates/:id': EndpointShape<
    void,
    UpdateTemplateBody,
    UpdateTemplateResponse
  >;
  'DELETE /api/templates/:id': EndpointShape<
    void,
    void,
    DeleteTemplateResponse
  >;
  'POST /api/templates/:id/materialize': EndpointShape<
    void,
    MaterializeTemplateBody,
    MaterializeTemplateResponse
  >;

  'GET /api/calendar/events': EndpointShape<
    ListCalendarEventsQuery,
    void,
    ListCalendarEventsResponse
  >;
  'POST /api/calendar/events': EndpointShape<
    void,
    CreateCalendarEventBody,
    CreateCalendarEventResponse
  >;
  'PATCH /api/calendar/events/:id': EndpointShape<
    void,
    UpdateCalendarEventBody,
    UpdateCalendarEventResponse
  >;
  'DELETE /api/calendar/events/:id': EndpointShape<
    void,
    void,
    DeleteCalendarEventResponse
  >;
  'POST /api/calendar/sync': EndpointShape<void, void, CalendarSyncResponse>;
  'GET /api/calendar/availability': EndpointShape<
    AvailabilityQuery,
    void,
    AvailabilityResponse
  >;

  'GET /api/io/pending': EndpointShape<void, void, IoPendingResponse>;
  'GET /api/io/results': EndpointShape<void, void, IoResultsResponse>;
  'POST /api/io/ingest': EndpointShape<void, void, IoIngestResponse>;
  'POST /api/io/results': EndpointShape<void, SubmitResultBody, SubmitResultResponse>;
  'GET /api/io/status': EndpointShape<void, void, IoStatusResponse>;
  'POST /api/results': EndpointShape<void, SubmitResultBody, SubmitResultResponse>;

  'GET /api/calendar/status': EndpointShape<void, void, CalendarStatusResponse>;

  'GET /api/data/export': EndpointShape<void, void, DataExportResponse>;
  'POST /api/data/import': EndpointShape<
    DataImportQuery,
    DataImportBody,
    DataImportResponse
  >;

  'GET /api/system/auto-launch': EndpointShape<void, void, AutoLaunchGetResponse>;
  'POST /api/system/auto-launch': EndpointShape<
    void,
    AutoLaunchSetBody,
    AutoLaunchSetResponse
  >;

  'GET /api/backups': EndpointShape<void, void, ListBackupsResponse>;
  'POST /api/backups': EndpointShape<void, void, CreateBackupResponse>;
  'GET /api/backups/status': EndpointShape<void, void, BackupsStatusResponse>;
  'DELETE /api/backups/:filename': EndpointShape<
    void,
    void,
    DeleteBackupResponse
  >;
  'POST /api/backups/:filename/restore': EndpointShape<
    void,
    void,
    RestoreBackupResponse
  >;

  'GET /api/telemetry/status': EndpointShape<
    void,
    void,
    TelemetryStatusResponse
  >;
  'POST /api/telemetry/flush': EndpointShape<
    void,
    void,
    TelemetryFlushResponse
  >;
  'POST /api/telemetry/event': EndpointShape<
    void,
    RecordTelemetryEventBody,
    OkResponse
  >;

  'GET /api/tasks/:id/permissions': EndpointShape<
    void,
    void,
    GetTaskPermissionsResponse
  >;
  'PATCH /api/tasks/:id/permissions': EndpointShape<
    void,
    UpdateTaskPermissionsBody,
    UpdateTaskPermissionsResponse
  >;
  'DELETE /api/tasks/:id/permissions': EndpointShape<
    void,
    void,
    ClearTaskPermissionsResponse
  >;
  'GET /api/permissions/profiles': EndpointShape<
    void,
    void,
    ListPermissionProfilesResponse
  >;
  'POST /api/permissions/profiles/:name/apply': EndpointShape<
    void,
    ApplyPermissionProfileBody,
    ApplyPermissionProfileResponse
  >;

  'GET /api/github/status': EndpointShape<void, void, GitHubStatusResponse>;
  'POST /api/github/connect': EndpointShape<
    void,
    GitHubConnectBody,
    GitHubConnectResponse
  >;
  'POST /api/github/disconnect': EndpointShape<void, void, OkResponse>;
  'GET /api/github/repos': EndpointShape<void, void, ListGitHubReposResponse>;
  'GET /api/github/repos/:owner/:repo': EndpointShape<
    void,
    void,
    GetGitHubRepoResponse
  >;
  'POST /api/github/branches': EndpointShape<
    void,
    CreateGitHubBranchBody,
    CreateGitHubBranchResponse
  >;
  'POST /api/github/commits': EndpointShape<
    void,
    CommitGitHubFilesBody,
    CommitGitHubFilesResponse
  >;
  'POST /api/github/pulls': EndpointShape<
    void,
    OpenGitHubPullBody,
    OpenGitHubPullResponse
  >;
  'GET /api/github/pulls/:owner/:repo/:number': EndpointShape<
    void,
    void,
    GetGitHubPullResponse
  >;
  'GET /api/github/issues': EndpointShape<
    ListGitHubIssuesQuery,
    void,
    ListGitHubIssuesResponse
  >;
  'POST /api/github/issues': EndpointShape<
    void,
    CreateGitHubIssueBody,
    CreateGitHubIssueResponse
  >;

  'GET /api/slack/status': EndpointShape<void, void, SlackStatusResponse>;
  'POST /api/slack/connect': EndpointShape<
    void,
    SlackConnectBody,
    SlackConnectResponse
  >;
  'POST /api/slack/disconnect': EndpointShape<void, void, OkResponse>;
  'GET /api/slack/channels': EndpointShape<
    void,
    void,
    ListSlackChannelsResponse
  >;
  'POST /api/slack/post': EndpointShape<
    void,
    PostSlackMessageBody,
    PostSlackMessageResponse
  >;
  'POST /api/slack/capture-now': EndpointShape<
    void,
    void,
    SlackCaptureNowResponse
  >;

  'GET /api/notion/status': EndpointShape<void, void, NotionStatusResponse>;
  'POST /api/notion/connect': EndpointShape<
    void,
    NotionConnectBody,
    NotionConnectResponse
  >;
  'POST /api/notion/disconnect': EndpointShape<void, void, OkResponse>;
  'GET /api/notion/databases': EndpointShape<
    void,
    void,
    ListNotionDatabasesResponse
  >;
  'POST /api/notion/databases/select': EndpointShape<
    void,
    SelectNotionDatabaseBody,
    SelectNotionDatabaseResponse
  >;
  'POST /api/notion/sync-now': EndpointShape<
    void,
    void,
    NotionSyncNowResponse
  >;

  'GET /api/gmail/status': EndpointShape<void, void, GmailStatusResponse>;
  'POST /api/gmail/connect/start': EndpointShape<
    void,
    GmailConnectStartBody,
    GmailConnectStartResponse
  >;
  'POST /api/gmail/connect/complete': EndpointShape<
    void,
    GmailConnectCompleteBody,
    GmailConnectCompleteResponse
  >;
  'POST /api/gmail/disconnect': EndpointShape<void, void, OkResponse>;
  'POST /api/gmail/messages/draft': EndpointShape<
    void,
    GmailDraftBody,
    GmailDraftResponse
  >;
  'POST /api/gmail/messages/send': EndpointShape<
    void,
    GmailSendBody,
    GmailSendResponse
  >;
  'POST /api/gmail/messages/:id/label': EndpointShape<
    void,
    GmailLabelBody,
    OkResponse
  >;
  'POST /api/gmail/capture-now': EndpointShape<
    void,
    void,
    GmailCaptureNowResponse
  >;

  'POST /api/plan/today': EndpointShape<
    void,
    GenerateDailyPlanBody,
    DailyPlanResponse
  >;
  'GET /api/plan/today': EndpointShape<
    GenerateDailyPlanQuery,
    void,
    DailyPlanResponse
  >;

  'GET /api/reddit/subreddit/:subreddit/posts': EndpointShape<
    ListSubredditPostsQuery,
    void,
    ListSubredditPostsResponse
  >;
  'GET /api/reddit/subreddit/:subreddit/posts/:post_id': EndpointShape<
    GetSubredditPostQuery,
    void,
    GetSubredditPostResponse
  >;
  'GET /api/reddit/subreddit/:subreddit/search': EndpointShape<
    SearchSubredditQuery,
    void,
    SearchSubredditResponse
  >;

  // Full-text search across tasks, decisions, execution outputs, attachments
  // (Wave 17). Query: `q` (required), `types` (comma list), `limit`.
  'GET /api/search': EndpointShape<SearchQuery, void, SearchResponse>;

  'GET /api/tasks/:id/links': EndpointShape<void, void, GetTaskLinksResponse>;
  'PATCH /api/tasks/:id/links': EndpointShape<
    void,
    UpdateTaskLinksBody,
    UpdateTaskLinksResponse
  >;
  'POST /api/tasks/:id/links/blocks/:other_id': EndpointShape<
    void,
    void,
    AddTaskBlockResponse
  >;
  'DELETE /api/tasks/:id/links/blocks/:other_id': EndpointShape<
    void,
    void,
    RemoveTaskBlockResponse
  >;

  'GET /api/skills': EndpointShape<void, void, ListSkillsResponse>;
  'GET /api/skills/suggest/:task_id': EndpointShape<
    void,
    void,
    SuggestSkillsForTaskResponse
  >;
  'POST /api/skills/register': EndpointShape<
    void,
    RegisterSkillBody,
    RegisterSkillResponse
  >;

  'GET /api/tasks/:id/lovable': EndpointShape<
    void,
    void,
    GetTaskLovableResponse
  >;
  'POST /api/tasks/:id/lovable': EndpointShape<
    void,
    AttachTaskLovableBody,
    AttachTaskLovableResponse
  >;
  'DELETE /api/tasks/:id/lovable': EndpointShape<
    void,
    void,
    DetachTaskLovableResponse
  >;

  'GET /api/reports/throughput': EndpointShape<
    ReportsThroughputQuery,
    void,
    ThroughputResponse
  >;
  'GET /api/reports/success-rate': EndpointShape<
    ReportsWindowQuery,
    void,
    SuccessRateResponse
  >;
  'GET /api/reports/time-to-done': EndpointShape<
    ReportsWindowQuery,
    void,
    TimeToDoneResponse
  >;
  'GET /api/reports/tags': EndpointShape<
    ReportsTagsQuery,
    void,
    TagHeatMapResponse
  >;
  'GET /api/reports/failures': EndpointShape<
    ReportsFailuresQuery,
    void,
    RecentFailuresResponse
  >;
  'GET /api/reports/review-trend': EndpointShape<
    ReportsThroughputQuery,
    void,
    ReviewTrendResponse
  >;
  'GET /api/reports/all': EndpointShape<
    ReportsAllQuery,
    void,
    ReportsAllResponse
  >;

  /* Cost tracking ---------------------------------------------------------- */
  'POST /api/cost/events': EndpointShape<
    void,
    RecordCostEventBody,
    RecordCostEventResponse
  >;
  'GET /api/cost/events': EndpointShape<
    ListCostEventsQuery,
    void,
    ListCostEventsResponse
  >;
  'GET /api/cost/summary': EndpointShape<
    CostSummaryQuery,
    void,
    CostSummaryResponse
  >;

  /* Feedback --------------------------------------------------------------- */
  'POST /api/feedback': EndpointShape<
    void,
    RecordFeedbackBody,
    RecordFeedbackResponse
  >;
  'GET /api/feedback': EndpointShape<
    ListFeedbackQuery,
    void,
    ListFeedbackResponse
  >;

  'GET /api/tasks/:id/outputs': EndpointShape<
    void,
    void,
    GetTaskOutputsResponse
  >;
  'GET /api/tasks/:id/briefing-pack': EndpointShape<
    void,
    void,
    GetTaskBriefingPackResponse
  >;

  /* Task journal (Wave 15A) ----------------------------------------------- */
  'GET /api/tasks/:id/journal': EndpointShape<
    JournalQuery,
    void,
    JournalResponse
  >;

  /* Decision log (Wave 16) ------------------------------------------------- */
  'GET /api/tasks/:id/decisions': EndpointShape<
    void,
    void,
    ListDecisionsResponse
  >;
  'POST /api/tasks/:id/decisions': EndpointShape<
    void,
    CreateDecisionBody,
    CreateDecisionResponse
  >;
  'DELETE /api/decisions/:id': EndpointShape<
    void,
    void,
    DeleteDecisionResponse
  >;

  'POST /api/tasks/:id/attachments': EndpointShape<
    void,
    void,
    UploadAttachmentResponse
  >;
  'GET /api/tasks/:id/attachments': EndpointShape<
    void,
    void,
    ListAttachmentsResponse
  >;
  'GET /api/tasks/:id/attachments/:filename': EndpointShape<
    void,
    void,
    /* binary download — no JSON envelope */ unknown
  >;
  'DELETE /api/tasks/:id/attachments/:filename': EndpointShape<
    void,
    void,
    DeleteAttachmentResponse
  >;

  /* Generic webhooks (Wave 13) --------------------------------------------- */
  'GET /api/webhooks/configs': EndpointShape<
    void,
    void,
    ListWebhookConfigsResponse
  >;
  'POST /api/webhooks/configs': EndpointShape<
    void,
    CreateWebhookConfigBody,
    CreateWebhookConfigResponse
  >;
  'PATCH /api/webhooks/configs/:id': EndpointShape<
    void,
    UpdateWebhookConfigBody,
    UpdateWebhookConfigResponse
  >;
  'DELETE /api/webhooks/configs/:id': EndpointShape<
    void,
    void,
    DeleteWebhookConfigResponse
  >;
  'POST /api/webhooks/configs/:id/test': EndpointShape<
    void,
    TestWebhookConfigBody,
    TestWebhookConfigResponse
  >;

  /* Bulk import (Wave 13) -------------------------------------------------- */
  'POST /api/import/suggest': EndpointShape<
    void,
    ImportSuggestBody,
    ImportSuggestResponse
  >;
  'POST /api/import/preview': EndpointShape<
    void,
    ImportPreviewBody,
    ImportPreviewResponse
  >;
  'POST /api/import/commit': EndpointShape<
    void,
    ImportCommitBody,
    ImportCommitResponse
  >;

  /* Phases / pipelines (Wave 15) ------------------------------------------ */
  'GET /api/phases/pipelines': EndpointShape<
    void,
    void,
    ListPipelinesResponse
  >;
  'POST /api/phases/pipelines': EndpointShape<
    void,
    CreatePipelineBody,
    CreatePipelineResponse
  >;
  'PATCH /api/phases/pipelines/:id': EndpointShape<
    void,
    UpdatePipelineBody,
    UpdatePipelineResponse
  >;
  'DELETE /api/phases/pipelines/:id': EndpointShape<
    void,
    void,
    DeletePipelineResponse
  >;
  'POST /api/phases/pipelines/reset': EndpointShape<
    void,
    void,
    ListPipelinesResponse
  >;
  'GET /api/tasks/:id/phase': EndpointShape<
    void,
    void,
    GetTaskPhaseResponse
  >;
  'PATCH /api/tasks/:id/phase': EndpointShape<
    void,
    UpdateTaskPhaseBody,
    UpdateTaskPhaseResponse
  >;
  'POST /api/tasks/:id/phase/advance': EndpointShape<
    void,
    void,
    UpdateTaskPhaseResponse
  >;
  'POST /api/tasks/:id/phase/regress': EndpointShape<
    void,
    void,
    UpdateTaskPhaseResponse
  >;

  /* Status report (Wave 16E) ---------------------------------------------- */
  'POST /api/reports/status': EndpointShape<
    void,
    GenerateStatusReportBody,
    GenerateStatusReportResponse
  >;
  'GET /api/reports/status/preview': EndpointShape<
    StatusReportPreviewQuery,
    void,
    StatusReportPreviewResponse
  >;
  'GET /api/reports/status/history': EndpointShape<
    StatusReportHistoryQuery,
    void,
    StatusReportHistoryResponse
  >;
  'GET /api/reports/status/schedule': EndpointShape<
    void,
    void,
    StatusReportScheduleResponse
  >;
  'PATCH /api/reports/status/schedule': EndpointShape<
    void,
    UpdateStatusReportScheduleBody,
    StatusReportScheduleResponse
  >;

  /* Businesses — per-business status surface ----------------------------- */
  'GET /api/businesses': EndpointShape<void, void, ListBusinessesResponse>;
  'GET /api/businesses/:tag': EndpointShape<void, void, GetBusinessResponse>;
  'GET /api/businesses/:tag/status.md': EndpointShape<void, void, string>;
  'POST /api/businesses/:tag/update': EndpointShape<
    void,
    PostBusinessUpdateBody,
    PostBusinessUpdateResponse
  >;

  /* Goals / Initiatives (Wave 17) ----------------------------------------- */
  'GET /api/goals': EndpointShape<ListGoalsQuery, void, ListGoalsResponse>;
  'POST /api/goals': EndpointShape<void, CreateGoalBody, CreateGoalResponse>;
  'GET /api/goals/:id': EndpointShape<void, void, GetGoalResponse>;
  'PATCH /api/goals/:id': EndpointShape<void, UpdateGoalBody, UpdateGoalResponse>;
  'DELETE /api/goals/:id': EndpointShape<void, void, DeleteGoalResponse>;
  'GET /api/goals/:id/tasks': EndpointShape<void, void, ListGoalTasksResponse>;
  'POST /api/tasks/:id/goal': EndpointShape<
    void,
    AttachTaskGoalBody,
    AttachTaskGoalResponse
  >;

  /* Cross-task knowledge graph (Wave 17) ----------------------------------- */
  'GET /api/graph': EndpointShape<GraphQuery, void, GraphResponse>;

  /* Ambient monitor (v6 — context observations + deliberations) ----------- */
  'POST /api/context/capture': EndpointShape<
    void,
    CaptureContextObservationBody,
    CaptureContextObservationResponse
  >;
  'POST /api/context/capture/batch': EndpointShape<
    void,
    CaptureContextObservationBatchBody,
    CaptureContextObservationBatchResponse
  >;
  'GET /api/context/observations': EndpointShape<
    ListContextObservationsQuery,
    void,
    ListContextObservationsResponse
  >;
  'DELETE /api/context/observations/:id': EndpointShape<
    void,
    void,
    DeleteContextObservationResponse
  >;
  'GET /api/context/deliberations': EndpointShape<
    ListDeliberationsQuery,
    void,
    ListDeliberationsResponse
  >;
  'GET /api/context/deliberations/:id': EndpointShape<
    void,
    void,
    GetDeliberationResponse
  >;
  'POST /api/context/deliberate': EndpointShape<
    void,
    RequestDeliberationBody,
    RequestDeliberationResponse
  >;
  /**
   * `GET /api/context/screenshots/:filename` returns a PNG image stream
   * rather than a JSON envelope; declared as `unknown` so consumers know not
   * to JSON-parse.
   */
  'GET /api/context/screenshots/:filename': EndpointShape<void, void, unknown>;
  'GET /api/context/status': EndpointShape<
    void,
    void,
    ContextMonitorStatusResponse
  >;
  'POST /api/context/panic/wipe': EndpointShape<void, void, PanicWipeResponse>;
}

/* -------------------------------------------------------------------------- */
/*  File attachments (Wave 13)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Per-task uploads (drag-drop or programmatic). Bytes live at
 * `~/.taskpilot/attachments/<task-id>/<filename>`; metadata lives at
 * `task.context.attachments`. See `~/.claude/skills/taskpilot/references/
 * ATTACHMENTS.md`.
 */
export interface ListAttachmentsResponse {
  attachments: Attachment[];
}

export interface UploadAttachmentResponse extends OkResponse {
  attachments: Attachment[];
}

export interface DeleteAttachmentResponse extends OkResponse {
  filename: string;
}

/* -------------------------------------------------------------------------- */
/*  Phases / pipelines (Wave 15)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Per-task phase + pipeline resolution. The endpoint returns both the raw
 * stored phase id (if any) AND the resolved {@link PhaseDefinition} so the
 * renderer can show a badge without rerunning the matcher.
 */
export interface GetTaskPhaseResponse {
  task_id: string;
  pipeline: Pipeline | null;
  phase: string | null;
  phase_definition: PhaseDefinition | null;
}

export interface UpdateTaskPhaseBody {
  /** Phase id (slug). `null` clears the phase. */
  phase: string | null;
  /**
   * Optional explicit pipeline binding. When provided, future resolution
   * skips the tag/workspace matcher and uses this pipeline directly. Pass
   * `null` to clear an existing override.
   */
  pipeline_id?: string | null;
}

export interface UpdateTaskPhaseResponse {
  task: Task;
  pipeline: Pipeline | null;
  phase: string | null;
  phase_definition: PhaseDefinition | null;
}

export interface ListPipelinesResponse {
  pipelines: Pipeline[];
}

export type CreatePipelineBody = Omit<Pipeline, 'id'> & {
  id?: string;
};

export interface CreatePipelineResponse {
  pipeline: Pipeline;
}

export type UpdatePipelineBody = Partial<Omit<Pipeline, 'id'>>;

export interface UpdatePipelineResponse {
  pipeline: Pipeline;
}

export interface DeletePipelineResponse extends OkResponse {
  id: string;
}

export type EndpointKey = keyof Endpoints;
export type EndpointQuery<K extends EndpointKey> = Endpoints[K]['query'];
export type EndpointBody<K extends EndpointKey> = Endpoints[K]['body'];
export type EndpointResponse<K extends EndpointKey> = Endpoints[K]['response'];

/* -------------------------------------------------------------------------- */
/*  Re-exports for convenience                                                */
/* -------------------------------------------------------------------------- */

export type {
  ApprovalKind,
  ApprovalPayload,
  Attachment,
  ContextObservation,
  ContextObservationSource,
  CostEvent,
  CostTokens,
  DecisionCategory,
  DecisionEntry,
  Deliberation,
  DeliberationStatus,
  DerivativeProposal,
  FeedbackEntry,
  FeedbackKind,
  Goal,
  GoalProgress,
  GoalStatus,
  GoalWithProgress,
  MaterializeTemplateOverrides,
  OutputArtifact,
  OutputBundle,
  KnowledgeBusinessSummary,
  KnowledgeExtractorStatus,
  KnowledgeMatch,
  KnowledgeResource,
  OutputFile,
  OutputFileContent,
  PermissionProfileDescriptor,
  PermissionProfileName,
  PermissionSet,
  PhaseAssignment,
  PhaseDefinition,
  Pipeline,
  RecurrenceRule,
  RejectionPayload,
  SkillDescriptor,
  Task,
  TaskLinks,
  TaskTemplate,
};
