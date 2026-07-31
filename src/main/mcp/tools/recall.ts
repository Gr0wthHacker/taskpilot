/**
 * MCP recall tool — cross-session memory lookup.
 *
 * "Wait, didn't I figure this out two weeks ago?" The tool runs a single
 * query across the most useful long-term memory surfaces and returns ranked
 * hits with enough context to skip the redo:
 *
 *   • FTS5 search over decisions, executions, tasks, attachments, memory
 *   • Conversation digests + titles (via the conversations listing)
 *   • Recent per-business status updates (the cross-session feed I just shipped)
 *
 * One MCP call returns the merged set. The model decides whether to act on
 * the prior answer or proceed with a fresh investigation.
 */

import { z } from 'zod';

import { listConversations } from '@/main/db/repositories/conversations';
import { listBusinesses, readUpdates } from '@/main/businesses';
import { searchGraveyard } from '@/main/graveyard';
import { search } from '@/main/search';
import { businessTagSchema } from '@/main/businesses/loader';

import type { McpTool } from '../tool-registry';

const recallInput = z.object({
  query: z.string().min(2).max(500),
  business: businessTagSchema.optional(),
  limit: z.number().int().min(1).max(50).default(10).optional(),
  include_conversations: z.boolean().default(true).optional(),
  include_status_updates: z.boolean().default(true).optional(),
});

interface RecallHit {
  source:
    | 'decision'
    | 'execution'
    | 'task'
    | 'attachment'
    | 'memory'
    | 'conversation'
    | 'status_update'
    | 'graveyard';
  title: string;
  snippet: string;
  /** ISO timestamp when known, else null. */
  at: string | null;
  /**
   * Loud flag for the model: this matches something Jack already rejected.
   * Present only on `source === 'graveyard'` hits.
   */
  rejected?: true;
  /** Optional pointer back to the originating entity. */
  ref?: {
    task_id?: string;
    conversation_id?: string;
    business?: string;
    entity_id?: string;
    graveyard_kind?: string;
  };
}

function clampSnippet(text: string, max = 280): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function pushUnique(out: RecallHit[], hit: RecallHit, seen: Set<string>): void {
  const key = `${hit.source}:${hit.title.toLowerCase()}:${hit.snippet.slice(0, 80).toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(hit);
}

const recallTool: McpTool<typeof recallInput> = {
  name: 'taskpilot_recall',
  description:
    'Cross-session memory lookup. Searches decisions, execution results, tasks, attachments, memory, Claude Code conversation digests, per-business status updates, AND the decision graveyard (kills/abandons) for prior answers to the question. Use this BEFORE re-deriving or re-researching something — if you previously figured it out, the prior answer comes back ranked with timestamps and pointers. Graveyard hits carry `rejected: true` — DO NOT propose those again unless Jack explicitly reopens the topic. Pass `business` to scope to one (e.g. "leal-health"). Defaults to top 10 hits across all surfaces.',
  inputSchema: recallInput,
  async handler(input) {
    const limit = input.limit ?? 10;
    const includeConv = input.include_conversations ?? true;
    const includeUpdates = input.include_status_updates ?? true;
    const out: RecallHit[] = [];
    const seen = new Set<string>();

    // FTS5 across the indexed entities — covers most of the long-term layer.
    const ftsHits = search(input.query, {
      limit: Math.min(limit * 2, 30),
      types: ['decision', 'execution', 'task', 'attachment', 'memory'],
    });
    for (const r of ftsHits) {
      pushUnique(
        out,
        {
          source: r.entity_type as RecallHit['source'],
          title: r.title || `(${r.entity_type})`,
          snippet: clampSnippet(stripMarks(r.snippet) || r.title),
          at: null,
          ref: {
            entity_id: r.entity_id,
            ...(r.task_id ? { task_id: r.task_id } : {}),
          },
        },
        seen,
      );
    }

    // Conversation digests — LIKE-scan the catalog. Cheap; the search() call
    // doesn't index conversations directly.
    if (includeConv) {
      const conversations = listConversations({
        search: input.query,
        limit: Math.min(limit * 2, 30),
      });
      for (const c of conversations) {
        pushUnique(
          out,
          {
            source: 'conversation',
            title: c.title ?? `(conversation ${c.id})`,
            snippet: clampSnippet(c.digest ?? c.topics.slice(0, 6).join(', ')),
            at: c.ended_at,
            ref: { conversation_id: c.id },
          },
          seen,
        );
      }
    }

    // Decision graveyard — surface hits LOUDLY so the model doesn't re-propose
    // an idea Jack already killed. The `rejected: true` flag is the visible
    // signal; the tool description tells the model what to do about it.
    {
      const graveHits = await searchGraveyard({
        query: input.query,
        ...(input.business !== undefined ? { business: input.business } : {}),
        limit,
      });
      for (const g of graveHits) {
        const refBlock: NonNullable<RecallHit['ref']> = { graveyard_kind: g.kind };
        if (g.business) refBlock.business = g.business;
        pushUnique(
          out,
          {
            source: 'graveyard',
            title: `[${g.kind.toUpperCase()}] ${g.subject}`,
            snippet: clampSnippet(
              g.reason
                ? `${g.reason}`
                : `Marked ${g.kind} on ${g.at.slice(0, 10)}.`,
            ),
            at: g.at,
            rejected: true,
            ref: refBlock,
          },
          seen,
        );
      }
    }

    // Per-business status updates. We scan the businesses listed in
    // projects.json (or just the one if `business` was supplied) and do a
    // case-insensitive substring filter — the feed is small enough that
    // hitting every business on each call is fine.
    if (includeUpdates) {
      const tags = input.business
        ? [input.business]
        : listBusinesses().map((b) => b.tag);
      const needle = input.query.toLowerCase();
      for (const tag of tags) {
        const updates = await readUpdates(tag, 40);
        for (const u of updates) {
          const haystack =
            `${u.headline} ${u.what_changed ?? ''} ${u.source ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
          pushUnique(
            out,
            {
              source: 'status_update',
              title: u.headline,
              snippet: clampSnippet(u.what_changed ?? u.source ?? u.headline),
              at: u.at,
              ref: { business: tag },
            },
            seen,
          );
        }
      }
    }

    return {
      query: input.query,
      ...(input.business !== undefined ? { business: input.business } : {}),
      total: out.length,
      hits: out.slice(0, limit),
    };
  },
};

/**
 * Strip the `<mark>` / `</mark>` wrappers FTS5 inserts via the `snippet()`
 * helper so the rendered MCP output reads cleanly in Claude's UI.
 */
function stripMarks(s: string): string {
  return s.replace(/<\/?mark>/g, '');
}

export const recallTools: McpTool[] = [recallTool as unknown as McpTool];
