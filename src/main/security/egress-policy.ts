/**
 * Boot-time egress auditor + runtime HTTP interceptor.
 *
 * Goal: every outbound network call from the main process must resolve to a
 * hostname on `ALLOWED_HOSTNAMES` (or one of the loopback exceptions). The
 * allowlist is the union of the integrations TaskPilot actually uses —
 * Google APIs (Calendar/Gmail), GitHub, Slack, Notion, Reddit, search
 * adapters (Brave, Serper, DuckDuckGo), the Anthropic API, plus loopback for
 * the local API server (:7847) and the Chrome remote-debugging port (:9222).
 *
 * Two surfaces:
 *
 *   - `assertEgressPolicy()` — deterministic boot-time audit. Throws an
 *     `EgressViolation` if a static piece of configuration would already
 *     contradict the policy (e.g., a telemetry endpoint pointed at a host
 *     that's not on the allowlist). Does NOT make any outbound probes; the
 *     purpose is to fail fast on configuration drift, not to validate
 *     reachability.
 *
 *   - `registerHttpInterceptor()` — wraps Node's `http.request`, `https.request`
 *     (and their `.get` shortcuts) plus `globalThis.fetch`, so that any call
 *     whose URL doesn't suffix-match the allowlist is refused at the network
 *     layer. Integration libraries (Octokit, @slack/web-api, @notionhq/client,
 *     googleapis) all flow through these primitives, so a single hook gates
 *     them all.
 *
 * Escape hatch: `TASKPILOT_DISABLE_EGRESS_GUARD=1` short-circuits both calls
 * for development / tests / smoke runs. The wrapper still installs (so the
 * `isInstalled` flag is correct) but every URL is allowed.
 *
 * Failure mode is closed: a blocked request throws `EgressBlocked` (code
 * `EGRESS_BLOCKED`), which integrations' existing classifyXError() branches
 * map to a 502 response. The local JSONL telemetry log is untouched, so
 * blocked telemetry uploads simply queue locally — no data is lost.
 */

import http from 'node:http';
import https from 'node:https';

/**
 * Hostnames TaskPilot is allowed to talk to. Suffix-matched: an entry of
 * `googleapis.com` matches `oauth2.googleapis.com`, `gmail.googleapis.com`,
 * etc. The base `*.googleapis.com` host is therefore covered by a single
 * entry; the more-specific entries are kept for documentation purposes and
 * because some adapters reach them directly.
 *
 * Loopback (`127.0.0.1`, `localhost`, `::1`) is handled separately via
 * `isLoopbackHost()` — it is unconditionally allowed regardless of this
 * list.
 */
export const ALLOWED_HOSTNAMES: readonly string[] = Object.freeze([
  // Anthropic — only relevant if a future feature ships an in-app caller;
  // listed for forward-compat. The current app shells out to Claude Code.
  'api.anthropic.com',

  // Google OAuth + APIs (Calendar, Gmail, generic googleapis surface)
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'gmail.googleapis.com',
  'calendar.googleapis.com',
  'googleapis.com',
  'accounts.google.com',

  // GitHub (Octokit hits api.github.com; raw.githubusercontent for asset
  // fetches the user might trigger via web/fetch)
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',

  // Slack
  'slack.com',

  // Notion
  'api.notion.com',

  // Reddit (read-only JSON API + OAuth surface for future use)
  'www.reddit.com',
  'oauth.reddit.com',
  'reddit.com',

  // Search adapters
  'api.search.brave.com',
  'google.serper.dev',
  'api.duckduckgo.com',
]);

/**
 * Code attached to thrown errors so existing classify*Error helpers can map
 * to a stable HTTP status (502) without string-matching.
 */
export const EGRESS_BLOCKED_CODE = 'EGRESS_BLOCKED' as const;

/**
 * Thrown by the interceptor when a request targets a disallowed host.
 * Carries the offending hostname so callers can render a useful message.
 */
export class EgressBlocked extends Error {
  readonly code = EGRESS_BLOCKED_CODE;
  readonly host: string;
  constructor(host: string) {
    super(`egress blocked: host not on allowlist: ${host}`);
    this.name = 'EgressBlocked';
    this.host = host;
  }
}

