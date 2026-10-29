/**
 * `/api/delivery/*` routes: the client delivery queue (T693) and delivery
 * templates (T694).
 *
 *   GET    /items                         queue, filterable by owner, SLA state, status, client, venture
 *   GET    /facets                        distinct owner names, clients, ventures
 *   POST   /items                         create one item
 *   PATCH  /items/:id                     update (status changes stamp completed_at)
 *   DELETE /items/:id
 *   GET    /templates                     templates with steps (seeds built-ins on first call)
 *   GET    /templates/:id                 by id or slug
 *   PATCH  /templates/:id                 name, description, venture, sop_url
 *   PATCH  /templates/:id/steps/:stepId   title, description, owner_role, sla_hours, sla_confirmed
 *   POST   /templates/:id/instantiate     create queue items for a client
 *
 * Mounted by `server/index.ts`: app.use('/api/delivery', deliveryRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  DeliveryError,
  createDeliveryItem,
  deleteDeliveryItem,
  getDeliveryItem,
  getDeliveryTemplate,
  instantiateDeliveryTemplate,
  listDeliveryFacets,
  listDeliveryItems,
  listDeliveryTemplates,
  updateDeliveryItem,
  updateDeliveryTemplate,
  updateDeliveryTemplateStep,
  type ListDeliveryItemsFilter,
} from '@/main/delivery/repository';
import {
  DELIVERY_OWNER_TYPES,
  DELIVERY_STATUSES,
  SLA_STATES,
  UNASSIGNED_OWNER,
  withSla,
} from '@/shared/delivery';
import { isSafeHttpUrl } from '@/shared/portal';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const ownerTypeSchema = z.enum(DELIVERY_OWNER_TYPES);
const statusSchema = z.enum(DELIVERY_STATUSES);
const slaStateSchema = z.enum(SLA_STATES);
const isoSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a valid date');
const slaHoursSchema = z.number().positive().max(24 * 365);
const shortText = z.string().max(200);

const createItemSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).nullable().optional(),
  owner_type: ownerTypeSchema,
  owner_name: shortText.nullable().optional(),
  client: z.string().min(1).max(200),
  venture: shortText.nullable().optional(),
  status: statusSchema.optional(),
  deadline: isoSchema.nullable().optional(),
  sla_hours: slaHoursSchema.nullable().optional(),
  sla_started_at: isoSchema.optional(),
  client_visible: z.boolean().optional(),
  deliverable_url: z
    .string()
    .max(2_000)
    .refine((v) => isSafeHttpUrl(v), 'must be an http(s) URL')
    .nullable()
    .optional(),
});

const updateItemSchema = createItemSchema.partial().extend({
  sla_started_at: isoSchema.optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5_000).nullable().optional(),
  venture: shortText.nullable().optional(),
  sop_url: z.string().max(2_000).nullable().optional(),
});

const updateStepSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).nullable().optional(),
  owner_role: ownerTypeSchema.optional(),
  sla_hours: slaHoursSchema.nullable().optional(),
  sla_confirmed: z.boolean().optional(),
});

const instantiateSchema = z.object({
  client: z.string().min(1).max(200),
  venture: shortText.nullable().optional(),
  start_at: isoSchema.optional(),
  deadline: isoSchema.nullable().optional(),
  assignees: z
    .object({
      jack: shortText.optional(),
      contractor: shortText.optional(),
      offshore: shortText.optional(),
    })
    .optional(),
  sections: z.array(z.string().min(1).max(64)).max(32).optional(),
});

/** Comma-separated list in a query param, validated against an enum. */
function csv<T extends string>(raw: unknown, schema: z.ZodType<T>, field: string): T[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: T[] = [];
  for (const p of parts) {
    const parsed = schema.safeParse(p);
    if (!parsed.success) throw new ApiHttpError(400, 'invalid_query', `Invalid ${field}: ${p}`);
    out.push(parsed.data);
  }
  return out;
}

function str(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function toApiError(err: unknown): unknown {
  if (err instanceof DeliveryError) {
    return new ApiHttpError(err.code === 'not_found' ? 404 : 400, `delivery_${err.code}`, err.message);
  }
  return err;
}

function run<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toApiError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function deliveryRouter(): Router {
  const router = Router();

  router.get(
    '/items',
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const ownerTypes = csv(q.owner_type, ownerTypeSchema, 'owner_type');
      if (ownerTypes && ownerTypes.length > 1) {
        throw new ApiHttpError(400, 'invalid_query', 'owner_type takes a single value');
      }
      const filter: ListDeliveryItemsFilter = {
        owner_type: ownerTypes?.[0],
        owner_name:
          q.owner_name === UNASSIGNED_OWNER ? '' : str(q.owner_name) || undefined,
        sla_state: csv(q.sla_state, slaStateSchema, 'sla_state'),
        status: csv(q.status, statusSchema, 'status'),
        client: str(q.client) || undefined,
        venture: str(q.venture) || undefined,
        instance_id: str(q.instance_id) || undefined,
        include_closed: q.include_closed === '1' || q.include_closed === 'true',
      };
      const result = listDeliveryItems(filter);
      res.json(result);
    }),
  );

  router.get(
    '/facets',
    asyncHandler(async (_req, res) => {
      res.json(listDeliveryFacets());
    }),
  );

  router.post(
    '/items',
    validateBody(createItemSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createItemSchema>;
      const item = run(() => createDeliveryItem(body));
      res.status(201).json({ item: withSla(item) });
    }),
  );

  router.patch(
    '/items/:id',
    validateBody(updateItemSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const body = req.body as z.infer<typeof updateItemSchema>;
      const item = run(() => updateDeliveryItem(id, body));
      if (!item) throw new ApiHttpError(404, 'not_found', `Delivery item ${id} not found`);
      res.json({ item: withSla(item) });
    }),
  );

  router.delete(
    '/items/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!getDeliveryItem(id) || !deleteDeliveryItem(id)) {
        throw new ApiHttpError(404, 'not_found', `Delivery item ${id} not found`);
      }
      res.json({ ok: true });
    }),
  );

  router.get(
    '/templates',
    asyncHandler(async (_req, res) => {
      res.json({ templates: listDeliveryTemplates() });
    }),
  );

  router.get(
    '/templates/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const template = getDeliveryTemplate(id);
      if (!template) throw new ApiHttpError(404, 'not_found', `Template ${id} not found`);
      res.json({ template });
    }),
  );

  router.patch(
    '/templates/:id',
    validateBody(updateTemplateSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const template = run(() => updateDeliveryTemplate(id, req.body as z.infer<typeof updateTemplateSchema>));
      if (!template) throw new ApiHttpError(404, 'not_found', `Template ${id} not found`);
      res.json({ template });
    }),
  );

  router.patch(
    '/templates/:id/steps/:stepId',
    validateBody(updateStepSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const stepId = String(req.params.stepId);
      const step = run(() =>
        updateDeliveryTemplateStep(id, stepId, req.body as z.infer<typeof updateStepSchema>),
      );
      if (!step) throw new ApiHttpError(404, 'not_found', `Step ${stepId} not found on template ${id}`);
      res.json({ step });
    }),
  );

  router.post(
    '/templates/:id/instantiate',
    validateBody(instantiateSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const body = req.body as z.infer<typeof instantiateSchema>;
      const result = run(() => instantiateDeliveryTemplate(id, body));
      res.status(201).json({ instance_id: result.instance_id, items: result.items.map((i) => withSla(i)) });
    }),
  );

  return router;
}
