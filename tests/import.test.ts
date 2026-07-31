/**
 * Bulk import tests.
 *
 * Three test groups:
 *   1. CSV parser — quoted fields, embedded commas, CRLF, escaped quotes.
 *   2. Notion export — header normalization, markdown match by title.
 *   3. Mapper — preview vs commit, dedupe by column, error reporting.
 *
 * No HTTP integration test here — the route file is a thin wrapper over
 * the mapper, and the route's behaviour is exercised by the wizard in
 * the renderer. Adding the HTTP test surface bloats the suite without
 * catching anything new.
 *
 * Wave 13 — Agent M.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { encodeCsv, parseCsv } from '@/main/import/csv';
import {
  commitImport,
  previewImport,
  suggestMapping,
} from '@/main/import/mapper';
import { parseNotionExport } from '@/main/import/notion';
import { createTask, listTasks } from '@/main/db/repositories/tasks';

/* -------------------------------------------------------------------------- */
/*  CSV parser                                                                */
/* -------------------------------------------------------------------------- */

describe('import/csv', () => {
  it('parses a simple sheet', () => {
    const text = 'a,b,c\n1,2,3\n4,5,6\n';
    const out = parseCsv(text);
    expect(out.headers).toEqual(['a', 'b', 'c']);
    expect(out.rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles quoted fields with embedded commas and quotes', () => {
    const text =
      'title,description\n' +
      '"Hello, world","She said ""hi"""\n' +
      '"line one\nline two","plain"\n';
    const out = parseCsv(text);
    expect(out.rows[0]).toEqual({
      title: 'Hello, world',
      description: 'She said "hi"',
    });
    expect(out.rows[1]).toEqual({
      title: 'line one\nline two',
      description: 'plain',
    });
  });

  it('handles CRLF line endings + BOM + trailing newline', () => {
    const text = '﻿a,b\r\n1,2\r\n3,4\r\n';
    const out = parseCsv(text);
    expect(out.headers).toEqual(['a', 'b']);
    expect(out.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('tolerates ragged rows', () => {
    const text = 'a,b,c\n1,2\n3,4,5,6\n';
    const out = parseCsv(text);
    expect(out.rows[0]).toEqual({ a: '1', b: '2', c: '' });
    // Extra column is dropped.
    expect(out.rows[1]).toEqual({ a: '3', b: '4', c: '5' });
  });

  it('throws on completely empty input', () => {
    expect(() => parseCsv('')).toThrow();
    expect(() => parseCsv('\n\n')).toThrow();
  });

  it('round-trips through encodeCsv', () => {
    const original = {
      headers: ['title', 'note'],
      rows: [
        { title: 'A, B', note: 'has "quotes"' },
        { title: 'plain', note: 'multi\nline' },
      ],
    };
    const encoded = encodeCsv(original);
    const reparsed = parseCsv(encoded);
    expect(reparsed.headers).toEqual(original.headers);
    expect(reparsed.rows).toEqual(original.rows);
  });
});

/* -------------------------------------------------------------------------- */
/*  Notion                                                                    */
/* -------------------------------------------------------------------------- */

describe('import/notion', () => {
  it('parses a Notion CSV without markdowns', () => {
    const csv = 'Name,Status\nPlan the trip,Todo\nBook hotel,Done\n';
    const out = parseNotionExport(csv);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].csv).toEqual({ Name: 'Plan the trip', Status: 'Todo' });
    expect(out.rows[0].markdown).toBeNull();
    expect(out.unmatched_markdowns).toEqual([]);
  });

  it('matches markdown bodies to rows by title', () => {
    const csv = 'Name,Status\nPlan the trip,Todo\nBook hotel,Done\n';
    const out = parseNotionExport(csv, {
      'Plan the trip a1b2c3d4.md': '# Trip\nDetails here.',
      'Book hotel 1234abcd.md': '# Hotel notes',
      'Stale page deadbeef.md': '# orphan',
    });
    expect(out.rows[0].markdown).toContain('Details here');
    expect(out.rows[1].markdown).toContain('Hotel notes');
    expect(out.unmatched_markdowns).toEqual(['Stale page deadbeef.md']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Mapper — preview & commit                                                 */
/* -------------------------------------------------------------------------- */

describe('import/mapper', () => {
  useMockedDb();

  it('suggestMapping picks obvious columns', () => {
    const s = suggestMapping(['Title', 'Description', 'Priority', 'Tags']);
    expect(s.title_column).toBe('Title');
    expect(s.description_column).toBe('Description');
    expect(s.priority_column).toBe('Priority');
    expect(s.tag_columns).toEqual(['Tags']);
  });

  it('preview returns mapped tasks + counts', () => {
    const rows = [
      { Title: 'A', Priority: 'p1', Tags: 'one,two' },
      { Title: 'B', Priority: 'p2', Tags: '' },
      { Title: '', Priority: 'p3', Tags: '' }, // invalid: blank title
    ];
    const out = previewImport(rows, {
      title_column: 'Title',
      priority_column: 'Priority',
      tag_columns: ['Tags'],
    });
    expect(out.total_rows).toBe(3);
    expect(out.preview).toHaveLength(3);
    expect(out.summary.valid).toBe(2);
    expect(out.summary.errors).toBe(1);
    expect(out.preview[0].task.priority).toBe('p1');
    expect(out.preview[0].task.tags).toEqual(['one', 'two']);
    expect(out.preview[2].errors.length).toBeGreaterThan(0);
  });

  it('preview applies priority_map for non-standard priority values', () => {
    const rows = [
      { Title: 'A', Importance: 'Urgent' },
      { Title: 'B', Importance: 'Normal' },
    ];
    const out = previewImport(rows, {
      title_column: 'Title',
      priority_column: 'Importance',
      priority_map: { Urgent: 'p0', Normal: 'p2' },
    });
    expect(out.preview[0].task.priority).toBe('p0');
    expect(out.preview[1].task.priority).toBe('p2');
  });

  it('commit creates tasks with import metadata', () => {
    const before = listTasks().length;
    const result = commitImport(
      [
        { Title: 'Imported task A', Notes: 'a' },
        { Title: 'Imported task B', Notes: 'b' },
      ],
      {
        title_column: 'Title',
        description_column: 'Notes',
      },
      { import_tag: 'batch1', source: 'csv' },
    );
    expect(result.created).toBe(2);
    expect(result.errored).toBe(0);
    expect(result.task_ids).toHaveLength(2);

    const after = listTasks();
    expect(after.length - before).toBe(2);

    const a = after.find((t) => t.title === 'Imported task A');
    expect(a?.description).toBe('a');
    expect(a?.tags).toContain('batch1');
    expect((a?.context as Record<string, unknown>).import_source).toBe('csv');
  });

  it('commit skips dedupe-key duplicates within the same run', () => {
    const result = commitImport(
      [
        { Title: 'one', Key: 'A' },
        { Title: 'two', Key: 'A' }, // duplicate within run
        { Title: 'three', Key: 'B' },
      ],
      {
        title_column: 'Title',
        skip_duplicates_by: 'Key',
      },
    );
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('commit skips rows whose dedupe key already exists on a task', () => {
    // Seed an existing task with the dedupe key in context.
    createTask({
      id: 'preexist0001',
      title: 'Pre-existing',
      context: { import_dedupe_key: 'EXISTING' },
    });

    const result = commitImport(
      [
        { Title: 'new', Key: 'NEW' },
        { Title: 'dupe', Key: 'EXISTING' },
      ],
      {
        title_column: 'Title',
        skip_duplicates_by: 'Key',
      },
    );
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('commit reports per-row errors for missing titles', () => {
    const result = commitImport(
      [
        { Title: '', Note: 'will fail' },
        { Title: 'ok', Note: 'fine' },
      ],
      { title_column: 'Title' },
    );
    expect(result.created).toBe(1);
    expect(result.errored).toBe(1);
    expect(result.errors[0].row_number).toBe(2); // header is row 1
    expect(result.errors[0].message).toMatch(/title/i);
  });
});
