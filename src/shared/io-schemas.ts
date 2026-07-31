/**
 * Zod schemas for the file-based agent I/O protocol.
 *
 * These validate the JSON payloads that Claude (Cowork / Claude Code) writes
 * into `~/.taskpilot/io/derived/` and `~/.taskpilot/io/results/`. The watcher
 * uses these schemas to gate ingestion — anything that fails parse gets moved
 * to `_invalid/`.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Task id                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical task-id shape. Restricted to the nanoid alphabet plus a length
 * cap so a value can never contain `..`, `/`, `\`, or any other character
 * that would let it escape its parent directory when joined into a path.
 *
 * Mirrored in `@/main/io/paths#isValidTaskId`. Update both together.
 */
export const taskIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid task id');

/**
 * Single-token tag — same alphabet as the task id, used to gate the
 * tags-LIKE bypass (see `src/main/db/repositories/tasks.ts`).
 */
export const tagSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid tag');

/* -------------------------------------------------------------------------- */
/*  Enums                                                                     */
/* -------------------------------------------------------------------------- */

export const taskStatusSchema = z.enum([
  'inbox',
  'queued',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
  'archived',
]);

export const taskPrioritySchema = z.enum(['p0', 'p1', 'p2', 'p3']);

export const agentMethodSchema = z.enum([
  'cowork',
  'cli',
  'either',
  'human_only',
]);

export const agentStatusSchema = z.enum([
  'pending',
  'assigned',
  'running',
  'succeeded',
  'failed',
  'needs_review',
]);

export const executionMethodSchema = z.enum(['cowork', 'cli']);

export const executionStatusSchema = z.enum([
  'succeeded',
  'failed',
  'needs_review',
]);

/* -------------------------------------------------------------------------- */
/*  Task (used inside ExecutionRequest)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Full task shape as expected on disk. Aligns with `types.ts#Task` after JSON
 * deserialization (i.e. `context` is already an object, `tags` is already an
 * array — repositories handle DB-layer parsing).
 */