/**
 * Thrown by `assertEgressPolicy()` when boot-time configuration would
 * contradict the policy. Distinct from `EgressBlocked` because this fires
 * during startup, not on a per-request basis, and the right thing to do is
 * dialog the user and exit.
 */
export class EgressViolation extends Error {
  readonly code = 'EGRESS_VIOLATION' as const;
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`egress policy violation:\n - ${reasons.join('\n - ')}`);
    this.name = 'EgressViolation';
    this.reasons = reasons;
  }
}

/**
 * Cheap check for `TASKPILOT_DISABLE_EGRESS_GUARD=1`. We accept "1", "true",
 * "yes" (case-insensitive) so users can flip it from .env or PowerShell
 * without surprises.
 */
export function isEgressGuardDisabled(): boolean {
  const raw = process.env.TASKPILOT_DISABLE_EGRESS_GUARD;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Loopback exceptions. Anything pointing at the local machine — by hostname
 * or by IPv4/IPv6 literal — is allowed unconditionally. This covers the
 * built-in API server (127.0.0.1:7847) and the Chrome remote-debugging port
 * (127.0.0.1:9222) without needing to enumerate ports.
 */
export function isLoopbackHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase().trim();
  if (h === 'localhost') return true;
  if (h === '127.0.0.1') return true;
  if (h === '::1' || h === '[::1]') return true;
  // IPv4 127.0.0.0/8 — covers anything in the loopback range.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Suffix-match the hostname against the allowlist. An entry of
 * `googleapis.com` matches `googleapis.com` itself and any subdomain
 * (`oauth2.googleapis.com`). Match is case-insensitive on the host portion.
 */
export function isHostAllowed(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  if (isLoopbackHost(hostname)) return true;
  const h = hostname.toLowerCase().trim();
  // Strip a trailing dot if the URL parser hands us a FQDN with one.
  const canonical = h.endsWith('.') ? h.slice(0, -1) : h;
  for (const entry of ALLOWED_HOSTNAMES) {
    const e = entry.toLowerCase();
    if (canonical === e) return true;
    if (canonical.endsWith(`.${e}`)) return true;
  }
  return false;
}

/**
 * Extract a hostname from anything the http / https / fetch APIs accept as
 * a target. Returns `null` when we can't determine a host — callers should
 * treat that as "deny" if strict, "allow" if the URL is clearly local
 * (handled at the call site).
 */
function extractHostname(
  input:
    | string
    | URL
    | http.RequestOptions
    | https.RequestOptions
    | Request
    | { url?: string; host?: string; hostname?: string },
): string | null {
  if (!input) return null;
  if (typeof input === 'string') {
    try {
      return new URL(input).hostname;
    } catch {
      return null;
    }
  }
  if (input instanceof URL) {
    return input.hostname;
  }
  // `Request` (from fetch). Guard with structural check so we don't require
  // the DOM lib in this file.
  if (
    typeof (input as { url?: unknown }).url === 'string' &&
    !('host' in input) &&
    !('hostname' in input)
  ) {
    try {
      return new URL((input as { url: string }).url).hostname;
    } catch {
      return null;
    }
  }
  // http.RequestOptions / https.RequestOptions
  const opts = input as {
    hostname?: string | null;
    host?: string | null;
    href?: string;
  };
  if (opts.hostname && typeof opts.hostname === 'string') {
    return opts.hostname;
  }
  if (opts.host && typeof opts.host === 'string') {
    // host may be "example.com:8080" — strip the port.
    const idx = opts.host.indexOf(':');
    return idx === -1 ? opts.host : opts.host.slice(0, idx);
  }
  return null;
}

/**
 * Module-level flag so re-entering `registerHttpInterceptor()` (e.g., from
 * tests) is idempotent. The original primitives are stashed here too so
 * tests can `unregisterHttpInterceptor()` if they need to.
 */
let installed = false;
let originalHttpRequest: typeof http.request | null = null;
let originalHttpGet: typeof http.get | null = null;
let originalHttpsRequest: typeof https.request | null = null;
let originalHttpsGet: typeof https.get | null = null;
let originalFetch: typeof globalThis.fetch | null = null;

/**
 * Returns true iff `registerHttpInterceptor()` has installed its wrappers.
 * Surfaced for tests and for the boot log line.
 */
export function isInterceptorInstalled(): boolean {
  return installed;
}

/**
 * Enforce the policy on a single hostname. Returns the host if allowed,
 * throws `EgressBlocked` otherwise. Centralizes the warn-then-throw pattern
 * so http/https/fetch wrappers share an identical failure mode.
 */
function enforceHost(host: string | null, context: string): void {
  if (isEgressGuardDisabled()) return;
  if (host && isHostAllowed(host)) return;
  const offending = host ?? '<unknown>';
  // eslint-disable-next-line no-console
  console.warn(
    `[taskpilot][egress] blocking ${context} to ${offending} — not on allowlist`,
  );
  throw new EgressBlocked(offending);
}

/**
 * Wrap `http.request`, `http.get`, `https.request`, `https.get`, and
 * `globalThis.fetch` so any disallowed host is refused. Idempotent:
 * subsequent calls are no-ops once installed.
 *
 * Returns `true` if the wrappers were freshly installed, `false` if a
 * previous call already installed them or the escape hatch is set (in which
 * case we still mark `installed` so the boot log line is honest, but the
 * wrappers no-op on every URL).
 */
export function registerHttpInterceptor(): boolean {
  if (installed) return false;
  installed = true;

  // Stash originals so wrappers can call through. We intentionally bind to
  // the module to preserve `this` for libraries that pass options as a
  // first argument.
  originalHttpRequest = http.request.bind(http);
  originalHttpGet = http.get.bind(http);
  originalHttpsRequest = https.request.bind(https);
  originalHttpsGet = https.get.bind(https);
  originalFetch = globalThis.fetch?.bind(globalThis) ?? null;

  // --- http.request / http.get ------------------------------------------
  // Signature is variadic — first arg is either a URL string, a URL object,
  // or an options object. We don't reimplement that switch; we just sniff
  // the first arg, enforce, and forward.
  const wrappedHttpRequest = ((...args: unknown[]) => {
    const host = extractHostname(args[0] as Parameters<typeof extractHostname>[0]);
    enforceHost(host, 'http.request');
    // Forward verbatim. The cast preserves the overload return type.
    return (originalHttpRequest as unknown as (...a: unknown[]) => http.ClientRequest)(
      ...args,
    );
  }) as typeof http.request;

  const wrappedHttpGet = ((...args: unknown[]) => {
    const host = extractHostname(args[0] as Parameters<typeof extractHostname>[0]);
    enforceHost(host, 'http.get');
    return (originalHttpGet as unknown as (...a: unknown[]) => http.ClientRequest)(
      ...args,
    );
  }) as typeof http.get;

  const wrappedHttpsRequest = ((...args: unknown[]) => {
    const host = extractHostname(args[0] as Parameters<typeof extractHostname>[0]);
    enforceHost(host, 'https.request');
    return (originalHttpsRequest as unknown as (...a: unknown[]) => http.ClientRequest)(
      ...args,
    );
  }) as typeof https.request;

  const wrappedHttpsGet = ((...args: unknown[]) => {
    const host = extractHostname(args[0] as Parameters<typeof extractHostname>[0]);
    enforceHost(host, 'https.get');
    return (originalHttpsGet as unknown as (...a: unknown[]) => http.ClientRequest)(
      ...args,
    );
  }) as typeof https.get;

  http.request = wrappedHttpRequest;
  http.get = wrappedHttpGet;
  https.request = wrappedHttpsRequest;
  https.get = wrappedHttpsGet;

  // --- fetch ------------------------------------------------------------
  // node-fetch (if used) and Octokit's transport reuse the global fetch on
  // Node >= 18, so wrapping `globalThis.fetch` covers them. The wrapper
  // returns a Promise so a sync `throw` still surfaces as a rejection.
  if (originalFetch) {
    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
      const host = extractHostname(
        input as Parameters<typeof extractHostname>[0],
      );
      enforceHost(host, 'fetch');
      // Forward to the original. Cast is safe — types are identical.
      return (originalFetch as typeof globalThis.fetch)(input, init);
    };
    globalThis.fetch = wrappedFetch;
  }

  return true;
}

