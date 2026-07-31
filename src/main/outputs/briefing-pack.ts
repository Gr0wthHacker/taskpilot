/**
 * Briefing pack zipper (Wave 15).
 *
 * Takes an {@link OutputBundle} (plus the underlying task) and zips it to a
 * temp path. The resulting archive bundles:
 *
 *   README.md          → human-readable task summary
 *   result.json        → copy of ~/.taskpilot/io/results/<id>/result.json
 *   output/            → every Claude-authored file
 *   attachments/       → every user-uploaded attachment
 *   artifacts.json     → list of external refs (PR, event, page, thread, draft)
 *   metrics.json       → cost/time/confidence rollup
 *   journal.json       → optional, included when Wave 15A's aggregator exists
 *
 * The output path is returned so the route handler can stream the bytes back.
 * The zipper is intentionally minimal — we don't pull in `archiver` to keep
 * the dep tree slim. The on-disk format is a STORE-only ZIP (no compression),
 * which keeps the implementation pin-droppingly simple. Briefing packs are
 * typically small (kilobytes to a few megabytes); skipping deflate trades a
 * tiny size-on-disk increase for code we don't have to audit.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readResult } from './collector';
import type { OutputBundle, Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface BriefingPackResult {
  /** Absolute path of the written zip. Caller owns cleanup. */
  path: string;
  /** Total bytes on disk — convenient for `Content-Length`. */
  size_bytes: number;
}

/**
 * Build the briefing-pack ZIP. Returns the absolute path of the zip.
 *
 * The caller (the route handler) is responsible for streaming the bytes and
 * unlinking the file afterwards.
 *
 * Sources that fail (missing file, malformed JSON) are silently skipped —
 * the briefing pack is a best-effort export, never a hard failure.
 */
export async function buildBriefingPack(
  task: Task,
  bundle: OutputBundle,
): Promise<BriefingPackResult> {
  const entries: ZipEntry[] = [];

  // README.md ----------------------------------------------------------------
  entries.push({
    name: 'README.md',
    data: Buffer.from(renderReadme(task, bundle), 'utf8'),
    mtime: new Date(),
  });

  // result.json --------------------------------------------------------------
  const result = await readResult(task.id);
  if (result) {
    entries.push({
      name: 'result.json',
      data: Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8'),
      mtime: new Date(),
    });
  }

  // output/ ------------------------------------------------------------------
  for (const file of bundle.files) {
    const bytes = await readFileSafe(file.path);
    if (bytes === null) continue;
    entries.push({
      name: `output/${path.basename(file.path)}`,
      data: bytes,
      mtime: parseMaybeDate(file.added_at) ?? new Date(),
    });
  }

  // attachments/ -------------------------------------------------------------
  for (const att of bundle.attachments) {
    const bytes = await readFileSafe(att.path);
    if (bytes === null) continue;
    entries.push({
      name: `attachments/${path.basename(att.path)}`,
      data: bytes,
      mtime: parseMaybeDate(att.added_at) ?? new Date(),
    });
  }

  // artifacts.json -----------------------------------------------------------
  entries.push({
    name: 'artifacts.json',
    data: Buffer.from(
      `${JSON.stringify({ artifacts: bundle.artifacts }, null, 2)}\n`,
      'utf8',
    ),
    mtime: new Date(),
  });

  // metrics.json -------------------------------------------------------------
  entries.push({
    name: 'metrics.json',
    data: Buffer.from(`${JSON.stringify(bundle.metrics, null, 2)}\n`, 'utf8'),
    mtime: new Date(),
  });

  // journal.json (Wave 15A) — defensive dynamic import so we work both
  // before and after Agent A lands. Any failure here just skips the entry.
  const journal = await tryReadJournal(task.id);
  if (journal !== null) {
    entries.push({
      name: 'journal.json',
      data: Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'),
      mtime: new Date(),
    });
  }

  // Stream out to a temp file. Using a random suffix avoids collisions when
  // two briefing packs render simultaneously.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskpilot-briefing-'));
  const dest = path.join(tmpDir, `task-${safeIdForFilename(task.id)}-briefing.zip`);
  await fs.writeFile(dest, encodeZip(entries));
  const stat = await fs.stat(dest);
  return { path: dest, size_bytes: stat.size };
}

/* -------------------------------------------------------------------------- */
/*  README renderer                                                            */
/* -------------------------------------------------------------------------- */

