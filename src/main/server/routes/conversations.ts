/**
 * `/api/conversations/...` routes (Wave 18 — Claude Code catalogue).
 *
 * Surfaces:
 *   GET    /api/conversations           list with filters
 *   GET    /api/conversations/:id       single conversation + linked tasks
 *   POST   /api/conversations/reconcile force a full filesystem scan
 *   POST   /api/conversations/compact   force a compaction tick (manual)
 *   POST   /api/conversations/:id/link  link to a task
 *   DELETE /api/conversations/:id/link/:task_id  unlink from a task
 *   DELETE /api/conversations/:id       hard-delete the row (link rows cascade)
 *
 * Plus a per-task view:
 *   GET    /api/tasks/:id/conversations (mounted by taskConversationsRouter)
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  aggregateTopics,
  deleteConversation,
  getConversation,
  linkConversationToTask,
  listConversations,
  listLinksForConversation,
  listLinksForTask,
  rollupByDay,
  rollupByProject,
  unlinkConversationFromTask,
} from '@/main/db/repositories/conversations';
import { getTask } from '@/main/db/repositories/tasks';
import { summarizeResponseSchema, taskIdSchema } from '@/shared/io-schemas';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

const conversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid conversation id');

const linkBodySchema = z.object({
  task_id: taskIdSchema,
  kind: z
    .enum(['session_pin', 'cwd_match', 'tag_match', 'manual', 'execute_result'])
    .default('manual'),
  confidence: z.number().min(0).max(1).optional(),
});

function parseConversationId(raw: string): string {
  const parsed = conversationIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(
      400,
      'invalid_conversation_id',
      `Invalid conversation id: ${raw}`,
    );
  }
  return parsed.data;
}

function parseTaskId(raw: string): string {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${raw}`);
  }
  return parsed.data;
}

/**
 * Mounted at `/api/conversations`.
 */
