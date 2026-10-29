/**
 * `/api/renewals/*` routes: the renewal engine (T704).
 *
 *   GET    /                       renewals with schedule (filters: client, item_type, state, include_inactive)
 *   GET    /meta                   item types, labels, per-type defaults, known clients
 *   POST   /                       create
 *   PATCH  /:id                    update
 *   DELETE /:id
 *   POST   /:id/renew              mark renewed: close the cycle's queue item and roll the due date
 *   POST   /import                 CSV import { csv, dry_run?, skip_invalid? }
 *   POST   /run                    run the engine pass now
 *   GET    /reminders              sent reminders (include_acknowledged=1 for history)
 *   POST   /reminders/:id/ack      acknowledge a reminder
 *
 * Mounted by `server/index.ts`: app.use('/api/renewals', renewalsRouter());
 */

import { Router } from 'express';
import { z } from 'zod';

import { importRenewalsCsv } from '@/main/renewals/csv';
import { markRenewed, runRenewalEngine } from '@/main/renewals/engine';
import {
  RenewalError,
  acknowledgeReminder,
  createRenewal,
  deleteRenewal,
  getRenewal,
  listReminders,
  listRenewalClients,
  listRenewals,
  updateRenewal,
} from '@/main/renewals/repository';
import { DELIVERY_OWNER_TYPES } from '@/shared/delivery';
import {
  RENEWAL_ITEM_TYPES,
  RENEWAL_ITEM_TYPE_LABELS,
  RENEWAL_STATES,
  RENEWAL_TYPE_DEFAULTS,
  computeRenewalSchedule,
} from '@/shared/renewals';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

const leadTimesSchema = z.union([z.array(z.number().int().min(0).max(730)).min(1).max(8), z.string().min(1).max(100)]);

const createSchema = z.object({
  client: z.string().min(1).max(200),
  item_type: z.enum(RENEWAL_ITEM_TYPES),
  label: z.string().min(1).max(300),
  due_date: z.string().min(8).max(10),
  recurrence: z.string().max(40).optional(),
  lead_times: leadTimesSchema.optional(),
  owner_type: z.enum(DELIVERY_OWNER_TYPES).optional(),
  owner_name: z.string().max(200).nullable().optional(),
  venture: z.string().max(200).nullable().optional(),
  notes: z.string().max(5_000).nullable().optional(),
  client_visible: z.boolean().optional(),
  active: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

const importSchema = z.object({
  csv: z.string().min(1).max(900_000),
  dry_run: z.boolean().optional(),
  skip_invalid: z.boolean().optional(),
});

function run<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RenewalError) {
      throw new ApiHttpError(err.code === 'not_found' ? 404 : 400, `renewal_${err.code}`, err.message);
    }
    throw err;
  }
}

function withSchedule<T extends Parameters<typeof computeRenewalSchedule>[0]>(r: T): T & {
  schedule: ReturnType<typeof computeRenewalSchedule>;
} {
  return { ...r, schedule: computeRenewalSchedule(r) };
}

export function renewalsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const itemType = typeof q.item_type === 'string' && q.item_type ? q.item_type : undefined;
      if (itemType && !(RENEWAL_ITEM_TYPES as readonly string[]).includes(itemType)) {
        throw new ApiHttpError(400, 'invalid_query', `Invalid item_type: ${itemType}`);
      }
      const states =
        typeof q.state === 'string' && q.state
          ? q.state.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      for (const s of states ?? []) {
        if (!(RENEWAL_STATES as readonly string[]).includes(s)) {
          throw new ApiHttpError(400, 'invalid_query', `Invalid state: ${s}`);
        }
      }
      const renewals = listRenewals({
        client: typeof q.client === 'string' && q.client ? q.client : undefined,
        item_type: itemType as (typeof RENEWAL_ITEM_TYPES)[number] | undefined,
        state: states as Array<(typeof RENEWAL_STATES)[number]> | undefined,
        include_inactive: q.include_inactive === '1' || q.include_inactive === 'true',
      });
      res.json({ renewals });
    }),
  );

  router.get(
    '/meta',
    asyncHandler(async (_req, res) => {
      res.json({
        item_types: RENEWAL_ITEM_TYPES.map((t) => ({
          value: t,
          label: RENEWAL_ITEM_TYPE_LABELS[t],
          ...RENEWAL_TYPE_DEFAULTS[t],
        })),
        clients: listRenewalClients(),
      });
    }),
  );

  router.get(
    '/reminders',
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      res.json({
        reminders: listReminders({
          include_acknowledged: q.include_acknowledged === '1' || q.include_acknowledged === 'true',
        }),
      });
    }),
  );

  router.post(
    '/reminders/:id/ack',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!acknowledgeReminder(id)) throw new ApiHttpError(404, 'not_found', `Open reminder ${id} not found`);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/run',
    asyncHandler(async (_req, res) => {
      res.json(runRenewalEngine());
    }),
  );

  router.post(
    '/import',
    validateBody(importSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof importSchema>;
      const result = run(() => importRenewalsCsv(body.csv, { dry_run: body.dry_run, skip_invalid: body.skip_invalid }));
      res.status(result.dry_run ? 200 : 201).json(result);
    }),
  );

  router.post(
    '/',
    validateBody(createSchema),
    asyncHandler(async (req, res) => {
      const renewal = run(() => createRenewal(req.body as z.infer<typeof createSchema>));
      res.status(201).json({ renewal: withSchedule(renewal) });
    }),
  );

  router.patch(
    '/:id',
    validateBody(updateSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const renewal = run(() => updateRenewal(id, req.body as z.infer<typeof updateSchema>));
      if (!renewal) throw new ApiHttpError(404, 'not_found', `Renewal ${id} not found`);
      res.json({ renewal: withSchedule(renewal) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!getRenewal(id) || !deleteRenewal(id)) throw new ApiHttpError(404, 'not_found', `Renewal ${id} not found`);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/:id/renew',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const renewal = markRenewed(id);
      if (!renewal) throw new ApiHttpError(404, 'not_found', `Renewal ${id} not found`);
      res.json({ renewal: withSchedule(renewal) });
    }),
  );

  return router;
}
