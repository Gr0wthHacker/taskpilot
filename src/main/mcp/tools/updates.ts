/**
 * MCP tools for the public updates log at `Gr0wthHacker/updates`.
 *
 * Workflow: a Claude session that just shipped something noteworthy drafts
 * an entry in Jack's voice (per the `feedback-updates-repo-voice` memory),
 * calls `taskpilot_publish_update`, and the entry lands on the public feed
 * without a local clone or a manual round-trip.
 *
 * The drafter side — taking captured session context and producing the
 * prose — runs inside the calling Claude session, not in this tool. This
 * surface only handles persistence and the optional draft queue.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import { publishUpdate } from '@/main/updates';
import { z } from 'zod';

import type { McpTool } from '../tool-registry';

const UPDATES_DRAFTS_DIR = path.join(
  TASKPILOT_HOME,
  'io',
  'updates_drafts',
);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,80}$/;

const publishInput = z.object({
  title: z.string().min(4).max(200),
  slug: z.string().regex(SLUG_REGEX, 'slug must be a-z, 0-9, hyphens'),
  date: z.string().regex(DATE_REGEX, 'date must be YYYY-MM-DD').optional(),
  category: z
    .enum([
      'launch',
      'system',
      'research',
      'fix',
      'note',
      'growth-experiment',
      'pivot',
      'client-win',
      'lesson',
    ])
    .default('system'),
  venture: z.string().min(1).max(64).default('personal'),
  tags: z.array(z.string().max(64)).max(16).default([]),
  status: z.enum(['shipped', 'in_flight', 'planning']).default('shipped'),
  link: z.string().url().max(2048).optional(),
  body: z.string().min(40).max(20_000),
  commit_message: z.string().max(2048).optional(),
});

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const publishTool: McpTool<typeof publishInput> = {
  name: 'taskpilot_publish_update',
  description:
    "Push a markdown entry to Jack's public updates log (Gr0wthHacker/updates@main). The repo renders on jackgierlich.com — write in plain prose for a thoughtful non-engineer audience. Do NOT include endpoint names, file paths, library callouts, skill names, or meta references to \"this log\". Lead with the user-visible problem or capability, then what shipped, then why it matters. Tone is confident-from-experience, direct, conversational with contractions. The frontmatter fields (title/date/category/venture/tags/status) are required; the date defaults to today. Returns the file path, commit sha, and a GitHub URL.",
  inputSchema: publishInput,
  async handler(input) {
    const date = input.date ?? todayIsoDate();
    const result = await publishUpdate({
      slug: input.slug,
      frontmatter: {
        title: input.title,
        date,
        category: input.category,
        venture: input.venture,
        tags: input.tags,
        status: input.status,
        ...(input.link ? { link: input.link } : {}),
        visibility: 'public',
      },
      body: input.body,
      ...(input.commit_message ? { commit_message: input.commit_message } : {}),
    });
    return { ok: true, ...result };
  },
};

const listDraftsInput = z.object({});

const listDraftsTool: McpTool<typeof listDraftsInput> = {
  name: 'taskpilot_list_update_drafts',
  description:
    'List pending draft updates the SessionEnd hook has flagged for review. Each draft carries context about what shipped (recent commits, business tag, source CWD) so you can use it to produce a finished entry to push via `taskpilot_publish_update`.',
  inputSchema: listDraftsInput,
  async handler() {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(UPDATES_DRAFTS_DIR);
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === 'ENOENT') return { drafts: [] };
      throw err;
    }
    const drafts: unknown[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(
          path.join(UPDATES_DRAFTS_DIR, name),
          'utf8',
        );
        drafts.push({ filename: name, ...(JSON.parse(raw) as object) });
      } catch {
        /* skip malformed */
      }
    }
    return { drafts };
  },
};

const resolveDraftInput = z.object({
  filename: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,128}$/, 'invalid filename'),
});

const resolveDraftTool: McpTool<typeof resolveDraftInput> = {
  name: 'taskpilot_resolve_update_draft',
  description:
    'Mark a pending update draft as handled by deleting its queue file. Call this after publishing the entry via `taskpilot_publish_update`. No-op when the draft is already gone.',
  inputSchema: resolveDraftInput,
  async handler(input) {
    try {
      await fs.unlink(path.join(UPDATES_DRAFTS_DIR, input.filename));
      return { ok: true, removed: input.filename };
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === 'ENOENT') return { ok: true, removed: null };
      throw err;
    }
  },
};

export const updateTools: McpTool[] = [
  publishTool as unknown as McpTool,
  listDraftsTool as unknown as McpTool,
  resolveDraftTool as unknown as McpTool,
];
