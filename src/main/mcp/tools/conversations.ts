/**
 * MCP tools for the conversations catalogue (Wave 18).
 *
 * Lets a remote Claude (Claude Code via MCP, future cloud agent, etc.) read
 * the local Claude Code session catalogue without filesystem access. Tools
 * here are read-mostly; mutation is limited to manual link/unlink and a
 * "force compaction now" trigger that mirrors the HTTP endpoint.
 */

import { z } from 'zod';

import {
  aggregateTopics,
  getConversation,
  linkConversationToTask,
  listConversations,
  listLinksForConversation,
  listLinksForTask,
  rollupByDay,
  unlinkConversationFromTask,
} from '@/main/db/repositories/conversations';
import { summarizeResponseSchema, taskIdSchema } from '@/shared/io-schemas';

import type { McpTool } from '../tool-registry';

const conversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid conversation id');

/* -------------------------------------------------------------------------- */
/*  list_conversations                                                        */
/* -------------------------------------------------------------------------- */

const listInput = z.object({
  source: z.enum(['claude_code', 'claude_desktop', 'manual']).optional(),
  project_path: z.string().max(2048).optional(),
  topic: z.string().max(120).optional(),
  task_id: taskIdSchema.optional(),
  compressed: z.boolean().optional(),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(500).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
});

