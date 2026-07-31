/**
 * Sensitive-content matcher + redactor.
 *
 * Shared module used by every persistence path that may otherwise store
 * a screen-grabbed title, URL, or extension-scraped page metadata that
 * reveals credentials, banking surfaces, OAuth flows, or other obvious
 * PII red flags. The matcher is a single compiled regex (default + user
 * override) applied case-insensitively to each candidate field; the
 * redactor swaps any matching text for a fixed placeholder so the row
 * still flows through the system (so the Watch view can show a "redacted"
 * badge and the deliberator can still count it) but the raw bytes never
 * land on disk.
 *
 * Consumers:
 *   - `monitor/index.ts#tickWindow` — redacts `window_title` before
 *     `contextObservationsRepository.create()`.
 *   - `monitor/index.ts#tickScreenshot` — gates the capture entirely
 *     (no screenshot is even written when the pattern matches).
 *   - `server/routes/context.ts` `POST /capture` and `POST /capture/batch`
 *     — redacts the browser extension's `page_title`, `h1`,
 *     `meta_description`, `selection`, `window_title`, and URL query
 *     string before persisting.
 *   - `monitor/index.ts` re-exports `matchesSensitivePattern` and
 *     `__resetSensitivePatternCacheForTests` for backward compatibility
 *     with the existing tests and any external imports that landed
 *     before the extraction.
 *
 * Why a single module?
 *   - One source of truth for the regex (the design contract: "DO NOT
 *     duplicate the pattern; import it").
 *   - One cache, keyed by regex source, so a Settings-driven override
 *     takes effect across every consumer on the next call without an
 *     explicit reset.
 *   - One place to extend the pattern when a new privacy category shows
 *     up (e.g. crypto wallets, MFA codes), with the matching test file
 *     to mirror every new behaviour.
 *
 * The matcher is a pure function aside from the lazy module-scoped
 * cache; it never touches the DB, the filesystem, or the network.
 */

import { settingsRepository } from '@/main/db/repositories/settings';

/* -------------------------------------------------------------------------- */
/*  Setting key + default pattern                                             */
/* -------------------------------------------------------------------------- */

/**
 * Setting key that holds the user-supplied "sensitive content" regex source.
 * When unset, empty, or malformed, we fall back to
 * {@link DEFAULT_SENSITIVE_PATTERN_SOURCE}.
 */
export const KEY_SENSITIVE_PATTERN = 'ambient_screenshot_sensitive_pattern';

/**
 * Placeholder text written in place of any matching field. Kept as a
 * module-level const so the Watch view (and any future consumer) can
 * match against the exact string when rendering a "redacted" badge.
 */
export const REDACTION_PLACEHOLDER = '[redacted-sensitive]';

/**
 * Default pattern used when the user has not configured one (or has
 * configured an invalid regex). Catches the obvious privacy hotspots a
 * monitor capture must NEVER end up storing:
 *
 *   - password managers (1Password, Bitwarden, LastPass, Authenticator)
 *   - banking surfaces (Bank of America, anything labelled "Banking")
 *   - OAuth / sign-in / login flows
 *   - explicit secret / token / api-key language
 *
 * Designed to err toward false positives (redact the field) rather than
 * false negatives (capture credentials). Tuned against the unit tests in
 * `tests/main/monitor/sensitive-pattern.test.ts` — update both together
 * if you add a category.
 */
export const DEFAULT_SENSITIVE_PATTERN_SOURCE =
  '\\b1password\\b|\\bbitwarden\\b|\\blastpass\\b|\\bauthenticator\\b|' +
  '\\bbank\\s+of\\s+america\\b|\\bbanking\\b|' +
  '\\bsign[- ]?in\\b|\\blogin\\b|\\boauth\\b|' +
  '\\bsecret\\b|\\btoken\\b|\\bapi[ -]?key\\b|\\bpersonal\\s+access\\s+token\\b';

/* -------------------------------------------------------------------------- */
/*  Cache                                                                     */
/* -------------------------------------------------------------------------- */

interface SensitivePatternCache {
  /** The raw source string used to compile {@link regex}. */
  source: string;
  /** Compiled regex; always case-insensitive. */
  regex: RegExp;
  /** Whether the cache reflects the default pattern (vs a user-supplied one). */
  isDefault: boolean;
}

let sensitivePatternCache: SensitivePatternCache | null = null;

function compileDefaultSensitivePattern(): SensitivePatternCache {
  return {
    source: DEFAULT_SENSITIVE_PATTERN_SOURCE,
    regex: new RegExp(DEFAULT_SENSITIVE_PATTERN_SOURCE, 'i'),
    isDefault: true,
  };
}

/**
 * Resolve the active sensitive-content regex, honoring the user's setting
 * when valid and falling back to the default otherwise. Result is cached
 * keyed on the source string so a Settings-pane edit takes effect on the
 * next call without an explicit reset (the cache compares source strings
 * and recompiles on mismatch).
 *
 * Exposed for callers that want the source string for diagnostics; the
 * common path just goes through {@link matchesSensitivePattern}.
 */
