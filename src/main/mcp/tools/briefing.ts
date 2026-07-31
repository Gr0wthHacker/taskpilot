/**
 * MCP tool for reading + regenerating the morning brief.
 *
 * Designed for the SessionStart pattern: a fresh Claude session calls
 * `taskpilot_morning_brief` first and gets the day's one-page CEO update
 * before doing anything else. The brief itself is a markdown blob with
 * per-business overview, your-move queue, and pending update drafts.
 */

import { z } from 'zod';

import {
  generateMorningBrief,
  isMorningBriefDue,
  readMorningBrief,
} from '@/main/briefing/morning-brief';
import {
  generateSelfProfile,
  isSelfProfileDue,
  readSelfProfile,
} from '@/main/self-profile';

import type { McpTool } from '../tool-registry';

const briefInput = z.object({
  /** Force a fresh render even if today's brief is cached. */
  regenerate: z.boolean().default(false).optional(),
});

const briefTool: McpTool<typeof briefInput> = {
  name: 'taskpilot_morning_brief',
  description:
    "Returns today's one-page morning brief — businesses at a glance, what needs you today, pending updates drafts, and a recommended first move. Use this at session start to orient on the day without re-asking. Pass `regenerate: true` to force a fresh render; otherwise returns the cached copy and regenerates only when the date has rolled over.",
  inputSchema: briefInput,
  async handler(input) {
    if (input.regenerate || isMorningBriefDue()) {
      const result = await generateMorningBrief();
      return {
        markdown: result.markdown,
        date: result.date,
        bytes: result.bytes,
        regenerated: true,
      };
    }
    const markdown = await readMorningBrief();
    if (markdown === null) {
      const result = await generateMorningBrief();
      return {
        markdown: result.markdown,
        date: result.date,
        bytes: result.bytes,
        regenerated: true,
      };
    }
    return { markdown, regenerated: false };
  },
};

const selfProfileInput = z.object({
  regenerate: z.boolean().default(false).optional(),
});

const selfProfileTool: McpTool<typeof selfProfileInput> = {
  name: 'taskpilot_self_profile',
  description:
    "Returns Jack's weekly self-profile — a private, deliberately unflattering mirror derived from 30 days of activity. Surfaces sharpest hours, where time is actually invested vs claimed, per-business completion ratios, and dormant or all-create-no-finish businesses. Use this when Jack asks 'how am I actually doing' or to ground a strategy conversation in observed behavior rather than narrative. Pass `regenerate: true` to force a fresh computation; otherwise returns the cached weekly copy.",
  inputSchema: selfProfileInput,
  async handler(input) {
    if (input.regenerate || isSelfProfileDue()) {
      const result = await generateSelfProfile();
      return {
        markdown: result.markdown,
        date: result.date,
        bytes: result.bytes,
        regenerated: true,
      };
    }
    const markdown = await readSelfProfile();
    if (markdown === null) {
      const result = await generateSelfProfile();
      return {
        markdown: result.markdown,
        date: result.date,
        bytes: result.bytes,
        regenerated: true,
      };
    }
    return { markdown, regenerated: false };
  },
};

export const briefingTools: McpTool[] = [
  briefTool as unknown as McpTool,
  selfProfileTool as unknown as McpTool,
];