export function conversationsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const q = req.query;
      // Hard cap every string param to prevent unbounded LIKE queries from
      // an attacker (or a runaway script) that POSTs e.g. a 1 MB topic.
      const clamp = (v: unknown, max: number): string | undefined => {
        if (typeof v !== 'string' || v.length === 0) return undefined;
        return v.slice(0, max);
      };
      const conversations = listConversations({
        source: clamp(q.source, 32) as never,
        project_path: clamp(q.project_path, 2048),
        topic: clamp(q.topic, 120),
        task_id: clamp(q.task_id, 64),
        compressed:
          q.compressed === 'true'
            ? true
            : q.compressed === 'false'
              ? false
              : undefined,
        search: clamp(q.search, 500),
        limit: q.limit ? Math.min(Math.max(1, Number(q.limit)), 500) : undefined,
        offset: q.offset ? Math.max(0, Number(q.offset)) : undefined,
      });
      res.json({ conversations });
    }),
  );

  router.get(
    '/topics',
    asyncHandler(async (_req, res) => {
      res.json({ topics: aggregateTopics() });
    }),
  );

  router.get(
    '/rollup',
    asyncHandler(async (req, res) => {
      const days = req.query.days ? Math.max(1, Math.min(180, Number(req.query.days))) : 14;
      res.json({ rollup: rollupByDay(days) });
    }),
  );

  router.get(
    '/by-project',
    asyncHandler(async (_req, res) => {
      res.json({ projects: rollupByProject() });
    }),
  );

  router.get(
    '/pending-summarizes',
    asyncHandler(async (req, res) => {
      const limit = req.query.limit ? Math.max(1, Math.min(100, Number(req.query.limit))) : 25;
      const mod = await import('@/main/conversations/compactor');
      const requests = await mod.listPendingSummarizeRequests(limit);
      res.json({ requests, count: requests.length });
    }),
  );

  router.post(
    '/:id/recompress',
    asyncHandler(async (req, res) => {
      const id = parseConversationId(String(req.params.id));
      const mod = await import('@/main/conversations/compactor');
      const updated = await mod.recompressConversation(id);
      if (!updated) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Conversation ${id} not found`,
        );
      }
      res.json({ ok: true, conversation: updated });
    }),
  );

  router.post(
    '/submit-summary',
    asyncHandler(async (req, res) => {
      const parsed = summarizeResponseSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiHttpError(
          400,
          'invalid_summary',
          parsed.error.message,
        );
      }
      const mod = await import('@/main/conversations/compactor');
      const result = mod.applySummary(parsed.data);
      if (!result.ok) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Conversation ${parsed.data.conversation_id} not found`,
        );
      }
      res.json({ ok: true, conversation: result.conversation });
    }),
  );

  router.get(
    '/:id/transcript',
    asyncHandler(async (req, res) => {
      const id = parseConversationId(String(req.params.id));
      const conversation = getConversation(id);
      if (!conversation) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Conversation ${id} not found`,
        );
      }
      if (!conversation.source_path) {
        throw new ApiHttpError(
          410,
          'archived',
          'Source path cleared by retention — full transcript no longer on disk',
        );
      }
      const { parseSessionFile } = await import('@/main/conversations/parser');
      const parsed = await parseSessionFile(conversation.source_path).catch(
        () => null,
      );
      if (!parsed) {
        throw new ApiHttpError(
          500,
          'parse_failed',
          'Source transcript file could not be parsed',
        );
      }
      const limit = req.query.limit
        ? Math.max(1, Math.min(1000, Number(req.query.limit)))
        : 200;
      const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
      const slice = parsed.messages.slice(offset, offset + limit);
      res.json({
        conversation_id: id,
        total_messages: parsed.messages.length,
        offset,
        limit,
        messages: slice,
      });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseConversationId(String(req.params.id));
      const conversation = getConversation(id);
      if (!conversation) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Conversation ${id} not found`,
        );
      }
      const links = listLinksForConversation(id);
      // Enrich each link with the task title so the UI shows something
      // human-readable instead of the raw id.
      const enriched = links.map((l) => {
        const t = getTask(l.task_id);
        return { ...l, task_title: t?.title ?? null };
      });
      res.json({ conversation, links: enriched });
    }),
  );

  router.post(
    '/reconcile',
    asyncHandler(async (req, res) => {
      const { reconcile } = await import('@/main/conversations/ingestor');
      const dryRun = req.query.dry_run === 'true';
      const max = req.query.max_sessions
        ? Math.max(1, Math.min(50_000, Number(req.query.max_sessions)))
        : undefined;
      const result = await reconcile({
        ...(dryRun ? { dry_run: true } : {}),
        ...(max !== undefined ? { max_sessions: max } : {}),
      });
      res.json(result);
    }),
  );

  router.post(
    '/compact',
    asyncHandler(async (_req, res) => {
      const mod = await import('@/main/conversations/compactor');
      const [d, i] = await Promise.all([
        mod.dispatchPendingCompactions(),
        mod.ingestPendingSummaries(),
      ]);
      const a = mod.archiveOldSources();
      res.json({
        dispatched: d.dispatched,
        ingested: i.ingested,
        archived: a.archived,
      });
    }),
  );

  router.post(
    '/:id/link',
    validateBody(linkBodySchema),
    asyncHandler(async (req, res) => {
      const id = parseConversationId(String(req.params.id));
      const conversation = getConversation(id);
      if (!conversation) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Conversation ${id} not found`,
        );
      }
      const body = req.body as z.infer<typeof linkBodySchema>;
      const task = getTask(body.task_id);
      if (!task) {
        throw new ApiHttpError(
          404,
          'task_not_found',
          `Task ${body.task_id} not found`,
        );
      }
      const link = linkConversationToTask({
        conversation_id: id,
        task_id: body.task_id,
        kind: body.kind,
        confidence: body.confidence ?? 1,
      });
      // Propagate decisions + references to the newly linked task — but skip
      // for `tag_match` since topic overlap alone is too weak a signal to
      // justify writing into a task's decision log.
      if (body.kind !== 'tag_match') {
        const { propagateToTask } = await import('@/main/conversations/side-effects');
        propagateToTask(conversation, body.task_id, []);
      }
      res.status(201).json({ link });
    }),
  );

  router.delete(
    '/:id/link/:task_id',
    asyncHandler(async (req, res) => {
      const id = parseConversationId(String(req.params.id));
      const taskId = parseTaskId(String(req.params.task_id));
      const removed = unlinkConversationFromTask(id, taskId);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', 'Link not found');
      }
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseConversationId(String(req.params.id));
      const removed = deleteConversation(id);
      if (!removed) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Conversation ${id} not found`,
        );
      }
      res.json({ ok: true, id });
    }),
  );

  return router;
}

/**
 * Mounted at `/api/tasks`. Adds `GET /:id/conversations`.
 */
export function taskConversationsRouter(): Router {
  const router = Router();

  router.get(
    '/:id/conversations',
    asyncHandler(async (req, res) => {
      const id = parseTaskId(String(req.params.id));
      const task = getTask(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const links = listLinksForTask(id);
      const conversations = links
        .map((l) => getConversation(l.conversation_id))
        .filter((c): c is NonNullable<typeof c> => c !== null);
      const enriched = links.map((l) => ({ ...l, task_title: task.title }));
      res.json({ conversations, links: enriched });
    }),
  );

  return router;
}