export function getSensitivePattern(): SensitivePatternCache {
  let configured: unknown = null;
  try {
    configured = settingsRepository.get<unknown>(KEY_SENSITIVE_PATTERN);
  } catch {
    // Settings repo unavailable (e.g. during shutdown). Fall back silently.
  }
  const sourceFromSetting =
    typeof configured === 'string' && configured.length > 0 ? configured : null;

  // No setting / empty setting → use the default. Reuse the cache when it's
  // already the default; otherwise (re)compile.
  if (sourceFromSetting === null) {
    if (sensitivePatternCache && sensitivePatternCache.isDefault) {
      return sensitivePatternCache;
    }
    sensitivePatternCache = compileDefaultSensitivePattern();
    return sensitivePatternCache;
  }

  // Setting present. If the cache already reflects the same source, reuse it.
  if (
    sensitivePatternCache &&
    !sensitivePatternCache.isDefault &&
    sensitivePatternCache.source === sourceFromSetting
  ) {
    return sensitivePatternCache;
  }

  try {
    sensitivePatternCache = {
      source: sourceFromSetting,
      regex: new RegExp(sourceFromSetting, 'i'),
      isDefault: false,
    };
    return sensitivePatternCache;
  } catch {
    // Invalid user-supplied regex — fall back to the default and cache that.
    sensitivePatternCache = compileDefaultSensitivePattern();
    return sensitivePatternCache;
  }
}

/* -------------------------------------------------------------------------- */
/*  Matcher                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Input shape for the object-form of {@link matchesSensitivePattern}. All
 * fields optional — pass whichever the call site has available. Each is
 * checked independently and case-insensitively; an empty / null / missing
 * field is treated as a non-match.
 */
export interface SensitiveMatchFields {
  /** Window title (desktop) or page title (browser). */
  title?: string | null;
  /** Process / app name (e.g. "chrome", "1Password"). */
  app_name?: string | null;
  /** Full URL — host + path + query are all candidate match surfaces. */
  url?: string | null;
  /** Page title alias — kept distinct from `title` for browser-side captures. */
  pageTitle?: string | null;
  /** Optional `<h1>` text scraped by the browser extension. */
  h1?: string | null;
  /** Optional `<meta name="description">` content. */
  meta_description?: string | null;
  /** Optional user-selected text. */
  selection?: string | null;
}

/**
 * Return true when ANY of the provided fields trips the active sensitive-
 * content regex. The match is case-insensitive; null / empty / missing
 * fields are non-matching.
 *
 * Two call forms are supported for backward compatibility with the
 * pre-extraction call sites and tests:
 *
 *   - Object form (preferred): `matchesSensitivePattern({ title, app_name, url, ... })`
 *   - Positional form (legacy): `matchesSensitivePattern(appName, windowTitle)`
 *
 * Used by:
 *   - {@link redactSensitiveText} (this module).
 *   - `monitor/index.ts#tickWindow` to redact `window_title`.
 *   - `monitor/index.ts#tickScreenshot` to gate the capture.
 *   - `server/routes/context.ts` `/capture` to redact extension intake.
 *
 * Pure function aside from the lazy regex cache read.
 */
export function matchesSensitivePattern(fields: SensitiveMatchFields): boolean;
export function matchesSensitivePattern(
  appName: string | null | undefined,
  windowTitle: string | null | undefined,
): boolean;
export function matchesSensitivePattern(
  fieldsOrAppName: SensitiveMatchFields | string | null | undefined,
  maybeWindowTitle?: string | null,
): boolean {
  const { regex } = getSensitivePattern();
  const candidates: Array<string | null | undefined> =
    typeof fieldsOrAppName === 'object' && fieldsOrAppName !== null
      ? [
          fieldsOrAppName.title,
          fieldsOrAppName.app_name,
          fieldsOrAppName.url,
          fieldsOrAppName.pageTitle,
          fieldsOrAppName.h1,
          fieldsOrAppName.meta_description,
          fieldsOrAppName.selection,
        ]
      : [fieldsOrAppName as string | null | undefined, maybeWindowTitle];

  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    if (value.length === 0) continue;
    if (regex.test(value)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Redactor                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Return `replacement` if `text` matches the active sensitive-content
 * regex; otherwise return `text` unchanged. `null`, `undefined`, and the
 * empty string pass through untouched (nothing sensitive to redact).
 *
 * This is the canonical write-side guard: every persistence path that
 * stores a user-visible string should run it through this helper before
 * hitting the DB.
 *
 * @param text — value to inspect (may be null/undefined).
 * @param replacement — placeholder, default {@link REDACTION_PLACEHOLDER}.
 */
export function redactSensitiveText(
  text: string | null | undefined,
  replacement: string = REDACTION_PLACEHOLDER,
): string | null | undefined {
  if (text === null || text === undefined) return text;
  if (text.length === 0) return text;
  const { regex } = getSensitivePattern();
  if (regex.test(text)) return replacement;
  return text;
}

/**
 * Strip the query string + fragment from a URL whose surrounding context
 * has been flagged as sensitive. Keeps the origin + path so the row still
 * conveys "user was on bank-of-america.com" without leaking session
 * tokens, account numbers, or OAuth `state` / `code` parameters that
 * commonly ride in the query.
 *
 * If `url` isn't parseable (e.g. internal scheme, relative path), falls
 * back to a coarse split on `?` / `#` so we never throw and always
 * return a truncated string.
 */
export function stripQueryAndFragment(
  url: string | null | undefined,
): string | null | undefined {
  if (url === null || url === undefined) return url;
  if (url.length === 0) return url;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    // Drop trailing "?" / "#" that URL.toString() preserves on some hosts.
    return parsed.toString().replace(/[?#]+$/, '');
  } catch {
    const qIdx = url.indexOf('?');
    const hIdx = url.indexOf('#');
    const cut = [qIdx, hIdx].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    if (cut === undefined) return url;
    return url.slice(0, cut);
  }
}

/* -------------------------------------------------------------------------- */
/*  Test hook                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Drop the compiled regex cache so the next call to
 * {@link matchesSensitivePattern} or {@link getSensitivePattern} re-reads
 * the setting and recompiles. Production code never needs this — the
 * cache self-invalidates when the source string changes — but tests want
 * determinism between cases.
 */
export function __resetSensitivePatternCacheForTests(): void {
  sensitivePatternCache = null;
}
