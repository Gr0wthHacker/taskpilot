#!/usr/bin/env tsx
/**
 * SessionEnd → TaskPilot business status delta.
 *
 * Designed to run as a Claude Code SessionEnd hook. When any session ends in
 * a CWD whose trailing folder name matches a `repos` entry in
 * `~/.taskpilot/projects.json`, this script writes a small JSON drop to
 * `~/.taskpilot/io/status_update/<id>.json`. TaskPilot's io watcher ingests
 * the drop and appends it to the owning business's updates feed — so the
 * next time you (or any Claude session) ask "what's the status of <X>?", the
 * answer reflects the work just done.
 *
 * Sources for headline/what_changed (in order of preference):
 *   1. CLI args: --headline "..." --what-changed "..."
 *   2. Hook stdin JSON: { headline, what_changed }
 *   3. Fallback: a generic "session ended" line + the CWD basename
 *
 * Installation: add a SessionEnd hook to `~/.claude/settings.json`:
 *
 *   {
 *     "hooks": {
 *       "SessionEnd": [
 *         {
 *           "matcher": "*",
 *           "hooks": [
 *             {
 *               "type": "command",
 *               "command": "npx tsx <PATH-TO-TASKPILOT>/scripts/session-end-status.ts"
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * Exit 0 always — a non-zero status from a hook is non-fatal for the session
 * but pollutes the terminal. We log to stderr when something is off (no
 * projects.json, no match) and silently no-op otherwise.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractTodos as extractTodosFromText,
  type TodoMatch,
} from '../src/main/businesses/todo-extractor';

interface BusinessConfig {
  tag: string;
  name: string;
  repos: string[];
}

interface ProjectsFile {
  projects: BusinessConfig[];
}

interface HookPayload {
  headline?: string;
  what_changed?: string;
  source?: string;
  cwd?: string;
}

const TASKPILOT_HOME = path.join(os.homedir(), '.taskpilot');
const PROJECTS_FILE = path.join(TASKPILOT_HOME, 'projects.json');
const STATUS_UPDATE_DIR = path.join(TASKPILOT_HOME, 'io', 'status_update');
const INBOX_DIR = path.join(TASKPILOT_HOME, 'io', 'inbox');
const UPDATES_DRAFTS_DIR = path.join(TASKPILOT_HOME, 'io', 'updates_drafts');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function logStderr(msg: string): void {
  process.stderr.write(`[session-end-status] ${msg}\n`);
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

function parseCliArgs(argv: string[]): HookPayload {
  const out: HookPayload = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--headline' && argv[i + 1]) {
      out.headline = argv[i + 1];
      i += 1;
    } else if (a === '--what-changed' && argv[i + 1]) {
      out.what_changed = argv[i + 1];
      i += 1;
    } else if (a === '--source' && argv[i + 1]) {
      out.source = argv[i + 1];
      i += 1;
    } else if (a === '--cwd' && argv[i + 1]) {
      out.cwd = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function readStdinJson(): Promise<HookPayload> {
  if (process.stdin.isTTY) return {};
  return await new Promise<HookPayload>((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text) as HookPayload;
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    };
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', finish);
    // Bail after 250ms — hook stdin should arrive immediately.
    setTimeout(finish, 250).unref();
  });
}

function shortId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${stamp}-${rand}`;
}

/**
 * Convert a real CWD to the on-disk slug Claude Code uses for the per-project
 * transcript folder. `:` and path separators become `-`. Mirrors the actual
 * encoding observed under `~/.claude/projects/`.
 */
function encodeProjectSlug(cwd: string): string {
  return cwd.replace(/[:/\\]/g, '-');
}

/**
 * Find the newest `.jsonl` transcript file for the given CWD, or null when
 * none exists. We pick the file with the greatest `mtimeMs` so the SessionEnd
 * hook reads the session it just ran inside, not a stale sibling.
 */
