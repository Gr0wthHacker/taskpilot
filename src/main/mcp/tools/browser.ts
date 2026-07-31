/**
 * MCP tools for browser automation via Chrome DevTools Protocol.
 *
 * All actions target a session (= a Chrome tab). The first call to
 * `taskpilot_browser_open` spawns a managed Chrome instance under
 * `~/.taskpilot/chrome-profile/` so the user's real browser session stays
 * untouched. Subsequent calls can omit `session_id` to act on the most
 * recently opened tab.
 */

import { z } from 'zod';

import {
  captureScreenshot,
  clickSelector,
  closeSession,
  evalExpression,
  getText,
  listSessions,
  openSession,
  typeIntoSelector,
} from '@/main/browser';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const sessionIdField = z.string().min(1).max(256);

// http(s) only — see the parallel comment in src/main/server/routes/browser.ts.
const openInput = z.object({
  url: z
    .string()
    .min(1)
    .max(2_048)
    .refine((s) => /^https?:\/\//i.test(s), {
      message: 'url must start with http:// or https://',
    }),
  headless: z.boolean().optional(),
  wait_ms: z.number().int().positive().max(60_000).optional(),
});

const screenshotInput = z.object({
  session_id: sessionIdField.optional(),
  full_page: z.boolean().optional(),
  format: z.enum(['png', 'jpeg']).optional(),
});

const evalInput = z.object({
  session_id: sessionIdField.optional(),
  expression: z.string().min(1).max(100_000),
  await_promise: z.boolean().optional(),
});

const clickInput = z.object({
  session_id: sessionIdField.optional(),
  selector: z.string().min(1).max(1_000),
});

const typeInput = z.object({
  session_id: sessionIdField.optional(),
  selector: z.string().min(1).max(1_000),
  text: z.string().max(100_000),
  replace: z.boolean().optional(),
});

const getTextInput = z.object({
  session_id: sessionIdField.optional(),
  selector: z.string().min(1).max(1_000).optional(),
  max_length: z.number().int().positive().max(500_000).optional(),
});

const closeInput = z.object({
  session_id: sessionIdField.optional(),
});

const listInput = z.object({});

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const openTool: McpTool<typeof openInput> = {
  name: 'taskpilot_browser_open',
  description:
    "Open a URL in a new managed Chrome tab and return the session id. The first call spawns Chrome with an isolated profile under `~/.taskpilot/chrome-profile/` (your normal browser is unaffected). Pass `headless: true` to run without a window. Returns `{ session: { id, url, title, createdAt } }`. Use this before any other browser tool when you need a fresh page.",
  inputSchema: openInput,
  async handler(input) {
    return {
      session: await openSession(input.url, {
        ...(input.headless !== undefined ? { headless: input.headless } : {}),
        ...(input.wait_ms !== undefined ? { waitMs: input.wait_ms } : {}),
      }),
    };
  },
};

const screenshotTool: McpTool<typeof screenshotInput> = {
  name: 'taskpilot_browser_screenshot',
  description:
    "Capture a screenshot of the current page in the given session (or the most recently opened session). Returns base64-encoded image data — PNG by default; pass `format: 'jpeg'` for smaller payloads. Pass `full_page: true` to capture the entire scrolling page rather than just the viewport.",
  inputSchema: screenshotInput,
  async handler(input) {
    return await captureScreenshot({
      ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
      ...(input.full_page !== undefined ? { fullPage: input.full_page } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
    });
  },
};

const evalTool: McpTool<typeof evalInput> = {
  name: 'taskpilot_browser_eval',
  description:
    "Run a JavaScript expression in the page context and return the result. `awaitPromise` defaults to true so async expressions resolve before returning. Returns `{ session_id, type, value }`. Use for anything not covered by the dedicated click/type/text tools (form submission, scrolling, extracting structured data, etc.).",
  inputSchema: evalInput,
  async handler(input) {
    return await evalExpression(input.expression, {
      ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
      ...(input.await_promise !== undefined
        ? { awaitPromise: input.await_promise }
        : {}),
    });
  },
};

const clickTool: McpTool<typeof clickInput> = {
  name: 'taskpilot_browser_click',
  description:
    'Click the first element matching the CSS selector in the current session. Scrolls the element into view before clicking. Throws `browser_selector_not_found` if nothing matches. Note: dispatches a synthetic `.click()` rather than a real cursor event — works for nearly all sites; if you hit one that requires a trusted user gesture, use `taskpilot_browser_eval` with the relevant DOM API instead.',
  inputSchema: clickInput,
  async handler(input) {
    return await clickSelector(input.selector, {
      ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
    });
  },
};

const typeTool: McpTool<typeof typeInput> = {
  name: 'taskpilot_browser_type',
  description:
    'Type text into an input, textarea, or contenteditable element matched by CSS selector. Fires `input` + `change` events so React/Vue listeners pick up the value. `replace: true` (default) clears existing content first; pass `false` to append.',
  inputSchema: typeInput,
  async handler(input) {
    return await typeIntoSelector(input.selector, input.text, {
      ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
      ...(input.replace !== undefined ? { replace: input.replace } : {}),
    });
  },
};

const textTool: McpTool<typeof getTextInput> = {
  name: 'taskpilot_browser_get_text',
  description:
    "Read visible text from the current page. With no selector, returns the entire body's innerText. With a selector, returns the matching element's innerText. Bounded by `max_length` (default 50,000 chars).",
  inputSchema: getTextInput,
  async handler(input) {
    return await getText({
      ...(input.session_id !== undefined ? { sessionId: input.session_id } : {}),
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.max_length !== undefined ? { maxLength: input.max_length } : {}),
    });
  },
};

const closeTool: McpTool<typeof closeInput> = {
  name: 'taskpilot_browser_close',
  description:
    'Close the tab for the given session (or the most recent session). The managed Chrome instance stays alive across calls — only the tab is closed.',
  inputSchema: closeInput,
  async handler(input) {
    return await closeSession(input.session_id);
  },
};

const listTool: McpTool<typeof listInput> = {
  name: 'taskpilot_browser_sessions',
  description:
    'List every active browser session managed by TaskPilot. Each entry includes the session id, current URL, and tab title. Useful for re-acquiring a session id when prior context has been lost.',
  inputSchema: listInput,
  async handler() {
    return { sessions: listSessions() };
  },
};

export const browserTools: McpTool[] = [
  openTool as unknown as McpTool,
  screenshotTool as unknown as McpTool,
  evalTool as unknown as McpTool,
  clickTool as unknown as McpTool,
  typeTool as unknown as McpTool,
  textTool as unknown as McpTool,
  closeTool as unknown as McpTool,
  listTool as unknown as McpTool,
];
