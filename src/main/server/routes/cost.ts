/**
 * `/api/cost/...` routes.
 *
 * Three endpoints:
 *   - `POST /api/cost/events` — record an LLM/third-party cost row
 *   - `GET  /api/cost/events` — list events (filterable by task)
 *   - `GET  /api/cost/summary` — aggregations (by tag, workspace, model)
 *
 * The cost-tracking module owns pricing + aggregation logic; this file is
 * just the HTTP surface.
 */

import { Router } from 'express';
import { z } from 'zod';

import { aggregateCost, recordCost } from '@/main/cost-tracking';
import { costEventsRepository } from '@/main/db/repositories/cost-events';
import { taskIdSchema } from '@/shared/io-schemas';
import type {
  CostSummaryResponse,
  ListCostEventsResponse,
  RecordCostEventResponse,
} from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const recordEventSchema = z
  .object({
    task_id: taskIdSchema,
    model: z.string().min(1).max(128).optional(),
    input_tokens: z.number().int().min(0).max(100_000_000).optional(),
    output_tokens: z.number().int().min(0).max(100_000_000).optional(),
    cache_read_tokens: z.number().int().min(0).max(100_000_000).optional(),
    cache_creation_tokens: z.number().int().min(0).max(100_000_000).optional(),
    source: z.string().max(128).optional(),
    third_party_label: z.string().max(128).optional(),
    third_party_cost_usd: z.number().min(0).max(1_000_000).optional(),
    cost_usd: z.number().min(0).max(1_000_000).optional(),
    at: z.string().max(64).optional(),
  })
  .strict();

const listEventsQuerySchema = z
  .object({
    task_id: taskIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1_000).optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
  })
  .strict();

const summaryQuerySchema = z
  .object({
    window: z
      .string()
      .max(16)
      .regex(/^(all|\d+d)$/, 'Expected "7d", "30d", "all", etc.')
      .optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function costRouter(): Router {
  const router = Router();

  // POST /api/cost/events --------------------------------------------------
  router.post(
    '/events',
    validateBody(recordEventSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof recordEventSchema>;

      // When the caller supplied `cost_usd` explicitly, persist verbatim —
      // they may know something the pricing table doesn't. Otherwise let
      // the cost-tracking module compute USD from the tokens + model.
      const tokens =
        body.model !== undefined ||
        body.input_tokens !== undefined ||
        body.output_tokens !== undefined ||
        body.cache_read_tokens !== undefined ||
        body.cache_creation_tokens !== undefined
          ? {
              ...(body.model !== undefined ? { model: body.model } : {}),
              ...(body.input_tokens !== undefined
                ? { input: body.input_tokens }
                : {}),
              ...(body.output_tokens !== undefined
                ? { output: body.output_tokens }
                : {}),
              ...(body.cache_read_tokens !== undefined
                ? { cache_read: body.cache_read_tokens }
                : {}),
              ...(body.cache_creation_tokens !== undefined
                ? { cache_creation: body.cache_creation_tokens }
                : {}),
            }
          : undefined;

      let event;
      if (body.cost_usd !== undefined) {
        // Explicit USD — bypass pricing.
        event = costEventsRepository.create({
          task_id: body.task_id,
          model: body.model ?? null,
          input_tokens: body.input_tokens ?? null,
          output_tokens: body.output_tokens ?? null,
          cache_read_tokens: body.cache_read_tokens ?? null,
          cache_creation_tokens: body.cache_creation_tokens ?? null,
          cost_usd: body.cost_usd,
          source: body.source ?? null,
          third_party_label: body.third_party_label ?? null,
          third_party_cost_usd: body.third_party_cost_usd ?? null,
          ...(body.at ? { at: body.at } : {}),
        });
      } else {
        const recordInput: Parameters<typeof recordCost>[0] = {
          task_id: body.task_id,
          ...(tokens ? { tokens } : {}),
          ...(body.source !== undefined ? { source: body.source } : {}),
          ...(body.third_party_label !== undefined
            ? { third_party_label: body.third_party_label }
            : {}),
          ...(body.third_party_cost_usd !== undefined
            ? { third_party_cost_usd: body.third_party_cost_usd }
            : {}),
          ...(body.at ? { at: body.at } : {}),
        };
        const created = recordCost(recordInput);
        if (!created) {
          throw new ApiHttpError(
            400,
            'empty_cost_event',
            'Cost event has no tokens and no third-party charge — nothing to record',
          );
        }
        event = created;
      }

      const response: RecordCostEventResponse = { event };
      res.status(201).json(response);
    }),
  );

  // GET /api/cost/events ---------------------------------------------------
  router.get(
    '/events',
    validateQuery(listEventsQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof listEventsQuerySchema>;
      const events = costEventsRepository.list({
        ...(q.task_id ? { task_id: q.task_id } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        limit: q.limit ?? 200,
      });
      const body: ListCostEventsResponse = { events };
      res.json(body);
    }),
  );

  // GET /api/cost/summary --------------------------------------------------
  router.get(
    '/summary',
    validateQuery(summaryQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof summaryQuerySchema>;
      const summary = aggregateCost(q.window ?? '30d');
      const body: CostSummaryResponse = summary;
      res.json(body);
    }),
  );

  return router;
}
