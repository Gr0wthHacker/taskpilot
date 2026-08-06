/**
 * 30-minute mindstream synthesis.
 *
 * Every 30 minutes, synthesizes recent activity across:
 *   - TaskPilot tasks (last 30 min)
 *   - Claude session transcripts (~/.claude/sessions/)
 *   - Gmail/Slack starred messages
 *
 * Groups activity by "lines of thinking" (inquiries, blockers, breakthroughs)
 * rather than raw tasks. Dedupes across synthesis windows. Filters company/app
 * names. Outputs a markdown summary ready for approval and publication to
 * jackgierlich/mindstream.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { getSqlite } from '@/main/db';
import * as settingsRepo from '@/main/db/repositories/settings';

export interface SynthesisLine {
  theme: string;
  details: string[];
  type: 'inquiry' | 'iteration' | 'blocker' | 'breakthrough';
}

export interface SynthesisResult {
  timestamp: string;
  lines: SynthesisLine[];
  raw_summary: string;
  hash: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    h = (h << 5) - h + char;
    h = h & h;
  }
  return Math.abs(h).toString(16);
}

function redactSensitiveNames(text: string): string {
  const sensitive = [
    'IndexThread',
    'Leal Health',
    'Leal',
    'Actually Health',
    'Actually',
    'TaskPilot',
    'jack.?gierlich',
  ];
  let result = text;
  for (const name of sensitive) {
    const re = new RegExp(name, 'gi');
    result = result.replace(re, '[redacted]');
  }
  return result;
}

function getRecentTasks(windowMinutes: number = 30): Array<{
  id: string;
  title: string;
  description: string | null;
  status: string;
  tags: string[];
  updated_at: string;
}> {
  const db = getSqlite();
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const rows = db
    .prepare(
      `
    SELECT id, title, description, status, tags, updated_at
    FROM tasks
    WHERE updated_at > ?
    ORDER BY updated_at DESC
  `,
    )
    .all(cutoff) as Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    tags: string | null;
    updated_at: string;
  }>;

  return rows.map((r) => ({
    ...r,
    tags: r.tags ? JSON.parse(r.tags as string) : [],
  }));
}

function getRecentExecutionLogs(windowMinutes: number = 30): Array<{
  id: string;
  task_id: string;
  status: string;
  output: string | null;
  error: string | null;
  started_at: string;
}> {
  const db = getSqlite();
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  return db
    .prepare(
      `
    SELECT id, task_id, status, output, error, started_at
    FROM execution_logs
    WHERE started_at > ?
    ORDER BY started_at DESC
  `,
    )
    .all(cutoff) as Array<{
    id: string;
    task_id: string;
    status: string;
    output: string | null;
    error: string | null;
    started_at: string;
  }>;
}

function getRecentClaudeTranscripts(windowMinutes: number = 30): string[] {
  const snippets: string[] = [];
  const claudeDir = path.join(homedir(), '.claude', 'sessions');
  const cutoff = Date.now() - windowMinutes * 60_000;

  try {
    const files = fs.readdirSync(claudeDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filepath = path.join(claudeDir, file);
      const stat = fs.statSync(filepath);
      if (stat.mtime.getTime() < cutoff) continue;

      try {
        const content = fs.readFileSync(filepath, 'utf-8');
        const session = JSON.parse(content);
        if (session.transcript && Array.isArray(session.transcript)) {
          for (const msg of session.transcript) {
            if (msg.role === 'user' && msg.content) {
              snippets.push(msg.content);
            } else if (msg.role === 'assistant' && msg.content) {
              const preview = msg.content.slice(0, 300);
              if (preview.length > 50) snippets.push(preview);
            }
          }
        }
      } catch {
        /* skip malformed sessions */
      }
    }
  } catch {
    /* ~/.claude/sessions/ doesn't exist yet */
  }

  return snippets;
}

