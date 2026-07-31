/**
 * Pre-compression digest builder.
 *
 * Takes a `ParsedSession` and produces the searchable summary that lives in
 * the `conversations` row until the rolling compactor replaces it with a
 * Claude-generated summary at the 30-day mark.
 *
 * What the digest captures:
 *   - Title: derived from `ai_title` if present, otherwise the first user
 *     prompt, otherwise "(untitled session)".
 *   - Topics: lightweight keyword extraction. Capitalized multi-word tokens,
 *     known business / product names from `KNOWN_TERMS`, common file
 *     extensions seen in tool calls.
 *   - Key decisions: lines matching decision-shaped patterns ("decided to",
 *     "going with", "we'll", "let's", "the plan is", "approved", "rejected").
 *   - Files touched: from tool_use inputs across all turns (deduped).
 *   - Digest text: first user prompt, last assistant summary, plus extracted
 *     code blocks — capped at ~8KB. This is what `digest` stores.
 *
 * Heuristics are deliberately simple; the real summarization happens at the
 * 30-day mark via the compactor + Claude.
 */

import type { ParsedSession } from './parser.js';

export interface Digest {
  title: string;
  digest: string;
  topics: string[];
  key_decisions: string[];
  files_touched: string[];
}

/**
 * Business / product / tooling terms that should always be promoted to a topic
 * if they show up in the conversation. Lowercased on match.
 */
const KNOWN_TERMS = [
  'taskpilot',
  'leal health',
  'leal',
  'actually health',
  'indexthread',
  'index thread',
  'haba',
  'multistatemd',
  'whitecoat',
  'cowork',
  'claude code',
  'mcp',
  'supabase',
  'next.js',
  'electron',
  'drizzle',
  'sqlite',
  'reddit',
  'oauth',
  'webhook',
  'compliance',
  'fda',
  'hipaa',
  'devvit',
  'praw',
  'vercel',
  'cloudflare',
];

const DECISION_PATTERNS = [
  /\bdecided to\b[^.\n]{0,200}/gi,
  /\bgoing with\b[^.\n]{0,200}/gi,
  /\bwe['’]?ll\b[^.\n]{0,200}/gi,
  /\blet['’]?s\b[^.\n]{0,200}/gi,
  /\bthe plan is\b[^.\n]{0,200}/gi,
  /\bapproved\b[^.\n]{0,200}/gi,
  /\brejected\b[^.\n]{0,200}/gi,
  /\bchose\b[^.\n]{0,200}/gi,
  /\bpicked\b[^.\n]{0,200}/gi,
];

const FIRST_LINE_RE = /^[^\n]{1,200}/;

function deriveTitle(session: ParsedSession): string {
  if (session.ai_title && session.ai_title.trim().length > 0) {
    return session.ai_title.trim().slice(0, 200);
  }
  const firstUser = session.messages.find((m) => m.role === 'user');
  if (firstUser) {
    const m = FIRST_LINE_RE.exec(firstUser.text);
    if (m) {
      const line = m[0].trim();
      if (line.length > 0) return line.slice(0, 200);
    }
  }
  return '(untitled session)';
}

function extractTopics(session: ParsedSession): string[] {
  const found = new Set<string>();
  const haystack = session.messages
    .map((m) => m.text)
    .join('\n')
    .toLowerCase();
  for (const term of KNOWN_TERMS) {
    if (haystack.includes(term)) found.add(term);
  }
  // Repo / file references (extensions seen in tool calls)
  for (const m of session.messages) {
    for (const f of m.files_touched) {
      const ext = f.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
      if (ext) found.add(`.${ext[1]}`);
    }
  }
  // Capped — never balloon the row.
  return Array.from(found).slice(0, 32);
}

function extractKeyDecisions(session: ParsedSession): string[] {
  const collected = new Set<string>();
  for (const m of session.messages) {
    if (m.role !== 'assistant') continue;
    for (const pattern of DECISION_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(m.text)) !== null) {
        const clean = match[0].trim().replace(/\s+/g, ' ').slice(0, 240);
        if (clean.length > 12) collected.add(clean);
        if (collected.size >= 24) break;
      }
      if (collected.size >= 24) break;
    }
    if (collected.size >= 24) break;
  }
  return Array.from(collected);
}

function extractFilesTouched(session: ParsedSession): string[] {
  const seen = new Set<string>();
  for (const m of session.messages) {
    for (const f of m.files_touched) seen.add(f);
    if (seen.size >= 200) break;
  }
  return Array.from(seen).slice(0, 200);
}

const DIGEST_BUDGET = 8_000;

function buildDigestText(session: ParsedSession): string {
  const parts: string[] = [];
  const firstUser = session.messages.find((m) => m.role === 'user');
  if (firstUser) parts.push(`USER: ${firstUser.text.slice(0, 1200)}`);

  // Walk assistant turns, capture first short paragraph of each + their code
  // blocks. Stop when we've used the digest budget.
  let used = parts.join('\n\n').length;
  for (const m of session.messages) {
    if (m.role !== 'assistant') continue;
    if (used >= DIGEST_BUDGET) break;
    const para = m.text.slice(0, 600).trim();
    if (para) {
      parts.push(`CLAUDE: ${para}`);
      used += para.length + 8;
    }
    for (const cb of m.code_blocks) {
      if (used >= DIGEST_BUDGET) break;
      const snippet = cb.slice(0, 800);
      parts.push(`CODE:\n${snippet}`);
      used += snippet.length + 8;
    }
  }
  return parts.join('\n\n').slice(0, DIGEST_BUDGET);
}

export function buildDigest(session: ParsedSession): Digest {
  return {
    title: deriveTitle(session),
    digest: buildDigestText(session),
    topics: extractTopics(session),
    key_decisions: extractKeyDecisions(session),
    files_touched: extractFilesTouched(session),
  };
}
