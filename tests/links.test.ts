/**
 * Task-links module tests.
 *
 * Coverage:
 *   - read/write of `task.context.links`
 *   - patchTaskLinks dedupes, strips self-references, and clears empties
 *   - addBlock / removeBlock idempotent + reject self / unknown referent
 *   - findBlockedBy walks every task's `blocks` array (reverse lookup)
 *   - cleanupLinksForDeletedTask runs on delete and scrubs references
 *     across blocks / related / duplicate_of
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import {
  addBlock,
  cleanupLinksForDeletedTask,
  findBlockedBy,
  getTaskLinks,
  patchTaskLinks,
  readTaskLinks,
  removeBlock,
} from '@/main/links';
import {
  createTask,
  deleteTask,
  getTask,
} from '@/main/db/repositories/tasks';

function seed(title: string): string {
  return createTask({ title }).id;
}

describe('links', () => {
  useMockedDb();

  describe('readTaskLinks', () => {
    it('returns empty links when nothing is stored', () => {
      const id = seed('A');
      const task = getTask(id);
      const links = readTaskLinks(task);
      expect(links).toEqual({ blocks: [], related: [], duplicate_of: null });
    });

    it('parses a stored block', () => {
      const id = seed('A');
      const other = seed('B');
      patchTaskLinks(id, { blocks: [other] });
      const refreshed = getTask(id);
      const links = readTaskLinks(refreshed);
      expect(links.blocks).toEqual([other]);
    });

    it('returns empty links for malformed context', () => {
      const id = seed('A');
      const task = getTask(id);
      expect(task).not.toBeNull();
      // Force a malformed links blob via direct context write.
      const malformed = { links: { blocks: 'not-an-array' } } as unknown as
        Record<string, unknown>;
      // We can't import updateTask in this scope cleanly; readTaskLinks
      // is fed the in-memory shape directly.
      const links = readTaskLinks({
        ...(task as NonNullable<typeof task>),
        context: malformed,
      });
      expect(links).toEqual({ blocks: [], related: [], duplicate_of: null });
    });
  });

  describe('patchTaskLinks', () => {
    it('persists each relation independently', () => {
      const id = seed('A');
      const b = seed('B');
      const c = seed('C');
      const d = seed('D');
      patchTaskLinks(id, { blocks: [b], related: [c], duplicate_of: d });
      const view = getTaskLinks(id);
      expect(view?.links.blocks).toEqual([b]);
      expect(view?.links.related).toEqual([c]);
      expect(view?.links.duplicate_of).toBe(d);
    });

    it('dedupes incoming ids and strips self-references', () => {
      const id = seed('A');
      const b = seed('B');
      patchTaskLinks(id, { blocks: [b, b, id] });
      const view = getTaskLinks(id);
      expect(view?.links.blocks).toEqual([b]);
    });

    it('clears duplicate_of with null', () => {
      const id = seed('A');
      const b = seed('B');
      patchTaskLinks(id, { duplicate_of: b });
      expect(getTaskLinks(id)?.links.duplicate_of).toBe(b);
      patchTaskLinks(id, { duplicate_of: null });
      expect(getTaskLinks(id)?.links.duplicate_of).toBeNull();
    });

    it('refuses to set duplicate_of to self', () => {
      const id = seed('A');
      patchTaskLinks(id, { duplicate_of: id });
      expect(getTaskLinks(id)?.links.duplicate_of).toBeNull();
    });

    it('returns null for missing task', () => {
      expect(patchTaskLinks('nope1234', { blocks: [] })).toBeNull();
    });
  });

  describe('addBlock / removeBlock', () => {
    it('addBlock is idempotent', () => {
      const a = seed('A');
      const b = seed('B');
      addBlock(a, b);
      addBlock(a, b);
      expect(getTaskLinks(a)?.links.blocks).toEqual([b]);
    });

    it('addBlock refuses self', () => {
      const a = seed('A');
      expect(addBlock(a, a)).toBeNull();
    });

    it('addBlock refuses unknown target', () => {
      const a = seed('A');
      expect(addBlock(a, 'ghost1234')).toBeNull();
    });

    it('removeBlock is idempotent on missing edge', () => {
      const a = seed('A');
      const b = seed('B');
      const result = removeBlock(a, b);
      expect(result).toEqual({ blocks: [], related: [], duplicate_of: null });
    });

    it('removeBlock strips a present edge', () => {
      const a = seed('A');
      const b = seed('B');
      addBlock(a, b);
      removeBlock(a, b);
      expect(getTaskLinks(a)?.links.blocks).toEqual([]);
    });
  });

  describe('findBlockedBy', () => {
    it('returns ids that have us in their blocks array', () => {
      const a = seed('A');
      const b = seed('B');
      const c = seed('C');
      addBlock(b, a);
      addBlock(c, a);
      const blockers = findBlockedBy(a);
      expect(blockers.sort()).toEqual([b, c].sort());
    });

    it('returns empty list when nothing blocks us', () => {
      const a = seed('A');
      expect(findBlockedBy(a)).toEqual([]);
    });
  });

  describe('cleanupLinksForDeletedTask', () => {
    it('scrubs blocks / related / duplicate_of references when called directly', () => {
      const target = seed('Target');
      const blocker = seed('Blocker');
      const related = seed('Related');
      const dup = seed('Dup');

      addBlock(blocker, target);
      patchTaskLinks(related, { related: [target] });
      patchTaskLinks(dup, { duplicate_of: target });

      const touched = cleanupLinksForDeletedTask(target);
      expect(touched).toBe(3);
      expect(getTaskLinks(blocker)?.links.blocks).toEqual([]);
      expect(getTaskLinks(related)?.links.related).toEqual([]);
      expect(getTaskLinks(dup)?.links.duplicate_of).toBeNull();
    });

    it('fires automatically on deleteTask via the pre-delete hook', async () => {
      // Side-effect import wires the hook into the tasks repo.
      await import('@/main/links');

      const target = seed('Target');
      const blocker = seed('Blocker');
      addBlock(blocker, target);

      expect(getTaskLinks(blocker)?.links.blocks).toEqual([target]);
      deleteTask(target);
      expect(getTaskLinks(blocker)?.links.blocks).toEqual([]);
    });

    it('is a no-op for tasks without dangling references', () => {
      const a = seed('A');
      const b = seed('B');
      // No links between them.
      const touched = cleanupLinksForDeletedTask(a);
      expect(touched).toBe(0);
      // B still exists untouched.
      expect(getTask(b)).not.toBeNull();
    });
  });
});
