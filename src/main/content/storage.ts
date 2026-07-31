/**
 * File-backed storage for the publishing pipeline.
 *
 * Each piece is one folder under `~/.taskpilot/content/<id>/`:
 *
 *   piece.json              the structured ContentPiece
 *   draft.md                duplicated draft markdown for grep / external editor
 *   derivatives/<channel>.md  per-channel atomized markdown (when atomized)
 *
 * `piece.json` is the source of truth — the `.md` sidecars are caches kept in
 * sync on every write. Deleting them is safe (they re-render on next save).
 *
 * No DB schema migration; the layout is intentionally inspectable so the
 * user can `git init` the dir or sync it across machines without TaskPilot
 * running.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';

import type { ContentDerivative, ContentPiece } from './types';

export const CONTENT_DIR = path.join(TASKPILOT_HOME, 'content');

const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function assertId(id: string): void {
  if (!ID_REGEX.test(id)) {
    throw new Error(`Invalid content id: ${JSON.stringify(id)}`);
  }
}

function pieceDir(id: string): string {
  assertId(id);
  return path.join(CONTENT_DIR, id);
}

function piecePath(id: string): string {
  return path.join(pieceDir(id), 'piece.json');
}

function draftPath(id: string): string {
  return path.join(pieceDir(id), 'draft.md');
}

function derivativePath(id: string, channel: string): string {
  if (!/^[a-z0-9_-]{1,32}$/.test(channel)) {
    throw new Error(`Invalid channel: ${channel}`);
  }
  return path.join(pieceDir(id), 'derivatives', `${channel}.md`);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/** Write a piece to disk, replacing every sidecar. Used for create + update. */
export async function writePiece(piece: ContentPiece): Promise<void> {
  await fs.mkdir(pieceDir(piece.id), { recursive: true });
  await fs.writeFile(
    piecePath(piece.id),
    `${JSON.stringify(piece, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(draftPath(piece.id), piece.draft_markdown, 'utf8');
  if (piece.derivatives.length > 0) {
    await fs.mkdir(path.join(pieceDir(piece.id), 'derivatives'), {
      recursive: true,
    });
    for (const d of piece.derivatives) {
      await fs.writeFile(derivativePath(piece.id, d.channel), d.markdown, 'utf8');
    }
  }
}

/** Read a piece by id, or null when it doesn't exist. */
export async function readPiece(id: string): Promise<ContentPiece | null> {
  try {
    const raw = await fs.readFile(piecePath(id), 'utf8');
    const parsed = JSON.parse(raw) as ContentPiece;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** List every piece on disk. Returns newest-first by `updated_at`. */
export async function listPieces(): Promise<ContentPiece[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(CONTENT_DIR);
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const out: ContentPiece[] = [];
  for (const name of entries) {
    if (!ID_REGEX.test(name)) continue;
    const piece = await readPiece(name).catch(() => null);
    if (piece) out.push(piece);
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Delete a piece + all sidecars. Returns true if anything was removed. */
export async function deletePiece(id: string): Promise<boolean> {
  try {
    await fs.rm(pieceDir(id), { recursive: true, force: true });
    return true;
  } catch (err: unknown) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Merge an updated derivative into a piece in-place, returning the new
 * derivatives array. Adds when the channel is new, replaces when present.
 */
export function mergeDerivative(
  current: ContentDerivative[],
  next: ContentDerivative,
): ContentDerivative[] {
  const out = current.filter((d) => d.channel !== next.channel);
  out.push(next);
  return out;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
