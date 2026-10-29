/**
 * CSV import for renewals (T704).
 *
 * Header row required. Column names are case-insensitive; spaces and dashes
 * count as underscores. Recognized columns (aliases in brackets):
 *
 *   client*            [practice, customer]
 *   item_type*         [type]            state_license, caqh_attestation, dea, risk_assessment,
 *                                        baa, site_rescan, custom, or their labels ("DEA", "CAQH")
 *   label*             [item, name]      what is being renewed
 *   due_date*          [due, expires, expiration_date]   YYYY-MM-DD or M/D/YYYY
 *   recurrence         [repeat, cadence] none, 120d, 3m, 2y, yearly, "every 2 years"
 *   lead_times         [lead_days, reminders]  90/60/30 (slashes, semicolons or spaces)
 *   owner_type         jack, contractor, offshore
 *   owner_name         [owner]
 *   venture
 *   notes
 *   client_visible     [visible, portal] yes/no, true/false, 1/0
 *
 * Validation runs on every row before anything is written. With errors and
 * `skip_invalid` false, nothing is imported. Rows matching an existing
 * renewal (same client, type, label and due date) are skipped as duplicates.
 */

import { getSqlite } from '@/main/db';
import { RENEWAL_ITEM_TYPES, RENEWAL_ITEM_TYPE_LABELS, type RenewalItemType } from '@/shared/renewals';

import { RenewalError, createRenewal, prepareRenewal, type CreateRenewalInput } from './repository';

export const MAX_IMPORT_ROWS = 2_000;

/** RFC 4180-ish parser: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const ALIASES: Record<string, keyof CreateRenewalInput> = {
  client: 'client',
  practice: 'client',
  customer: 'client',
  item_type: 'item_type',
  type: 'item_type',
  label: 'label',
  item: 'label',
  name: 'label',
  due_date: 'due_date',
  due: 'due_date',
  expires: 'due_date',
  expiration_date: 'due_date',
  recurrence: 'recurrence',
  repeat: 'recurrence',
  cadence: 'recurrence',
  lead_times: 'lead_times',
  lead_days: 'lead_times',
  reminders: 'lead_times',
  owner_type: 'owner_type',
  owner_name: 'owner_name',
  owner: 'owner_name',
  venture: 'venture',
  notes: 'notes',
  client_visible: 'client_visible',
  visible: 'client_visible',
  portal: 'client_visible',
};

const REQUIRED: Array<keyof CreateRenewalInput> = ['client', 'item_type', 'label', 'due_date'];

function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const TYPE_LOOKUP: Record<string, RenewalItemType> = (() => {
  const out: Record<string, RenewalItemType> = {};
  for (const t of RENEWAL_ITEM_TYPES) {
    out[t] = t;
    out[headerKey(RENEWAL_ITEM_TYPE_LABELS[t])] = t;
  }
  Object.assign(out, {
    license: 'state_license',
    medical_license: 'state_license',
    caqh: 'caqh_attestation',
    caqh_reattestation: 'caqh_attestation',
    dea_registration: 'dea',
    sra: 'risk_assessment',
    security_risk_assessment: 'risk_assessment',
    business_associate_agreement: 'baa',
    rescan: 'site_rescan',
  });
  return out;
})();

function parseItemType(raw: string): string {
  const key = headerKey(raw);
  return TYPE_LOOKUP[key] ?? raw.trim();
}

function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (['1', 'y', 'yes', 'true', 'on'].includes(v)) return true;
  if (['0', 'n', 'no', 'false', 'off'].includes(v)) return false;
  throw new RenewalError('invalid', `client_visible must be yes or no: ${raw}`);
}

export interface ImportRowResult {
  /** 1-based line number in the file, counting the header as line 1. */
  line: number;
  status: 'ok' | 'duplicate' | 'error';
  error?: string;
  client?: string;
  label?: string;
  due_date?: string;
}

export interface ImportResult {
  dry_run: boolean;
  imported: number;
  duplicates: number;
  errors: number;
  rows: ImportRowResult[];
}

export function importRenewalsCsv(
  text: string,
  opts: { dry_run?: boolean; skip_invalid?: boolean } = {},
  now: number = Date.now(),
): ImportResult {
  const table = parseCsv(text);
  if (table.length === 0) throw new RenewalError('invalid', 'CSV is empty');
  const [header, ...body] = table;
  if (body.length > MAX_IMPORT_ROWS) {
    throw new RenewalError('invalid', `CSV has ${body.length} rows; the limit is ${MAX_IMPORT_ROWS}`);
  }
  const columns = header.map((h) => ALIASES[headerKey(h)] ?? null);
  const missing = REQUIRED.filter((r) => !columns.includes(r));
  if (missing.length > 0) {
    throw new RenewalError('invalid', `CSV is missing required column(s): ${missing.join(', ')}`);
  }

  const db = getSqlite();
  const dupStmt = db.prepare(
    'SELECT 1 FROM renewals WHERE client = ? AND item_type = ? AND label = ? AND due_date = ? LIMIT 1',
  );
  const seen = new Set<string>();
  const prepared: Array<{ line: number; input: CreateRenewalInput } | null> = [];
  const rows: ImportRowResult[] = body.map((cells, idx) => {
    const line = idx + 2;
    try {
      const input: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        if (!col) return;
        const raw = (cells[i] ?? '').trim();
        if (col === 'client_visible') {
          const b = parseBool(raw);
          if (b !== undefined) input.client_visible = b;
        } else if (col === 'item_type') {
          input.item_type = parseItemType(raw);
        } else if (raw !== '') {
          input[col] = raw;
        }
      });
      const normalized = prepareRenewal(input as unknown as CreateRenewalInput);
      const key = [normalized.client, normalized.item_type, normalized.label, normalized.due_date].join('\u0000');
      const base = { line, client: normalized.client, label: normalized.label, due_date: normalized.due_date };
      if (seen.has(key) || dupStmt.get(normalized.client, normalized.item_type, normalized.label, normalized.due_date)) {
        prepared.push(null);
        return { ...base, status: 'duplicate' as const };
      }
      seen.add(key);
      prepared.push({ line, input: normalized });
      return { ...base, status: 'ok' as const };
    } catch (err) {
      prepared.push(null);
      return { line, status: 'error' as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const errors = rows.filter((r) => r.status === 'error').length;
  const duplicates = rows.filter((r) => r.status === 'duplicate').length;
  const dryRun = opts.dry_run === true || (errors > 0 && !opts.skip_invalid);
  let imported = 0;
  if (!dryRun) {
    db.transaction(() => {
      for (const p of prepared) {
        if (!p) continue;
        createRenewal(p.input, now);
        imported += 1;
      }
    })();
  }
  return { dry_run: dryRun, imported, duplicates, errors, rows };
}
