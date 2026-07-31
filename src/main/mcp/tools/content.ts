/**
 * MCP tools for the publishing pipeline.
 *
 * Lets a Claude session create a piece, push a draft, advance state, or
 * attach a derivative — useful when the user's workflow is "I drafted
 * something in chat, save it as a content piece so the calendar + state
 * machine track it from here."
 */

import { z } from 'zod';

import {
  advanceState,
  ContentStateError,
  CONTENT_CHANNELS,
  createPiece,
  listPieces,
  readPiece,
  setDerivative,
  updatePiece,
} from '@/main/content';
import { CONTENT_STATES } from '@/main/content/types';
import { businessTagSchema } from '@/main/businesses/loader';

import type { McpTool } from '../tool-registry';

const idSchema = z.string().regex(/^c_[A-Za-z0-9_-]{1,62}$/, 'Invalid content id');

const createInput = z.object({
  title: z.string().min(1).max(500),
  business: businessTagSchema.optional(),
  draft_markdown: z.string().max(200_000).optional(),
  hypothesis: z.string().max(2_000).optional(),
  notes: z.string().max(10_000).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});

const createTool: McpTool<typeof createInput> = {
  name: 'taskpilot_create_content_piece',
  description:
    'Create a new content piece in `draft` state. Use this when you and the user have just drafted something in chat and want the publishing pipeline to track it — title + draft markdown + optional business tag (matches projects.json). Returns the created piece including its id.',
  inputSchema: createInput,
  async handler(input) {
    const piece = await createPiece({
      title: input.title,
      ...(input.business !== undefined ? { business: input.business } : {}),
      ...(input.draft_markdown !== undefined
        ? { draft_markdown: input.draft_markdown }
        : {}),
      ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    });
    return { piece };
  },
};

const listInput = z.object({
  state: z.enum(CONTENT_STATES).optional(),
  business: businessTagSchema.optional(),
});

const listTool: McpTool<typeof listInput> = {
  name: 'taskpilot_list_content_pieces',
  description:
    'List every content piece on disk, newest first. Optionally filter by state (draft/deai_checked/atomized/scheduled/published/tracked) and/or business tag.',
  inputSchema: listInput,
  async handler(input) {
    const all = await listPieces();
    const filtered = all.filter(
      (p) =>
        (input.state ? p.state === input.state : true) &&
        (input.business ? p.business === input.business : true),
    );
    return { pieces: filtered };
  },
};

const getInput = z.object({ id: idSchema });

const getTool: McpTool<typeof getInput> = {
  name: 'taskpilot_get_content_piece',
  description:
    'Fetch a single content piece by id, including its draft markdown and every per-channel derivative.',
  inputSchema: getInput,
  async handler(input) {
    const piece = await readPiece(input.id);
    if (!piece) return { ok: false, reason: 'not_found' };
    return { ok: true, piece };
  },
};

const updateInput = z.object({
  id: idSchema,
  title: z.string().min(1).max(500).optional(),
  business: businessTagSchema.nullable().optional(),
  draft_markdown: z.string().max(200_000).optional(),
  hypothesis: z.string().max(2_000).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});

const updateTool: McpTool<typeof updateInput> = {
  name: 'taskpilot_update_content_piece',
  description:
    'Patch editable fields on a content piece. Only the fields you pass are touched; everything else stays. Use this to push a revised draft, change the business tag, or attach a marketing hypothesis.',
  inputSchema: updateInput,
  async handler(input) {
    const { id, ...patch } = input;
    const piece = await updatePiece(id, patch);
    if (!piece) return { ok: false, reason: 'not_found' };
    return { ok: true, piece };
  },
};

const advanceInput = z.object({
  id: idSchema,
  to: z.enum(CONTENT_STATES),
});

const advanceTool: McpTool<typeof advanceInput> = {
  name: 'taskpilot_advance_content_piece',
  description:
    'Advance a piece through the state machine: draft → deai_checked → atomized → scheduled → published → tracked. Any state can be sent back to `draft` (rewind). Other illegal transitions return ok=false with reason=invalid_transition.',
  inputSchema: advanceInput,
  async handler(input) {
    try {
      const piece = await advanceState(input.id, input.to);
      if (!piece) return { ok: false, reason: 'not_found' };
      return { ok: true, piece };
    } catch (err) {
      if (err instanceof ContentStateError) {
        return { ok: false, reason: 'invalid_transition', message: err.message };
      }
      throw err;
    }
  },
};

const setDerivativeInput = z.object({
  id: idSchema,
  channel: z.enum(CONTENT_CHANNELS),
  markdown: z.string().max(50_000),
  scheduled_at: z.string().datetime().optional(),
  published_at: z.string().datetime().optional(),
  published_url: z.string().url().max(2_048).optional(),
});

const setDerivativeTool: McpTool<typeof setDerivativeInput> = {
  name: 'taskpilot_set_content_derivative',
  description:
    'Add or replace a per-channel derivative (linkedin / reddit / newsletter / twitter / blog) for a piece. Use after running the atomizing skill to push each channel-tailored copy back into the piece. Optionally include a scheduled_at, published_at, or published_url.',
  inputSchema: setDerivativeInput,
  async handler(input) {
    const piece = await setDerivative(input.id, {
      channel: input.channel,
      markdown: input.markdown,
      scheduled_at: input.scheduled_at ?? null,
      published_at: input.published_at ?? null,
      published_url: input.published_url ?? null,
    });
    if (!piece) return { ok: false, reason: 'not_found' };
    return { ok: true, piece };
  },
};

export const contentTools: McpTool[] = [
  createTool as unknown as McpTool,
  listTool as unknown as McpTool,
  getTool as unknown as McpTool,
  updateTool as unknown as McpTool,
  advanceTool as unknown as McpTool,
  setDerivativeTool as unknown as McpTool,
];
