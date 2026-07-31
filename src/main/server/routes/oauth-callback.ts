/**
 * `GET /oauth/callback` — Google OAuth redirect target.
 *
 * Mounted at the SERVER ROOT (not under `/api/`) because Google redirects the
 * user's browser here directly. The route must:
 *   1. Read `req.query.code` (and `req.query.error` if the user denied consent).
 *   2. Exchange the code for tokens via `completeAuthFlow(code)`.
 *   3. Render a tiny inline HTML page that the user sees. On success the page
 *      auto-closes after a short delay; on failure it surfaces the error and
 *      shows the raw code as copyable text so the user can fall back to the
 *      manual-paste flow inside Settings.
 *   4. Emit `pipeline_changed { reason: 'calendar_authenticated' }` on success
 *      so connected SSE clients (the Settings view) refresh status promptly.
 *
 * The HTML is inlined — no template files, no external assets. The page is
 * deliberately self-contained so it works even if the renderer is offline.
 */

import { Router } from 'express';

import { ioEvents } from '@/main/io/events';

import { asyncHandler } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Soft module loader (mirrors calendar-auth.ts so the route never explodes  */
/*  when the calendar subsystem isn't compiled in)                            */
/* -------------------------------------------------------------------------- */

interface OauthModule {
  completeAuthFlow?: (code: string, state?: string) => Promise<void>;
  isAuthenticated?: () => Promise<boolean>;
}

let cachedMod: OauthModule | null = null;
let loadAttempted = false;

async function loadOauth(): Promise<OauthModule | null> {
  if (cachedMod) return cachedMod;
  if (loadAttempted) return null;
  loadAttempted = true;
  try {
    const mod = (await import('@/main/calendar/oauth')) as OauthModule;
    cachedMod = mod;
    return mod;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  HTML rendering                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal HTML-escape for arbitrary strings injected into the response body.
 * We only need to neutralize the 5 characters that have special meaning inside
 * an HTML document; nothing here ever interpolates into a JS context.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSuccessHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>TaskPilot — Connected</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #0a0a0a;
        color: #f5f5f5;
      }
      .card {
        max-width: 420px;
        padding: 32px;
        border-radius: 16px;
        background: #161616;
        border: 1px solid #262626;
        text-align: center;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      }
      .check {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: #16a34a;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 18px;
        font-size: 28px;
      }
      h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
      p { margin: 0; color: #a3a3a3; font-size: 14px; }
      .hint { margin-top: 18px; font-size: 12px; color: #737373; }
    </style>
  </head>
  <body>
    <div class="card" role="status" aria-live="polite">
      <div class="check" aria-hidden="true">&#10003;</div>
      <h1>Connected to Google Calendar</h1>
      <p>You can close this tab. TaskPilot is finishing up.</p>
      <div class="hint">This window closes automatically in 3 seconds.</div>
    </div>
    <script>
      // Best-effort auto-close. window.close() is a no-op if this tab wasn't
      // opened by a script — that's fine; the visible message tells the user.
      setTimeout(function () { try { window.close(); } catch (e) {} }, 3000);
    </script>
  </body>
</html>
`;
}

function renderErrorHtml(args: {
  heading: string;
  detail: string;
  code: string | null;
}): string {
  const heading = escapeHtml(args.heading);
  const detail = escapeHtml(args.detail);
  const codeBlock =
    args.code === null
      ? ''
      : `
      <div class="code-label">Authorization code (paste into Settings → Calendar):</div>
      <pre class="code" id="code">${escapeHtml(args.code)}</pre>
      <button class="copy" id="copy-btn" type="button">Copy code</button>`;

  // The script block reads the code from the rendered <pre> rather than
  // having it baked into JS — keeps escaping simple.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>TaskPilot — Connection error</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #0a0a0a;
        color: #f5f5f5;
        padding: 24px;
      }
      .card {
        max-width: 520px;
        width: 100%;
        padding: 28px;
        border-radius: 16px;
        background: #161616;
        border: 1px solid #7f1d1d;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      }
      .x {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: #dc2626;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        margin-bottom: 14px;
      }
      h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
      p { margin: 0 0 14px; color: #d4d4d4; font-size: 14px; line-height: 1.5; }
      .code-label { margin-top: 14px; font-size: 12px; color: #a3a3a3; }
      .code {
        margin: 6px 0 12px;
        padding: 10px 12px;
        border-radius: 8px;
        background: #0a0a0a;
        border: 1px solid #262626;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        word-break: break-all;
        white-space: pre-wrap;
        color: #e5e5e5;
      }
      .copy {
        background: #f5f5f5;
        color: #0a0a0a;
        border: 0;
        padding: 8px 14px;
        font-size: 13px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 500;
      }
      .copy:hover { background: #e5e5e5; }
    </style>
  </head>
  <body>
    <div class="card" role="alert">
      <div class="x" aria-hidden="true">&times;</div>
      <h1>${heading}</h1>
      <p>${detail}</p>${codeBlock}
    </div>
    <script>
      var btn = document.getElementById("copy-btn");
      var pre = document.getElementById("code");
      if (btn && pre) {
        btn.addEventListener("click", function () {
          var text = pre.textContent || "";
          try {
            navigator.clipboard.writeText(text).then(function () {
              btn.textContent = "Copied";
              setTimeout(function () { btn.textContent = "Copy code"; }, 1500);
            }, function () {
              btn.textContent = "Press Ctrl+C";
            });
          } catch (e) {
            btn.textContent = "Press Ctrl+C";
          }
        });
      }
    </script>
  </body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function firstQueryValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function oauthCallbackRouter(): Router {
  const router = Router();

  router.get(
    '/oauth/callback',
    asyncHandler(async (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Belt-and-suspenders: never let a browser cache this response. The
      // `code` is single-use and we don't want it lingering in history.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      // Tight CSP so even if a future change interpolates user data into the
      // page, no remote scripts/styles/images can load. The page is fully
      // self-contained — only the inline <script>/<style> blocks are needed.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      );
      // No referrer leaks the code to anywhere via clicks/redirects.
      res.setHeader('Referrer-Policy', 'no-referrer');
      // Hide from indexers (paranoid; Google's redirect URI is opaque anyway).
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');

      const oauthError = firstQueryValue(req.query.error);
      const code = firstQueryValue(req.query.code);
      const state = firstQueryValue(req.query.state);

      // CSRF protection: state is REQUIRED on the redirect path. The legacy
      // "missing state allowed when no pending flows" branch in
      // completeAuthFlow() is for the manual-paste-from-another-tool fallback
      // only; an HTTP callback that lacks state is treated as suspicious.
      if (!oauthError && !state) {
        res.status(400).send(
          renderErrorHtml({
            heading: 'Missing OAuth state',
            detail:
              'The callback URL is missing the `state` parameter required for CSRF protection. Start the connect flow again from Settings.',
            code: null,
          }),
        );
        return;
      }

      if (oauthError) {
        res.status(400).send(
          renderErrorHtml({
            heading: 'Google declined the request',
            detail: `Google returned an error: ${oauthError}. You can close this tab and try again from Settings.`,
            code: null,
          }),
        );
        return;
      }

      if (!code) {
        res.status(400).send(
          renderErrorHtml({
            heading: 'Missing authorization code',
            detail:
              'Google did not include a `code` parameter. Try the connect flow again from Settings.',
            code: null,
          }),
        );
        return;
      }

      const mod = await loadOauth();
      if (!mod || typeof mod.completeAuthFlow !== 'function') {
        res.status(503).send(
          renderErrorHtml({
            heading: 'Calendar module unavailable',
            detail:
              'TaskPilot could not load its calendar subsystem. Copy the code below and paste it into Settings → Calendar to finish connecting.',
            code,
          }),
        );
        return;
      }

      try {
        // state is guaranteed non-null here (we 400'd above otherwise) — pass
        // it through unconditionally so completeAuthFlow takes the strict
        // CSRF-validation branch, never the legacy "missing state" path.
        await mod.completeAuthFlow(code, state ?? undefined);
      } catch (err: unknown) {
        // `completeAuthFlow` already treats "code already used + already
        // authenticated" as success. Anything that lands here is a real
        // failure — show the code so the user can retry.
        const message =
          err instanceof Error ? err.message : 'Unknown error during exchange.';
        res.status(400).send(
          renderErrorHtml({
            heading: 'Could not finish authentication',
            detail: message,
            code,
          }),
        );
        return;
      }

      // Notify any connected SSE listeners (the Settings UI) so they can
      // refresh status without waiting for their next poll.
      try {
        ioEvents.emit('pipeline_changed', {
          reason: 'calendar_authenticated',
        });
      } catch {
        // Non-fatal — the UI will catch up via its 2s status poll.
      }

      res.status(200).send(renderSuccessHtml());
    }),
  );

  return router;
}
