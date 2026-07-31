/**
 * Status-report publisher (Wave 16E).
 *
 * `publishReport(report, destinations)` fans a generated {@link StatusReport}
 * out to the requested destinations. Every integration is reached through a
 * DEFENSIVE dynamic import + a connectivity check:
 *
 *   - If the integration module can't be loaded (renamed / removed) → the
 *     destination is reported as `skipped` with a note.
 *   - If the integration loads but isn't connected (`getStatus().connected`
 *     is false) → `skipped` with a note.
 *   - If the publish call throws → `ok: false` with the error message.
 *
 * Gmail is draft-only — we call `createDraft`, never `sendMessage`. That's a
 * hard rule: a status report should never leave the user's outbox without
 * their hand on it.
 *
 * The `disk` destination always works (no integration to be connected) and
 * writes both a `.md` file and a `.json` sidecar under `~/.taskpilot/reports/`.
 * The sidecar lets the history endpoint reconstruct metrics without parsing
 * Markdown.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { settingsRepository } from '@/main/db/repositories/settings';
import type {
  StatusReport,
  StatusReportDestination,
  StatusReportPublishResult,
} from '@/shared/api-contract';

import { reportsDir } from './status-report';

/* -------------------------------------------------------------------------- */
/*  Settings keys for destination targets                                      */
/* -------------------------------------------------------------------------- */

const SLACK_CHANNEL_KEY = 'status_report_slack_channel';
const GMAIL_TO_KEY = 'status_report_email_to';
const NOTION_DATABASE_KEY = 'notion_database_id';

function readString(key: string): string | null {
  const raw = settingsRepository.get<unknown>(key);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Publish a report to each destination. Always resolves — per-destination
 * outcomes are captured in the returned array rather than thrown. An empty
 * `destinations` list resolves to an empty array (the caller persists to disk
 * separately if it wants a copy regardless).
 */
export async function publishReport(
  report: StatusReport,
  destinations: StatusReportDestination[] = [],
): Promise<StatusReportPublishResult[]> {
  const results: StatusReportPublishResult[] = [];
  // De-dupe so a destination listed twice only fires once.
  const unique = [...new Set(destinations)];
  for (const dest of unique) {
    results.push(await publishOne(report, dest));
  }
  return results;
}

async function publishOne(
  report: StatusReport,
  dest: StatusReportDestination,
): Promise<StatusReportPublishResult> {
  switch (dest) {
    case 'slack':
      return publishToSlack(report);
    case 'notion':
      return publishToNotion(report);
    case 'gmail':
      return publishToGmail(report);
    case 'disk':
      return publishToDisk(report);
    default:
      return {
        destination: dest,
        ok: false,
        detail: `unknown destination "${String(dest)}"`,
        skipped: true,
      };
  }
}

/* -------------------------------------------------------------------------- */
/*  Slack                                                                      */
/* -------------------------------------------------------------------------- */

async function publishToSlack(
  report: StatusReport,
): Promise<StatusReportPublishResult> {
  const base = { destination: 'slack' as const };
  let slack: typeof import('@/main/slack') | null = null;
  try {
    slack = (await import('@/main/slack')) as typeof import('@/main/slack');
  } catch {
    return { ...base, ok: false, skipped: true, detail: 'Slack module unavailable' };
  }

  try {
    const status = await slack.getStatus();
    if (!status.connected) {
      return { ...base, ok: false, skipped: true, detail: 'Slack not connected' };
    }
  } catch {
    return { ...base, ok: false, skipped: true, detail: 'Slack not connected' };
  }

  const channel = readString(SLACK_CHANNEL_KEY);
  if (!channel) {
    return {
      ...base,
      ok: false,
      skipped: true,
      detail: 'No Slack channel configured (set status_report_slack_channel)',
    };
  }

  try {
    const res = await slack.postMessage({ channel, text: report.markdown });
    return {
      ...base,
      ok: true,
      skipped: false,
      detail: res.permalink ?? `posted to ${channel}`,
    };
  } catch (err) {
    return { ...base, ok: false, skipped: false, detail: errMsg(err) };
  }
}

/* -------------------------------------------------------------------------- */
/*  Notion                                                                     */
/* -------------------------------------------------------------------------- */

async function publishToNotion(
  report: StatusReport,
): Promise<StatusReportPublishResult> {
  const base = { destination: 'notion' as const };
  let notion: typeof import('@/main/notion') | null = null;
  try {
    notion = (await import('@/main/notion')) as typeof import('@/main/notion');
  } catch {
    return { ...base, ok: false, skipped: true, detail: 'Notion module unavailable' };
  }

  try {
    const status = await notion.getStatus();
    if (!status.connected) {
      return { ...base, ok: false, skipped: true, detail: 'Notion not connected' };
    }
  } catch {
    return { ...base, ok: false, skipped: true, detail: 'Notion not connected' };
  }

  const databaseId = readString(NOTION_DATABASE_KEY);
  if (!databaseId) {
    return {
      ...base,
      ok: false,
      skipped: true,
      detail: 'No Notion database selected',
    };
  }

  const title = `Status Report — ${report.window.from.slice(0, 10)} → ${report.window.to.slice(0, 10)}`;
  try {
    const res = await notion.upsertPage({
      database_id: databaseId,
      title,
      description: report.markdown,
    });
    return {
      ...base,
      ok: true,
      skipped: false,
      detail: res.url ?? `page ${res.page_id}`,
    };
  } catch (err) {
    return { ...base, ok: false, skipped: false, detail: errMsg(err) };
  }
}

/* -------------------------------------------------------------------------- */
/*  Gmail — DRAFT ONLY                                                         */
/* -------------------------------------------------------------------------- */

async function publishToGmail(
  report: StatusReport,
): Promise<StatusReportPublishResult> {
  const base = { destination: 'gmail' as const };
  let gmail: typeof import('@/main/gmail') | null = null;
  try {
    gmail = (await import('@/main/gmail')) as typeof import('@/main/gmail');
  } catch {
    return { ...base, ok: false, skipped: true, detail: 'Gmail module unavailable' };
  }

  let to: string | null = readString(GMAIL_TO_KEY);
  try {
    const status = await gmail.getStatus();
    if (!status.connected) {
      return { ...base, ok: false, skipped: true, detail: 'Gmail not connected' };
    }
    // Default recipient is the connected account itself (a draft to self) when
    // no explicit recipient is configured.
    if (!to && status.email) to = status.email;
  } catch {
    return { ...base, ok: false, skipped: true, detail: 'Gmail not connected' };
  }

  if (!to) {
    return {
      ...base,
      ok: false,
      skipped: true,
      detail: 'No recipient configured (set status_report_email_to)',
    };
  }

  const subject = `TaskPilot Status Report — ${report.window.from.slice(0, 10)} → ${report.window.to.slice(0, 10)}`;
  try {
    // createDraft NEVER sends. This is the hard rule for the gmail destination.
    const res = await gmail.createDraft({ to, subject, body: report.markdown });
    return {
      ...base,
      ok: true,
      skipped: false,
      detail: `draft created (${res.draft_id})`,
    };
  } catch (err) {
    return { ...base, ok: false, skipped: false, detail: errMsg(err) };
  }
}

/* -------------------------------------------------------------------------- */
/*  Disk                                                                       */
/* -------------------------------------------------------------------------- */

/** Build the slug/basename for a report file from its generated timestamp. */
export function reportBasename(generatedAt: string): string {
  // `2026-05-27T08:00:00.123Z` → `status-report-2026-05-27T08-00-00`
  const safe = generatedAt.replace(/:/g, '-').replace(/\.\d+Z$/, '').replace(/Z$/, '');
  return `status-report-${safe}`;
}

async function publishToDisk(
  report: StatusReport,
): Promise<StatusReportPublishResult> {
  const base = { destination: 'disk' as const };
  try {
    const dir = reportsDir();
    await fs.mkdir(dir, { recursive: true });
    const stem = reportBasename(report.generated_at);
    const mdPath = path.join(dir, `${stem}.md`);
    const jsonPath = path.join(dir, `${stem}.json`);
    await fs.writeFile(mdPath, report.markdown, 'utf8');
    // Sidecar carries the structured fields so history can render without
    // re-parsing the Markdown.
    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        {
          window: report.window,
          generated_at: report.generated_at,
          metrics: report.metrics,
          by_tag: report.by_tag,
          by_workspace: report.by_workspace,
          highlights: report.highlights,
        },
        null,
        2,
      ),
      'utf8',
    );
    return { ...base, ok: true, skipped: false, detail: mdPath };
  } catch (err) {
    return { ...base, ok: false, skipped: false, detail: errMsg(err) };
  }
}

