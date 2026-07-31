/**
 * `/api/context/...` routes — ambient monitor (v6).
 *
 * The Chrome extension, the renderer Watch view, and the manual hotkey capture
 * all flow through this router. Endpoints:
 *
 *   POST   /capture              — single observation
 *   POST   /capture/batch        — bulk observations (extension flush)
 *   GET    /observations         — list (filterable, paginated)
 *   DELETE /observations/:id     — drop a row + its screenshot file
 *   GET    /deliberations        — list deliberation verdicts
 *   GET    /deliberations/:id    — single verdict + joined observations
 *   POST   /deliberate           — manually force a deliberation
 *   GET    /screenshots/:file    — serve a captured PNG (path-traversal hardened)
 *   GET    /status               — composed status for Watch header / Settings
 *
 * All endpoints are protected by the standard bearer-token middleware. The
 * Chrome extension authenticates the same way Claude Code does — by reading
 * `~/.taskpilot/api-token` (the user pastes it into the extension popup once
 * on install). The auth allowlist in `middleware/auth.ts` is NOT extended.
 *
 * Capture endpoints are intentionally fast: validate → insert → emit → respond.
 * They never block on deliberation; the orchestrator runs out-of-band.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';
import { z } from 'zod';

import { CAPTURES_DIR } from '@/shared/constants';
import {
  contextObservationApiItemSchema,
  contextObservationsBatchSchema,
  contextObservationSourceSchema,
  taskIdSchema,
} from '@/shared/io-schemas';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { settingsRepository } from '@/main/db/repositories/settings';
import { requestDeliberation } from '@/main/deliberation/orchestrator';
import { ioEvents } from '@/main/io/events';
import {
  REDACTION_PLACEHOLDER,
  matchesSensitivePattern,
  redactSensitiveText,
  stripQueryAndFragment,
} from '@/main/monitor/sensitive-pattern';
import { runPanicWipe } from '@/main/monitor/panic-wipe';
import type {
  CaptureContextObservationBatchResponse,
  CaptureContextObservationResponse,
  ContextMonitorStatusResponse,
  DeleteContextObservationResponse,
  GetDeliberationResponse,
  ListContextObservationsResponse,
  ListDeliberationsResponse,
  PanicWipeResponse,
  RequestDeliberationResponse,
} from '@/shared/api-contract';
import type {
  ContextObservation,
  ContextObservationSource,
  DeliberationStatus,
} from '@/shared/types';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Validation schemas                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Body for `POST /api/context/capture`. Accepts the same shape the extension
 * sends to the batch endpoint, so a single endpoint can serve both the
 * extension (browser) and the manual / hotkey path.
 */
const captureBodySchema = contextObservationApiItemSchema;

const observationIdParamSchema = taskIdSchema;

const deliberationIdParamSchema = taskIdSchema;

const listObservationsQuerySchema = z.object({
  limit: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'string' ? Number(v) : v))
    .pipe(z.number().int().min(1).max(500))
    .optional(),
  source: contextObservationSourceSchema.optional(),
  since: z.string().max(64).optional(),
  batch_id: z.string().max(64).optional(),
  workspace_id: z.string().max(64).optional(),
});

const listDeliberationsQuerySchema = z.object({
  limit: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'string' ? Number(v) : v))
    .pipe(z.number().int().min(1).max(200))
    .optional(),
  status: z.enum(['pending', 'completed', 'failed', 'skipped']).optional(),
  since: z.string().max(64).optional(),
});

const requestDeliberationBodySchema = z.object({
  reason: z.enum(['manual', 'hotkey']).optional(),
  observation_ids: z.array(taskIdSchema).max(200).optional(),
});

/**
 * Filename regex accepting BOTH formats:
 *   - New opaque format: `cap_<16-hex>.png` (privacy-preserving).
 *   - Legacy format: `<iso-ts>__display-<idx>.png`, kept readable so files
 *     captured by older builds still serve through one full retention cycle
 *     after upgrade.
 *
 * The path-traversal hardening in the route handler (path.resolve +
 * startsWith()) still applies independently — this regex is the *first*
 * gate, not the only one.
 */
const screenshotFilenameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?:cap_[a-f0-9]{16}\.png)|(?:[0-9A-Za-z-]+__display-\d+\.png)$/,
    'invalid screenshot filename',
  );

