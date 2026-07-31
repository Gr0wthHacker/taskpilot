/**
 * Minimal RFC 4180-ish CSV parser.
 *
 * No external deps — Jack's stack rule. Handles:
 *   - Comma-separated fields
 *   - Quoted fields with embedded commas, newlines, and `""` escapes
 *   - LF or CRLF line endings (mixed is fine)
 *   - Trailing newline (optional)
 *
 * Returns `{ headers, rows }` where each row is a `Record<string, string>`
 * keyed by the headers. Rows with fewer fields than the header count get
 * empty strings for the missing trailing columns; extra fields are
 * dropped. Both behaviors mirror what spreadsheet apps do on round-trip.
 *
 * Not a streaming parser — the import flow loads the full content into
 * memory anyway (the renderer needs the rows to render a preview), so
 * a simple state machine over the string is the right tradeoff.
 *
 * Wave 13 — Agent M.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/* -------------------------------------------------------------------------- */
/*  Tokenizer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Walk the CSV text and emit a list of records, each a `string[]` whose
 * length matches the field count in the source row. This is the
 * structural pass — header alignment happens in `parseCsv()`.
 */
function tokenize(text: string): string[][] {
  // Strip an optional UTF-8 BOM. Excel and Google Sheets both emit one.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: string[][] = [];
  let current: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = src[i + 1];
        if (next === '"') {
          // Escaped quote.
          field += '"';
          i += 2;
          continue;
        }
        // End of quoted field.
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    // Outside quotes.
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      current.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // CRLF — drop the CR and let the LF branch finalize.
      i += 1;
      continue;
    }
    if (ch === '\n') {
      current.push(field);
      field = '';
      records.push(current);
      current = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the final field/record. If the source ended on a newline we'd
  // have already pushed; only flush a trailing record if there's content.
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    records.push(current);
  }

  return records;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse a CSV string into headers + row objects.
 *
 * Throws when the input has zero non-empty rows (no header line). All
 * other shape problems (ragged rows, blank lines) are tolerated.
 */
export function parseCsv(text: string): ParsedCsv {
  const tokens = tokenize(text);
  // Drop fully-empty trailing records ("" only).
  while (
    tokens.length > 0 &&
    tokens[tokens.length - 1].length === 1 &&
    tokens[tokens.length - 1][0] === ''
  ) {
    tokens.pop();
  }
  if (tokens.length === 0) {
    throw new Error('CSV is empty — expected at least a header row');
  }

  const headers = tokens[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let r = 1; r < tokens.length; r++) {
    const record = tokens[r];
    // Skip rows that are entirely empty — usually trailing blank lines.
    if (record.length === 1 && record[0] === '') continue;

    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      obj[key] = record[c] ?? '';
    }
    rows.push(obj);
  }

  return { headers, rows };
}

/* -------------------------------------------------------------------------- */
/*  Encoder (for the export side / tests)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-encode a parsed CSV back to a string. Quotes fields that contain a
 * comma, quote, or newline. Used by tests and the round-trip sanity
 * check in `previewImport()`.
 */
export function encodeCsv(parsed: ParsedCsv): string {
  const lines: string[] = [];
  lines.push(parsed.headers.map(encodeField).join(','));
  for (const row of parsed.rows) {
    lines.push(parsed.headers.map((h) => encodeField(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

function encodeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
