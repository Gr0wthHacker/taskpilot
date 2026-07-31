/**
 * Tests for `src/main/security/egress-policy.ts`.
 *
 * The interceptor mutates `globalThis.fetch`, `http.request`, and
 * `https.request`, so we install/uninstall in beforeEach/afterEach to keep
 * the test isolation airtight. We also clear the escape-hatch env var at
 * the top of each test — global setup.ts may have set TASKPILOT_DISABLE_AUTH,
 * but that's not the egress hatch.
 *
 * No real network is touched anywhere in these tests — we sniff at the
 * wrapper boundary by calling the wrapped primitives with a host and
 * asserting whether they throw.
 */

import http from 'node:http';
import https from 'node:https';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALLOWED_HOSTNAMES,
  EgressBlocked,
  EgressViolation,
  assertEgressPolicy,
  isHostAllowed,
  isLoopbackHost,
  registerHttpInterceptor,
  unregisterHttpInterceptor,
} from '@/main/security/egress-policy';

const HATCH = 'TASKPILOT_DISABLE_EGRESS_GUARD';

beforeEach(() => {
  // Make sure no test sees a stale escape hatch from a sibling suite.
  delete process.env[HATCH];
  // Reset the interceptor so each test starts from a clean state.
  unregisterHttpInterceptor();
});

afterEach(() => {
  delete process.env[HATCH];
  unregisterHttpInterceptor();
});