/**
 * Restore the original http/https/fetch primitives. Exposed for tests so
 * one suite's interceptor doesn't leak into the next. Real boot never calls
 * this.
 */
export function unregisterHttpInterceptor(): void {
  if (!installed) return;
  if (originalHttpRequest) http.request = originalHttpRequest;
  if (originalHttpGet) http.get = originalHttpGet;
  if (originalHttpsRequest) https.request = originalHttpsRequest;
  if (originalHttpsGet) https.get = originalHttpsGet;
  if (originalFetch) globalThis.fetch = originalFetch;
  originalHttpRequest = null;
  originalHttpGet = null;
  originalHttpsRequest = null;
  originalHttpsGet = null;
  originalFetch = null;
  installed = false;
}

/**
 * Inputs to `assertEgressPolicy()`. Centralized here so callers (main.ts,
 * tests) construct the same shape and so the function stays pure (no DB
 * reads inside — the caller is responsible for collecting the snapshot).
 *
 * All fields are optional: missing data is treated as "no configuration",
 * not as a violation.
 */
export interface EgressPolicyInputs {
  /** Value of the `telemetry_endpoint` setting, if any. */
  telemetryEndpoint?: string | null;
  /** Value of `webhook` endpoints, if any. Outbound webhooks must also
   *  comply with the allowlist (the inbound dispatcher is separate). */
  webhookEndpoints?: readonly string[] | null;
  /** Additive user-supplied hosts (e.g., `ambient_egress_allowlist`).
   *  Currently not honored — kept on the interface so wiring it later is a
   *  one-line change and so we can warn if the user has added entries that
   *  look unsafe. */
  additionalAllowlist?: readonly string[] | null;
}