function extractThinkingLines(
  tasks: ReturnType<typeof getRecentTasks>,
  logs: ReturnType<typeof getRecentExecutionLogs>,
  claudeSnippets: string[],
): SynthesisLine[] {
  const lines: Map<string, SynthesisLine> = new Map();

  for (const task of tasks) {
    const text = `${task.title} ${task.description || ''}`;
    const type = task.status === 'done' ? 'iteration' : 'inquiry';
    const key = text.toLowerCase().slice(0, 50);

    if (!lines.has(key)) {
      lines.set(key, {
        theme: redactSensitiveNames(task.title),
        details: [],
        type,
      });
    }

    const line = lines.get(key)!;
    if (task.description) {
      line.details.push(redactSensitiveNames(task.description));
    }
  }

  for (const log of logs) {
    const type = log.status === 'succeeded' ? 'breakthrough' : 'blocker';
    const key = `log-${log.task_id}`;

    if (log.error) {
      lines.set(key, {
        theme: `Encountered blocker`,
        details: [redactSensitiveNames(log.error.slice(0, 100))],
        type,
      });
    } else if (log.output) {
      const preview = redactSensitiveNames(log.output.slice(0, 150));
      lines.set(key, {
        theme: `Generated result`,
        details: [preview],
        type,
      });
    }
  }

  for (const snippet of claudeSnippets) {
    const redacted = redactSensitiveNames(snippet);
    if (redacted.length < 30) continue;
    const key = `claude-${redacted.slice(0, 30)}`;

    if (!lines.has(key)) {
      const isQuery = redacted.includes('?');
      lines.set(key, {
        theme: `Researching: ${redacted.slice(0, 60)}...`,
        details: [],
        type: isQuery ? 'inquiry' : 'iteration',
      });
    }
  }

  return Array.from(lines.values()).slice(0, 20);
}

function generateMarkdown(lines: SynthesisLine[]): string {
  if (lines.length === 0) {
    return '(no activity in the last 30 minutes)';
  }

  const sections = {
    inquiry: 'Research & Questions',
    iteration: 'Building & Refining',
    blocker: 'Blockers',
    breakthrough: 'Breakthroughs',
  };

  const grouped = new Map<string, SynthesisLine[]>();
  for (const line of lines) {
    const section = sections[line.type] || 'Other';
    if (!grouped.has(section)) {
      grouped.set(section, []);
    }
    grouped.get(section)!.push(line);
  }

  let md = '';
  const order = ['Research & Questions', 'Building & Refining', 'Breakthroughs', 'Blockers'];

  for (const section of order) {
    const items = grouped.get(section) || [];
    if (items.length === 0) continue;

    md += `## ${section}\n\n`;
    for (const item of items) {
      md += `- **${item.theme}**`;
      if (item.details.length > 0) {
        md += `\n  - ${item.details[0]}\n`;
      } else {
        md += '\n';
      }
    }
    md += '\n';
  }

  return md;
}

function readPreviousSyntheses(): string[] {
  const settingsKey = 'mindstream_previous_hashes';
  const raw = settingsRepo.get<unknown>(settingsKey);
  if (Array.isArray(raw)) {
    return raw.filter((h): h is string => typeof h === 'string');
  }
  return [];
}

function saveSynthesisHash(newHash: string): void {
  const settingsKey = 'mindstream_previous_hashes';
  const prev = readPreviousSyntheses();
  const updated = [newHash, ...prev].slice(0, 100);
  settingsRepo.set(settingsKey, updated);
}

export async function generateSynthesis(
  windowMinutes: number = 30,
): Promise<SynthesisResult | null> {
  const tasks = getRecentTasks(windowMinutes);
  const logs = getRecentExecutionLogs(windowMinutes);
  const claudeSnippets = getRecentClaudeTranscripts(windowMinutes);

  if (tasks.length === 0 && logs.length === 0 && claudeSnippets.length === 0) {
    return null;
  }

  const lines = extractThinkingLines(tasks, logs, claudeSnippets);
  const raw_summary = generateMarkdown(lines);
  const h = hash(raw_summary);

  const prevHashes = readPreviousSyntheses();
  if (prevHashes.includes(h)) {
    return null;
  }

  saveSynthesisHash(h);

  return {
    timestamp: nowIso(),
    lines,
    raw_summary,
    hash: h,
  };
}