export const taskSchema = z.object({
  id: taskIdSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  due: z.string().max(64).nullable(),
  calendar_event_id: z.string().max(256).nullable(),
  parent_id: taskIdSchema.nullable(),
  agent_executable: z.boolean(),
  agent_method: agentMethodSchema,
  agent_instructions: z.string().max(50_000).nullable(),
  agent_status: agentStatusSchema,
  context: z.record(z.string(), z.unknown()).nullable(),
  tags: z.array(tagSchema).max(64),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Loose schema for `~/.taskpilot/io/inbox/<id>.json` drops. Only `title` is
 * required — everything else is optional and normalized to a full Task by
 * `normalizeInboxDrop()`. This is the documented "drop a partial task" shape
 * that the skill and CLI tell callers to use; the watcher must NOT validate
 * inbox drops against the full `taskSchema` (which requires server-generated
 * fields like id/status/created_at and would reject every hand-written drop).
 */
export const inboxDropSchema = z.object({
  id: taskIdSchema.optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).nullable().optional(),
  priority: taskPrioritySchema.optional(),
  due: z.string().max(64).nullable().optional(),
  parent_id: taskIdSchema.nullable().optional(),
  agent_method: agentMethodSchema.optional(),
  agent_instructions: z.string().max(50_000).nullable().optional(),
  agent_executable: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  tags: z.array(tagSchema).max(64).optional(),
});

export type InboxDrop = z.infer<typeof inboxDropSchema>;

/* -------------------------------------------------------------------------- */
/*  StatusUpdate (cross-session business status feed)                          */
/* -------------------------------------------------------------------------- */

/**
 * Payload dropped into `~/.taskpilot/io/status_update/<id>.json` by any
 * Claude session (typically the SessionEnd hook) to record a status delta
 * against a business. The watcher appends it to that business's
 * `updates.jsonl` and re-renders the cached snapshot.
 *
 * `business` MUST match the `tag` field of a configured entry in
 * `~/.taskpilot/projects.json` — otherwise the file is quarantined.
 */
export const statusUpdateSchema = z.object({
  business: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid business tag'),
  at: z.string().datetime().optional(),
  headline: z.string().min(1).max(500),
  what_changed: z.string().max(10_000).optional(),
  source: z.string().max(500).optional(),
  links: z
    .array(
      z.object({
        label: z.string().max(200),
        url: z.string().max(2048),
      }),
    )
    .max(16)
    .optional(),
});

export type StatusUpdateDrop = z.infer<typeof statusUpdateSchema>;

/**
 * Turn a validated inbox drop into a full Task, filling server-side defaults.
 * `fallbackId` is the filename-derived id (already validated by the watcher);
 * an explicit `drop.id` wins if present. Pure — no I/O, no nanoid needed since
 * the inbox filename supplies a stable id.
 */
export function normalizeInboxDrop(
  fallbackId: string,
  drop: InboxDrop,
): import('./types').Task {
  const now = new Date().toISOString();
  const method = drop.agent_method ?? 'human_only';
  const agentExecutable =
    drop.agent_executable ??
    (method === 'cli' || method === 'cowork' || method === 'either');
  return {
    id: drop.id ?? fallbackId,
    title: drop.title,
    description: drop.description ?? null,
    status: 'inbox',
    priority: drop.priority ?? 'p2',
    due: drop.due ?? null,
    calendar_event_id: null,
    parent_id: drop.parent_id ?? null,
    agent_executable: agentExecutable,
    agent_method: method,
    agent_instructions: drop.agent_instructions ?? null,
    agent_status: 'pending',
    context: drop.context ?? null,
    tags: drop.tags ?? [],
    created_at: now,
    updated_at: now,
  };
}

/* -------------------------------------------------------------------------- */
/*  DerivationRequest                                                         */
/* -------------------------------------------------------------------------- */

export const derivationRequestSchema = z.object({
  request_type: z.literal('derive'),
  task: z.object({
    id: taskIdSchema,
    title: z.string().min(1).max(500),
    description: z.string().max(50_000).nullable(),
    priority: taskPrioritySchema,
    due: z.string().max(64).nullable(),
    tags: z.array(tagSchema).max(64),
  }),
  context: z.object({
    calendar_snapshot: z.string().max(1_000_000),
    related_tasks: z.array(taskIdSchema).max(500),
    available_tools: z.array(z.string().max(64)).max(64),
    execution_modes: z.array(executionMethodSchema),
  }),
  instructions: z.string().max(50_000),
});

/* -------------------------------------------------------------------------- */
/*  DerivativeProposal + DerivationResponse                                   */
/* -------------------------------------------------------------------------- */

export const derivativeProposalSchema = z.object({
  title: z.string().min(1).max(500),
  agent_executable: z.boolean(),
  agent_method: agentMethodSchema,
  agent_instructions: z.string().max(50_000).nullable(),
  estimated_minutes: z.number().int().nonnegative().max(60 * 24 * 30),
  depends_on: z.array(z.string().max(500)).max(64),
  review_required: z.boolean(),
});

export const derivationResponseSchema = z.object({
  task_id: taskIdSchema,
  derived_at: z.string(),
  derivatives: z.array(derivativeProposalSchema).max(64),
});

/* -------------------------------------------------------------------------- */
/*  ExecutionRequest                                                          */
/* -------------------------------------------------------------------------- */

export const executionRequestSchema = z.object({
  request_type: z.literal('execute'),
  task: taskSchema,
  parent_outputs: z.record(taskIdSchema, z.array(z.string().max(4_096)).max(1_024)),
  context: z.record(z.string().max(128), z.unknown()),
  instructions: z.string().max(50_000),
});

/* -------------------------------------------------------------------------- */
/*  ExecutionResult                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Optional token-usage block on an ExecutionResult. Lets Claude self-report
 * what model it spent on a task so the cost tracker can compute USD without
 * round-tripping through a separate telemetry channel. Every field is
 * optional — a partial report (e.g. just input/output tokens) is still
 * useful; the pricing layer treats missing fields as 0.
 */
export const costTokensSchema = z
  .object({
    model: z.string().min(1).max(128).optional(),
    input: z.number().int().min(0).max(100_000_000).optional(),
    output: z.number().int().min(0).max(100_000_000).optional(),
    cache_read: z.number().int().min(0).max(100_000_000).optional(),
    cache_creation: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict();

export type CostTokensInput = z.infer<typeof costTokensSchema>;

export const executionResultSchema = z.object({
  task_id: taskIdSchema,
  status: executionStatusSchema,
  completed_at: z.string(),
  summary: z.string().max(50_000),
  output_files: z.array(z.string().max(4_096)).max(1_024),
  notes: z.string().max(50_000).optional(),
  error: z.string().max(50_000).optional(),
  /**
   * Optional self-reported confidence in [0, 1]. When present and below the
   * configured `confidence_threshold` setting (default 0.7), ingestion auto-
   * routes the result to /review even when `review_required` is false.
   */
  confidence: z.number().min(0).max(1).optional(),
  /**
   * Optional token-usage block. Pricing is computed against the hardcoded
   * table in `@/main/cost-tracking/pricing` (overridable via setting
   * `model_pricing_override`).
   */
  cost_tokens: costTokensSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/*  PermissionSet                                                             */
/* -------------------------------------------------------------------------- */

export const networkAccessSchema = z.enum(['off', 'restricted', 'open']);

export const githubOperationSchema = z.enum(['read', 'branch', 'commit', 'pr']);

export const permissionProfileNameSchema = z.enum([
  'trusted-local',
  'sandboxed',
  'read-only-research',
  'github-pr',
]);

/**
 * Permission envelope attached to a task. Bounded sizes everywhere so a
 * malicious payload can't blow up the DB / JSON layer.
 *
 * `workspace` is a freeform absolute path — we don't validate filesystem
 * existence here (the server resolver does). `denied_patterns` are stored
 * verbatim as glob strings; the resolver does the matching at enforcement
 * time.
 */
export const permissionSetSchema = z
  .object({
    workspace: z.string().max(1024).optional(),
    allowed_tools: z.array(z.string().max(128)).max(64).optional(),
    denied_patterns: z.array(z.string().max(256)).max(64).optional(),
    network_access: networkAccessSchema.optional(),
    max_runtime_minutes: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 30)
      .optional(),
    confirm_destructive: z.boolean().optional(),
    github_repo: z
      .string()
      .max(256)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Expected "org/name"')
      .optional(),
    github_branch_policy: z.string().max(256).optional(),
    github_operations: z.array(githubOperationSchema).max(8).optional(),
  })
  .strict();

export type PermissionSet = z.infer<typeof permissionSetSchema>;

export const parsePermissionSet = (data: unknown): PermissionSet =>
  permissionSetSchema.parse(data);
export const safeParsePermissionSet = (data: unknown) =>
  permissionSetSchema.safeParse(data);

/* -------------------------------------------------------------------------- */
/*  Conversation summarization (Wave 18)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Request that the compactor drops into `~/.taskpilot/io/summarize/<id>.json`
 * when a conversation crosses the rolling-compression age threshold. Claude
 * reads it, generates a real summary, and writes the response shape below to
 * `~/.taskpilot/io/summarized/<id>.json`.
 *
 * Bounded sizes keep the JSON tractable for the model; the compactor truncates
 * large fields before writing.
 */
export const summarizeRequestSchema = z.object({
  request_type: z.literal('summarize'),
  conversation_id: z.string().min(1).max(64),
  source: z.string().max(32),
  source_id: z.string().max(256),
  title: z.string().max(500).nullable(),
  project_path: z.string().max(2048).nullable(),
  /** Optional absolute path to the on-disk JSONL — present when retention hasn't archived it. */
  source_path: z.string().max(2048).nullable().optional(),
  started_at: z.string(),
  ended_at: z.string(),
  model: z.string().max(128).nullable(),
  message_count: z.number().int().nonnegative(),
  /** Pre-compression digest (user prompts + code blocks + extracted decisions). */
  current_digest: z.string().max(200_000).nullable(),
  /**
   * Larger sampled excerpt from the live transcript. Built by the compactor
   * from first N + last N + every Mth user/assistant turn. Bounded but
   * generous so Claude has real content to summarize from instead of a
   * pre-truncated digest.
   */
  excerpt: z.string().max(120_000).optional(),
  /** Hint topics extracted at ingest time. */
  topics: z.array(z.string().max(120)).max(64),
  files_touched: z.array(z.string().max(1024)).max(200),
  instructions: z.string().max(8_000),
});

export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>;

export const summarizeResponseSchema = z.object({
  conversation_id: z.string().min(1).max(64),
  summarized_at: z.string(),
  /** Replacement for `digest` — narrative summary. */
  summary: z.string().max(20_000),
  /** Final topic tags (Claude can refine the hints). */
  topics: z.array(z.string().max(120)).max(64).default([]),
  /** Decisions Claude pulled out. Replaces `key_decisions`. */
  key_decisions: z.array(z.string().max(500)).max(64).default([]),
  /** Optional one-line headline derived for the catalogue. */
  title: z.string().max(500).optional(),
});

export type SummarizeResponse = z.infer<typeof summarizeResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Task links (Wave 12 intelligence layer)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Validates the cross-task relationships block stored at `task.context.links`.
 *
 * All ids are constrained to the canonical task-id alphabet. Arrays are
 * capped (256 entries) so a malicious payload can't blow up the row. The
 * shape is strict — extra keys are rejected to keep the contract narrow.
 */
export const taskLinksSchema = z
  .object({
    blocks: z.array(taskIdSchema).max(256).default([]),
    related: z.array(taskIdSchema).max(256).default([]),
    duplicate_of: taskIdSchema.nullable().default(null),
  })
  .strict();

export type TaskLinksInput = z.infer<typeof taskLinksSchema>;

/**
 * PATCH body shape for `/api/tasks/:id/links` — every field is optional so
 * callers can patch a single side. `null` on `duplicate_of` clears the link.
 */
export const taskLinksPatchSchema = z
  .object({
    blocks: z.array(taskIdSchema).max(256).optional(),
    related: z.array(taskIdSchema).max(256).optional(),
    duplicate_of: taskIdSchema.nullable().optional(),
  })
  .strict();

export type TaskLinksPatch = z.infer<typeof taskLinksPatchSchema>;

/**
 * Skill binding list — each entry is a skill identifier. The character set
 * mirrors the skill registry's id alphabet (lowercase alnum + `-`, `_`, and a
 * single optional `<plugin>:<skill>` segment). Cap at 32 — a task should
 * realistically declare a handful, not dozens.
 */
export const skillIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]+(?::[a-z0-9_-]+)?$/, 'Invalid skill id')
  .max(128);

export const taskSkillsSchema = z.array(skillIdSchema).max(32);

/* -------------------------------------------------------------------------- */
/*  File attachments (Wave 13)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Sanitized attachment filename. Same alphabet enforced by
 * `sanitizeAttachmentFilename()` in `@/main/attachments` — keep the regex in
 * sync if you ever loosen the sanitizer. Cap mirrors the 200-char limit
 * applied at sanitize time.
 */
export const attachmentFilenameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid attachment filename');

export const attachmentSchema = z
  .object({
    filename: attachmentFilenameSchema,
    size_bytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
    content_type: z.string().min(1).max(256),
    added_at: z.string().min(1).max(64),
  })
  .strict();

export type AttachmentInput = z.infer<typeof attachmentSchema>;

export const taskAttachmentsSchema = z.array(attachmentSchema).max(256);

/* -------------------------------------------------------------------------- */
/*  Decision log (Wave 16)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Decision-log entry category. Mirrors {@link DecisionCategory} in
 * `@/shared/types`. Used to gate the POST body for
 * `/api/tasks/:id/decisions`.
 */
export const decisionCategorySchema = z.enum([
  'decision',
  'context',
  'reference',
  'rationale',
  'risk',
  'note',
]);

/**
 * Body shape for `POST /api/tasks/:id/decisions`. `text` is required;
 * `category` defaults to `note`; `author` defaults to `user` server-side
 * when omitted. `link` is an optional URL / on-disk ref.
 */
export const createDecisionSchema = z
  .object({
    category: decisionCategorySchema.default('note'),
    text: z.string().min(1).max(10_000),
    author: z.string().min(1).max(64).optional(),
    link: z.string().max(2_048).optional(),
  })
  .strict();

export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;

/* -------------------------------------------------------------------------- */
/*  Goals / Initiatives (Wave 17 — goals tier)                                */
/* -------------------------------------------------------------------------- */

/**
 * Goal id — same constrained alphabet as a task id so it round-trips through
 * the URL/path/SQL layers safely and can be stored on `task.context.goal_id`.
 */
export const goalIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid goal id');

export const goalStatusSchema = z.enum([
  'active',
  'achieved',
  'abandoned',
  'on_hold',
]);

/**
 * Body for `POST /api/goals`. `name` is required; everything else optional.
 * `target_date` is a freeform bounded string (ISO date or timestamp); we do
 * not enforce a strict date grammar so partial dates / timestamps both pass.
 */
export const createGoalSchema = z
  .object({
    id: goalIdSchema.optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(10_000).nullable().optional(),
    status: goalStatusSchema.optional(),
    target_date: z.string().max(64).nullable().optional(),
    workspace: z.string().max(64).nullable().optional(),
    tags: z.array(tagSchema).max(64).optional(),
  })
  .strict();

export type CreateGoalBody = z.infer<typeof createGoalSchema>;

/**
 * PATCH body for `/api/goals/:id` — every field optional.
 */
export const updateGoalSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).nullable().optional(),
    status: goalStatusSchema.optional(),
    target_date: z.string().max(64).nullable().optional(),
    workspace: z.string().max(64).nullable().optional(),
    tags: z.array(tagSchema).max(64).optional(),
  })
  .strict();

