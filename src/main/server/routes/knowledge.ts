/**
 * `/api/knowledge` routes — manage the local knowledge base and inspect what
 * matches a given task.
 *
 *   GET  /api/knowledge                 → overview (businesses + extractor status)
 *   POST /api/knowledge/reindex         → reindex all, or one business (body)
 *   GET  /api/knowledge/resources/:biz  → full catalog for one business
 *   GET  /api/knowledge/task/:id        → resources matched to a task
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  KNOWLEDGE_DIR,
  extractorStatus,
  knowledgeOverview,
  matchKnowledgeForTask,
  reindexAll,
  reindexBusiness,
} from '@/main/knowledge';
import { readCatalog } from '@/main/knowledge/catalog';
import { tasksRepository } from '@/main/db/repositories/tasks';
import { taskIdSchema } from '@/shared/io-schemas';
import type {
  GetKnowledgeOverviewResponse,
  GetKnowledgeResourcesResponse,
  GetTaskKnowledgeResponse,
  ReindexKnowledgeResponse,
} from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

const reindexBodySchema = z.object({
  business: z.string().min(1).max(128).optional(),
});

// Business slugs are folder names — keep them tame.
const businessSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'invalid business slug');

export function knowledgeRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const [businesses, extractor] = await Promise.all([
        knowledgeOverview(),
        extractorStatus(),
      ]);
      const body: GetKnowledgeOverviewResponse = {
        root: KNOWLEDGE_DIR,
        businesses,
        extractor,
      };
      res.json(body);
    }),
  );

  router.post(
    '/reindex',
    validateBody(reindexBodySchema),
    asyncHandler(async (req, res) => {
      const { business } = req.body as z.infer<typeof reindexBodySchema>;
      if (business !== undefined) {
        const parsed = businessSchema.safeParse(business);
        if (!parsed.success) {
          throw new ApiHttpError(400, 'invalid_business', 'Invalid business slug');
        }
        await reindexBusiness(parsed.data);
      } else {
        await reindexAll();
      }
      const body: ReindexKnowledgeResponse = {
        ok: true,
        businesses: await knowledgeOverview(),
      };
      res.json(body);
    }),
  );

  router.get(
    '/resources/:business',
    asyncHandler(async (req, res) => {
      const parsed = businessSchema.safeParse(String(req.params.business));
      if (!parsed.success) {
        throw new ApiHttpError(400, 'invalid_business', 'Invalid business slug');
      }
      const body: GetKnowledgeResourcesResponse = {
        business: parsed.data,
        resources: await readCatalog(parsed.data),
      };
      res.json(body);
    }),
  );

  router.get(
    '/task/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!taskIdSchema.safeParse(id).success) {
        throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${id}`);
      }
      const task = tasksRepository.findById(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      const body: GetTaskKnowledgeResponse = {
        task_id: id,
        matches: await matchKnowledgeForTask(task, 6),
      };
      res.json(body);
    }),
  );

  return router;
}
