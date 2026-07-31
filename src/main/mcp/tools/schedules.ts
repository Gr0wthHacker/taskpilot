/**
 * MCP tools for recurring schedules.
 *
 * Three tools cover the full lifecycle:
 *   - `taskpilot_schedule_create` — define a new schedule
 *   - `taskpilot_schedule_list`   — see what's configured
 *   - `taskpilot_schedule_fire_now` — manual trigger (skips the tick loop)
 *
 * Editing/deleting uses the HTTP API directly; the MCP surface is kept lean
 * because the typical pattern is "create once, edit rarely in the UI."
 */

import { z } from 'zod';

import {
  createSchedule,
  fireSchedule,
  listSchedules,
} from '@/main/schedules';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const recurrenceKindSchema = z.enum(['daily', 'weekdays', 'weekly', 'monthly']);

const childTemplateSchema = z.object({
  title_template: z.string().min(1).max(500),
  instructions_template: z.string().max(50_000).optional(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  agent_method: z.enum(['human_only', 'cli', 'cowork', 'either']).optional(),
  agent_executable: z.boolean().optional(),
  permission_profile: z
    .enum(['trusted-local', 'sandboxed', 'read-only-research', 'github-pr'])
    .optional(),
});

const createInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  enabled: z.boolean().optional(),
  recurrence_kind: recurrenceKindSchema,
  recurrence_interval: z.number().int().positive().max(366).optional(),
  next_fire_at: z.string().min(1).max(64),
  fan_out_goal_id: z.string().min(1).max(64).optional(),
  child_templates: z.array(childTemplateSchema).min(1).max(32),
});

const fireInput = z.object({
  schedule_id: z.string().min(1).max(64),
});

const listInput = z.object({});

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const createTool: McpTool<typeof createInput> = {
  name: 'taskpilot_schedule_create',
  description:
    "Define a new recurring schedule. On the cadence specified by `recurrence_kind` + `recurrence_interval`, the scheduler creates one task per `child_templates` entry. If `fan_out_goal_id` is set, it fans out further: one task per repo in that goal × per child template. Template interpolation tokens: `{repo}` (e.g. owner/name), `{repo_short}` (just name), `{site_name}` (Title Case), `{date}` (YYYY-MM-DD), `{schedule_name}`. `next_fire_at` is the first scheduled fire as an ISO timestamp. Use this for weekly content reviews, monthly audits, daily standup prep, etc.",
  inputSchema: createInput,
  async handler(input) {
    const schedule = createSchedule({
      name: input.name,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      recurrence_kind: input.recurrence_kind,
      ...(input.recurrence_interval !== undefined
        ? { recurrence_interval: input.recurrence_interval }
        : {}),
      next_fire_at: input.next_fire_at,
      ...(input.fan_out_goal_id !== undefined
        ? { fan_out_goal_id: input.fan_out_goal_id }
        : {}),
      child_templates: input.child_templates,
    });
    return { schedule };
  },
};

const listTool: McpTool<typeof listInput> = {
  name: 'taskpilot_schedule_list',
  description:
    'List every recurring schedule with its name, recurrence rule, next fire time, last fire time, and child template count. Useful for auditing what TaskPilot is going to create on its own.',
  inputSchema: listInput,
  async handler() {
    return { schedules: listSchedules() };
  },
};

const fireTool: McpTool<typeof fireInput> = {
  name: 'taskpilot_schedule_fire_now',
  description:
    "Manually trigger a schedule's fan-out right now — bypasses the tick loop, but still advances `next_fire_at`. Returns the list of created task ids. Use when you want to test a newly-created schedule or run an extra ad-hoc fire (e.g. \"do the weekly Sparman batch today even though it's Tuesday\").",
  inputSchema: fireInput,
  async handler(input) {
    return await fireSchedule(input.schedule_id);
  },
};

export const scheduleTools: McpTool[] = [
  createTool as unknown as McpTool,
  listTool as unknown as McpTool,
  fireTool as unknown as McpTool,
];
