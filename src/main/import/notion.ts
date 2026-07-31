/**
 * Notion export reader.
 *
 * Notion's "Export → Markdown & CSV" gives you a zip with one CSV listing
 * every row plus one Markdown file per row (named `<Row Title>
 * <hash>.md`). The renderer drops the CSV in, optionally accompanied by
 * a map of markdown bodies keyed by filename — the user pastes/uploads
 * those alongside the CSV.
 *
 * We deliberately don't parse zip archives in TypeScript here: that
 * would need an external dep (`adm-zip` etc.) which conflicts with the
 * "lean stacks" rule. Instead the renderer-side wizard accepts either:
 *
 *   - A plain CSV file (no per-row markdowns), OR
 *   - The extracted CSV + the markdown directory contents as a
 *     `{ filename: body }` map.
 *
 * When markdown bodies are provided, we match them to CSV rows by title:
 * Notion's filenames begin with the row's Name column. The match is
 * fuzzy (Notion sanitizes the filename) — `matchMarkdownToRow()` tries
 * progressively looser matches.
 *
 * Wave 13 — Agent M.
 */

import { parseCsv, type ParsedCsv } from './csv';

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export interface NotionRow {
  /** Original CSV row, unchanged. */
  csv: Record<string, string>;
  /** Markdown body matched to this row by title, when supplied. */
  markdown: string | null;
  /** Filename of the matched markdown, for traceability. */
  markdown_filename: string | null;
}

export interface NotionExport {
  headers: string[];
  rows: NotionRow[];
  /** Markdown files that didn't match any row — surfaced so the UI can
   *  warn the user (typically a title-rename done after the export). */
  unmatched_markdowns: string[];
}

/**
 * Parse a Notion export. `csvText` is required; `markdowns` is an optional
 * map of `filename → file body`. When both are passed, we try to attach
 * each markdown to its matching row by title.
 */
export function parseNotionExport(
  csvText: string,
  markdowns?: Record<string, string>,
): NotionExport {
  const parsed = parseCsv(csvText);

  // Pick the title column. Notion always uses "Name" but defensively we
  // fall back to the first column if "Name" is missing.
  const titleColumn = parsed.headers.includes('Name') ? 'Name' : parsed.headers[0];

  const mdEntries = markdowns
    ? Object.entries(markdowns).map(([filename, body]) => ({
        filename,
        // Drop the trailing hash suffix Notion appends (`title abcd1234.md`).
        normalizedTitle: normalizeTitle(filename),
        body,
        consumed: false,
      }))
    : [];

  const rows: NotionRow[] = parsed.rows.map((row) => {
    const title = (row[titleColumn] ?? '').trim();
    if (!title || mdEntries.length === 0) {
      return { csv: row, markdown: null, markdown_filename: null };
    }
    const normTitle = normalizeTitle(title);
    const hit = mdEntries.find(
      (e) => !e.consumed && e.normalizedTitle === normTitle,
    );
    if (hit) {
      hit.consumed = true;
      return {
        csv: row,
        markdown: hit.body,
        markdown_filename: hit.filename,
      };
    }
    // Looser fallback: prefix match.
    const prefix = mdEntries.find(
      (e) => !e.consumed && e.normalizedTitle.startsWith(normTitle),
    );
    if (prefix) {
      prefix.consumed = true;
      return {
        csv: row,
        markdown: prefix.body,
        markdown_filename: prefix.filename,
      };
    }
    return { csv: row, markdown: null, markdown_filename: null };
  });

  const unmatched = mdEntries.filter((e) => !e.consumed).map((e) => e.filename);

  return {
    headers: parsed.headers,
    rows,
    unmatched_markdowns: unmatched,
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Strip the trailing hash suffix Notion appends and lowercase everything
 * so a row titled `Plan the trip` matches a file named
 * `Plan the trip 1a2b3c4d.md`.
 */
function normalizeTitle(input: string): string {
  let cleaned = input.trim();
  // Drop trailing extension.
  cleaned = cleaned.replace(/\.(md|markdown|csv)$/i, '');
  // Drop trailing Notion hash (32 hex chars or short 8-char).
  cleaned = cleaned.replace(/\s+[0-9a-f]{8,32}$/i, '');
  // Collapse repeated whitespace.
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  Re-export                                                                 */
/* -------------------------------------------------------------------------- */

export type { ParsedCsv };
