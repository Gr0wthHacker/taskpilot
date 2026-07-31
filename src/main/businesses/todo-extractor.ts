/**
 * Pure helpers for the SessionEnd auto-derive flow.
 *
 * The interesting work — parsing a JSONL transcript, pulling text content
 * out of message frames, matching forward-looking lines — lives here so it
 * can be unit-tested without spawning the hook script. The script imports
 * these and supplies the filesystem layer.
 */

/**
 * Maximum messages from the tail of the session JSONL to scan. Tight bound
 * so the SessionEnd hook stays fast even on a giant transcript — the lines
 * we want almost always land in the final exchange.
 */
export const TODO_SCAN_TAIL_MESSAGES = 40;

/** Hard cap on inbox drops created by a single session. */
export const TODO_MAX_DROPS = 8;

/**
 * Match an explicit forward-looking line. Anchored to the line start so we
 * don't catch e.g. "the TODO list said". Bold markdown wrappers around the
 * label are tolerated. The captured group becomes the inbox title.
 */
export const TODO_LINE_RX =
  /^\s*(?:[-*]\s+)?(?:\*\*)?(?:TODO|Next step|Next|Tomorrow|Don't forget|Follow up|Action item|Action)(?:\*\*)?\s*[:\-—]\s*(.+?)\s*$/i;

export interface TodoMatch {
  title: string;
  rawLine: string;
}

/**
 * Pull plain-text out of a Claude Code message frame. Content can be a
 * string or an array of `{type, text}` blocks; anything that isn't a text
 * block (tool_use, tool_result, image, …) is dropped.
 */
export function extractMessageText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const obj = raw as Record<string, unknown>;
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text') {
        const text = (c as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Extract forward-looking lines from the *trailing* portion of a JSONL
 * transcript. Deduped by lowercased title — the same TODO mentioned twice
 * in one session only produces one drop. Caller decides what to do with
 * the matches (write inbox drops, post via API, etc.).
 */
export function extractTodos(
  jsonlText: string,
  opts: { tailMessages?: number; maxDrops?: number } = {},
): TodoMatch[] {
  const tailMessages = opts.tailMessages ?? TODO_SCAN_TAIL_MESSAGES;
  const maxDrops = opts.maxDrops ?? TODO_MAX_DROPS;
  const lines = jsonlText.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.slice(-tailMessages);
  const seen = new Set<string>();
  const out: TodoMatch[] = [];
  for (const jsonLine of tail) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      continue;
    }
    const textBlock = extractMessageText(parsed);
    if (!textBlock) continue;
    for (const physical of textBlock.split(/\r?\n/)) {
      const m = TODO_LINE_RX.exec(physical);
      if (!m) continue;
      const title = (m[1] ?? '').trim().slice(0, 280);
      if (title.length < 4) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, rawLine: physical.trim() });
      if (out.length >= maxDrops) return out;
    }
  }
  return out;
}