export type UpdateGoalBody = z.infer<typeof updateGoalSchema>;

/**
 * Body for `POST /api/tasks/:id/goal` — attach (`goal_id` set) or detach
 * (`goal_id: null`) a task. The id, when present, must be a valid goal id.
 */
export const attachGoalSchema = z
  .object({
    goal_id: goalIdSchema.nullable(),
  })
  .strict();

export type AttachGoalBody = z.infer<typeof attachGoalSchema>;

/* -------------------------------------------------------------------------- */
/*  Phases / pipelines (Wave 15)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Slug-shaped id for pipelines + phase definitions. Same alphabet as the
 * task id so the phase value stored in `task.context.phase` round-trips
 * through every layer without escaping.
 */
export const phaseIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, 'Invalid phase id');

export const phaseDefinitionSchema = z
  .object({
    id: phaseIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    color: z.string().max(64).optional(),
    is_terminal: z.boolean().optional(),
  })
  .strict();

export const pipelineSchema = z
  .object({
    id: phaseIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    phases: z.array(phaseDefinitionSchema).min(1).max(32),
    applies_to: z
      .object({
        tags: z.array(tagSchema).max(32).optional(),
        workspaces: z.array(z.string().min(1).max(64)).max(32).optional(),
      })
      .strict()
      .optional(),
    default: z.boolean().optional(),
  })
  .strict();