/* -------------------------------------------------------------------------- */
/*  History                                                                    */
/* -------------------------------------------------------------------------- */

export interface HistoryEntry {
  filename: string;
  generated_at: string;
  window: { from: string; to: string } | null;
  metrics: StatusReport['metrics'] | null;
}

/**
 * List past reports persisted to disk, newest first. Reads the `.json`
 * sidecars when present (richer), falling back to the `.md` filename + mtime
 * for legacy files written without a sidecar. Returns `[]` when the reports
 * directory doesn't exist.
 */
export async function listReportHistory(limit = 20): Promise<HistoryEntry[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const dir = reportsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const out: HistoryEntry[] = [];
  const mdFiles = entries.filter((f) => f.endsWith('.md'));
  for (const md of mdFiles) {
    const stem = md.slice(0, -3);
    const jsonPath = path.join(dir, `${stem}.json`);
    let generatedAt = '';
    let window: HistoryEntry['window'] = null;
    let metrics: HistoryEntry['metrics'] = null;
    try {
      const raw = await fs.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StatusReport>;
      if (typeof parsed.generated_at === 'string') generatedAt = parsed.generated_at;
      if (parsed.window) window = parsed.window;
      if (parsed.metrics) metrics = parsed.metrics;
    } catch {
      // No sidecar — use the mtime as the generated-at fallback.
    }
    if (!generatedAt) {
      try {
        const stat = await fs.stat(path.join(dir, md));
        generatedAt = stat.mtime.toISOString();
      } catch {
        generatedAt = '';
      }
    }
    out.push({ filename: md, generated_at: generatedAt, window, metrics });
  }

  out.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  return out.slice(0, safeLimit);
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