function findRecentSessionJsonl(cwd: string): string | null {
  const slug = encodeProjectSlug(cwd);
  const dir = path.join(CLAUDE_PROJECTS_DIR, slug);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const p = path.join(dir, e.name);
      try {
        return { path: p, mtime: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]!.path;
}

/**
 * Read a transcript JSONL from disk and return any forward-looking lines.
 * Thin wrapper over the shared, unit-tested extractor in
 * `src/main/businesses/todo-extractor.ts` — the script supplies fs only.
 */
function extractTodos(jsonlPath: string): TodoMatch[] {
  let text: string;
  try {
    text = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return [];
  }
  return extractTodosFromText(text);
}

/**
 * Write a single inbox drop for one extracted TODO. The watcher validates
 * via inboxDropSchema, so we send the minimum the schema requires plus the
 * source business tag and a context hint pointing back at the transcript.
 */
function writeInboxDrop(args: {
  todo: TodoMatch;
  businessTag: string;
  cwd: string;
  jsonlPath: string;
}): string | null {
  const { todo, businessTag, cwd, jsonlPath } = args;
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    const id = `auto-${shortId()}`;
    const dest = path.join(INBOX_DIR, `${id}.json`);
    const payload = {
      id,
      title: todo.title,
      description: `Auto-extracted from session end. Source line:\n\n> ${todo.rawLine}`,
      priority: 'p2',
      tags: [businessTag, 'auto-extracted'],
      context: {
        source: 'session-end-auto-derive',
        source_cwd: cwd,
        source_transcript: jsonlPath,
        business: businessTag,
      },
    };
    fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return dest;
  } catch (err) {
    logStderr(
      `inbox drop failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const stdinPayload = await readStdinJson();
  const cwd =
    cliArgs.cwd ??
    stdinPayload.cwd ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();

  const projects = loadProjects();
  if (projects.projects.length === 0) {
    logStderr(`no businesses configured in ${PROJECTS_FILE} — skipping`);
    return;
  }

  const tag = inferBusinessTag(cwd, projects);
  if (!tag) {
    // Silent no-op — most sessions won't land in a known repo, and the hook
    // shouldn't spam stderr in unrelated directories.
    return;
  }

  const headline =
    cliArgs.headline ??
    stdinPayload.headline ??
    `Session ended in ${path.basename(cwd)}`;
  const what_changed =
    cliArgs.what_changed ??
    stdinPayload.what_changed ??
    undefined;
  const source =
    cliArgs.source ?? stdinPayload.source ?? 'claude-code:session-end';

  const payload: Record<string, unknown> = {
    business: tag,
    at: new Date().toISOString(),
    headline,
    source,
  };
  if (what_changed) payload.what_changed = what_changed;

  try {
    fs.mkdirSync(STATUS_UPDATE_DIR, { recursive: true });
    const dest = path.join(STATUS_UPDATE_DIR, `${shortId()}.json`);
    fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    logStderr(`wrote status delta for ${tag} → ${dest}`);
  } catch (err) {
    logStderr(
      `failed to write status delta: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Auto-derive — scan the recent transcript for explicit forward-looking
  // lines ("TODO: x", "Next: y", "Tomorrow: z") and drop them as inbox
  // tasks. Per-business defaults will be applied by the io ingestion layer.
  // A missing transcript only blocks this step; the updates drafter below
  // depends only on git history and still runs.
  const jsonlPath = findRecentSessionJsonl(cwd);
  if (jsonlPath) {
    const todos = extractTodos(jsonlPath);
    let written = 0;
    for (const todo of todos) {
      const drop = writeInboxDrop({
        todo,
        businessTag: tag,
        cwd,
        jsonlPath,
      });
      if (drop) written += 1;
    }
    if (written > 0) {
      logStderr(`auto-derive: wrote ${written} inbox drop${written === 1 ? '' : 's'}`);
    }
  } else {
    logStderr(`no transcript found for ${cwd}; skipping auto-derive`);
  }

  // Updates-log drafter — if this session produced one or more commits in the
  // matched business's CWD, drop a queue file so a future Claude session can
  // call `taskpilot_publish_update`. We deliberately don't write the prose
  // here — the hook has no LLM. The queue carries enough context (recent
  // commit subjects + business tag + headline) for a model to draft cleanly.
  await maybeDropUpdateDraft({
    businessTag: tag,
    cwd,
    headline,
    whatChanged: what_changed,
  });
}

/**
 * Inspect the working tree for commits authored in the last few hours and
 * drop a draft queue entry when at least one exists. No-op when the CWD isn't
 * a git repo or no recent commits were made.
 */
async function maybeDropUpdateDraft(args: {
  businessTag: string;
  cwd: string;
  headline: string;
  whatChanged: string | undefined;
}): Promise<void> {
  const recentCommits = collectRecentCommitSubjects(args.cwd);
  if (recentCommits.length === 0) {
    return;
  }
  try {
    fs.mkdirSync(UPDATES_DRAFTS_DIR, { recursive: true });
    const id = `draft-${shortId()}`;
    const dest = path.join(UPDATES_DRAFTS_DIR, `${id}.json`);
    const payload = {
      id,
      created_at: new Date().toISOString(),
      business: args.businessTag,
      cwd: args.cwd,
      headline: args.headline,
      what_changed: args.whatChanged ?? null,
      recent_commits: recentCommits,
      voice_guide:
        'High-level for public consumption. No file paths, endpoint names, ' +
        'library callouts, skill names, or meta references to "this log". ' +
        'Lead with the user-visible problem or capability, then what shipped, ' +
        'then why it matters. Conversational, confident, contractions OK.',
      suggested_next_action:
        'Draft the entry in Jack\'s voice and push via taskpilot_publish_update. ' +
        'After publishing, call taskpilot_resolve_update_draft to clear this queue file.',
    };
    fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    logStderr(`queued updates draft → ${dest}`);
  } catch (err) {
    logStderr(
      `update-draft queue failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Get short subject lines of commits authored in the last ~6 hours under the
 * given CWD. Empty array when not a git repo, when git isn't installed, or
 * when nothing recent.
 */
function collectRecentCommitSubjects(cwd: string): string[] {
  try {
    const stdout = execFileSync(
      'git',
      ['log', '--since=6.hours.ago', '--format=%s', '-n', '20'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

void main().catch((err) => {
  logStderr(
    `unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  );
});
