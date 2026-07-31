/**
 * Tests for the publishing pipeline engine — CRUD, state machine, derivatives,
 * and the file-backed storage layout.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

import {
  advanceState,
  canTransition,
  ContentStateError,
  createPiece,
  CONTENT_DIR,
  deletePiece,
  listPieces,
  readPiece,
  setDerivative,
  updatePiece,
} from '@/main/content';

function clearContentDir(): void {
  try {
    fs.rmSync(CONTENT_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('content/engine', () => {
  beforeEach(clearContentDir);
  afterEach(clearContentDir);

  it('content dir lives under TASKPILOT_HOME', () => {
    expect(CONTENT_DIR.startsWith(PATHS.TASKPILOT_HOME)).toBe(true);
  });

  it('canTransition encodes the forward graph + draft rewind', () => {
    expect(canTransition('draft', 'deai_checked')).toBe(true);
    expect(canTransition('deai_checked', 'atomized')).toBe(true);
    expect(canTransition('atomized', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'published')).toBe(true);
    expect(canTransition('published', 'tracked')).toBe(true);
    // Rewind always allowed
    expect(canTransition('scheduled', 'draft')).toBe(true);
    expect(canTransition('published', 'draft')).toBe(true);
    // Illegal forward jumps
    expect(canTransition('draft', 'published')).toBe(false);
    expect(canTransition('draft', 'atomized')).toBe(false);
    expect(canTransition('tracked', 'published')).toBe(false);
  });

  it('createPiece persists the piece and the sidecar markdown', async () => {
    const piece = await createPiece({
      title: 'My first piece',
      business: 'leal-health',
      draft_markdown: '# hello\n\nbody',
    });
    expect(piece.state).toBe('draft');
    expect(piece.business).toBe('leal-health');
    expect(piece.id.startsWith('c_')).toBe(true);

    const pieceJson = path.join(CONTENT_DIR, piece.id, 'piece.json');
    const draftMd = path.join(CONTENT_DIR, piece.id, 'draft.md');
    expect(fs.existsSync(pieceJson)).toBe(true);
    expect(fs.existsSync(draftMd)).toBe(true);
    expect(fs.readFileSync(draftMd, 'utf8')).toBe('# hello\n\nbody');
  });

  it('readPiece returns null for missing ids', async () => {
    expect(await readPiece('c_no-such-piece')).toBeNull();
  });

  it('listPieces returns newest-first by updated_at', async () => {
    const a = await createPiece({ title: 'a' });
    // Force monotonic ordering — updatePiece sets updated_at = nowIso().
    await new Promise((r) => setTimeout(r, 5));
    const b = await createPiece({ title: 'b' });
    const list = await listPieces();
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
  });

  it('updatePiece merges and persists', async () => {
    const piece = await createPiece({ title: 'pre' });
    const updated = await updatePiece(piece.id, {
      title: 'post',
      notes: 'a note',
    });
    expect(updated?.title).toBe('post');
    expect(updated?.notes).toBe('a note');
    expect(updated?.draft_markdown).toBe('');
    const reread = await readPiece(piece.id);
    expect(reread?.title).toBe('post');
  });

  it('advanceState walks the legal path; illegal jumps throw', async () => {
    const piece = await createPiece({ title: 'flow' });
    const next1 = await advanceState(piece.id, 'deai_checked');
    expect(next1?.state).toBe('deai_checked');
    const next2 = await advanceState(piece.id, 'atomized');
    expect(next2?.state).toBe('atomized');
    await expect(
      advanceState(piece.id, 'tracked'),
    ).rejects.toBeInstanceOf(ContentStateError);
  });

  it('advanceState allows rewind to draft from anywhere', async () => {
    const piece = await createPiece({ title: 'rewind' });
    await advanceState(piece.id, 'deai_checked');
    await advanceState(piece.id, 'atomized');
    await advanceState(piece.id, 'scheduled');
    const rewound = await advanceState(piece.id, 'draft');
    expect(rewound?.state).toBe('draft');
  });

  it('setDerivative adds and replaces by channel', async () => {
    const piece = await createPiece({ title: 'derivs' });
    const after1 = await setDerivative(piece.id, {
      channel: 'linkedin',
      markdown: 'first linkedin',
      scheduled_at: null,
      published_at: null,
      published_url: null,
    });
    expect(after1?.derivatives).toHaveLength(1);
    const after2 = await setDerivative(piece.id, {
      channel: 'linkedin',
      markdown: 'replaced',
      scheduled_at: null,
      published_at: null,
      published_url: null,
    });
    expect(after2?.derivatives).toHaveLength(1);
    expect(after2?.derivatives[0]?.markdown).toBe('replaced');
    const after3 = await setDerivative(piece.id, {
      channel: 'reddit',
      markdown: 'reddit copy',
      scheduled_at: null,
      published_at: null,
      published_url: null,
    });
    expect(after3?.derivatives).toHaveLength(2);
    // Sidecar markdown lands on disk.
    expect(
      fs.existsSync(
        path.join(CONTENT_DIR, piece.id, 'derivatives', 'reddit.md'),
      ),
    ).toBe(true);
  });

  it('deletePiece wipes the folder', async () => {
    const piece = await createPiece({ title: 'gone' });
    const dir = path.join(CONTENT_DIR, piece.id);
    expect(fs.existsSync(dir)).toBe(true);
    const removed = await deletePiece(piece.id);
    expect(removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
