/**
 * `/api/calendar/auth/...` and `/api/calendar/status` routes.
 *
 * Drives the OAuth flow from the renderer's Settings view:
 *   - GET    /api/calendar/status           → { authenticated, email? }
 *   - POST   /api/calendar/auth/start       → { auth_url, redirect_uri }
 *   - POST   /api/calendar/auth/complete    body { code }
 *   - POST   /api/calendar/auth/disconnect
 *
 * The OAuth module is loaded defensively so the API still works (returning
 * 503 on these endpoints) even when the calendar subsystem hasn't been
 * compiled yet.
 */

import { Router } from 'express';
import { z } from 'zod';

import type { CalendarStatusResponse } from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

interface OauthModule {
  isAuthenticated?: () => Promise<boolean>;
  startAuthFlow?: () => Promise<{ url: string; redirectUri: string; state?: string }>;
  completeAuthFlow?: (code: string, state?: string) => Promise<void>;
  signOut?: () => Promise<void>;
}

let cached: OauthModule | null = null;
let loadAttempted = false;

async function loadOauth(): Promise<OauthModule | null> {
  if (cached) return cached;
  if (loadAttempted) return null;
  loadAttempted = true;
  try {
    const mod = (await import('@/main/calendar/oauth')) as OauthModule;
    cached = mod;
    return mod;
  } catch {
    return null;
  }
}

function requireFn<K extends keyof OauthModule>(
  mod: OauthModule | null,
  key: K,
): NonNullable<OauthModule[K]> {
  if (!mod) {
    throw new ApiHttpError(503, 'calendar_not_initialized', 'Calendar module not loaded');
  }
  const candidate = mod[key];
  if (typeof candidate !== 'function') {
    throw new ApiHttpError(
      503,
      'calendar_not_initialized',
      `Calendar module is missing ${String(key)}()`,
    );
  }
  return candidate as NonNullable<OauthModule[K]>;
}

const completeSchema = z.object({
  code: z.string().min(1).max(2_048),
  state: z.string().min(1).max(256).optional(),
});

export function calendarAuthRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const mod = await loadOauth();
      if (!mod || typeof mod.isAuthenticated !== 'function') {
        const body: CalendarStatusResponse = { connected: false };
        res.json(body);
        return;
      }
      try {
        const authed = await mod.isAuthenticated();
        const body: CalendarStatusResponse = { connected: authed };
        res.json(body);
      } catch {
        const body: CalendarStatusResponse = { connected: false };
        res.json(body);
      }
    }),
  );

  router.post(
    '/auth/start',
    asyncHandler(async (_req, res) => {
      const mod = await loadOauth();
      const fn = requireFn(mod, 'startAuthFlow');
      const { url, redirectUri, state } = await fn();
      const body: Record<string, unknown> = {
        auth_url: url,
        redirect_uri: redirectUri,
      };
      // Expose the state token to the renderer so the manual-paste fallback
      // path (Settings → Calendar) can submit it alongside the code. The
      // browser callback at `/oauth/callback` reads state directly from the
      // query string Google supplies.
      if (state !== undefined) body.state = state;
      res.json(body);
    }),
  );

  router.post(
    '/auth/complete',
    validateBody(completeSchema),
    asyncHandler(async (req, res) => {
      const { code, state } = req.body as z.infer<typeof completeSchema>;
      const mod = await loadOauth();
      const fn = requireFn(mod, 'completeAuthFlow');
      await fn(code, state);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/auth/disconnect',
    asyncHandler(async (_req, res) => {
      const mod = await loadOauth();
      const fn = requireFn(mod, 'signOut');
      await fn();
      res.json({ ok: true });
    }),
  );

  return router;
}
