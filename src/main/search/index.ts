/**
 * Full-text search engine (Wave 17 — search).
 *
 * Searches across every TaskPilot entity that carries human-meaningful text:
 *   - `task`       — title + description + agent_instructions
 *   - `decision`   — decision-log entry text
 *   - `execution`  — execution-log output (result summaries)
 *   - `attachment` — attachment filename (from `task.context.attachments`)
 *
 * Two backends, picked at boot:
 *   1. SQLite FTS5 (`search_index` virtual table) when the better-sqlite3 build
 *      ships FTS5 (the default). Ranked with `bm25()`, snippets via `snippet()`.
 *   2. LIKE-based scan over the source tables when FTS5 isn't compiled in.
 *      Ranked by a simple match-count heuristic, snippets built by hand.
 *
 * The public surface (`search`, `isFtsAvailable`) is identical regardless of
 * backend so callers never branch on it. The route layer just forwards the
 * `fts_available` flag so the UI can note degraded mode if it ever matters.
 *
 * Indexing (building/maintaining the FTS table) lives in `./indexer.ts`. This
 * module owns querying.
 */

import { getSqlite } from '@/main/db';
import { ensureSearchIndex } from '@/main/db/migrations';
import type {
  SearchEntityType,
  SearchResult,
} from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  FTS availability                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Forced-fallback override. When set to `false`, the engine pretends FTS5 is
 * unavailable regardless of the real build — used by the fallback test path.
 * `null` means "use the real probe". There is no `true` override: the table
 * still has to actually exist for FTS queries to work.
 */
let ftsForced: boolean | null = null;

/**
 * Returns true when FTS5 is available AND the `search_index` virtual table
 * exists on the *current* DB handle. We call `ensureSearchIndex` every time —
 * it's a cheap `CREATE VIRTUAL TABLE IF NOT EXISTS`, and crucially it ensures
 * the table exists on whatever DB is current (the per-test in-memory DB swaps
 * underneath us, so a process-lifetime cache would be wrong).
 *
 * Defensive: a missing DB handle (server boot before the mock DB is set) or a
 * non-FTS5 build → false (LIKE fallback). Honors the forced-fallback override.
 */
export function isFtsAvailable(): boolean {
  if (ftsForced === false) return false;
  try {
    return ensureSearchIndex(getSqlite());
  } catch {
    return false;
  }
}

/**
 * Test/boot hook. Call with no args to clear the forced-fallback override
 * (use the real probe again); call with `false` to pin the engine into LIKE
 * fallback mode for a test.
 */
export function resetSearchEngine(force?: boolean): void {
  ftsForced = force === undefined ? null : force;
}

/* -------------------------------------------------------------------------- */
/*  Query parsing                                                             */
/* -------------------------------------------------------------------------- */

const ALL_TYPES: readonly SearchEntityType[] = [
  'task',
  'decision',
  'execution',
  'attachment',
  'memory',
];

export interface SearchOptions {
  /** Restrict to these entity types. Empty / undefined → all types. */
  types?: SearchEntityType[];
  /** Max results. Defaults to 50, hard-capped at 200. */
  limit?: number;
}

/**
 * Sanitize a raw user query into a safe FTS5 MATCH expression.
 *
 * FTS5's query language treats `"`, `*`, `(`, `)`, `:`, `^`, `-`, `AND`, `OR`,
 * `NEAR` as operators. A naive interpolation of user text lets a stray quote
 * throw a syntax error (or worse, change semantics). We split the query into
 * bare word tokens (alphanumerics + a few inner punctuation chars), then wrap
 * each token in double quotes and append `*` for prefix matching. Tokens are
 * implicitly AND-ed (FTS5 default), so "reddit ads" matches rows containing
 * both terms.
 *
 * Returns `null` when the query has no usable tokens (caller returns []).
 */
