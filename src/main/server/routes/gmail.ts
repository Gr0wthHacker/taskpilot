/**
 * `/api/gmail/...` routes.
 *
 * Endpoints:
 *   - GET    /api/gmail/status                   → connection + granted scopes
 *   - POST   /api/gmail/connect/start            → returns Google auth URL
 *   - POST   /api/gmail/connect/complete         body { code, state? }
 *   - POST   /api/gmail/disconnect               → drop Gmail scopes
 *   - POST   /api/gmail/messages/draft           body { to, subject, body, in_reply_to_message_id? }
 *   - POST   /api/gmail/messages/send            body { draft_id? | (to, subject, body) }
 *   - POST   /api/gmail/messages/:id/label       body { add?, remove? }
 *   - POST   /api/gmail/capture-now              → trigger immediate capture
 *
 * Gmail auth piggybacks on the Calendar OAuth callback at `/oauth/callback`
 * because both use the same Google OAuth2 client. The Gmail "connect" flow
 * asks for the union of Calendar + Gmail scopes — re-running it from the
 * Gmail card after the user already connected Calendar simply re-grants
 * with a wider scope set.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  GmailApiError,
  GmailAuthError,
  GmailNotConfiguredError,
} from '@/main/gmail';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Soft module loader                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The Gmail subsystem is loaded defensively so missing builds (or test
 * mocks) don't take the API down. Every handler walks through `loadGmail()`
 * and 503s with `gmail_not_initialized` when the module can't be reached.
 */
interface GmailModule {
  getStatus?: typeof import('@/main/gmail').getStatus;
  startAuthFlow?: typeof import('@/main/gmail').startAuthFlow;
  disconnect?: typeof import('@/main/gmail').disconnect;
  setSendEnabledInSettings?: typeof import('@/main/gmail').setSendEnabledInSettings;
  isSendAllowed?: typeof import('@/main/gmail').isSendAllowed;
  createDraft?: typeof import('@/main/gmail').createDraft;
  sendMessage?: typeof import('@/main/gmail').sendMessage;
  applyLabel?: typeof import('@/main/gmail').applyLabel;
  captureOnce?: typeof import('@/main/gmail').captureOnce;
}

let cachedMod: GmailModule | null = null;
let loadAttempted = false;

async function loadGmail(): Promise<GmailModule | null> {
  if (cachedMod) return cachedMod;
  if (loadAttempted) return null;
  loadAttempted = true;
  try {
    const mod = (await import('@/main/gmail')) as GmailModule;
    cachedMod = mod;
    return mod;
  } catch {
    return null;
  }
}

function requireMod(mod: GmailModule | null): asserts mod is GmailModule {
  if (!mod) {
    throw new ApiHttpError(
      503,
      'gmail_not_initialized',
      'Gmail subsystem not loaded',
    );
  }
}

function requireFn<K extends keyof GmailModule>(
  mod: GmailModule | null,
  key: K,
): NonNullable<GmailModule[K]> {
  requireMod(mod);
  const fn = mod[key];
  if (typeof fn !== 'function') {
    throw new ApiHttpError(
      503,
      'gmail_not_initialized',
      `Gmail module missing ${String(key)}()`,
    );
  }
  return fn as NonNullable<GmailModule[K]>;
}

/* -------------------------------------------------------------------------- */
/*  Error translation                                                         */
/* -------------------------------------------------------------------------- */

function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (err instanceof GmailNotConfiguredError) {
    return new ApiHttpError(
      401,
      'gmail_not_configured',
      err.message || 'Gmail is not connected.',
    );
  }
  if (err instanceof GmailAuthError) {
    const status = err.status === 403 ? 403 : 401;
    const code = err.status === 403 ? 'gmail_forbidden' : 'gmail_auth';
    return new ApiHttpError(status, code, err.message);
  }
  if (err instanceof GmailApiError) {
    const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
    return new ApiHttpError(status, 'gmail_api_error', err.message);
  }
  return new ApiHttpError(
    500,
    'gmail_unknown',
    err instanceof Error ? err.message : 'Unknown Gmail error',
  );
}

function safe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw toApiError(err);
  });
}

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const completeSchema = z.object({
  code: z.string().min(1).max(2_048),
  state: z.string().min(1).max(256).optional(),
});

const draftSchema = z.object({
  to: z.string().min(3).max(1_024),
  subject: z.string().min(1).max(512),
  body: z.string().min(1).max(200_000),
  cc: z.string().max(1_024).optional(),
  bcc: z.string().max(1_024).optional(),
  in_reply_to_message_id: z.string().min(1).max(256).optional(),
});

const sendSchema = z
  .object({
    draft_id: z.string().min(1).max(256).optional(),
    to: z.string().min(3).max(1_024).optional(),
    subject: z.string().min(1).max(512).optional(),
    body: z.string().min(1).max(200_000).optional(),
    cc: z.string().max(1_024).optional(),
    bcc: z.string().max(1_024).optional(),
    in_reply_to_message_id: z.string().min(1).max(256).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.draft_id) return;
    if (!v.to || !v.subject || !v.body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'send requires either draft_id or (to, subject, body)',
        path: ['draft_id'],
      });
    }
  });

const labelSchema = z
  .object({
    add: z.array(z.string().min(1).max(128)).max(20).optional(),
    remove: z.array(z.string().min(1).max(128)).max(20).optional(),
  })
  .refine(
    (v) =>
      (v.add && v.add.length > 0) || (v.remove && v.remove.length > 0),
    { message: 'add or remove must be a non-empty list' },
  );