export const pipelinesArraySchema = z.array(pipelineSchema).max(64);

export type PipelineInput = z.infer<typeof pipelineSchema>;
export type PhaseDefinitionInput = z.infer<typeof phaseDefinitionSchema>;

/**
 * PATCH body shape for `/api/phases/pipelines/:id` — every top-level field
 * is optional so callers can rename or swap phases independently.
 */
export const pipelinePatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2_000).optional(),
    phases: z.array(phaseDefinitionSchema).min(1).max(32).optional(),
    applies_to: z
      .object({
        tags: z.array(tagSchema).max(32).optional(),
        workspaces: z.array(z.string().min(1).max(64)).max(32).optional(),
      })
      .strict()
      .optional(),
    default: z.boolean().optional(),
  })
  .strict();

export type PipelinePatch = z.infer<typeof pipelinePatchSchema>;

/**
 * Body shape for `PATCH /api/tasks/:id/phase`. `null` clears the phase.
 */
export const taskPhasePatchSchema = z
  .object({
    phase: phaseIdSchema.nullable(),
    pipeline_id: phaseIdSchema.nullable().optional(),
  })
  .strict();

export type TaskPhasePatchInput = z.infer<typeof taskPhasePatchSchema>;

/* -------------------------------------------------------------------------- */
/*  InboxCreateSchema — simple create payload for io/inbox/ files            */
/* -------------------------------------------------------------------------- */

