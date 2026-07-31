/**
 * Memory subsystem — IO bridge.
 *
 * Mirrors the task derive/derived pattern:
 *  - `writeEnrichRequest(memory)` drops a JSON file under
 *    `~/.taskpilot/io/memory_enrich/<id>.json` for the runner to pick up.
 *  - `ingestEnrichResponse(response)` applies a runner's reply onto the
 *    memory item, creates suggested links, and flips status to `enriched`
 *    (or `failed`).
 *
 * Writes are atomic (tmp-file + rename) so a crashed runner mid-write can't
 * leave a half-parsed JSON for the watcher.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { IO_MEMORY_ENRICH } from '@/shared/constants';
import type {
  MemoryEnrichRequest,
  MemoryEnrichResponse,
} from '@/shared/io-schemas';
import { ioEvents } from '@/main/io/events';

import {
  addMemoryLink,
  getMemory,
  updateMemory,
} from './repository';

/**
 * Atomic JSON write — temp file + fsync + rename. Same as the protocol layer
 * for tasks. Avoids partial-file reads when the watcher races a writer.
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Instructions block embedded in every enrich request. The runner reads this
 * verbatim — it explains what fields the response should populate. Keeping
 * it inline (rather than a doc reference) means the runner doesn't need to
 * fetch anything else before doing the work.
 */
function buildInstructions(): string {
  return [
    'You are enriching a memory item that the user just captured.',
    '',
    'Produce a concise enrichment payload as a `memory_enriched/<id>.json`',
    "file with the response schema's shape:",
    '',
    '- `summary`: 1-2 sentences that capture what this is about. Plain prose,',
    '  no preamble. If the content is a URL fetch, summarize the page, not',
    '  the URL.',
    '- `tags`: 3-8 lowercase, hyphenated tags. Prefer specific over generic',
    "  (e.g. `b2b-saas-pricing` over `business`). No personal-name tags.",
    '- `entities`: an object grouping people / organizations / urls / topics',
    '  that appear in the content. Optional but useful for the graph.',
    '- `links`: up to 16 suggested edges to related memory items or tasks.',
    '  Score 0-1; use 1.0 only for explicit references.',
    '- `status`: "enriched" on success, "failed" with an `error` string when',
    '  the content is unreadable.',
    '',
    'Set status to enriched even when tags or entities are empty — partial',
    'enrichment is fine. Only "failed" if you literally cannot summarize.',
  ].join('\n');
}

export async function writeEnrichRequest(memoryId: string): Promise<string> {
  const item = getMemory(memoryId);
  if (!item) throw new Error(`memory item not found: ${memoryId}`);

  const request: MemoryEnrichRequest = {
    request_type: 'memory_enrich',
    memory_id: item.id,
    kind: item.kind,
    title: item.title,
    source_url: item.source_url,
    source_path: item.source_path,
    raw_content: item.raw_content,
    created_at: item.created_at,
    instructions: buildInstructions(),
  };

  const target = path.join(IO_MEMORY_ENRICH, `${item.id}.json`);
  await writeJsonAtomic(target, request);
  return target;
}

/**
 * Apply a runner's enrichment response onto the memory item. Idempotent —
 * re-running with the same payload is safe (no link duplicates thanks to
 * the unique index on `memory_links`).
 */
export function ingestEnrichResponse(
  response: MemoryEnrichResponse,
): { applied: boolean; reason?: string } {
  const item = getMemory(response.memory_id);
  if (!item) return { applied: false, reason: 'memory item not found' };

  if (response.status === 'failed') {
    updateMemory(item.id, {
      status: 'failed',
      enrichment_error: response.error ?? 'enrichment failed (no detail)',
    });
    ioEvents.emit('memory_enriched', {
      memory_id: item.id,
      status: 'failed',
    });
    return { applied: true };
  }

  updateMemory(item.id, {
    status: 'enriched',
    summary: response.summary ?? null,
    tags: response.tags ?? [],
    entities: response.entities ?? null,
    enrichment_error: null,
  });

  // Persist the suggested links. Each is bounded to 16 by the schema.
  if (response.links) {
    for (const link of response.links) {
      try {
        addMemoryLink({
          source_id: item.id,
          target_kind: link.target_kind,
          target_id: link.target_id,
          link_kind: link.link_kind,
          score: link.score,
        });
      } catch {
        // Best-effort — a bad target_id shouldn't kill the whole batch.
      }
    }
  }

  ioEvents.emit('memory_enriched', { memory_id: item.id, status: 'enriched' });
  return { applied: true };
}
