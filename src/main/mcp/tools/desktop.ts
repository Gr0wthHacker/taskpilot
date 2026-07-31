/**
 * MCP tools for desktop input — screenshot, mouse, keyboard.
 *
 * Every tool requires the `desktop_input_enabled` setting to be true. When
 * the setting is off, the tool returns a structured `desktop_input_disabled`
 * error so Claude can ask the user to opt in explicitly rather than
 * mysteriously failing.
 */

import { z } from 'zod';

import {
  captureScreen,
  clickAt,
  getPrimaryScreenSize,
  moveMouse,
  sendKeys,
} from '@/main/desktop';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const noInput = z.object({});

const moveInput = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const clickInput = z.object({
  x: z.number().int(),
  y: z.number().int(),
  button: z.enum(['left', 'right', 'middle']).optional(),
});

const keysInput = z.object({
  keys: z.string().min(1).max(10_000),
  raw: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const screenSizeTool: McpTool<typeof noInput> = {
  name: 'taskpilot_desktop_screen_size',
  description:
    "Get the primary display's width and height in pixels. Useful to bound mouse coordinates before issuing clicks. Requires `desktop_input_enabled = true` in TaskPilot settings.",
  inputSchema: noInput,
  async handler() {
    return await getPrimaryScreenSize();
  },
};

const screenshotTool: McpTool<typeof noInput> = {
  name: 'taskpilot_desktop_screenshot',
  description:
    "Capture the entire primary screen as a base64-encoded PNG. Returns `{ width, height, format: 'png', data }`. Requires `desktop_input_enabled = true`. Use this when you need to see what's on screen — for example before clicking somewhere or to verify a UI state.",
  inputSchema: noInput,
  async handler() {
    return await captureScreen();
  },
};

const moveTool: McpTool<typeof moveInput> = {
  name: 'taskpilot_desktop_mouse_move',
  description:
    'Move the OS cursor to absolute screen coordinates. (0,0) is the top-left of the primary display. Requires `desktop_input_enabled = true`.',
  inputSchema: moveInput,
  async handler(input) {
    return await moveMouse(input.x, input.y);
  },
};

const clickTool: McpTool<typeof clickInput> = {
  name: 'taskpilot_desktop_mouse_click',
  description:
    'Click at absolute screen coordinates. Optional `button` is one of `left` (default), `right`, `middle`. Combines a cursor move with a full down/up sequence. Requires `desktop_input_enabled = true`. ⚠️ Real mouse event — the host machine sees this as the user clicking.',
  inputSchema: clickInput,
  async handler(input) {
    return await clickAt(input.x, input.y, input.button ?? 'left');
  },
};

const keysTool: McpTool<typeof keysInput> = {
  name: 'taskpilot_desktop_keys',
  description:
    "Send keyboard input to whatever window currently has focus. Plain text goes through verbatim. Use the SendKeys DSL for combos: `^a` = Ctrl+A, `+{TAB}` = Shift+Tab, `{ENTER}`, `{F5}`, `{ESC}`, `%{F4}` = Alt+F4. Pass `raw: true` to skip the literal-text escaping (use only when you want the DSL to be interpreted). Requires `desktop_input_enabled = true`. ⚠️ Real keystrokes — confirm the right window is focused before calling.",
  inputSchema: keysInput,
  async handler(input) {
    return await sendKeys(
      input.keys,
      input.raw !== undefined ? { raw: input.raw } : {},
    );
  },
};

export const desktopTools: McpTool[] = [
  screenSizeTool as unknown as McpTool,
  screenshotTool as unknown as McpTool,
  moveTool as unknown as McpTool,
  clickTool as unknown as McpTool,
  keysTool as unknown as McpTool,
];
