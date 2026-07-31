/**
 * Claude Code session JSONL parser.
 *
 * The on-disk format under `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`
 * is one JSON object per line. Event types we care about:
 *
 *   - `user` — user prompt or tool-result reply. `message.content` is either a
 *     string or an array of content blocks (per the Anthropic Messages shape).
 *   - `assistant` — assistant response. `message.content` is an array of
 *     `{type:'text',text}` / `{type:'tool_use',name,input}` blocks.
 *     `message.usage` carries token counts; `message.model` carries the model id.
 *   - `ai-title` — Claude-generated title for the session (we keep the latest).
 *   - `summary` — periodic summary; the latest is a useful description fallback.
 *
 * Everything else (queue-operation, attachment, last-prompt, system, ...) is
 * ignored for the catalogue. The full JSONL stays on disk untouched —
 * `parseSessionFile` reads it once and returns a normalized snapshot.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

export interface ParsedMessage {
  role: 'user' | 'assistant';
  timestamp: string;
  /** Concatenated text content. Tool-use blocks render as `[tool: name]`. */
  text: string;
  /** Extracted ``` code blocks from assistant text content. */
  code_blocks: string[];
  /** File paths referenced in tool_use inputs (best-effort). */
  files_touched: string[];
  /** Tool calls the assistant invoked in this turn. */
  tool_calls: string[];
}

export interface ParsedSession {
  /** UUID from the filename / sessionId field. */
  session_id: string;
  /** Working directory at the time of the session. May be null on older logs. */
  cwd: string | null;
  git_branch: string | null;
  /** Best-known model id (most recent assistant turn wins). */
  model: string | null;
  started_at: string;
  ended_at: string;
  messages: ParsedMessage[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Latest `ai-title` entry; null if none. */
  ai_title: string | null;
  /** Latest `summary` entry; null if none. */
  summary: string | null;
  /** sha256 of the file contents — used to skip re-ingest. */
  content_hash: string;
  /** Total raw bytes read. */
  bytes: number;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function blockToText(block: unknown): {
  text: string;
  toolName: string | null;
  files: string[];
} {
  if (typeof block === 'string') {
    return { text: block, toolName: null, files: [] };
  }
  if (!block || typeof block !== 'object') {
    return { text: '', toolName: null, files: [] };
  }
  const b = block as AnthropicContentBlock;
  if (b.type === 'text' && typeof b.text === 'string') {
    return { text: b.text, toolName: null, files: [] };
  }
  if (b.type === 'tool_use' && typeof b.name === 'string') {
    const files: string[] = [];
    const input = b.input ?? {};
    for (const key of ['file_path', 'path', 'filename']) {
      const v = (input as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.length < 1024) files.push(v);
    }
    return { text: `[tool: ${b.name}]`, toolName: b.name, files };
  }
  if (b.type === 'tool_result') {
    return { text: '[tool_result]', toolName: null, files: [] };
  }
  return { text: '', toolName: null, files: [] };
}

function extractContent(message: unknown): {
  text: string;
  toolCalls: string[];
  files: string[];
} {
  if (!message || typeof message !== 'object') {
    return { text: '', toolCalls: [], files: [] };
  }
  const content = (message as { content?: unknown }).content;
  const toolCalls: string[] = [];
  const files: string[] = [];
  if (typeof content === 'string') {
    return { text: content, toolCalls, files };
  }
  if (!Array.isArray(content)) {
    return { text: '', toolCalls, files };
  }
  const parts: string[] = [];
  for (const block of content) {
    const { text, toolName, files: bf } = blockToText(block);
    if (text) parts.push(text);
    if (toolName) toolCalls.push(toolName);
    for (const f of bf) files.push(f);
  }
  return { text: parts.join('\n').trim(), toolCalls, files };
}

const CODE_BLOCK_RE = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;

function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    const block = match[1].trim();
    if (block.length > 0 && block.length < 20_000) blocks.push(block);
  }
  return blocks;
}

/**
 * Read and parse a Claude Code session JSONL file.
 *
 * Tolerates malformed lines (skips with a counter; never throws on a single
 * bad row). Returns null if the file has no recognizable messages at all.
 */
export async function parseSessionFile(
  filePath: string,
): Promise<ParsedSession | null> {
  const buffer = await fs.readFile(filePath);
  const content_hash = createHash('sha256').update(buffer).digest('hex');
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);

  let session_id: string | null = null;
  let cwd: string | null = null;
  let git_branch: string | null = null;
  let model: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const messages: ParsedMessage[] = [];
  let input_tokens = 0;
  let output_tokens = 0;
  let cache_read_tokens = 0;
  let cache_creation_tokens = 0;
  let ai_title: string | null = null;
  let summary: string | null = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof evt.sessionId === 'string' && !session_id) {
      session_id = evt.sessionId;
    }
    if (typeof evt.cwd === 'string' && !cwd) cwd = evt.cwd;
    if (typeof evt.gitBranch === 'string' && !git_branch) git_branch = evt.gitBranch;

    const ts = typeof evt.timestamp === 'string' ? evt.timestamp : null;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    const type = typeof evt.type === 'string' ? evt.type : null;
    if (type === 'ai-title' && typeof evt.title === 'string') {
      ai_title = evt.title;
      continue;
    }
    if (type === 'summary' && typeof evt.summary === 'string') {
      summary = evt.summary;
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue;

    const message = evt.message;
    if (!message || typeof message !== 'object') continue;
    if (type === 'assistant') {
      const m = message as { model?: unknown; usage?: Record<string, unknown> };
      if (typeof m.model === 'string') model = m.model;
      const usage = m.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        const i = Number(u.input_tokens);
        const o = Number(u.output_tokens);
        const cr = Number(u.cache_read_input_tokens ?? u.cache_read_tokens);
        const cc = Number(
          u.cache_creation_input_tokens ?? u.cache_creation_tokens,
        );
        if (Number.isFinite(i)) input_tokens += i;
        if (Number.isFinite(o)) output_tokens += o;
        if (Number.isFinite(cr)) cache_read_tokens += cr;
        if (Number.isFinite(cc)) cache_creation_tokens += cc;
      }
    }

    const { text: msgText, toolCalls, files } = extractContent(message);
    if (!msgText && toolCalls.length === 0) continue;
    const code_blocks =
      type === 'assistant' ? extractCodeBlocks(msgText) : [];
    messages.push({
      role: type,
      timestamp: ts ?? lastTs ?? new Date(0).toISOString(),
      text: msgText,
      code_blocks,
      files_touched: files,
      tool_calls: toolCalls,
    });
  }

  if (!session_id || messages.length === 0 || !firstTs || !lastTs) {
    return null;
  }

  return {
    session_id,
    cwd,
    git_branch,
    model,
    started_at: firstTs,
    ended_at: lastTs,
    messages,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_creation_tokens,
    ai_title,
    summary,
    content_hash,
    bytes: buffer.length,
  };
}
