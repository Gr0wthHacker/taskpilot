/**
 * MCP tools for the outcome reverse-engineer module.
 *
 *   • `taskpilot_log_milestone` — record a milestone (revenue / deal / ship)
 *     against a business. Triggers the trace path the next time it's queried.
 *   • `taskpilot_list_milestones` — list every milestone for a business
 *     (or across businesses when no tag passed).
 *   • `taskpilot_trace_milestone` — for a given milestone, return the
 *     contributing tasks / decisions / conversations / status deltas in the
 *     window leading up to it. Caller decides whether to render that as
 *     a narrative or feed it into a report.
 */

import { nanoid } from 'nanoid';
import { z } from 'zod';

import { businessTagSchema } from '@/main/businesses/loader';
import { listBusinesses } from '@/main/businesses';
import {
  listMilestones,
  recordMilestone,
  traceMilestone,
} from '@/main/outcomes';

import type { McpTool } from '../tool-registry';

const milestoneKindSchema = z.enum([
  'revenue',
  'deal',
  'ship',
  'launch',
  'press',
  'hire',
  'milestone',
]);

const logInput = z.object({
  business: businessTagSchema,
  kind: milestoneKindSchema.default('milestone'),
  headline: z.string().min(4).max(500),
  value: z.string().max(200).optional(),
  link: z.string().url().max(2_048).optional(),
  at: z.string().datetime().optional(),
  window_days: z.number().int().min(1).max(180).optional(),
});

const logTool: McpTool<typeof logInput> = {
  name: 'taskpilot_log_milestone',
  description:
    "Log a milestone against a business — revenue hit, deal closed, ship, launch, press, hire. Use this whenever Jack mentions something landed (e.g. 'we closed Acme', 'hit $50k MRR', 'shipped the deck'). The system later traces back through tasks/decisions/conversations/status deltas to surface what contributed. Defaults the timestamp to now; pass `at` for backdated entries. `window_days` controls how far back the trace looks (default 14).",
  inputSchema: logInput,
  async handler(input) {
    const at = input.at ?? new Date().toISOString();
    const m = await recordMilestone({
      id: `m_${nanoid(10)}`,
      business: input.business,
      at,
      kind: input.kind,
      headline: input.headline,
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.link !== undefined ? { link: input.link } : {}),
      ...(input.window_days !== undefined
        ? { window_days: input.window_days }
        : {}),
    });
    return { ok: true, milestone: m };
  },
};

const listInput = z.object({
  business: businessTagSchema.optional(),
});

const listTool: McpTool<typeof listInput> = {
  name: 'taskpilot_list_milestones',
  description:
    'List logged milestones. Pass `business` to scope to one (e.g. "leal-health"), or omit to list across every configured business. Newest first.',
  inputSchema: listInput,
  async handler(input) {
    if (input.business) {
      const list = await listMilestones(input.business);
      return { business: input.business, milestones: list };
    }
    const out: unknown[] = [];
    for (const b of listBusinesses()) {
      const list = await listMilestones(b.tag);
      for (const m of list) out.push(m);
    }
    out.sort((a, b) => {
      const ma = (a as { at: string }).at;
      const mb = (b as { at: string }).at;
      return mb.localeCompare(ma);
    });
    return { milestones: out };
  },
};

const traceInput = z.object({
  business: businessTagSchema,
  milestone_id: z
    .string()
    .regex(/^m_[A-Za-z0-9_-]{1,62}$/, 'invalid milestone id'),
});

const traceTool: McpTool<typeof traceInput> = {
  name: 'taskpilot_trace_milestone',
  description:
    "Reverse-engineer a milestone — return every contributing task, decision, conversation, and status delta in the window leading up to it. Use this when Jack asks 'how did X happen' or before a VP+ interview where he needs to actually explain the causal chain. The output is structured (tasks/decisions/conversations/status_deltas arrays) — call this first, THEN write the narrative.",
  inputSchema: traceInput,
  async handler(input) {
    const trace = await traceMilestone({
      business: input.business,
      milestoneId: input.milestone_id,
    });
    if (!trace) return { ok: false, reason: 'not_found' };
    return { ok: true, trace };
  },
};

export const outcomeTools: McpTool[] = [
  logTool as unknown as McpTool,
  listTool as unknown as McpTool,
  traceTool as unknown as McpTool,
];
