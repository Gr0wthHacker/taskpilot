/**
 * Chrome DevTools Protocol session manager.
 *
 * Wraps `chrome-remote-interface` so callers don't have to track the
 * connect/disconnect lifecycle per tab. Each TaskPilot browser session maps
 * 1:1 to a Chrome target (a tab) and a held-open CDP client connection.
 *
 * Module state:
 *   - `sessions` keyed by `target.id`. Adding a session opens the underlying
 *     WebSocket; releasing one closes it. The Chrome target itself is closed
 *     when the caller invokes `closeSession()`.
 *   - `lastSessionId` lets callers omit the session id and target the most
 *     recently created tab — the common "open a page then do things to it"
 *     pattern.
 */

import CRIDefault from 'chrome-remote-interface';

import { currentHandle, ensureChrome } from './chrome';

// chrome-remote-interface is a CJS module whose `module.exports` is the
// factory function plus helper methods (`List`, `New`, `Close`, ...). With
// `esModuleInterop`, the default import is the whole exports object. The
// declared shape is narrow on purpose — only what we actually call.
const CRI = CRIDefault as unknown as CdpFactory;

/* -------------------------------------------------------------------------- */
/*  CDP types — narrow shims for what we actually use                          */
/* -------------------------------------------------------------------------- */

interface CdpFactory {
  (options: {
    port: number;
    target?: string | TargetSelector;
    host?: string;
  }): Promise<CdpClient>;
  List(options: { port: number }): Promise<TargetInfo[]>;
  New(options: { port: number; url?: string }): Promise<TargetInfo>;
  Close(options: { port: number; id: string }): Promise<void>;
  Activate(options: { port: number; id: string }): Promise<void>;
  Version(options: { port: number }): Promise<{ Browser: string; webSocketDebuggerUrl: string }>;
}

type TargetSelector = (targets: TargetInfo[]) => TargetInfo | undefined;

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpClient {
  Page: {
    enable: () => Promise<void>;
    navigate: (params: { url: string }) => Promise<{ frameId: string }>;
    captureScreenshot: (params?: {
      format?: 'png' | 'jpeg';
      quality?: number;
      fullPage?: boolean;
    }) => Promise<{ data: string }>;
    loadEventFired: (listener: () => void) => void;
  };
  Runtime: {
    enable: () => Promise<void>;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
      awaitPromise?: boolean;
      userGesture?: boolean;
    }) => Promise<{
      result: { type: string; value?: unknown; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>;
  };
  DOM: {
    enable: () => Promise<void>;
  };
  close: () => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Session registry                                                          */
/* -------------------------------------------------------------------------- */

export interface BrowserSession {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

interface InternalSession {
  id: string;
  client: CdpClient;
  target: TargetInfo;
  createdAt: string;
}

const sessions = new Map<string, InternalSession>();
let lastSessionId: string | null = null;

export function listSessions(): BrowserSession[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    url: s.target.url,
    title: s.target.title ?? '',
    createdAt: s.createdAt,
  }));
}

function getSession(id?: string): InternalSession {
  const effectiveId = id ?? lastSessionId;
  if (!effectiveId) {
    throw new BrowserError(
      'browser_no_session',
      'No active browser session. Call browser_open first to create one.',
    );
  }
  const s = sessions.get(effectiveId);
  if (!s) {
    throw new BrowserError(
      'browser_session_not_found',
      `No browser session with id "${effectiveId}". Use browser_open to create one.`,
    );
  }
  return s;
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

export class BrowserError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a new browser tab pointed at `url`, register it as a session, and
 * return the session metadata. Waits for the page to be `complete` (via a
 * combined `loadEventFired` + readyState poll) before resolving so the first
 * action against the session sees a settled DOM.
 *
 * On any failure after the Chrome target has been created, the tab is
 * closed before the error propagates — otherwise orphan tabs leak in the
 * managed Chrome instance.
 */
export async function openSession(
  url: string,
  options: { headless?: boolean; waitMs?: number } = {},
): Promise<BrowserSession> {
  const chrome = await ensureChrome(
    options.headless !== undefined ? { headless: options.headless } : {},
  );
  const target = await CRI.New({ port: chrome.port, url });

  // Everything from here until session-map insertion must clean up the
  // orphan tab on failure, otherwise we leak a Chrome target.
  let client: CdpClient | null = null;
  try {
    client = await CRI({ port: chrome.port, target: target.id });
    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.DOM.enable(),
    ]);
    await waitForReady(client, options.waitMs ?? 15_000);
  } catch (err) {
    if (client) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    }
    try {
      await CRI.Close({ port: chrome.port, id: target.id });
    } catch {
      /* tab may already be gone */
    }
    throw err;
  }

  // Re-query the target so we capture the post-navigation title + URL.
  // Fall back to the originally-returned target shape if List() drops the
  // entry (some Chrome builds briefly omit just-created targets from
  // /json/list right after creation).
  const refreshed = await refreshTarget(chrome.port, target.id, target);

  const session: InternalSession = {
    id: target.id,
    client,
    target: refreshed,
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.id, session);
  lastSessionId = session.id;

  return {
    id: session.id,
    url: refreshed.url,
    title: refreshed.title ?? '',
    createdAt: session.createdAt,
  };
}

