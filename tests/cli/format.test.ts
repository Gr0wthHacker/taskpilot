/**
 * CLI format + parsing helper tests.
 *
 * Coverage:
 *   - `parseDurationMinutes` accepts bare minutes, single units, compound.
 *   - `printTable` writes a stable table to stdout.
 */

import { describe, expect, it, vi } from 'vitest';

import { parseDurationMinutes } from '@/cli/commands/cal';
import { printTable, type TableColumn } from '@/cli/format';

describe('parseDurationMinutes', () => {
  it('parses bare minutes', () => {
    expect(parseDurationMinutes('90')).toBe(90);
    expect(parseDurationMinutes('0')).toBe(0);
    expect(parseDurationMinutes('1')).toBe(1);
  });

  it('parses single-unit minute strings', () => {
    expect(parseDurationMinutes('60m')).toBe(60);
    expect(parseDurationMinutes('15min')).toBe(15);
    expect(parseDurationMinutes('45 minutes')).toBe(45);
  });

  it('parses single-unit hour strings', () => {
    expect(parseDurationMinutes('1h')).toBe(60);
    expect(parseDurationMinutes('2h')).toBe(120);
    expect(parseDurationMinutes('3hr')).toBe(180);
    expect(parseDurationMinutes('2 hours')).toBe(120);
  });

  it('parses compound h+m', () => {
    expect(parseDurationMinutes('1h30m')).toBe(90);
    expect(parseDurationMinutes('2h15m')).toBe(135);
    expect(parseDurationMinutes('1h0m')).toBe(60);
  });

  it('is case-insensitive', () => {
    expect(parseDurationMinutes('1H30M')).toBe(90);
    expect(parseDurationMinutes('45MIN')).toBe(45);
  });

  it('throws on empty input', () => {
    expect(() => parseDurationMinutes('')).toThrow();
    expect(() => parseDurationMinutes('   ')).toThrow();
  });

  it('throws on unparseable strings', () => {
    expect(() => parseDurationMinutes('soon')).toThrow();
    expect(() => parseDurationMinutes('1y')).toThrow();
  });
});

describe('printTable', () => {
  it('writes a header line and one row per item', () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Buffer): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return true;
      }) as typeof process.stdout.write);

    interface Row {
      id: string;
      title: string;
    }
    const rows: Row[] = [
      { id: 'a', title: 'first' },
      { id: 'b', title: 'second' },
    ];
    const cols: TableColumn<Row>[] = [
      { header: 'ID', get: (r) => r.id },
      { header: 'TITLE', get: (r) => r.title },
    ];

    printTable(rows, cols);
    spy.mockRestore();

    const out = writes.join('');
    expect(out).toContain('ID');
    expect(out).toContain('TITLE');
    expect(out).toContain('first');
    expect(out).toContain('second');
    // header + sep + 2 rows
    expect(out.split('\n').filter((l) => l.length > 0)).toHaveLength(4);
  });

  it('reports "(no rows)" for an empty list', () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Buffer): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return true;
      }) as typeof process.stdout.write);
    printTable([], [{ header: 'X', get: () => '' }]);
    spy.mockRestore();
    const out = writes.join('');
    expect(out).toContain('(no rows)');
  });
});