/**
 * Lenient schema for files Claude drops into `~/.taskpilot/io/inbox/`.
 *
 * Mirrors the MCP `createTaskInput` shape so Claude (Cowork / Claude Code)
 * can write a minimal JSON blob — just `title` is required — and the watcher
 * hydrates the rest with the same defaults the MCP `taskpilot_create_task`
 * tool applies. This is intentionally a subset of `taskSchema`; the watcher
 * runs both schemas in order (full Task first for backward compat, then this
 * for the simple create case).
 *
 * Fields:
 *   - `title`              required, 1-500 chars
 *   - `description`        optional markdown body
 *   - `priority`           optional, defaults to 'p2'
 *   - `due`                optional ISO datetime string
 *   - `tags`               optional array of tag tokens
 *   - `agent_method`       optional, defaults to 'human_only'
 *   - `agent_instructions` optional, required if agent_method != human_only
 *   - `parent_id`          optional nanoid of a parent task
 */
export const inboxCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  priority: taskPrioritySchema.optional(),
  due: z.string().max(64).optional(),
  tags: z.array(tagSchema).max(64).optional(),
  agent_method: agentMethodSchema.optional(),
  agent_instructions: z.string().max(50_000).optional(),
  parent_id: taskIdSchema.optional(),
});

export type InboxCreate = z.infer<typeof inboxCreateSchema>;

export const parseInboxCreate = (data: unknown): InboxCreate =>
  inboxCreateSchema.parse(data);