const listTool: McpTool<typeof listInput> = {
  name: 'taskpilot_list_conversations',
  description:
    'List ingested Claude Code conversations from the local catalogue. Filter by source, project_path, topic, linked task_id, compressed=true/false (post-30-day summarization state), or a search string (matches title/digest/topics). Returns conversations newest-first with metadata + digest preview, token totals, and detected topics. Use this to find prior sessions about a subject, audit token spend, or locate the conversation that produced a given output.',
  inputSchema: listInput,
  async handler(input) {
    return {
      conversations: listConversations({
        ...(input.source ? { source: input.source } : {}),
        ...(input.project_path ? { project_path: input.project_path } : {}),
        ...(input.topic ? { topic: input.topic } : {}),
        ...(input.task_id ? { task_id: input.task_id } : {}),
        ...(input.compressed !== undefined
          ? { compressed: input.compressed }
          : {}),
        ...(input.search ? { search: input.search } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        ...(input.offset ? { offset: input.offset } : {}),
      }),
    };
  },
};

/* -------------------------------------------------------------------------- */
/*  get_conversation                                                          */
/* -------------------------------------------------------------------------- */

const getInput = z.object({ id: conversationIdSchema });

const getTool: McpTool<typeof getInput> = {
  name: 'taskpilot_get_conversation',
  description:
    "Fetch a single conversation by id, plus its linked tasks. Returns the full digest, topics, key_decisions, files_touched, token usage, and link kinds. Note: this returns the cataloged metadata + digest only — the raw JSONL transcript stays on disk at source_path. For the full transcript you'd read that file directly via the filesystem.",
  inputSchema: getInput,
  async handler(input) {
    const conversation = getConversation(input.id);
    if (!conversation) {
      return { ok: false, reason: 'not_found' };
    }
    const links = listLinksForConversation(input.id);
    return { ok: true, conversation, links };
  },
};

/* -------------------------------------------------------------------------- */
/*  list_conversations_for_task                                               */
/* -------------------------------------------------------------------------- */

const forTaskInput = z.object({ task_id: taskIdSchema });

const forTaskTool: McpTool<typeof forTaskInput> = {
  name: 'taskpilot_list_conversations_for_task',
  description:
    'List every conversation linked to a task. Useful when you want to know the discussion history behind a task before continuing work on it.',
  inputSchema: forTaskInput,
  async handler(input) {
    const links = listLinksForTask(input.task_id);
    const conversations = links
      .map((l) => getConversation(l.conversation_id))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return { conversations, links };
  },
};

/* -------------------------------------------------------------------------- */
/*  link / unlink                                                             */
/* -------------------------------------------------------------------------- */

const linkInput = z.object({
  conversation_id: conversationIdSchema,
  task_id: taskIdSchema,
  kind: z
    .enum(['session_pin', 'cwd_match', 'tag_match', 'manual', 'execute_result'])
    .default('manual'),
  confidence: z.number().min(0).max(1).optional(),
});

const linkTool: McpTool<typeof linkInput> = {
  name: 'taskpilot_link_conversation_to_task',
  description:
    'Manually link a conversation to a task. Useful when the auto-linker missed a match (e.g. the session ran in a different cwd than the task). Upserts on (conversation_id, task_id) — re-linking with a stronger kind upgrades the existing link instead of duplicating it. Also propagates the conversation key_decisions + a touched-files reference to the task decision log, unless `kind="tag_match"` (which is too weak a signal to mutate the log).',
  inputSchema: linkInput,
  async handler(input) {
    const conversation = getConversation(input.conversation_id);
    if (!conversation) {
      return { ok: false, reason: 'conversation_not_found' };
    }
    const link = linkConversationToTask({
      conversation_id: input.conversation_id,
      task_id: input.task_id,
      kind: input.kind,
      confidence: input.confidence ?? 1,
    });
    if (input.kind !== 'tag_match') {
      const { propagateToTask } = await import(
        '@/main/conversations/side-effects'
      );
      propagateToTask(conversation, input.task_id, []);
    }
    return { ok: true, link };
  },
};

const unlinkInput = z.object({
  conversation_id: conversationIdSchema,
  task_id: taskIdSchema,
});

const unlinkTool: McpTool<typeof unlinkInput> = {
  name: 'taskpilot_unlink_conversation_from_task',
  description:
    'Remove a link between a conversation and a task. The conversation and task themselves are untouched.',
  inputSchema: unlinkInput,
  async handler(input) {
    const removed = unlinkConversationFromTask(
      input.conversation_id,
      input.task_id,
    );
    return { ok: removed };
  },
};

/* -------------------------------------------------------------------------- */
/*  compact_now                                                               */
/* -------------------------------------------------------------------------- */

const compactInput = z.object({});

const compactTool: McpTool<typeof compactInput> = {
  name: 'taskpilot_conversations_compact_now',
  description:
    'Manually fire the 30-day rolling compactor: dispatches summarize requests for any conversation older than `conversation_compression_days` (default 30), ingests any pending summarized responses, and archives source pointers past the retention window. Returns `{dispatched, ingested, archived}`. Normally runs on a 1-hour cadence; call this when you want immediate progress.',
  inputSchema: compactInput,
  async handler() {
    const mod = await import('@/main/conversations/compactor');
    const [d, i] = await Promise.all([
      mod.dispatchPendingCompactions(),
      mod.ingestPendingSummaries(),
    ]);
    const a = mod.archiveOldSources();
    return {
      dispatched: d.dispatched,
      ingested: i.ingested,
      archived: a.archived,
    };
  },
};

/* -------------------------------------------------------------------------- */
/*  reconcile                                                                 */
/* -------------------------------------------------------------------------- */

const reconcileInput = z.object({
  dry_run: z.boolean().default(false).optional(),
  max_sessions: z.number().int().min(1).max(50_000).default(5_000).optional(),
});

const reconcileTool: McpTool<typeof reconcileInput> = {
  name: 'taskpilot_conversations_reconcile',
  description:
    'Scan ~/.claude/projects/ and ingest every JSONL session into the catalogue. Idempotent — sessions with an unchanged content hash are skipped. Use after first install or after importing transcripts from another machine.\n\nFor large project directories (hundreds of sessions) the scan can take 30+ seconds. Pass `dry_run: true` first to get a count without ingesting, then optionally cap each call with `max_sessions` and run repeatedly to drain a large backlog.',
  inputSchema: reconcileInput,
  async handler(input) {
    const mod = await import('@/main/conversations/ingestor');
    return await mod.reconcile({
      ...(input.dry_run !== undefined ? { dry_run: input.dry_run } : {}),
      ...(input.max_sessions !== undefined ? { max_sessions: input.max_sessions } : {}),
    });
  },
};

/* -------------------------------------------------------------------------- */
/*  list_pending_summarizes — the consumer-side discovery surface             */
/* -------------------------------------------------------------------------- */

const listPendingInput = z.object({
  limit: z.number().int().min(1).max(100).default(10).optional(),
});

const listPendingTool: McpTool<typeof listPendingInput> = {
  name: 'taskpilot_list_pending_summarizes',
  description:
    "List conversations awaiting 30-day rolling compression. Returns the full SummarizeRequest payloads from `~/.taskpilot/io/summarize/` — title, current digest, sampled excerpt from the live JSONL, topics, files touched, model. Use this to drain the queue: read each request, generate a narrative summary, and submit via `taskpilot_submit_summary` (or write to ~/.taskpilot/io/summarized/<id>.json).",
  inputSchema: listPendingInput,
  async handler(input) {
    const mod = await import('@/main/conversations/compactor');
    const requests = await mod.listPendingSummarizeRequests(input.limit ?? 10);
    return { requests, count: requests.length };
  },
};

/* -------------------------------------------------------------------------- */
/*  submit_summary — programmatic write side                                  */
/* -------------------------------------------------------------------------- */

const submitInput = z.object({
  conversation_id: conversationIdSchema,
  summarized_at: z.string().optional(),
  summary: z.string().min(1).max(20_000),
  topics: z.array(z.string().max(120)).max(64).default([]).optional(),
  key_decisions: z.array(z.string().max(500)).max(64).default([]).optional(),
  title: z.string().max(500).optional(),
});

const submitTool: McpTool<typeof submitInput> = {
  name: 'taskpilot_submit_summary',
  description:
    'Submit a compacted summary for a conversation. Replaces the conversation digest, sets compressed_at, refreshes topic + decision lists, propagates decisions to any linked tasks, and re-indexes for search — all without requiring a file write. Use this after reading a request from `taskpilot_list_pending_summarizes`.',
  inputSchema: submitInput,
  async handler(input) {
    const payload = {
      conversation_id: input.conversation_id,
      summarized_at: input.summarized_at ?? new Date().toISOString(),
      summary: input.summary,
      topics: input.topics ?? [],
      key_decisions: input.key_decisions ?? [],
      ...(input.title ? { title: input.title } : {}),
    };
    const parsed = summarizeResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, reason: 'schema_invalid', detail: parsed.error.message };
    }
    const mod = await import('@/main/conversations/compactor');
    const result = mod.applySummary(parsed.data);
    if (!result.ok) {
      return { ok: false, reason: 'conversation_not_found' };
    }
    return { ok: true, conversation: result.conversation };
  },
};

