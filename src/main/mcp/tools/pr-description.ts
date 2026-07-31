/**
 * MCP tools that auto-fill PR descriptions from TaskPilot task context.
 *
 *   • `taskpilot_generate_pr_description` — returns the title + body without
 *     opening anything. Use this when you want to preview before committing.
 *   • `taskpilot_open_pr_with_context` — generates the body AND opens the PR
 *     in one shot. The autopilot path.
 */

import { z } from 'zod';

import { openPR } from '@/main/github/operations';
import { generatePrDescription } from '@/main/github/pr-description';
import { taskIdSchema } from '@/shared/io-schemas';

import type { McpTool } from '../tool-registry';

const ownerNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const branchNameSchema = z.string().min(1).max(255);

const previewInput = z.object({
  task_id: taskIdSchema,
  commit_subjects: z.array(z.string().max(500)).max(50).optional(),
  title_override: z.string().min(1).max(500).optional(),
});

const previewTool: McpTool<typeof previewInput> = {
  name: 'taskpilot_generate_pr_description',
  description:
    'Generate a PR title + body from a task id. Pulls the task description, recent decisions, linked conversations, tags, and any commit subjects you pass in. Returns plain markdown — DOES NOT open the PR. Use this when you want to preview before committing, or when the user wants to edit the draft.',
  inputSchema: previewInput,
  async handler(input) {
    const generated = generatePrDescription({
      task_id: input.task_id,
      ...(input.commit_subjects !== undefined
        ? { commit_subjects: input.commit_subjects }
        : {}),
      ...(input.title_override !== undefined
        ? { title_override: input.title_override }
        : {}),
    });
    if (!generated) {
      return { ok: false, reason: 'task_not_found' };
    }
    return { ok: true, ...generated };
  },
};

const openInput = z.object({
  task_id: taskIdSchema,
  owner: ownerNameSchema,
  repo: ownerNameSchema,
  head: branchNameSchema,
  base: branchNameSchema.optional(),
  title_override: z.string().min(1).max(500).optional(),
  commit_subjects: z.array(z.string().max(500)).max(50).optional(),
  draft: z.boolean().default(false).optional(),
});

const openTool: McpTool<typeof openInput> = {
  name: 'taskpilot_open_pr_with_context',
  description:
    'Open a PR with a body auto-filled from the linked task. Combines generate + openPR in one call — the body carries task description, decisions, conversation links, and commit subjects. Use this for the autopilot path when you trust the generated draft. For preview-first, call `taskpilot_generate_pr_description` instead, then pass the body to the standard openPR tool.',
  inputSchema: openInput,
  async handler(input) {
    const generated = generatePrDescription({
      task_id: input.task_id,
      ...(input.commit_subjects !== undefined
        ? { commit_subjects: input.commit_subjects }
        : {}),
      ...(input.title_override !== undefined
        ? { title_override: input.title_override }
        : {}),
    });
    if (!generated) {
      return { ok: false, reason: 'task_not_found' };
    }
    const result = await openPR({
      owner: input.owner,
      repo: input.repo,
      head: input.head,
      ...(input.base !== undefined ? { base: input.base } : {}),
      title: generated.title,
      body: generated.body,
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
    });
    return {
      ok: true,
      pr_number: result.number,
      pr_url: result.url,
      title: generated.title,
      body: generated.body,
      sources: generated.sources,
    };
  },
};

export const prDescriptionTools: McpTool[] = [
  previewTool as unknown as McpTool,
  openTool as unknown as McpTool,
];