function renderReadme(task: Task, bundle: OutputBundle): string {
  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push('');
  lines.push(`Task id: \`${task.id}\``);
  lines.push(`Status: \`${task.status}\` · Priority: \`${task.priority}\``);
  if (task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.map((t) => `\`${t}\``).join(', ')}`);
  }
  lines.push(`Created: ${task.created_at}`);
  lines.push(`Updated: ${task.updated_at}`);
  lines.push(`Generated: ${bundle.generated_at}`);
  lines.push('');

  if (task.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(task.description);
    lines.push('');
  }

  if (bundle.summary) {
    lines.push('## Result summary');
    lines.push('');
    lines.push(bundle.summary);
    lines.push('');
  }

  lines.push('## Metrics');
  lines.push('');
  const m = bundle.metrics;
  lines.push(`- Total cost: $${m.total_cost_usd.toFixed(4)}`);
  lines.push(`- Tokens (in/out): ${m.total_input_tokens.toLocaleString()} / ${m.total_output_tokens.toLocaleString()}`);
  lines.push(
    `- Time to done: ${m.time_to_done_hours === null ? 'n/a' : `${m.time_to_done_hours} hours`}`,
  );
  lines.push(
    `- Last confidence: ${m.last_confidence === null ? 'n/a' : m.last_confidence.toFixed(2)}`,
  );
  lines.push(`- Executions: ${m.execution_count}`);
  lines.push('');

  if (bundle.files.length > 0) {
    lines.push('## Output files');
    lines.push('');
    for (const f of bundle.files) {
      lines.push(
        `- \`output/${path.basename(f.path)}\` — ${formatBytes(f.size_bytes)} (${f.content_type})`,
      );
    }
    lines.push('');
  }

  if (bundle.attachments.length > 0) {
    lines.push('## Attachments (uploaded)');
    lines.push('');
    for (const a of bundle.attachments) {
      lines.push(
        `- \`attachments/${path.basename(a.path)}\` — ${formatBytes(a.size_bytes)} (${a.content_type})`,
      );
    }
    lines.push('');
  }

  if (bundle.artifacts.length > 0) {
    lines.push('## External artifacts');
    lines.push('');
    for (const art of bundle.artifacts) {
      switch (art.kind) {
        case 'github_pr':
          lines.push(`- GitHub PR #${art.number} (${art.state}): ${art.url}`);
          break;
        case 'github_issue':
          lines.push(`- GitHub issue #${art.number} (${art.state}): ${art.url}`);
          break;
        case 'calendar_event':
          lines.push(
            `- Calendar event \`${art.event_id}\`${art.summary ? ` — ${art.summary}` : ''}`,
          );
          break;
        case 'notion_page':
          lines.push(
            `- Notion page \`${art.page_id}\`${art.url ? ` — ${art.url}` : ''}${art.last_synced ? ` (synced ${art.last_synced})` : ''}`,
          );
          break;
        case 'slack_thread':
          lines.push(
            `- Slack thread${art.channel ? ` in #${art.channel}` : ''}: ${art.permalink}`,
          );
          break;
        case 'gmail_draft':
          lines.push(
            `- Gmail message \`${art.message_id}\`${art.subject ? ` — ${art.subject}` : ''}`,
          );
          break;
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated by TaskPilot. See `result.json`, `artifacts.json`, and `metrics.json` for the raw data._');
  lines.push('');
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseMaybeDate(s: string | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

function safeIdForFilename(id: string): string {
  // Task ids are already constrained to [A-Za-z0-9_-]; defensive collapse
  // covers the unlikely case someone passes an unsanitized id through.
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

async function readFileSafe(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Journal (Wave 15A) — defensive dynamic import                              */
/* -------------------------------------------------------------------------- */

/**
 * Try to load the Wave 15A journal aggregator. We deliberately don't
 * statically import `@/main/journal` so this module compiles and runs
 * cleanly whether or not Agent A has landed. A `node_modules`-style
 * runtime check (`import.meta.resolve` isn't reliably available in our
 * tsup output) is replaced by a try/catch around the dynamic import.
 */
async function tryReadJournal(taskId: string): Promise<unknown | null> {
  // We accept any of these shapes from the journal module:
  //   - default export = (taskId) => Journal
  //   - named export `collectJournal(taskId)`
  //   - named export `getJournalForTask(taskId)`
  let mod: Record<string, unknown> | null = null;
  try {
    // The path is fed in via an indirection (the Function() wrapper) so
    // the static analyzer can't see it. Otherwise tsup/Rollup would try
    // to resolve `@/main/journal` at build time and break compilation
    // before Wave 15A's module lands.
    //
    // The wrapper returns a function that performs the dynamic import on
    // demand; once Agent A lands, replacing this with a normal
    // `await import('@/main/journal')` is straightforward.
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier);',
    ) as (s: string) => Promise<Record<string, unknown>>;
    mod = await dynamicImport('@/main/journal');
  } catch {
    return null;
  }
  if (!mod) return null;
  const candidates: Array<unknown> = [
    mod['collectJournal'],
    mod['getJournalForTask'],
    mod['default'],
  ];
  for (const fn of candidates) {
    if (typeof fn === 'function') {
      try {
        const out = await (fn as (id: string) => unknown | Promise<unknown>)(taskId);
        if (out !== undefined && out !== null) return out;
      } catch {
        /* skip this candidate */
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Minimal ZIP encoder                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One file to embed in the archive. `mtime` is normalised to MS-DOS time on
 * encode so a fresh build is reproducible across platforms.
 */
interface ZipEntry {
  /** Path inside the archive (forward-slash separated). */
  name: string;
  data: Buffer;
  mtime: Date;
}

/**
 * Encode an array of {@link ZipEntry} into a STORE-only ZIP archive.
 * STORE means no compression — the central directory still describes
 * each entry, but the data is stored verbatim. This trades a few
 * percent of archive size for an implementation that's <100 lines and
 * needs zero external deps.
 *
 * The spec we follow is the PKWARE APPNOTE.TXT (rev 6.3) baseline that
 * every unzipper on every OS implements.
 */
function encodeZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const { dosDate, dosTime } = toDosTime(entry.mtime);

    // Local file header (offset 0).
    //   bytes 0-3  : 0x04034b50 (PK\x03\x04)
    //   bytes 4-5  : version needed to extract (20)
    //   bytes 6-7  : general-purpose bit flag (0x0800 = UTF-8 filename)
    //   bytes 8-9  : compression method (0 = store)
    //   bytes 10-11: last mod file time
    //   bytes 12-13: last mod file date
    //   bytes 14-17: crc-32
    //   bytes 18-21: compressed size
    //   bytes 22-25: uncompressed size
    //   bytes 26-27: filename length
    //   bytes 28-29: extra field length
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, nameBuf, entry.data);

    // Central directory header.
    //   bytes 0-3  : 0x02014b50 (PK\x01\x02)
    //   bytes 4-5  : version made by (20)
    //   bytes 6-7  : version needed (20)
    //   bytes 8-9  : general-purpose bit flag (0x0800 = UTF-8 filename)
    //   bytes 10-11: compression method (0 = store)
    //   bytes 12-13: last mod time
    //   bytes 14-15: last mod date
    //   bytes 16-19: crc-32
    //   bytes 20-23: compressed size
    //   bytes 24-27: uncompressed size
    //   bytes 28-29: filename length
    //   bytes 30-31: extra field length
    //   bytes 32-33: file comment length
    //   bytes 34-35: disk number start
    //   bytes 36-37: internal file attributes
    //   bytes 38-41: external file attributes (0)
    //   bytes 42-45: offset of local header
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8);
    cdHeader.writeUInt16LE(0, 10);
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(size, 20);
    cdHeader.writeUInt32LE(size, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42);

    centralDirectory.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + size;
  }

  const cdBuf = Buffer.concat(centralDirectory);

  // End of central directory record.
  //   bytes 0-3  : 0x06054b50 (PK\x05\x06)
  //   bytes 4-5  : disk number (0)
  //   bytes 6-7  : disk where cd starts (0)
  //   bytes 8-9  : number of cd records on this disk
  //   bytes 10-11: total number of cd records
  //   bytes 12-15: size of cd
  //   bytes 16-19: offset of start of cd
  //   bytes 20-21: comment length (0)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * CRC-32 (IEEE 802.3 polynomial). Standard ZIP requirement. We compute the
 * table once at module load; the loop is trivial because Node Buffers are
 * fast to byte-iterate.
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Convert a JS Date into the MS-DOS time/date fields used by ZIP. Years
 * before 1980 clamp to 1980-01-01.
 */
function toDosTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  return { dosDate, dosTime };
}

