/**
 * Public facade for the content pipeline.
 *
 * Wraps the storage layer with the domain operations the HTTP/MCP/UI layers
 * actually need: create, update, advance state, set a derivative, list/get,
 * delete. Pure-async — every write hits disk and the in-memory cache is the
 * filesystem itself.
 */

import { nanoid } from 'nanoid';

import { recordGraveyardEntry } from '@/main/graveyard';

import {
  CONTENT_DIR,
  deletePiece,
  listPieces,
  mergeDerivative,
  readPiece,
  writePiece,
} from './storage';
import {
  canTransition,
  CONTENT_CHANNELS,
  type ContentChannel,
  type ContentDerivative,
  type ContentPiece,
  type ContentState,
} from './types';

export {
  canTransition,
  CONTENT_CHANNELS,
  CONTENT_DIR,
  deletePiece,
  listPieces,
  readPiece,
};
export type {
  ContentChannel,
  ContentDerivative,
  ContentPiece,
  ContentState,
};

export interface CreatePieceInput {
  title: string;
  business?: string | null;
  draft_markdown?: string;
  hypothesis?: string | null;
  notes?: string | null;
  tags?: string[];
}

export interface UpdatePieceInput {
  title?: string;
  business?: string | null;
  draft_markdown?: string;
  hypothesis?: string | null;
  notes?: string | null;
  tags?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Create a fresh piece in `draft` state. Returns the persisted record. */
export async function createPiece(input: CreatePieceInput): Promise<ContentPiece> {
  const now = nowIso();
  const piece: ContentPiece = {
    id: `c_${nanoid(10)}`,
    title: input.title,
    business: input.business ?? null,
    state: 'draft',
    draft_markdown: input.draft_markdown ?? '',
    derivatives: [],
    hypothesis: input.hypothesis ?? null,
    notes: input.notes ?? null,
    tags: input.tags ?? [],
    created_at: now,
    updated_at: now,
  };
  await writePiece(piece);
  return piece;
}

/** Patch any subset of editable fields. Returns null when no piece exists. */
export async function updatePiece(
  id: string,
  patch: UpdatePieceInput,
): Promise<ContentPiece | null> {
  const current = await readPiece(id);
  if (!current) return null;
  const next: ContentPiece = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.business !== undefined ? { business: patch.business } : {}),
    ...(patch.draft_markdown !== undefined
      ? { draft_markdown: patch.draft_markdown }
      : {}),
    ...(patch.hypothesis !== undefined ? { hypothesis: patch.hypothesis } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    updated_at: nowIso(),
  };
  await writePiece(next);
  return next;
}

export class ContentStateError extends Error {
  readonly code = 'invalid_transition';
  constructor(from: ContentState, to: ContentState) {
    super(`Illegal transition from "${from}" to "${to}"`);
  }
}

/**
 * Advance (or rewind to draft) the piece's state. Validates the transition
 * via {@link canTransition}; throws {@link ContentStateError} when illegal.
 */
export async function advanceState(
  id: string,
  to: ContentState,
): Promise<ContentPiece | null> {
  const current = await readPiece(id);
  if (!current) return null;
  if (!canTransition(current.state, to)) {
    throw new ContentStateError(current.state, to);
  }
  const next: ContentPiece = {
    ...current,
    state: to,
    updated_at: nowIso(),
  };
  await writePiece(next);
  // Side effect: when a piece is sent to `skipped`, log it in the decision
  // graveyard so recall surfaces "you decided not to ship this" if the
  // same idea comes up again. Best-effort.
  if (to === 'skipped') {
    try {
      await recordGraveyardEntry({
        at: next.updated_at,
        kind: 'skipped',
        subject: `Content piece: ${current.title}`,
        ...(current.business ? { business: current.business } : {}),
        source: `content:${current.id}`,
      });
    } catch {
      /* graveyard write is best-effort */
    }
  }
  return next;
}

/**
 * Set or replace a per-channel derivative. Creates the derivatives array
 * entry when the channel is new, replaces it when present. Returns null on
 * a missing piece.
 */
export async function setDerivative(
  id: string,
  derivative: ContentDerivative,
): Promise<ContentPiece | null> {
  const current = await readPiece(id);
  if (!current) return null;
  const merged = mergeDerivative(current.derivatives, derivative);
  const next: ContentPiece = {
    ...current,
    derivatives: merged,
    updated_at: nowIso(),
  };
  await writePiece(next);
  return next;
}