export const safeParseInboxCreate = (data: unknown) =>
  inboxCreateSchema.safeParse(data);

/* -------------------------------------------------------------------------- */
/*  PascalCase re-exports                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Wave 1C/1D imports these under PascalCase names. Both naming conventions
 * are exported so importers can pick whichever matches the surrounding code.
 */

export {
  taskStatusSchema as TaskStatusSchema,
  taskPrioritySchema as TaskPrioritySchema,
  agentMethodSchema as AgentMethodSchema,
  agentStatusSchema as AgentStatusSchema,
  executionMethodSchema as ExecutionMethodSchema,
  executionStatusSchema as ExecutionStatusSchema,
  taskSchema as TaskSchema,
  derivationRequestSchema as DerivationRequestSchema,
  derivativeProposalSchema as DerivativeProposalSchema,
  derivationResponseSchema as DerivationResponseSchema,
  executionRequestSchema as ExecutionRequestSchema,
  executionResultSchema as ExecutionResultSchema,
  permissionSetSchema as PermissionSetSchema,
  networkAccessSchema as NetworkAccessSchema,
  githubOperationSchema as GithubOperationSchema,
  permissionProfileNameSchema as PermissionProfileNameSchema,
};

/* -------------------------------------------------------------------------- */
/*  Inferred TS types (mirror src/shared/types.ts)                            */
/* -------------------------------------------------------------------------- */

export type DerivationRequest = z.infer<typeof derivationRequestSchema>;
export type DerivativeProposal = z.infer<typeof derivativeProposalSchema>;
export type DerivationResponse = z.infer<typeof derivationResponseSchema>;
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;

/* -------------------------------------------------------------------------- */
/*  Parse helpers — strongly typed wrappers around .parse / .safeParse        */
/* -------------------------------------------------------------------------- */

export const parseDerivationRequest = (data: unknown): DerivationRequest =>
  derivationRequestSchema.parse(data);
export const safeParseDerivationRequest = (data: unknown) =>
  derivationRequestSchema.safeParse(data);

export const parseDerivationResponse = (data: unknown): DerivationResponse =>
  derivationResponseSchema.parse(data);
export const safeParseDerivationResponse = (data: unknown) =>
  derivationResponseSchema.safeParse(data);

export const parseDerivativeProposal = (data: unknown): DerivativeProposal =>
  derivativeProposalSchema.parse(data);
export const safeParseDerivativeProposal = (data: unknown) =>
  derivativeProposalSchema.safeParse(data);

export const parseExecutionRequest = (data: unknown): ExecutionRequest =>
  executionRequestSchema.parse(data);
export const safeParseExecutionRequest = (data: unknown) =>
  executionRequestSchema.safeParse(data);

export const parseExecutionResult = (data: unknown): ExecutionResult =>
  executionResultSchema.parse(data);
export const safeParseExecutionResult = (data: unknown) =>
  executionResultSchema.safeParse(data);

/* -------------------------------------------------------------------------- */
/*  Ambient monitor — v6 (context observations + deliberations)               */
/* -------------------------------------------------------------------------- */

/**
 * Where an ambient capture came from. Mirrors
 * {@link import('./types').ContextObservationSource}.
 */
export const contextObservationSourceSchema = z.enum([
  'window',
  'screenshot',
  'browser',
  'manual',
]);

/**
 * Loose schema for files dropped into `~/.taskpilot/io/observations/<id>.json`.
 * Only `source` is required — the rest is filled by `normalizeObservationDrop()`
 * (id = nanoid(12), captured_at = nowIso(), other fields default to null).
 *
 * The browser-extension and ambient monitor primarily call the API; this
 * schema gates the rarer file-drop path so the watcher can hydrate it via the
 * same normalizer.
 */