async function refreshTarget(
  port: number,
  id: string,
  fallback: TargetInfo,
): Promise<TargetInfo> {
  try {
    const all = await CRI.List({ port });
    const found = all.find((t) => t.id === id);
    if (found) return found;
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

/**
 * Resolve once the page is `complete`. We race three signals:
 *   - `Page.loadEventFired` for normal navigations
 *   - a `document.readyState === 'complete'` poll for cached/fast pages where
 *     the load event already fired before the listener attached
 *   - a hard timeout so a stuck page can't pin the caller indefinitely
 *
 * Without the readyState poll, opening a cached or `about:blank` page paid
 * a hidden 15s timeout on every call.
 */
function waitForReady(client: CdpClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    client.Page.loadEventFired(() => finish());
    const poll = setInterval(() => {
      client.Runtime.evaluate({
        expression: 'document.readyState',
        returnByValue: true,
      })
        .then((r) => {
          if (r.result.value === 'complete') finish();
        })
        .catch(() => {
          /* connection may have closed; the outer timer will resolve */
        });
    }, 100);
  });
}

/**
 * Close the session's tab and tear down the WebSocket. No-op if the session
 * is already gone.
 *
 * Uses `currentHandle()` rather than `ensureChrome()` so a shutdown that runs
 * after Chrome has already died doesn't respawn the browser just to send a
 * Close that nobody's listening for.
 */
export async function closeSession(id?: string): Promise<{ id: string; closed: boolean }> {
  const effectiveId = id ?? lastSessionId;
  if (!effectiveId) {
    return { id: '', closed: false };
  }
  const session = sessions.get(effectiveId);
  if (!session) return { id: effectiveId, closed: false };
  sessions.delete(effectiveId);
  if (lastSessionId === effectiveId) {
    lastSessionId = sessions.size > 0 ? [...sessions.keys()].pop() ?? null : null;
  }
  try {
    await session.client.close();
  } catch {
    /* best-effort */
  }
  const handle = currentHandle();
  if (handle) {
    try {
      await CRI.Close({ port: handle.port, id: session.id });
    } catch {
      /* best-effort — Chrome may have already discarded the tab */
    }
  }
  return { id: session.id, closed: true };
}

/**
 * Close every active session. Used at server shutdown so we don't leak tabs.
 */
export async function closeAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => closeSession(id).catch(() => undefined)));
}

/* -------------------------------------------------------------------------- */
/*  Actions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hard cap on screenshot payload (base64). A full-page screenshot of a long
 * scrolling page can easily exceed 10 MB, and JSON-encoded responses balloon
 * 4/3×. MCP responses also have a token budget that base64 PNG burns fast.
 */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export async function captureScreenshot(
  options: { sessionId?: string; fullPage?: boolean; format?: 'png' | 'jpeg' } = {},
): Promise<{
  session_id: string;
  format: 'png' | 'jpeg';
  data: string;
  truncated: boolean;
  byte_length: number;
}> {
  const session = getSession(options.sessionId);
  const format = options.format ?? 'png';
  const shotParams: Parameters<CdpClient['Page']['captureScreenshot']>[0] = {
    format,
  };
  if (options.fullPage !== undefined) shotParams.fullPage = options.fullPage;
  const result = await session.client.Page.captureScreenshot(shotParams);
  const data = result.data;
  if (data.length > MAX_SCREENSHOT_BYTES) {
    throw new BrowserError(
      'browser_screenshot_too_large',
      `Screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes (${data.length}). ` +
        'Use format: \'jpeg\' or capture a viewport-only screenshot (fullPage: false).',
    );
  }
  return {
    session_id: session.id,
    format,
    data,
    truncated: false,
    byte_length: data.length,
  };
}