/* -------------------------------------------------------------------------- */
/*  Settings helpers                                                          */
/* -------------------------------------------------------------------------- */

function settingBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = settingsRepository.get(key);
    if (raw === null || raw === undefined) return defaultValue;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
    }
    if (typeof raw === 'number') return raw !== 0;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Today (local clock) as the ISO timestamp of midnight, suitable for
 * the `since` filter on `count()`. We deliberately use local time so the
 * "observations today" counter matches what the user sees on the wall clock.
 */
function startOfTodayIso(): string {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return midnight.toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Persist helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Coerce a `CaptureBody` (zero metadata, optional fields) into the shape
 * `contextObservationsRepository.create()` expects. The repository fills any
 * gaps (id, captured_at, batch_id) on its own.
 *
 * **Redaction pass.** Before handing the body off to the DB, we run every
 * user-visible string field through the same sensitive-content matcher the
 * ambient monitor uses (`@/main/monitor/sensitive-pattern`). If ANY of
 * `window_title`, `page_title`, `h1`, `meta_description`, `selection`, or
 * the URL trips the regex, ALL of those fields are replaced with
 * {@link REDACTION_PLACEHOLDER} and the URL is stripped of its query +
 * fragment — banking and OAuth flows carry account numbers / tokens in
 * the query string, so it's safer to drop the whole thing than try to
 * surgically remove individual params.
 *
 * `app_name` is left intact because it's a process name (low PII) and
 * the matcher already factored it in when deciding to redact. The row
 * is still persisted — the batcher counts it for context-shift, and the
 * Watch view shows a "redacted" badge driven by `metadata.sensitive_pattern_match`.
 */
function bodyToCreateInput(
  body: z.infer<typeof captureBodySchema>,
): Parameters<typeof contextObservationsRepository.create>[0] {
  const sensitive = matchesSensitivePattern({
    title: body.window_title ?? null,
    app_name: body.app_name ?? null,
    url: body.url ?? null,
    pageTitle: body.page_title ?? null,
    h1: body.h1 ?? null,
    meta_description: body.meta_description ?? null,
    selection: body.selection ?? null,
  });

  let window_title = body.window_title ?? null;
  let url = body.url ?? null;
  let page_title = body.page_title ?? null;
  let h1 = body.h1 ?? null;
  let meta_description = body.meta_description ?? null;
  let selection = body.selection ?? null;
  let metadata: Record<string, unknown> | null = body.metadata
    ? { ...body.metadata }
    : null;

  if (sensitive) {
    window_title = body.window_title ? REDACTION_PLACEHOLDER : window_title;
    page_title = body.page_title ? REDACTION_PLACEHOLDER : page_title;
    h1 = body.h1 ? REDACTION_PLACEHOLDER : h1;
    meta_description = body.meta_description
      ? REDACTION_PLACEHOLDER
      : meta_description;
    selection = body.selection ? REDACTION_PLACEHOLDER : selection;
    // URL: strip query + fragment entirely. Keep origin + path so the row
    // still conveys "user was on bank-of-america.com" without leaking
    // session tokens, account numbers, or OAuth `state` / `code`.
    const stripped = stripQueryAndFragment(url);
    url = stripped === undefined ? null : stripped;
    metadata = metadata ?? {};
    metadata.sensitive_pattern_match = true;
  } else {
    // Field-level redaction for the case where the URL alone trips the
    // matcher (e.g. login.example.com) — defence in depth in case a
    // future caller passes a URL with `?token=...` we missed at the
    // group-level check. `redactSensitiveText()` is a no-op when the
    // matcher doesn't fire on this particular field.
    const maybe = redactSensitiveText(url);
    if (maybe !== url) {
      url = stripQueryAndFragment(url) ?? null;
      metadata = metadata ?? {};
      metadata.sensitive_pattern_match = true;
    }
  }

  return {
    source: body.source as ContextObservationSource,
    app_name: body.app_name ?? null,
    window_title,
    url,
    page_title,
    h1,
    meta_description,
    selection,
    screenshot_path: body.screenshot_path ?? null,
    workspace_id: body.workspace_id ?? null,
    metadata,
  };
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sub-router mounted at `/api/context`. See file-level doc for endpoint list.
 */
export function contextRouter(): Router {
  const router = Router();

  // POST /api/context/capture ---------------------------------------------
  router.post(
    '/capture',
    validateBody(captureBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof captureBodySchema>;
      const observation = contextObservationsRepository.create(
        bodyToCreateInput(body),
      );
      // Fire-and-forget: the batcher subscribes to this and may decide to
      // request a deliberation, but the response is sent immediately. Any
      // listener error must not bubble into the HTTP response.
      try {
        ioEvents.emit('observation_captured', observation);
      } catch {
        /* non-fatal */
      }
      const responseBody: CaptureContextObservationResponse = {
        id: observation.id,
        captured_at: observation.captured_at,
      };
      res.status(201).json(responseBody);
    }),
  );

  // POST /api/context/capture/batch ---------------------------------------
  router.post(
    '/capture/batch',
    validateBody(contextObservationsBatchSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof contextObservationsBatchSchema>;
      const inputs = body.observations.map((item) =>
        bodyToCreateInput(item),
      );
      const inserted = contextObservationsRepository.insertMany(inputs);
      for (const row of inserted) {
        try {
          ioEvents.emit('observation_captured', row);
        } catch {
          /* non-fatal */
        }
      }
      const responseBody: CaptureContextObservationBatchResponse = {
        ids: inserted.map((r) => r.id),
        captured_at: new Date().toISOString(),
      };
      res.status(201).json(responseBody);
    }),
  );

  // GET /api/context/observations -----------------------------------------
  router.get(
    '/observations',
    validateQuery(listObservationsQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<
        typeof listObservationsQuerySchema
      >;
      const filter = {
        limit: q.limit ?? 50,
        source: q.source,
        since: q.since,
        batch_id: q.batch_id,
        workspace_id: q.workspace_id,
      };
      const observations = contextObservationsRepository.list(filter);
      const total = contextObservationsRepository.count({
        source: q.source,
        since: q.since,
        batch_id: q.batch_id,
        workspace_id: q.workspace_id,
      });
      const responseBody: ListContextObservationsResponse = {
        observations,
        total,
      };
      res.json(responseBody);
    }),
  );

  // DELETE /api/context/observations/:id ----------------------------------
  router.delete(
    '/observations/:id',
    asyncHandler(async (req, res) => {
      const parsed = observationIdParamSchema.safeParse(String(req.params.id));
      if (!parsed.success) {
        throw new ApiHttpError(
          400,
          'invalid_observation_id',
          'Invalid observation id',
        );
      }
      const id = parsed.data;
      const existing = contextObservationsRepository.get(id);
      if (!existing) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Observation ${id} not found`,
        );
      }
      // Unlink the screenshot first so we don't orphan a file when the row
      // is gone. We DO NOT echo the path back in errors — the renderer only
      // needs a success/failure code.
      if (
        existing.source === 'screenshot' &&
        typeof existing.screenshot_path === 'string' &&
        existing.screenshot_path.length > 0
      ) {
        try {
          await fs.unlink(existing.screenshot_path);
        } catch {
          /* file may already be missing; ignore */
        }
      }
      contextObservationsRepository.delete(id);
      const responseBody: DeleteContextObservationResponse = { ok: true, id };
      res.json(responseBody);
    }),
  );

  // GET /api/context/deliberations ----------------------------------------
  router.get(
    '/deliberations',
    validateQuery(listDeliberationsQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<
        typeof listDeliberationsQuerySchema
      >;
      const filter = {
        limit: q.limit ?? 50,
        status: q.status as DeliberationStatus | undefined,
        since: q.since,
      };
      const list = deliberationsRepository.list(filter);
      const total = deliberationsRepository.count({
        status: q.status as DeliberationStatus | undefined,
        since: q.since,
      });
      const responseBody: ListDeliberationsResponse = {
        deliberations: list,
        total,
      };
      res.json(responseBody);
    }),
  );

  // GET /api/context/deliberations/:id ------------------------------------
  router.get(
    '/deliberations/:id',
    asyncHandler(async (req, res) => {
      const parsed = deliberationIdParamSchema.safeParse(String(req.params.id));
      if (!parsed.success) {
        throw new ApiHttpError(
          400,
          'invalid_deliberation_id',
          'Invalid deliberation id',
        );
      }
      const id = parsed.data;
      const deliberation = deliberationsRepository.get(id);
      if (!deliberation) {
        throw new ApiHttpError(
          404,
          'not_found',
          `Deliberation ${id} not found`,
        );
      }
      const observations = resolveObservationsForDeliberation(
        deliberation.observation_ids,
      );
      const responseBody: GetDeliberationResponse = {
        deliberation,
        observations,
      };
      res.json(responseBody);
    }),
  );

  // POST /api/context/deliberate ------------------------------------------
  router.post(
    '/deliberate',
    validateBody(requestDeliberationBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof requestDeliberationBodySchema>;
      try {
        const outcome = await requestDeliberation({
          observation_ids: body.observation_ids,
          trigger_reason: body.reason ?? 'manual',
        });
        const responseBody: RequestDeliberationResponse = {
          batch_id: outcome.batch_id,
          deliberation_id: outcome.deliberation.id,
        };
        res.status(202).json(responseBody);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'deliberation failed';
        if (message.includes('no observations')) {
          throw new ApiHttpError(
            400,
            'no_observations',
            'No observations available to deliberate over',
          );
        }
        throw new ApiHttpError(500, 'deliberation_failed', message);
      }
    }),
  );

  // GET /api/context/screenshots/:filename --------------------------------
  router.get(
    '/screenshots/:filename',
    asyncHandler(async (req, res) => {
      const parsed = screenshotFilenameSchema.safeParse(
        String(req.params.filename),
      );
      if (!parsed.success) {
        throw new ApiHttpError(
          400,
          'invalid_filename',
          'Invalid screenshot filename',
        );
      }
      // Re-resolve through `path.join` + a startsWith() check so an attacker
      // can't smuggle a traversal token past the regex via Unicode quirks.
      const resolved = path.resolve(path.join(CAPTURES_DIR, parsed.data));
      const root = path.resolve(CAPTURES_DIR) + path.sep;
      if (!resolved.startsWith(root)) {
        throw new ApiHttpError(
          400,
          'invalid_filename',
          'Invalid screenshot filename',
        );
      }
      try {
        await fs.access(resolved);
      } catch {
        throw new ApiHttpError(404, 'not_found', 'Screenshot not found');
      }
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(resolved);
    }),
  );

  // GET /api/context/status -----------------------------------------------
  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const monitorEnabled = settingBool('ambient_monitor_enabled', false);
      const screenshotEnabled = settingBool('ambient_screenshot_enabled', false);
      const extensionEnabled = settingBool('ambient_extension_enabled', false);
      // Panic mode is read at request time (no caching) so the Watch view's
      // 5s refetch always reflects the latest hotkey/tray toggle.
      const panicModeActive = settingBool('ambient_panic_mode', false);
      const last = contextObservationsRepository.getLast();
      const pending = deliberationsRepository.count({ status: 'pending' });
      const observationsToday = contextObservationsRepository.count({
        since: startOfTodayIso(),
      });
      const responseBody: ContextMonitorStatusResponse = {
        monitor_enabled: monitorEnabled,
        screenshot_enabled: screenshotEnabled,
        extension_enabled: extensionEnabled,
        panic_mode_active: panicModeActive,
        last_observation_at: last ? last.captured_at : null,
        pending_deliberations: pending,
        observations_today: observationsToday,
        captures_dir: CAPTURES_DIR,
      };
      res.json(responseBody);
    }),
  );

  // POST /api/context/panic/wipe ------------------------------------------
  // Destructive nuke. Delegates to `runPanicWipe()` which acquires the
  // monitor mutex, renames the captures dir atomically, async-deletes the
  // renamed tree, marks pending deliberations skipped, and emits an audit
  // event. Never throws — partial failures come back as `warnings`.
  router.post(
    '/panic/wipe',
    asyncHandler(async (_req, res) => {
      const result = await runPanicWipe({ reason: 'api' });
      const responseBody: PanicWipeResponse = {
        ok: result.ok,
        files_deleted: result.files_deleted,
        rows_skipped: result.rows_skipped,
        warnings: result.warnings,
      };
      res.status(200).json(responseBody);
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Helpers — shared                                                          */
/* -------------------------------------------------------------------------- */

function resolveObservationsForDeliberation(
  ids: string[],
): ContextObservation[] {
  const out: ContextObservation[] = [];
  for (const id of ids) {
    const row = contextObservationsRepository.get(id);
    if (row) out.push(row);
  }
  return out;
}
