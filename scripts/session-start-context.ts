#!/usr/bin/env tsx
/**
 * SessionStart context injector for Claude Code.
 *
 * Mirror of `session-end-status.ts`: when a Claude Code session opens in a
 * CWD whose trailing folder matches a repo in `~/.taskpilot/projects.json`,
 * this script writes a system-message-shaped block to stdout that Claude
 * Code injects into the new session as initial context.
 *
 * What lands in context:
 *   • The matched business's STATUS.md (open tasks, next steps, recent
 *     updates, decisions, mapped sessions)
 *   • Pending update drafts for the business (so you remember to publish)
 *   • Anything overdue across the business
 *
 * Skips silently in unknown CWDs — fresh sessions in unrelated directories
 * should look exactly like before.
 *
 * Installation: add a SessionStart hook to `~/.claude/settings.json`:
 *
 *   "SessionStart": [{
 *     "matcher": "*",
 *     "hooks": [{
 *       "type": "command",
 *       "command": "npx tsx C:/Users/Jack/taskpilot/scripts/session-start-context.ts"
 *     }]
 *   }]
 *
 * The script always exits 0 — a hook failure should NEVER block a session
 * from starting.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface BusinessConfig {
  tag: string;
  name: string;
  repos: string[];
}

interface ProjectsFile {
  projects: BusinessConfig[];
}

const TASKPILOT_HOME = path.join(os.homedir(), '.taskpilot');
const PROJECTS_FILE = path.join(TASKPILOT_HOME, 'projects.json');
const BUSINESSES_DIR = path.join(TASKPILOT_HOME, 'businesses');
const UPDATES_DRAFTS_DIR = path.join(TASKPILOT_HOME, 'io', 'updates_drafts');
const GRAVEYARD_FILE = path.join(TASKPILOT_HOME, 'graveyard', 'entries.jsonl');

/** Cap the injected payload — Claude Code's context budget is finite. */
const MAX_CONTEXT_BYTES = 12_000;

function logStderr(msg: string): void {
  process.stderr.write(`[session-start-context] ${msg}\n`);
}

function loadProjects(): ProjectsFile {
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as ProjectsFile;
    if (!parsed || !Array.isArray(parsed.projects)) return { projects: [] };
    return parsed;
  } catch {
    return { projects: [] };
  }
}

function inferBusinessTag(cwd: string, projects: ProjectsFile): string | null {
  if (!cwd) return null;
  const tail = path.basename(cwd.replace(/\\/g, '/')).toLowerCase();
  if (!tail) return null;
  for (const p of projects.projects) {
    for (const repo of p.repos) {
      const repoName = (repo.split('/').pop() ?? '').toLowerCase();
      if (repoName === tail) return p.tag;
    }
  }
  return null;
}

function readStatusMd(tag: string): string | null {
  try {
    return fs.readFileSync(path.join(BUSINESSES_DIR, tag, 'STATUS.md'), 'utf8');
  } catch {
    return null;
  }
}

interface PendingDraft {
  filename: string;
  business: string;
  headline: string;
  recent_commits: string[];
}

interface GraveyardEntry {
  at: string;
  kind: string;
  subject: string;
  reason?: string;
  business?: string | null;
}

function readRecentGraveyard(forBusiness: string, days = 14, limit = 6): GraveyardEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(GRAVEYARD_FILE, 'utf8');
  } catch {
    return [];
  }
  const cutoffMs = Date.now() - days * 86_400_000;
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const out: GraveyardEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      const e = JSON.parse(lines[i]!) as GraveyardEntry;
      if (typeof e?.at !== 'string' || typeof e?.subject !== 'string') continue;
      if (e.business && e.business !== forBusiness) continue;
      const ms = Date.parse(e.at);
      if (Number.isFinite(ms) && ms < cutoffMs) continue;
      out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