const connectStartSchema = z.object({
  include_send: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function gmailRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const mod = await loadGmail();
      if (!mod || typeof mod.getStatus !== 'function') {
        res.json({
          connected: false,
          scopes_granted: [],
          send_enabled: false,
        });
        return;
      }
      try {
        const status = await mod.getStatus();
        res.json(status);
      } catch {
        res.json({
          connected: false,
          scopes_granted: [],
          send_enabled: false,
        });
      }
    }),
  );

  router.post(
    '/connect/start',
    validateBody(connectStartSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof connectStartSchema>;
      const mod = await loadGmail();
      const fn = requireFn(mod, 'startAuthFlow');
      const { url, redirectUri, state } = await safe(() =>
        fn(body.include_send !== undefined ? { includeSend: body.include_send } : {}),
      );
      res.json({ auth_url: url, redirect_uri: redirectUri, state });
    }),
  );

  router.post(
    '/connect/complete',
    validateBody(completeSchema),
    asyncHandler(async (req, res) => {
      const { code, state } = req.body as z.infer<typeof completeSchema>;
      // The Gmail consent flow uses the same Google OAuth2 client as
      // Calendar, so the token exchange goes through the calendar module's
      // completeAuthFlow — that's the function that knows how to persist
      // the merged token blob into ~/.taskpilot/tokens.json.
      let calendarMod: {
        completeAuthFlow?: (c: string, s?: string) => Promise<void>;
      };
      try {
        calendarMod = (await import('@/main/calendar/oauth')) as typeof calendarMod;
      } catch {
        throw new ApiHttpError(
          503,
          'gmail_not_initialized',
          'Calendar OAuth module is required to complete Gmail consent',
        );
      }
      if (typeof calendarMod.completeAuthFlow !== 'function') {
        throw new ApiHttpError(
          503,
          'gmail_not_initialized',
          'completeAuthFlow not available',
        );
      }
      await safe(() => calendarMod.completeAuthFlow!(code, state));
      // Re-probe status so the renderer gets the up-to-date scopes immediately.
      const mod = await loadGmail();
      if (mod?.getStatus) {
        try {
          const status = await mod.getStatus();
          res.json({ ok: true, status });
          return;
        } catch {
          /* fall through */
        }
      }
      res.json({ ok: true });
    }),
  );

  router.post(
    '/disconnect',
    asyncHandler(async (_req, res) => {
      const mod = await loadGmail();
      const fn = requireFn(mod, 'disconnect');
      await safe(() => fn());
      res.json({ ok: true });
    }),
  );

  router.post(
    '/messages/draft',
    validateBody(draftSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof draftSchema>;
      const mod = await loadGmail();
      const fn = requireFn(mod, 'createDraft');
      const result = await safe(() =>
        fn({
          to: body.to,
          subject: body.subject,
          body: body.body,
          ...(body.cc !== undefined ? { cc: body.cc } : {}),
          ...(body.bcc !== undefined ? { bcc: body.bcc } : {}),
          ...(body.in_reply_to_message_id !== undefined
            ? { inReplyToMessageId: body.in_reply_to_message_id }
            : {}),
        }),
      );
      res.json({ ok: true, ...result });
    }),
  );

  router.post(
    '/messages/send',
    validateBody(sendSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof sendSchema>;
      const mod = await loadGmail();
      // Pre-flight: refuse early when send isn't allowed so the user gets
      // a clean 403 instead of an opaque API error.
      if (mod?.isSendAllowed) {
        const allowed = await mod.isSendAllowed();
        if (!allowed) {
          throw new ApiHttpError(
            403,
            'gmail_send_disabled',
            'Sending is disabled. Enable "Send on behalf" in Settings → Integrations → Gmail.',
          );
        }
      }
      const fn = requireFn(mod, 'sendMessage');
      const result = await safe(() =>
        fn({
          ...(body.draft_id !== undefined ? { draftId: body.draft_id } : {}),
          ...(body.to !== undefined ? { to: body.to } : {}),
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.cc !== undefined ? { cc: body.cc } : {}),
          ...(body.bcc !== undefined ? { bcc: body.bcc } : {}),
          ...(body.in_reply_to_message_id !== undefined
            ? { inReplyToMessageId: body.in_reply_to_message_id }
            : {}),
        }),
      );
      res.json({ ok: true, ...result });
    }),
  );

  router.post(
    '/messages/:id/label',
    validateBody(labelSchema),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id ?? '').trim();
      if (!id) {
        throw new ApiHttpError(400, 'bad_request', 'Missing message id');
      }
      const body = req.body as z.infer<typeof labelSchema>;
      const mod = await loadGmail();
      const fn = requireFn(mod, 'applyLabel');
      await safe(() =>
        fn(id, {
          ...(body.add !== undefined ? { add: body.add } : {}),
          ...(body.remove !== undefined ? { remove: body.remove } : {}),
        }),
      );
      res.json({ ok: true });
    }),
  );

  router.post(
    '/capture-now',
    asyncHandler(async (_req, res) => {
      const mod = await loadGmail();
      const fn = requireFn(mod, 'captureOnce');
      const result = await safe(() => fn());
      res.json({ ok: true, ...result });
    }),
  );

  return router;
}
