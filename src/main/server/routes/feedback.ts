/**
 * `/api/feedback/...` routes.
 *
 * Two endpoints:
 *   - `POST /api/feedback` — record a free-form feedback entry
 *   - `GET  /api/feedback` — list entries (filterable by task)
 *
 * The /review router also records rejection entries automatically when the
 * user clicks "Reject" on a queue item — see `routes/review.ts`.
 */

import { Router } from 'express';
import { z } from 'zod';

import { feedbackRepository } from '@/main/db/repositories/feedback';
import { recordFeedback } from '@/main/feedback';
import { taskIdSchema } from '@/shared/io-schemas';
import type {
  ListFeedbackResponse,
  RecordFeedbackResponse,
} from '@/shared/api-contract';

import { asyncHandler, validateBody, validateQuery } from '../middleware';

const feedbackKindSchema = z.enum([
  'rejection_derivation',
  'rejection_result',
  'low_confidence',
  'edit_after_run',
  'note',
]);

const recordSchema = z
  .object({
    task_id: taskIdSchema,
    kind: feedbackKindSchema,
    reason: z.string().max(2_000).optional(),
    details: z.string().max(20_000).optional(),
  })
  .strict();

const listQuerySchema = z
  .object({
    task_id: taskIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export function feedbackRouter(): Router {
  const router = Router();

  router.post(
    '/',
    validateBody(recordSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof recordSchema>;
      const entry = recordFeedback({
        task_id: body.task_id,
        kind: body.kind,
        reason: body.reason ?? null,
        details: body.details ?? null,
      });
      const response: RecordFeedbackResponse = { entry };
      res.status(201).json(response);
    }),
  );

  router.get(
    '/',
    validateQuery(listQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof listQuerySchema>;
      const entries = feedbackRepository.list({
        ...(q.task_id ? { task_id: q.task_id } : {}),
        limit: q.limit ?? 100,
      });
      const body: ListFeedbackResponse = { entries };
      res.json(body);
    }),
  );

  return router;
}