describe('isLoopbackHost', () => {
  it('matches the canonical loopback names', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    // Whole 127.0.0.0/8 range
    expect(isLoopbackHost('127.0.0.55')).toBe(true);
  });

  it('rejects non-loopback hosts that merely contain 127', () => {
    expect(isLoopbackHost('127.example.com')).toBe(false);
    expect(isLoopbackHost('api.github.com')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('isHostAllowed (suffix-match semantics)', () => {
  it('passes an exact match on every allowlist entry', () => {
    for (const entry of ALLOWED_HOSTNAMES) {
      expect(isHostAllowed(entry)).toBe(true);
    }
  });

  it('passes subdomain matches', () => {
    // `googleapis.com` is in the allowlist; subdomains should suffix-match.
    expect(isHostAllowed('oauth2.googleapis.com')).toBe(true);
    expect(isHostAllowed('gmail.googleapis.com')).toBe(true);
    // `slack.com` is in the allowlist; api subdomains should match.
    expect(isHostAllowed('api.slack.com')).toBe(true);
  });

  it('is case-insensitive and tolerant of FQDN trailing dot', () => {
    expect(isHostAllowed('API.GITHUB.COM')).toBe(true);
    expect(isHostAllowed('api.github.com.')).toBe(true);
  });

  it('rejects hosts that are not on the allowlist', () => {
    expect(isHostAllowed('evil.example.com')).toBe(false);
    expect(isHostAllowed('notion.com')).toBe(false); // only api.notion.com is allowed
    expect(isHostAllowed('')).toBe(false);
    expect(isHostAllowed(null)).toBe(false);
  });

  it('rejects look-alike hosts that share a suffix substring (not a real subdomain)', () => {
    // Critical security property: `evilgithub.com` must NOT match `github.com`.
    expect(isHostAllowed('evilgithub.com')).toBe(false);
    expect(isHostAllowed('githubXcom')).toBe(false);
  });

  it('treats loopback as allowed regardless of the list', () => {
    expect(isHostAllowed('localhost')).toBe(true);
    expect(isHostAllowed('127.0.0.1')).toBe(true);
  });
});

describe('registerHttpInterceptor — runtime wrapping', () => {
  it('allows fetch to allowed hosts (does not throw before reaching the network)', async () => {
    registerHttpInterceptor();
    // We don't actually want to hit the network; we want to confirm the
    // wrapper does NOT throw `EgressBlocked` on an allowed host. To do that
    // cleanly, we set the escape hatch AFTER install — install captures the
    // gate-check inside the wrapper, but the gate reads the env var at call
    // time, so this flips it to a pass-through. That isolates "allowed host"
    // from "actual network reachability."
    //
    // Strategy: temporarily install a stub fetch BEFORE registering, then
    // verify the wrapper forwards to it.
    unregisterHttpInterceptor();
    let forwardedTo: string | null = null;
    const stub: typeof globalThis.fetch = async (input) => {
      forwardedTo = typeof input === 'string' ? input : String(input);
      return new Response('ok', { status: 200 });
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      registerHttpInterceptor();
      const res = await globalThis.fetch('https://api.github.com/user');
      expect(res.status).toBe(200);
      expect(forwardedTo).toBe('https://api.github.com/user');
    } finally {
      unregisterHttpInterceptor();
      globalThis.fetch = realFetch;
    }
  });

  it('blocks fetch to disallowed hosts with EgressBlocked', async () => {
    registerHttpInterceptor();
    await expect(globalThis.fetch('https://evil.example.com/api')).rejects.toMatchObject(
      {
        code: 'EGRESS_BLOCKED',
        host: 'evil.example.com',
      },
    );
  });

  it('blocks fetch when input is a URL object', async () => {
    registerHttpInterceptor();
    await expect(
      globalThis.fetch(new URL('https://evil.example.com/x')),
    ).rejects.toBeInstanceOf(EgressBlocked);
  });

  it('allows loopback fetch unconditionally', async () => {
    // Stub the underlying fetch so we can verify the wrapper FORWARDS the
    // call rather than throwing.
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('local', { status: 200 });
    };
    try {
      registerHttpInterceptor();
      const res = await globalThis.fetch('http://127.0.0.1:7847/api/health');
      expect(res.status).toBe(200);
      expect(called).toBe(true);
    } finally {
      unregisterHttpInterceptor();
      globalThis.fetch = realFetch;
    }
  });

  it('blocks https.request to a disallowed host', () => {
    registerHttpInterceptor();
    expect(() => https.request('https://evil.example.com/x')).toThrow(EgressBlocked);
  });

  it('blocks http.request to a disallowed host', () => {
    registerHttpInterceptor();
    expect(() => http.request('http://evil.example.com/x')).toThrow(EgressBlocked);
  });

  it('blocks options-style http.request calls (host field, no full URL)', () => {
    registerHttpInterceptor();
    expect(() => http.request({ host: 'evil.example.com', path: '/x' })).toThrow(
      EgressBlocked,
    );
  });

  it('honors the escape hatch — disallowed hosts pass through when guard is disabled', async () => {
    process.env[HATCH] = '1';
    // Stub the global fetch BEFORE installing, so we can verify forwarding.
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('passthrough', { status: 200 });
    };
    try {
      registerHttpInterceptor();
      const res = await globalThis.fetch('https://evil.example.com/x');
      expect(res.status).toBe(200);
      expect(called).toBe(true);
    } finally {
      unregisterHttpInterceptor();
      globalThis.fetch = realFetch;
    }
  });

  it('is idempotent — installing twice does not double-wrap', () => {
    expect(registerHttpInterceptor()).toBe(true);
    // Second call must return false (already installed) and not re-wrap.
    expect(registerHttpInterceptor()).toBe(false);
  });
});

describe('assertEgressPolicy — boot-time audit', () => {
  it('passes when there is no configuration', () => {
    expect(() => assertEgressPolicy({})).not.toThrow();
  });

  it('passes when telemetry endpoint is on the allowlist', () => {
    expect(() =>
      assertEgressPolicy({ telemetryEndpoint: 'https://api.anthropic.com/v1/log' }),
    ).not.toThrow();
  });

  it('passes when telemetry endpoint is loopback', () => {
    expect(() =>
      assertEgressPolicy({ telemetryEndpoint: 'http://127.0.0.1:8080/log' }),
    ).not.toThrow();
  });

  it('throws EgressViolation when telemetry endpoint is disallowed', () => {
    let caught: unknown = null;
    try {
      assertEgressPolicy({ telemetryEndpoint: 'https://evil.example.com/log' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EgressViolation);
    expect((caught as EgressViolation).reasons.join(' ')).toContain('evil.example.com');
  });

  it('throws when an outbound webhook points at a disallowed host', () => {
    expect(() =>
      assertEgressPolicy({
        webhookEndpoints: [
          'https://api.github.com/hook', // ok
          'https://evil.example.com/hook', // bad
        ],
      }),
    ).toThrow(EgressViolation);
  });

  it('throws when telemetry endpoint uses an unsupported protocol', () => {
    expect(() =>
      assertEgressPolicy({ telemetryEndpoint: 'file:///etc/passwd' }),
    ).toThrow(EgressViolation);
  });

  it('flags additional_allowlist entries that look like URLs', () => {
    expect(() =>
      assertEgressPolicy({ additionalAllowlist: ['https://api.github.com'] }),
    ).toThrow(EgressViolation);
  });

  it('escape hatch short-circuits the audit', () => {
    process.env[HATCH] = '1';
    expect(() =>
      assertEgressPolicy({ telemetryEndpoint: 'https://evil.example.com/log' }),
    ).not.toThrow();
  });
});