export async function evalExpression(
  expression: string,
  options: { sessionId?: string; awaitPromise?: boolean } = {},
): Promise<{
  session_id: string;
  type: string;
  value: unknown;
}> {
  const session = getSession(options.sessionId);
  const res = await session.client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: options.awaitPromise ?? true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      'Evaluation threw';
    throw new BrowserError('browser_eval_threw', desc);
  }
  return {
    session_id: session.id,
    type: res.result.type,
    value: res.result.value ?? null,
  };
}

/**
 * Click an element by CSS selector. Uses `element.click()` under the hood —
 * this fires a synthetic event that most apps treat identically to a real
 * click. For sites that strictly require trusted user gestures, swap to
 * `Input.dispatchMouseEvent` (out of scope for v1).
 */
export async function clickSelector(
  selector: string,
  options: { sessionId?: string } = {},
): Promise<{ session_id: string; clicked: boolean }> {
  const session = getSession(options.sessionId);
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'not_found' };
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true };
    })()
  `;
  const res = await session.client.Runtime.evaluate({
    expression: expr,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new BrowserError(
      'browser_click_threw',
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
    );
  }
  const value = res.result.value as { ok: boolean; error?: string } | undefined;
  if (!value?.ok) {
    throw new BrowserError(
      'browser_selector_not_found',
      `No element matched selector ${JSON.stringify(selector)}`,
    );
  }
  return { session_id: session.id, clicked: true };
}

/**
 * Type text into an element matched by CSS selector. Sets `.value` for form
 * fields and `.textContent` for contenteditables, then dispatches `input` so
 * any framework listening (React, Vue) registers the change.
 */
export async function typeIntoSelector(
  selector: string,
  text: string,
  options: { sessionId?: string; replace?: boolean } = {},
): Promise<{ session_id: string; typed: boolean }> {
  const session = getSession(options.sessionId);
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'not_found' };
      el.focus();
      const text = ${JSON.stringify(text)};
      const replace = ${JSON.stringify(options.replace ?? true)};
      if ('value' in el) {
        const prev = replace ? '' : (el.value ?? '');
        const nativeSetter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(el, prev + text);
        else el.value = prev + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        if (replace) el.textContent = text;
        else el.textContent = (el.textContent ?? '') + text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        return { ok: false, error: 'not_editable' };
      }
      return { ok: true };
    })()
  `;
  const res = await session.client.Runtime.evaluate({
    expression: expr,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new BrowserError(
      'browser_type_threw',
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
    );
  }
  const value = res.result.value as { ok: boolean; error?: string } | undefined;
  if (!value?.ok) {
    const code =
      value?.error === 'not_editable'
        ? 'browser_selector_not_editable'
        : 'browser_selector_not_found';
    throw new BrowserError(
      code,
      `Selector ${JSON.stringify(selector)} ${value?.error === 'not_editable' ? 'is not editable' : 'did not match anything'}`,
    );
  }
  return { session_id: session.id, typed: true };
}

/**
 * Read visible text from an element by CSS selector, or from the whole page
 * when no selector is given.
 */
export async function getText(
  options: { sessionId?: string; selector?: string; maxLength?: number } = {},
): Promise<{ session_id: string; text: string; truncated: boolean }> {
  const session = getSession(options.sessionId);
  const selectorExpr = options.selector
    ? `document.querySelector(${JSON.stringify(options.selector)})`
    : `document.body`;
  const expr = `
    (function() {
      const el = ${selectorExpr};
      if (!el) return null;
      return el.innerText ?? el.textContent ?? '';
    })()
  `;
  const res = await session.client.Runtime.evaluate({
    expression: expr,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new BrowserError(
      'browser_get_text_threw',
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
    );
  }
  const raw = res.result.value;
  if (raw === null || raw === undefined) {
    if (options.selector) {
      throw new BrowserError(
        'browser_selector_not_found',
        `No element matched selector ${JSON.stringify(options.selector)}`,
      );
    }
    return { session_id: session.id, text: '', truncated: false };
  }
  const str = String(raw);
  const max = options.maxLength ?? 50_000;
  const truncated = str.length > max;
  return {
    session_id: session.id,
    text: truncated ? str.slice(0, max) : str,
    truncated,
  };
}
