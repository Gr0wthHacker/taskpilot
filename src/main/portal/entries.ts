/**
 * Portal entries (T707, monthly notes for T703): findings, deliverable
 * links, next steps and monthly notes Jack writes per client. Every entry
 * starts hidden (`client_visible = false`) until Jack publishes it.
 */

import { nanoid } from 'nanoid';

import { getSqlite } from '@/main/db';
import {
  MONTHLY_ENTRY_KINDS,
  PORTAL_ENTRY_KINDS,
  isMonth,
  isSafeHttpUrl,
  type PortalEntry,
  type PortalEntryKind,
} from '@/shared/portal';
import { monthOf } from '@/shared/renewals';

export class PortalError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'PortalError';
  }
}

interface EntryRow {
  id: string;
  client: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  month: string | null;
  client_visible: number;
  done: number;
  position: number;
  created_at: string;
  updated_at: string;
}

function rowToEntry(r: EntryRow): PortalEntry {
  return {
    ...r,
    kind: r.kind as PortalEntryKind,
    client_visible: r.client_visible === 1,
    done: r.done === 1,
    position: Number(r.position),
  };
}

export function getPortalEntry(id: string): PortalEntry | null {
  const row = getSqlite().prepare('SELECT * FROM portal_entries WHERE id = ?').get(id) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export interface PortalEntryInput {
  client: string;
  kind: string;
  title: string;
  body?: string | null;
  url?: string | null;
  month?: string | null;
  client_visible?: boolean;
  done?: boolean;
  position?: number;
}

function normalize(input: PortalEntryInput, now: number): Omit<PortalEntry, 'id' | 'created_at' | 'updated_at'> {
  const client = input.client.trim();
  if (!client) throw new PortalError('invalid', 'client is required');
  if (!(PORTAL_ENTRY_KINDS as readonly string[]).includes(input.kind)) {
    throw new PortalError('invalid', `Unknown entry kind: ${input.kind}`);
  }
  const kind = input.kind as PortalEntryKind;
  const title = input.title.trim();
  if (!title) throw new PortalError('invalid', 'title is required');
  const url = input.url?.trim() || null;
  if (url && !isSafeHttpUrl(url)) throw new PortalError('invalid', 'url must start with http:// or https://');
  let month: string | null = null;
  if (MONTHLY_ENTRY_KINDS.includes(kind)) {
    month = input.month?.trim() || monthOf(now);
    if (!isMonth(month)) throw new PortalError('invalid', `month must be YYYY-MM: ${month}`);
  }
  return {
    client,
    kind,
    title,
    body: input.body?.trim() || null,
    url,
    month,
    client_visible: input.client_visible ?? false,
    done: input.done ?? false,
    position: input.position ?? 0,
  };
}

export function createPortalEntry(input: PortalEntryInput, now: number = Date.now()): PortalEntry {
  const e = normalize(input, now);
  const id = nanoid(12);
  const ts = new Date(now).toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO portal_entries
        (id, client, kind, title, body, url, month, client_visible, done, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, e.client, e.kind, e.title, e.body, e.url, e.month, e.client_visible ? 1 : 0, e.done ? 1 : 0, e.position, ts, ts);
  return getPortalEntry(id)!;
}

export function updatePortalEntry(
  id: string,
  patch: Partial<PortalEntryInput>,
  now: number = Date.now(),
): PortalEntry | null {
  const current = getPortalEntry(id);
  if (!current) return null;
  const e = normalize(
    {
      client: patch.client ?? current.client,
      kind: patch.kind ?? current.kind,
      title: patch.title ?? current.title,
      body: patch.body !== undefined ? patch.body : current.body,
      url: patch.url !== undefined ? patch.url : current.url,
      month: patch.month !== undefined ? patch.month : current.month,
      client_visible: patch.client_visible ?? current.client_visible,
      done: patch.done ?? current.done,
      position: patch.position ?? current.position,
    },
    now,
  );
  getSqlite()
    .prepare(
      `UPDATE portal_entries SET client = ?, kind = ?, title = ?, body = ?, url = ?, month = ?,
        client_visible = ?, done = ?, position = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      e.client,
      e.kind,
      e.title,
      e.body,
      e.url,
      e.month,
      e.client_visible ? 1 : 0,
      e.done ? 1 : 0,
      e.position,
      new Date(now).toISOString(),
      id,
    );
  return getPortalEntry(id);
}

export function deletePortalEntry(id: string): boolean {
  return getSqlite().prepare('DELETE FROM portal_entries WHERE id = ?').run(id).changes > 0;
}

export function listPortalEntries(filter: { client?: string; month?: string; kind?: PortalEntryKind } = {}): PortalEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.client) {
    where.push('client = ?');
    params.push(filter.client);
  }
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.month) {
    // Next steps carry no month and always show.
    where.push('(month = ? OR month IS NULL)');
    params.push(filter.month);
  }
  const sql = `SELECT * FROM portal_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY kind, position, created_at`;
  return (getSqlite().prepare(sql).all(...params) as EntryRow[]).map(rowToEntry);
}