export const contextObservationDropSchema = z.object({
  id: taskIdSchema.optional(),
  source: contextObservationSourceSchema,
  captured_at: z.string().max(64).optional(),
  app_name: z.string().max(500).optional(),
  window_title: z.string().max(2_000).optional(),
  url: z.string().max(4_096).optional(),
  page_title: z.string().max(2_000).optional(),
  h1: z.string().max(2_000).optional(),
  meta_description: z.string().max(4_000).optional(),
  selection: z.string().max(10_000).optional(),
  screenshot_path: z.string().max(4_096).optional(),
  workspace_id: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ContextObservationDrop = z.infer<typeof contextObservationDropSchema>;

export const parseContextObservationDrop = (
  data: unknown,
): ContextObservationDrop => contextObservationDropSchema.parse(data);
export const safeParseContextObservationDrop = (data: unknown) =>
  contextObservationDropSchema.safeParse(data);

/**
 * Single observation item as accepted by `POST /api/context/capture` and the
 * batch endpoint. The capture endpoint stamps `id` and `captured_at` itself,
 * so both are omitted here.
 */
export const contextObservationApiItemSchema = z.object({
  source: contextObservationSourceSchema,
  url: z.string().max(4_096).optional(),
  page_title: z.string().max(2_000).optional(),
  h1: z.string().max(2_000).optional(),
  meta_description: z.string().max(4_000).optional(),
  selection: z.string().max(10_000).optional(),
  app_name: z.string().max(500).optional(),
  window_title: z.string().max(2_000).optional(),
  screenshot_path: z.string().max(4_096).optional(),
  workspace_id: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ContextObservationApiItem = z.infer<
  typeof contextObservationApiItemSchema
>;

/**
 * Batched capture payload submitted by the Chrome extension when it flushed
 * queued events. Source is always `'browser'` at this entry point.
 */
export const contextObservationsBatchSchema = z.object({
  source: z.literal('browser'),
  observations: z.array(contextObservationApiItemSchema).min(1).max(500),
});

export type ContextObservationsBatch = z.infer<
  typeof contextObservationsBatchSchema
>;

export const parseContextObservationsBatch = (
  data: unknown,
): ContextObservationsBatch => contextObservationsBatchSchema.parse(data);
export const safeParseContextObservationsBatch = (data: unknown) =>
  contextObservationsBatchSchema.safeParse(data);

/**
 * Trigger reason for a deliberation request. Mirrors
 * {@link import('./types').DeliberationTriggerReason}.
 */
export const deliberationTriggerReasonSchema = z.enum([
  'batch_size',
  'context_shift',
  'manual',
  'hotkey',
]);

/**
 * Observation as embedded in a deliberation request payload. The shape is
 * the API surface (no server-only metadata) — just the fields Claude needs to
 * score interrupter vs waiter.
 */
export const deliberationRequestObservationSchema = z.object({
  id: taskIdSchema,
  source: z.string().max(64),
  captured_at: z.string().max(64),
  app_name: z.string().max(500).optional(),
  window_title: z.string().max(2_000).optional(),
  url: z.string().max(4_096).optional(),
  page_title: z.string().max(2_000).optional(),
  h1: z.string().max(2_000).optional(),
  meta_description: z.string().max(4_000).optional(),
  selection: z.string().max(10_000).optional(),
  screenshot_path: z.string().max(4_096).optional(),
});

/**
 * Recent-task summary as embedded in a deliberation request payload. Enough
 * for Claude to know what the user is already working on without needing to
 * round-trip to the tasks API.
 */
export const deliberationRequestRecentTaskSchema = z.object({
  id: taskIdSchema,
  title: z.string().min(1).max(500),
  status: z.string().max(64),
  priority: z.string().max(8).optional(),
});

/**
 * Payload written by `writeDeliberationRequest()` into
 * `~/.taskpilot/io/deliberate/<batch_id>.json`. Self-contained so Claude can
 * run the two-agent (interrupter vs waiter) scoring without callbacks.
 */
export const deliberationRequestSchema = z.object({
  id: taskIdSchema,
  requested_at: z.string().max(64),
  trigger_reason: deliberationTriggerReasonSchema,
  observations: z.array(deliberationRequestObservationSchema).max(200),
  recent_tasks: z.array(deliberationRequestRecentTaskSchema).max(50),
  active_workspace_id: z.string().max(64).optional(),
  quiet_hours_active: z.boolean(),
  instructions: z.object({
    interrupter_role: z.string().max(10_000),
    waiter_role: z.string().max(10_000),
    scoring_rubric: z.string().max(10_000),
  }),
});

export type DeliberationRequest = z.infer<typeof deliberationRequestSchema>;
export type DeliberationRequestObservation = z.infer<
  typeof deliberationRequestObservationSchema
>;
export type DeliberationRequestRecentTask = z.infer<
  typeof deliberationRequestRecentTaskSchema
>;
export type DeliberationProposedAction = z.infer<
  typeof deliberationProposedActionSchema
>;

export const parseDeliberationRequest = (data: unknown): DeliberationRequest =>
  deliberationRequestSchema.parse(data);
export const safeParseDeliberationRequest = (data: unknown) =>
  deliberationRequestSchema.safeParse(data);

/**
 * Proposed action surfaced by the interrupter when it thinks the user should
 * be nudged. `none` means "do not surface anything"; `create_task` spawns a
 * task; `notify` fires a passive notification.
 */
export const deliberationProposedActionSchema = z.object({
  type: z.enum(['create_task', 'notify', 'none']),
  title: z.string().max(500).optional(),
  body: z.string().max(10_000).optional(),
  priority: z.enum(['low', 'med', 'high']).optional(),
  due: z.string().max(64).optional(),
});

/**
 * Two-agent scoring output written by Claude into
 * `~/.taskpilot/io/deliberated/<batch_id>.json`. Ingestion uses
 * `decision` to spawn a task, fire a passive notification, or no-op. Falls
 * under trust-by-default — `confidence` < the configured threshold routes to
 * review.
 */
export const deliberationResultSchema = z.object({
  batch_id: taskIdSchema,
  completed_at: z.string().max(64),
  interrupter: z.object({
    score: z.number().min(0).max(1),
    reasoning: z.string().max(10_000),
    proposed_action: deliberationProposedActionSchema.optional(),
  }),
  waiter: z.object({
    score: z.number().min(0).max(1),
    reasoning: z.string().max(10_000),
  }),
  decision: z.enum(['interrupt', 'wait']),
  summary: z.string().max(10_000),
  confidence: z.number().min(0).max(1),
});

export type DeliberationResult = z.infer<typeof deliberationResultSchema>;

export const parseDeliberationResult = (data: unknown): DeliberationResult =>
  deliberationResultSchema.parse(data);
export const safeParseDeliberationResult = (data: unknown) =>
  deliberationResultSchema.safeParse(data);

/* -------------------------------------------------------------------------- */
/*  Memory enrichment (v9)                                                    */
/* -------------------------------------------------------------------------- */

export const memoryItemIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const memoryKindSchema = z.enum(['text', 'url', 'file']);

/**
 * What the app writes to `memory_enrich/<id>.json` for the runner to pick
 * up. Includes the raw content + minimal metadata so the runner doesn't
 * need to round-trip back to the API for context.
 */
export const memoryEnrichRequestSchema = z.object({
  request_type: z.literal('memory_enrich'),
  memory_id: memoryItemIdSchema,
  kind: memoryKindSchema,
  title: z.string().max(500).nullable(),
  source_url: z.string().max(2048).nullable(),
  source_path: z.string().max(2048).nullable(),
  raw_content: z.string().max(1_000_000),
  created_at: z.string(),
  instructions: z.string().max(10_000),
});

/**
 * What the runner writes to `memory_enriched/<id>.json` after the AI pass.
 * Every field is optional except `memory_id` + `status`; the watcher merges
 * whatever's present onto the item via `updateMemory()`.
 */
export const memoryEnrichResponseSchema = z.object({
  memory_id: memoryItemIdSchema,
  status: z.enum(['enriched', 'failed']),
  summary: z.string().max(8_000).optional(),
  // 1–12 short snake_case-ish tags.
  tags: z.array(z.string().min(1).max(64)).max(12).optional(),
  entities: z.record(z.string().max(64), z.unknown()).optional(),
  /**
   * Suggested links. The watcher creates each as a memory_links row
   * targeting another memory item or a task. Cap at 16 to avoid runaway
   * fan-out.
   */
  links: z
    .array(
      z.object({
        target_kind: z.enum(['memory', 'task', 'goal']),
        target_id: z.string().min(1).max(64),
        link_kind: z.enum(['related', 'refers_to', 'duplicate_of']),
        score: z.number().min(0).max(1).optional(),
      }),
    )
    .max(16)
    .optional(),
  error: z.string().max(2_000).optional(),
});

export type MemoryEnrichRequest = z.infer<typeof memoryEnrichRequestSchema>;
export type MemoryEnrichResponse = z.infer<typeof memoryEnrichResponseSchema>;

export const parseMemoryEnrichRequest = (data: unknown): MemoryEnrichRequest =>
  memoryEnrichRequestSchema.parse(data);
export const safeParseMemoryEnrichRequest = (data: unknown) =>
  memoryEnrichRequestSchema.safeParse(data);

export const parseMemoryEnrichResponse = (data: unknown): MemoryEnrichResponse =>
  memoryEnrichResponseSchema.parse(data);
export const safeParseMemoryEnrichResponse = (data: unknown) =>
  memoryEnrichResponseSchema.safeParse(data);