function readPendingDrafts(forBusiness: string): PendingDraft[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(UPDATES_DRAFTS_DIR);
  } catch {
    return [];
  }
  const out: PendingDraft[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(
        path.join(UPDATES_DRAFTS_DIR, name),
        'utf8',
      );
      const parsed = JSON.parse(raw) as Partial<PendingDraft>;
      if (parsed.business !== forBusiness) continue;
      out.push({
        filename: name,
        business: parsed.business ?? forBusiness,
        headline: parsed.headline ?? '(no headline)',
        recent_commits: parsed.recent_commits ?? [],
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  // Naive truncation by char count with a safety margin — Claude's tokenizer
  // doesn't care about a clean boundary here, just that we don't overshoot.
  return `${text.slice(0, Math.floor(max * 0.95))}\n\n…[truncated for context budget]`;
}

function renderContext(args: {
  tag: string;
  name: string;
  statusMd: string | null;
  drafts: PendingDraft[];
  rejected: GraveyardEntry[];
}): string {
  const sections: string[] = [];
  sections.push('## TaskPilot context for this session');
  sections.push('');
  sections.push(
    `You are working in **${args.name}** (\`${args.tag}\`). The current ` +
      `state of that business follows. Use this as the orientation pass — you ` +
      `don't need to re-read prior conversations or grep the repo to figure ` +
      `out where things stand.`,
  );
  sections.push('');

  if (args.drafts.length > 0) {
    sections.push(`### Pending update drafts (${args.drafts.length})`);
    sections.push('');
    sections.push(
      `These were queued by SessionEnd hooks from recent sessions. They ` +
        `represent work that shipped but hasn't been written up for the ` +
        `public updates log yet. If the user wants to publish today, draft ` +
        `entries from these and call \`taskpilot_publish_update\`.`,
    );
    sections.push('');
    for (const d of args.drafts.slice(0, 5)) {
      sections.push(`- **${d.headline}** (\`${d.filename}\`)`);
      for (const c of d.recent_commits.slice(0, 3)) {
        sections.push(`  - ${c}`);
      }
    }
    sections.push('');
  }

  if (args.rejected.length > 0) {
    sections.push(`### Recently rejected (last 14 days)`);
    sections.push('');
    sections.push(
      `Jack already said no to these — don't re-propose them unless he ` +
        `explicitly reopens the topic. Acknowledge briefly if his current ask ` +
        `overlaps.`,
    );
    sections.push('');
    for (const r of args.rejected) {
      const date = r.at.slice(0, 10);
      const reason = r.reason ? ` — ${r.reason}` : '';
      sections.push(`- _${date} (${r.kind})_ **${r.subject}**${reason}`);
    }
    sections.push('');
  }

  if (args.statusMd) {
    sections.push('### Live status');
    sections.push('');
    sections.push(args.statusMd.trim());
    sections.push('');
  } else {
    sections.push(
      `_No \`STATUS.md\` on disk for this business yet — call ` +
        `\`taskpilot_business_status\` with tag="${args.tag}" to compute ` +
        `the current snapshot._`,
    );
    sections.push('');
  }

  sections.push('---');
  sections.push(
    `_Auto-injected by TaskPilot SessionStart hook. Skip this whole block ` +
      `if the user's request has nothing to do with ${args.name}._`,
  );

  return clampBytes(sections.join('\n'), MAX_CONTEXT_BYTES);
}

function emitForClaudeCode(context: string): void {
  // Claude Code SessionStart hooks expect a JSON envelope on stdout with the
  // additional context payload. See Claude Code hooks docs. We use the
  // documented `hookSpecificOutput.additionalContext` field.
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function main(): void {
  const cwd =
    process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const projects = loadProjects();
  if (projects.projects.length === 0) {
    return; // no businesses configured — silent no-op
  }
  const tag = inferBusinessTag(cwd, projects);
  if (!tag) return; // CWD doesn't match a known business — silent no-op
  const config = projects.projects.find((p) => p.tag === tag);
  if (!config) return;

  const statusMd = readStatusMd(tag);
  const drafts = readPendingDrafts(tag);
  const rejected = readRecentGraveyard(tag);

  // If we have absolutely nothing useful to inject, stay quiet rather than
  // spamming the session with "no status" boilerplate.
  if (!statusMd && drafts.length === 0 && rejected.length === 0) {
    logStderr(`no status/drafts/rejects for ${tag}; skipping context inject`);
    return;
  }

  const context = renderContext({
    tag,
    name: config.name,
    statusMd,
    drafts,
    rejected,
  });
  emitForClaudeCode(context);
  logStderr(
    `injected context for ${tag} (${Buffer.byteLength(context, 'utf8')} bytes)`,
  );
}

try {
  main();
} catch (err) {
  logStderr(
    `unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  );
}