function toFtsMatch(raw: string): string | null {
  const tokens = extractTokens(raw);
  if (tokens.length === 0) return null;
  // Escape embedded double quotes by doubling them (FTS5 string literal rule),
  // wrap in quotes to treat as a literal phrase token, then prefix-match.
  return tokens
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
}

/**
 * Pull bare search tokens out of a raw query. Keeps letters, digits, and a
 * couple of inner punctuation marks that show up in real text (`_`, `-`, `.`,
 * `/`); drops everything else (which would be FTS operators or noise).
 */
function extractTokens(raw: string): string[] {
  const matches = raw.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_./-]*/gu);
  if (!matches) return [];
  // De-dupe while preserving order; cap token count to keep the MATCH bounded.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (m.length === 0) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= 12) break;
  }
  return out;
}

function resolveTypes(types: SearchEntityType[] | undefined): SearchEntityType[] {
  if (!types || types.length === 0) return [...ALL_TYPES];
  const valid = types.filter((t): t is SearchEntityType =>
    (ALL_TYPES as readonly string[]).includes(t),
  );
  return valid.length > 0 ? valid : [...ALL_TYPES];
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

/* -------------------------------------------------------------------------- */
/*  Public query                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Run a full-text search. Returns ranked results (best first). Empty query or
 * no usable tokens → empty array. Never throws on a malformed query — input is
 * sanitized first.
 */
export function search(rawQuery: string, options: SearchOptions = {}): SearchResult[] {
  const query = (rawQuery ?? '').trim();
  if (query.length === 0) return [];

  const types = resolveTypes(options.types);
  const limit = clampLimit(options.limit);

  if (isFtsAvailable()) {
    return searchFts(query, types, limit);
  }
  return searchLike(query, types, limit);
}

/* -------------------------------------------------------------------------- */
/*  FTS5 backend                                                              */
/* -------------------------------------------------------------------------- */

interface FtsRow {
  entity_type: string;
  entity_id: string;
  task_id: string;
  title: string;
  matched_field: string;
  snippet: string;
  score: number;
}

function searchFts(
  query: string,
  types: SearchEntityType[],
  limit: number,
): SearchResult[] {
  const match = toFtsMatch(query);
  if (match === null) return [];

  const db = getSqlite();
  const typePlaceholders = types.map(() => '?').join(', ');

  // bm25() returns a negative-leaning relevance score (lower = better in
  // SQLite's convention). We order ascending and then flip the sign for the
  // public `score` so a *higher* score means a better match (more intuitive
  // for API consumers + UI sorting).
  //
  // snippet(table, columnIndex, openTag, closeTag, ellipsis, tokenCount). We
  // snippet over the `body` column (index 4); when a match was title-only the
  // body snippet may be empty, so we fall back to the title in JS.
  const sql = `
    SELECT
      entity_type,
      entity_id,
      task_id,
      title,
      matched_field,
      snippet(search_index, 4, '<mark>', '</mark>', '…', 12) AS snippet,
      bm25(search_index) AS score
    FROM search_index
    WHERE search_index MATCH ?
      AND entity_type IN (${typePlaceholders})
    ORDER BY score ASC
    LIMIT ?
  `;

  let rows: FtsRow[];
  try {
    rows = db.prepare(sql).all(match, ...types, limit) as FtsRow[];
  } catch {
    // A pathological query that still slipped past the sanitizer, or an FTS
    // build quirk. Degrade to the LIKE scan rather than 500.
    return searchLike(query, types, limit);
  }

  return rows.map((r) => {
    const snippet =
      r.snippet && r.snippet.trim().length > 0
        ? r.snippet
        : highlight(r.title, query);
    return {
      entity_type: r.entity_type as SearchEntityType,
      entity_id: r.entity_id,
      task_id: r.task_id,
      title: r.title,
      snippet,
      // Flip the sign so higher = better. bm25 is negative; -score is positive.
      score: Math.round(-r.score * 1000) / 1000,
      matched_field: r.matched_field,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  LIKE fallback backend                                                     */
/* -------------------------------------------------------------------------- */

interface LikeSourceRow {
  entity_type: SearchEntityType;
  entity_id: string;
  task_id: string;
  title: string;
  body: string;
  matched_field: string;
}

/**
 * LIKE-based scan used when FTS5 isn't compiled in. We read every candidate
 * row from the source tables, filter to rows that contain ALL query tokens
 * (case-insensitive substring) across title+body, score by total occurrence
 * count, and snippet by hand.
 *
 * This is O(rows) per query — fine for a local single-user DB. The FTS path is
 * the production path; this exists purely so a stripped SQLite build still
 * returns useful results instead of nothing.
 */
function searchLike(
  query: string,
  types: SearchEntityType[],
  limit: number,
): SearchResult[] {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return [];

  const candidates = collectLikeCandidates(types);
  const scored: Array<{ result: SearchResult; score: number }> = [];

  for (const row of candidates) {
    const titleLc = row.title.toLowerCase();
    const bodyLc = row.body.toLowerCase();
    const haystack = `${titleLc}\n${bodyLc}`;

    // Require every token to appear somewhere in title or body.
    let allMatch = true;
    let occurrences = 0;
    let titleHit = false;
    for (const token of tokens) {
      const count = countOccurrences(haystack, token);
      if (count === 0) {
        allMatch = false;
        break;
      }
      occurrences += count;
      if (titleLc.includes(token)) titleHit = true;
    }
    if (!allMatch) continue;

    // Score: occurrence count + a bonus when at least one token hit the title.
    const score = occurrences + (titleHit ? 5 : 0);

    // Snippet from the field that actually contains the first token; prefer
    // body (more context), fall back to title.
    const firstToken = tokens[0] ?? '';
    const snippetSource = bodyLc.includes(firstToken) ? row.body : row.title;
    const snippet = buildLikeSnippet(snippetSource, tokens);

    scored.push({
      result: {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        task_id: row.task_id,
        title: row.title,
        snippet,
        score,
        matched_field: row.matched_field,
      },
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.result);
}

/**
 * Gather every searchable row from the source tables for the LIKE scan. We
 * read directly via raw SQL (not the repos) to avoid pulling the full Task
 * object graph; only the columns we index are selected.
 */
function collectLikeCandidates(types: SearchEntityType[]): LikeSourceRow[] {
  const db = getSqlite();
  const wanted = new Set(types);
  const out: LikeSourceRow[] = [];

  if (wanted.has('task')) {
    const taskRows = db
      .prepare(
        'SELECT id, title, description, agent_instructions, context FROM tasks',
      )
      .all() as Array<{
      id: string;
      title: string;
      description: string | null;
      agent_instructions: string | null;
      context: string | null;
    }>;
    for (const t of taskRows) {
      const body = [t.description ?? '', t.agent_instructions ?? '']
        .filter(Boolean)
        .join('\n');
      out.push({
        entity_type: 'task',
        entity_id: t.id,
        task_id: t.id,
        title: t.title,
        body,
        matched_field: 'task',
      });

      if (wanted.has('attachment')) {
        for (const filename of extractAttachmentFilenames(t.context)) {
          out.push({
            entity_type: 'attachment',
            entity_id: `${t.id}:${filename}`,
            task_id: t.id,
            title: filename,
            body: filename,
            matched_field: 'filename',
          });
        }
      }
    }
  }

  if (wanted.has('decision')) {
    const decisionRows = db
      .prepare('SELECT id, task_id, category, text FROM decisions')
      .all() as Array<{
      id: string;
      task_id: string;
      category: string;
      text: string;
    }>;
    for (const d of decisionRows) {
      out.push({
        entity_type: 'decision',
        entity_id: d.id,
        task_id: d.task_id,
        title: `${capitalize(d.category)} note`,
        body: d.text,
        matched_field: 'decision',
      });
    }
  }

  if (wanted.has('execution')) {
    const execRows = db
      .prepare(
        "SELECT id, task_id, output FROM execution_logs WHERE output IS NOT NULL AND output <> ''",
      )
      .all() as Array<{ id: string; task_id: string; output: string }>;
    for (const e of execRows) {
      out.push({
        entity_type: 'execution',
        entity_id: e.id,
        task_id: e.task_id,
        title: 'Execution output',
        body: e.output,
        matched_field: 'output',
      });
    }
  }

  if (wanted.has('memory')) {
    // Memory items aren't tied to a task; `task_id` stays empty so the
    // result-renderer can branch on entity_type and link to `/memory/:id`.
    let memRows: Array<{
      id: string;
      title: string | null;
      summary: string | null;
      raw_content: string;
      source_url: string | null;
    }> = [];
    try {
      memRows = db
        .prepare(
          'SELECT id, title, summary, raw_content, source_url FROM memory_items',
        )
        .all() as typeof memRows;
    } catch {
      // Table may not exist on pre-v9 DBs — degrade quietly.
    }
    for (const m of memRows) {
      const body = [
        m.summary ?? '',
        m.source_url ?? '',
        // Cap raw body so a huge URL fetch doesn't dominate the LIKE scan.
        m.raw_content.slice(0, 64 * 1024),
      ]
        .filter((s) => s.length > 0)
        .join('\n');
      out.push({
        entity_type: 'memory',
        entity_id: m.id,
        task_id: '',
        title: m.title ?? m.summary?.slice(0, 120) ?? '(memory)',
        body,
        matched_field: 'memory',
      });
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Helpers (shared)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Extract attachment filenames from a task's JSON-stringified `context`.
 * Defensive: tolerates malformed JSON / unexpected shapes. Exported for the
 * indexer so both backends derive filenames identically.
 */
export function extractAttachmentFilenames(rawContext: string | null): string[] {
  if (!rawContext) return [];
  try {
    const parsed: unknown = JSON.parse(rawContext);
    if (!parsed || typeof parsed !== 'object') return [];
    const att = (parsed as Record<string, unknown>)['attachments'];
    if (!Array.isArray(att)) return [];
    const names: string[] = [];
    for (const entry of att) {
      if (entry && typeof entry === 'object') {
        const fn = (entry as Record<string, unknown>)['filename'];
        if (typeof fn === 'string' && fn.length > 0) names.push(fn);
      }
    }
    return names;
  } catch {
    return [];
  }
}

function countOccurrences(haystack: string, token: string): number {
  if (token.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(token);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(token, idx + token.length);
  }
  return count;
}

/**
 * Build a manual `<mark>`-highlighted snippet for the LIKE backend. Centers a
 * window around the first matched token and wraps every token occurrence in
 * `<mark>`. HTML-escapes the source first so user text can't inject markup.
 */
function buildLikeSnippet(source: string, tokens: string[]): string {
  const WINDOW = 160;
  const lower = source.toLowerCase();
  let firstIdx = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) firstIdx = idx;
  }
  const start = firstIdx === -1 ? 0 : Math.max(0, firstIdx - WINDOW / 2);
  const end = Math.min(source.length, start + WINDOW);
  let slice = source.slice(start, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  slice = escapeHtml(slice);
  slice = markTokens(slice, tokens);
  return `${prefix}${slice}${suffix}`;
}

/**
 * Wrap every (already HTML-escaped) snippet around a bare title with `<mark>`
 * on matching tokens. Used as the FTS-path fallback when `snippet()` returns
 * empty (title-only matches).
 */
function highlight(title: string, query: string): string {
  return markTokens(escapeHtml(title), extractTokens(query));
}

function markTokens(escaped: string, tokens: string[]): string {
  let out = escaped;
  for (const token of tokens) {
    if (token.length === 0) continue;
    const re = new RegExp(`(${escapeRegExp(escapeHtml(token))})`, 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
