/**
 * Tests for `safeJoin` + `isValidTaskId` in `@/main/io/paths`.
 *
 * These are the primary defenses against path-traversal attacks where a
 * malicious task id (or other externally supplied path segment) could escape
 * the configured I/O root.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isValidTaskId, safeJoin } from '@/main/io/paths';

describe('isValidTaskId', () => {
  it('accepts canonical nanoid-like ids', () => {
    expect(isValidTaskId('abc123')).toBe(true);
    expect(isValidTaskId('A_b-c-12_34')).toBe(true);
    expect(isValidTaskId('a'.repeat(64))).toBe(true);
  });

  it('rejects ids with traversal tokens', () => {
    expect(isValidTaskId('..')).toBe(false);
    expect(isValidTaskId('../../etc/passwd')).toBe(false);
    expect(isValidTaskId('foo/bar')).toBe(false);
    expect(isValidTaskId('foo\\bar')).toBe(false);
  });

  it('rejects ids with reserved characters', () => {
    expect(isValidTaskId('foo bar')).toBe(false);
    expect(isValidTaskId('foo;bar')).toBe(false);
    expect(isValidTaskId('foo:bar')).toBe(false);
    expect(isValidTaskId('foo.bar')).toBe(false);
    expect(isValidTaskId('foo"bar')).toBe(false);
    expect(isValidTaskId("foo'bar")).toBe(false);
  });

  it('rejects empty and oversize ids', () => {
    expect(isValidTaskId('')).toBe(false);
    expect(isValidTaskId('a'.repeat(65))).toBe(false);
  });

  it('rejects non-string inputs gracefully', () => {
    expect(isValidTaskId(123 as unknown as string)).toBe(false);
    expect(isValidTaskId(null as unknown as string)).toBe(false);
    expect(isValidTaskId(undefined as unknown as string)).toBe(false);
  });
});

describe('safeJoin', () => {
  const root = path.resolve('/tmp/taskpilot-io');

  it('joins segments that stay inside the root', () => {
    const joined = safeJoin(root, 'derive', 'abc123.json');
    expect(joined).toBe(path.resolve(root, 'derive', 'abc123.json'));
  });

  it('allows the root itself to be the result (zero segments)', () => {
    expect(safeJoin(root)).toBe(path.resolve(root));
  });

  it('throws on `..` traversal that escapes the root', () => {
    expect(() => safeJoin(root, '..', 'tokens.json')).toThrow(/Path escape/);
    expect(() => safeJoin(root, '..', '..', 'etc', 'passwd')).toThrow(
      /Path escape/,
    );
  });

  it('throws when segments resolve outside via absolute path', () => {
    expect(() => safeJoin(root, '/etc/passwd')).toThrow(/Path escape/);
  });

  it('throws when the resolved path is a sibling, not a descendant', () => {
    // `/tmp/taskpilot-io-other` is NOT inside `/tmp/taskpilot-io`, even though
    // the string starts the same way. Tests defend against a naive
    // `startsWith` check.
    expect(() => safeJoin(root, '../taskpilot-io-other')).toThrow(/Path escape/);
  });

  it('accepts nested deep paths inside the root', () => {
    const joined = safeJoin(root, 'results', 'abc', 'output', 'file.txt');
    expect(joined).toBe(
      path.resolve(root, 'results', 'abc', 'output', 'file.txt'),
    );
  });
});
