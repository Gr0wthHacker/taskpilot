/**
 * `/api/webhooks/incoming/...` route.
 *
 * Generic webhook receiver — counterpart to the GitHub-specific receiver
 * in `routes/webhooks.ts`. Any external service can POST here. The
 * matching `WebhookConfig` (looked up by URL segment) controls HMAC
 * verification, signature header name, and mapping rules.
 *
 * Auth model: HMAC over the raw request body, exactly like the GitHub
 * route. The bearer-auth middleware allowlists `/api/webhooks/*` so
 * external services don't need a TaskPilot bearer token. When a config's
 * `signature_algorithm` is `none`, the request is accepted on origin
 * alone — only ever appropriate for trusted internal callers.
 *
 * Body bytes: we mount `express.raw` BEFORE the global JSON parser
 * claims the stream (see `server/index.ts`). The raw bytes hash; we
 * also JSON-parse them so mapping rules can dereference fields.
 *
 * Wave 13 — Agent M.
 */

import { Router, type Request } from 'express';
import express from 'express';

import { dispatch, verifySignature } from '@/main/webhooks/dispatcher';
import { getConfigByName } from '@/main/webhooks/registry';

import { ApiHttpError } from '../errors';
import { asyncHandler } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function genericWebhooksRouter(): Router {
  const router = Router();

  // Raw body capture. Same shape as the GitHub router — mounted BEFORE
  // any handler so the bytes are intact for HMAC. We also re-parse JSON
  // for the dispatcher.
  router.use(
    '/:name',
    express.raw({ type: '*/*', limit: '5mb' }),
    (req, _res, next) => {
      const body = (req as Request).body;
      if (Buffer.isBuffer(body)) {
        (req as Request & { rawBody?: Buffer }).rawBody = body;
        try {
          (req as Request).body = JSON.parse(body.toString('utf8'));
        } catch {
          // Body wasn't JSON. Leave as an empty object so rule evaluation
          // doesn't blow up — match expressions against missing paths
          // return undefined and the rule simply doesn't fire.
          (req as Request).body = {};
        }
      } else if (body && typeof body === 'object') {
        try {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(
            JSON.stringify(body),
            'utf8',
          );
        } catch {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from('', 'utf8');
        }
      } else {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from('', 'utf8');
      }
      next();
    },
  );

  router.post(
    '/:name',
    asyncHandler(async (req, res) => {
      const name = String(req.params.name ?? '').toLowerCase();
      if (name.length === 0) {
        throw new ApiHttpError(400, 'bad_request', 'Missing webhook name');
      }

      const config = getConfigByName(name);
      if (!config) {
        throw new ApiHttpError(
          404,
          'webhook_not_found',
          `No webhook config named "${name}"`,
        );
      }
      if (!config.enabled) {
        throw new ApiHttpError(
          404,
          'webhook_disabled',
          `Webhook "${name}" is disabled`,
        );
      }

      const headerName = (config.signature_header ?? 'X-Signature-256').toLowerCase();
      const signature = req.header(headerName);
      const rawBody =
        (req as Request & { rawBody?: Buffer }).rawBody ??
        Buffer.from('', 'utf8');

      const verified = verifySignature(config, rawBody, signature);
      if (!verified.ok) {
        // 401 for any signature failure — matches the GitHub-specific
        // route's behavior so external callers see one consistent code.
        throw new ApiHttpError(
          401,
          verified.code ?? 'invalid_signature',
          verified.message ?? 'Signature did not match',
        );
      }

      const payload = (req.body && typeof req.body === 'object'
        ? req.body
        : {}) as Record<string, unknown>;

      const result = dispatch(config, payload);

      res.json({
        ok: true,
        webhook: name,
        triggered_rules: result.triggered_rules,
        created_tasks: result.created_tasks,
        updated_tasks: result.updated_tasks,
      });
    }),
  );

  return router;
}