/**
 * Validate a single URL against the policy. Returns an error reason string
 * if the URL is unsafe, `null` otherwise. Used by `assertEgressPolicy()`.
 */
function reasonIfUnsafe(label: string, url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${label} is not a valid URL: ${url}`;
  }
  // Allow only http/https — file:// or javascript: URLs as endpoints are
  // categorically wrong here.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${label} uses unsupported protocol: ${parsed.protocol}`;
  }
  if (isLoopbackHost(parsed.hostname)) return null;
  if (!isHostAllowed(parsed.hostname)) {
    return `${label} points at disallowed host: ${parsed.hostname}`;
  }
  return null;
}

/**
 * Boot-time audit. Throws `EgressViolation` if any of the supplied static
 * configuration values would be refused by the runtime interceptor. Safe to
 * call before the interceptor is installed — this function does NOT touch
 * the network.
 *
 * The escape hatch (`TASKPILOT_DISABLE_EGRESS_GUARD=1`) short-circuits this
 * check. Tests and dev runs can disable both halves with one env var.
 */
export function assertEgressPolicy(inputs: EgressPolicyInputs = {}): void {
  if (isEgressGuardDisabled()) return;
  const reasons: string[] = [];

  const telemetryReason = reasonIfUnsafe(
    'telemetry_endpoint',
    inputs.telemetryEndpoint ?? null,
  );
  if (telemetryReason) reasons.push(telemetryReason);

  if (inputs.webhookEndpoints) {
    for (const url of inputs.webhookEndpoints) {
      const r = reasonIfUnsafe('outbound webhook', url);
      if (r) reasons.push(r);
    }
  }

  // The additionalAllowlist is informational for now — warn (via reason) if
  // an entry looks like a URL rather than a hostname, which is a common
  // misconfiguration.
  if (inputs.additionalAllowlist) {
    for (const entry of inputs.additionalAllowlist) {
      if (entry.includes('://') || entry.includes('/')) {
        reasons.push(
          `additional_allowlist entry "${entry}" looks like a URL — expected a bare hostname`,
        );
      }
    }
  }

  if (reasons.length > 0) {
    throw new EgressViolation(reasons);
  }
}