/* -------------------------------------------------------------------------- */
/*  topics — aggregation                                                      */
/* -------------------------------------------------------------------------- */

const topicsInput = z.object({});

const topicsTool: McpTool<typeof topicsInput> = {
  name: 'taskpilot_conversation_topics',
  description:
    'Aggregate every topic that appears in any conversation. Returns `{topic, conversation_count, total_tokens, total_cost_usd, latest_at}` sorted by count, descending. Use this to find dominant themes across your Claude Code history.',
  inputSchema: topicsInput,
  async handler() {
    return { topics: aggregateTopics() };
  },
};

/* -------------------------------------------------------------------------- */
/*  rollup — daily breakdown                                                  */
/* -------------------------------------------------------------------------- */

const rollupInput = z.object({
  days: z.number().int().min(1).max(180).default(14).optional(),
});

const rollupTool: McpTool<typeof rollupInput> = {
  name: 'taskpilot_conversations_rollup',
  description:
    'Per-day rollup of conversation activity for the past N days (default 14). Each day surfaces sessions, total_tokens, total_cost_usd, top topics, and top files. Use this for "what did I work on this week" or to drive a weekly status report.',
  inputSchema: rollupInput,
  async handler(input) {
    return { rollup: rollupByDay(input.days ?? 14) };
  },
};

/* -------------------------------------------------------------------------- */
/*  transcript — paginated raw messages from the on-disk JSONL                */
/* -------------------------------------------------------------------------- */

const transcriptInput = z.object({
  id: conversationIdSchema,
  limit: z.number().int().min(1).max(1000).default(200).optional(),
  offset: z.number().int().min(0).default(0).optional(),
});

const transcriptTool: McpTool<typeof transcriptInput> = {
  name: 'taskpilot_conversation_transcript',
  description:
    "Read paginated messages from a conversation's on-disk JSONL transcript. Returns up to `limit` messages starting at `offset`, plus total_messages. Each message has role/timestamp/text/code_blocks/files_touched/tool_calls. Returns ok=false with reason='archived' when source_path was cleared by retention.",
  inputSchema: transcriptInput,
  async handler(input) {
    const conversation = getConversation(input.id);
    if (!conversation) return { ok: false, reason: 'not_found' };
    if (!conversation.source_path) return { ok: false, reason: 'archived' };
    const { parseSessionFile } = await import('@/main/conversations/parser');
    const parsed = await parseSessionFile(conversation.source_path).catch(
      () => null,
    );
    if (!parsed) return { ok: false, reason: 'parse_failed' };
    const limit = input.limit ?? 200;
    const offset = input.offset ?? 0;
    return {
      ok: true,
      total_messages: parsed.messages.length,
      offset,
      limit,
      messages: parsed.messages.slice(offset, offset + limit),
    };
  },
};

/* -------------------------------------------------------------------------- */
/*  recompress — force a fresh summary pass on an already-compressed row      */
/* -------------------------------------------------------------------------- */

const recompressInput = z.object({ id: conversationIdSchema });

const recompressTool: McpTool<typeof recompressInput> = {
  name: 'taskpilot_recompress_conversation',
  description:
    "Clear the `compressed_at` field on a conversation so the compactor will re-dispatch a summarize request on its next tick. Removes any stale request file. Use this when an earlier summary turned out to be weak and you want a fresh attempt — the new summary will replace the old digest.",
  inputSchema: recompressInput,
  async handler(input) {
    const mod = await import('@/main/conversations/compactor');
    const updated = await mod.recompressConversation(input.id);
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, conversation: updated };
  },
};

export const conversationTools: McpTool[] = [
  listTool as unknown as McpTool,
  getTool as unknown as McpTool,
  forTaskTool as unknown as McpTool,
  linkTool as unknown as McpTool,
  unlinkTool as unknown as McpTool,
  compactTool as unknown as McpTool,
  reconcileTool as unknown as McpTool,
  listPendingTool as unknown as McpTool,
  submitTool as unknown as McpTool,
  topicsTool as unknown as McpTool,
  rollupTool as unknown as McpTool,
  recompressTool as unknown as McpTool,
  transcriptTool as unknown as McpTool,
];
