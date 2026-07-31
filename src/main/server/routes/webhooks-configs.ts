/**
 * `/api/webhooks/configs/...` routes.
 *
 * CRUD for generic webhook configurations. These endpoints REQUIRE the
 * bearer token (they mutate registry state) — distinguishing them from
 * the inbound webhook receivers (`/api/webhooks/github`,
 * `/api/webhooks/incoming/*`) which auth via HMAC instead. The auth
 * allowlist in `middleware/auth.ts` was tightened in Wave 13 to spell
 * this out.
 *
 * Also exposes `POST /:id/test` — simulate a delivery against the config
 * WITHOUT touching the DB so a user can verify their mapping rules
 * before pointing a real service at the endpoint.
 *
 * Wave 13 — Agent M.
 */

import { Router } from 'express';
import { z } from 'zod';

import { dispatch } from '@/main/webhooks/dispatcher';
import {
  createConfig,
  deleteConfig,
  getConfig,
  listConfigs,
  redact,
  updateConfig,
  type MappingRule,
} from '@/main/webhooks/registry';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const taskPrioritySchema = z.enum(['p0', 'p1', 'p2', 'p3']);
const agentMethodSchema = z.enum(['cowork', 'cli', 'either', 'human_only']);
const algorithmSchema = z.enum(['sha256', 'sha1', 'none']);

const mappingRuleSchema = z.object({
  match: z
    .object({
      path: z.string().min(1).max(200),
      equals: z.unknown(),
    })
    .optional(),
  action: z.enum(['create_task', 'update_task', 'comment_task']),
  template: z.object({
    title: z.string().max(5_000).optional(),
    description: z.string().max(50_000).optional(),
    priority: taskPrioritySchema.optional(),
    tags: z.array(z.string().min(1).max(64)).max(64).optional(),
    task_id: z.string().min(1).max(500).optional(),
    note: z.string().max(50_000).optional(),
    agent_method: agentMethodSchema.optional(),
  }),
});

const createConfigSchema = z
  .object({
    name: z.string().min(1).max(63),
    secret: z.string().max(512).optional(),
    signature_header: z.string().min(1).max(128).optional(),
    signature_algorithm: algorithmSchema.optional(),
    trusted_network_only: z.boolean().optional(),
    mapping_rules: z.array(mappingRuleSchema).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.signature_algorithm !== 'none' || v.trusted_network_only === true,
    {
      message:
        "signature_algorithm: 'none' requires trusted_network_only: true",
      path: ['trusted_network_only'],
    },
  );

const updateConfigSchema = z
  .object({
    name: z.string().min(1).max(63).optional(),
    // Allow null to clear the secret.
    secret: z.string().max(512).nullable().optional(),
    signature_header: z.string().min(1).max(128).optional(),
    signature_algorithm: algorithmSchema.optional(),
    trusted_network_only: z.boolean().optional(),
    mapping_rules: z.array(mappingRuleSchema).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  // Note: this refine only catches the "set algorithm=none + omit trusted"
  // case. Patches that only set algorithm=none on an existing config need
  // the registry-level guard (assertSafeAlgorithm) to combine patch + current
  // state. Both layers run; this one catches the obvious payload bug at the
  // route boundary so the user gets a 400 with a clear field path.
  .refine(
    (v) =>
      v.signature_algorithm !== 'none' || v.trusted_network_only === true,
    {
      message:
        "signature_algorithm: 'none' requires trusted_network_only: true",
      path: ['trusted_network_only'],
    },
  );

const testBodySchema = z.object({
  payload: z.unknown(),
});

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function webhooksConfigsRouter(): Router {
  const router = Router();

  // GET /api/webhooks/configs ----------------------------------------------
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const configs = listConfigs().map(redact);
      res.json({ configs });
    }),
  );

  // POST /api/webhooks/configs ---------------------------------------------
  router.post(
    '/',
    validateBody(createConfigSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createConfigSchema>;
      try {
        const created = createConfig({
          ...body,
          mapping_rules: body.mapping_rules as MappingRule[] | undefined,
        });
        res.status(201).json({ config: redact(created) });
      } catch (err) {
        throw new ApiHttpError(
          400,
          'invalid_webhook',
          err instanceof Error ? err.message : 'Invalid webhook config',
        );
      }
    }),
  );

  // GET /api/webhooks/configs/:id ------------------------------------------
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const config = getConfig(id);
      if (!config) {
        throw new ApiHttpError(404, 'not_found', `Webhook ${id} not found`);
      }
      res.json({ config: redact(config) });
    }),
  );

  // PATCH /api/webhooks/configs/:id ----------------------------------------
  router.patch(
    '/:id',
    validateBody(updateConfigSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const patch = req.body as z.infer<typeof updateConfigSchema>;
      try {
        const updated = updateConfig(id, {
          ...patch,
          mapping_rules: patch.mapping_rules as MappingRule[] | undefined,
        });
        if (!updated) {
          throw new ApiHttpError(404, 'not_found', `Webhook ${id} not found`);
        }
        res.json({ config: redact(updated) });
      } catch (err) {
        if (err instanceof ApiHttpError) throw err;
        throw new ApiHttpError(
          400,
          'invalid_webhook',
          err instanceof Error ? err.message : 'Invalid webhook patch',
        );
      }
    }),
  );

  // DELETE /api/webhooks/configs/:id ---------------------------------------
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const removed = deleteConfig(id);
      if (!removed) {
        throw new ApiHttpError(404, 'not_found', `Webhook ${id} not found`);
      }
      res.json({ ok: true, id });
    }),
  );

  // POST /api/webhooks/configs/:id/test ------------------------------------
  // Simulate dispatch against a payload WITHOUT touching the DB. Returns
  // each rule's match outcome and the actions that would have run.
  router.post(
    '/:id/test',
    validateBody(testBodySchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const config = getConfig(id);
      if (!config) {
        throw new ApiHttpError(404, 'not_found', `Webhook ${id} not found`);
      }
      const { payload } = req.body as z.infer<typeof testBodySchema>;
      const result = dispatch(config, payload, { dryRun: true });
      res.json({
        triggered_rules: result.triggered_rules,
        rule_outcomes: result.rule_outcomes,
      });
    }),
  );

  return router;
}
