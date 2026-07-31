/**
 * MCP tools for the per-business status surface.
 *
 * Designed for the "instant context in future sessions" use case: any Claude
 * session (Claude Code, Cowork, a fresh chat) calls
 * `taskpilot_business_status` and gets the same STATUS.md a developer would
 * see — derived from open tasks, recent decisions, mapped Claude Code
 * sessions, and explicit cross-session deltas — without having to grep,
 * trawl GitHub, or re-read prior conversations.
 *
 * Three tools:
 *   list      — overview entries (one line per business)
 *   status    — full snapshot for one business
 *   update    — append a delta (the manual write side; the SessionEnd hook
 *               uses the file-drop io path instead)
 */

import { z } from 'zod';

import {
  computeOverview,
  recordUpdate,
  refreshAndPersistSnapshot,
  renderStatusMarkdown,
} from '@/main/businesses';
import { businessTagSchema } from '@/main/businesses/loader';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  list                                                                       */
/* -------------------------------------------------------------------------- */

const listInput = z.object({});

const listTool: McpTool<typeof listInput> = {
  name: 'taskpilot_list_businesses',
  description:
    'List every configured business from ~/.taskpilot/projects.json with a one-line overview: headline, last touched, open task count, overdue count, and the most recent status update. Use this first to see which businesses exist before drilling in.',
  inputSchema: listInput,
  async handler() {
    return { businesses: await computeOverview() };
  },
};

/* -------------------------------------------------------------------------- */
/*  status                                                                     */
/* -------------------------------------------------------------------------- */

const statusInput = z.object({
  tag: businessTagSchema,
  format: z.enum(['markdown', 'json']).default('markdown').optional(),
});

const statusTool: McpTool<typeof statusInput> = {
  name: 'taskpilot_business_status',
  description:
    'Return the live status snapshot for a single business — headline, next steps, open tasks, recent decisions, mapped Claude Code sessions, and the cross-session updates feed. Default format is markdown (the same STATUS.md surfaced by the app); pass format="json" for the structured shape. Use this at the start of a session to orient on "where things stand with X" without re-reading prior conversations or grepping the repo.',
  inputSchema: statusInput,
  async handler(input) {
    const snapshot = await refreshAndPersistSnapshot(input.tag);
    if (!snapshot) {
      return {
        ok: false,
        reason: 'not_configured',
        message: `No business for tag "${input.tag}" in ~/.taskpilot/projects.json.`,
      };
    }
    if ((input.format ?? 'markdown') === 'markdown') {
      return {
        ok: true,
        tag: snapshot.tag,
        name: snapshot.name,
        markdown: renderStatusMarkdown(snapshot),
      };
    }
    return { ok: true, snapshot };
  },
};

/* -------------------------------------------------------------------------- */
/*  update                                                                     */
/* -------------------------------------------------------------------------- */

const updateInput = z.object({
  tag: businessTagSchema,
  headline: z.string().min(1).max(500),
  what_changed: z.string().max(10_000).optional(),
  source: z.string().max(500).optional(),
  at: z.string().datetime().optional(),
  links: z
    .array(
      z.object({
        label: z.string().max(200),
        url: z.string().max(2048),
      }),
    )
    .max(16)
    .optional(),
});

const updateTool: McpTool<typeof updateInput> = {
  name: 'taskpilot_update_business_status',
  description:
    'Append a status delta to a business. Use this from any Claude session to record progress, a decision, or a context note that the next session should see — e.g. "ripped out the old auth middleware, swapping to the new one next" against business "leal-health". The delta lands in ~/.taskpilot/businesses/<tag>/updates.jsonl and the cached STATUS.md is re-rendered immediately. Pass `source` to label the entry (session id, repo, chat link).',
  inputSchema: updateInput,
  async handler(input) {
    const at = input.at ?? new Date().toISOString();
    const snapshot = await recordUpdate(input.tag, {
      at,
      headline: input.headline,
      ...(input.what_changed !== undefined
        ? { what_changed: input.what_changed }
        : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.links !== undefined ? { links: input.links } : {}),
    });
    if (!snapshot) {
      return {
        ok: false,
        reason: 'not_configured',
        message: `No business for tag "${input.tag}" in ~/.taskpilot/projects.json.`,
      };
    }
    return {
      ok: true,
      tag: snapshot.tag,
      headline: input.headline,
      at,
      recent_updates: snapshot.recent_updates.length,
    };
  },
};

export const businessTools: McpTool[] = [
  listTool as unknown as McpTool,
  statusTool as unknown as McpTool,
  updateTool as unknown as McpTool,
];
