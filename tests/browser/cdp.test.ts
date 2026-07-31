/**
 * CDP session manager tests.
 *
 * We mock chrome-remote-interface and `ensureChrome` so the suite stays
 * hermetic. The assertions cover:
 *   - openSession registers a session and records it as "last"
 *   - actions default to the most recent session when no id is passed
 *   - actions throw BrowserError when the session doesn't exist
 *   - closeSession tears down the client and removes it from the registry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chrome-remote-interface', () => {
  const lastInstance = { current: null as null | MockClient };
  interface MockClient {
    Page: {
      enable: ReturnType<typeof vi.fn>;
      navigate: ReturnType<typeof vi.fn>;
      captureScreenshot: ReturnType<typeof vi.fn>;
      loadEventFired: ReturnType<typeof vi.fn>;
    };
    Runtime: {
      enable: ReturnType<typeof vi.fn>;
      evaluate: ReturnType<typeof vi.fn>;
    };
    DOM: { enable: ReturnType<typeof vi.fn> };
    close: ReturnType<typeof vi.fn>;
  }

  const factory = vi.fn(async () => {
    const client: MockClient = {
      Page: {
        enable: vi.fn().mockResolvedValue(undefined),
        navigate: vi.fn().mockResolvedValue({ frameId: 'f1' }),
        captureScreenshot: vi
          .fn()
          .mockResolvedValue({ data: 'fake-base64-data' }),
        // Invoke the listener synchronously so waitForLoad resolves immediately.
        loadEventFired: vi.fn((cb: () => void) => {
          setImmediate(cb);
        }),
      },
      Runtime: {
        enable: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue({
          result: { type: 'object', value: { ok: true } },
        }),
      },
      DOM: { enable: vi.fn().mockResolvedValue(undefined) },
      close: vi.fn().mockResolvedValue(undefined),
    };
    lastInstance.current = client;
    return client;
  }) as unknown as {
    (...args: unknown[]): Promise<MockClient>;
    List: ReturnType<typeof vi.fn>;
    New: ReturnType<typeof vi.fn>;
    Close: ReturnType<typeof vi.fn>;
    Activate: ReturnType<typeof vi.fn>;
    Version: ReturnType<typeof vi.fn>;
  };

  let nextId = 1;
  factory.New = vi.fn(async (opts: { url?: string }) => ({
    id: `target-${nextId++}`,
    type: 'page',
    url: opts.url ?? 'about:blank',
    title: opts.url ? `Page ${opts.url}` : 'New Tab',
    webSocketDebuggerUrl: 'ws://x',
  }));
  factory.List = vi.fn(async () => []);
  factory.Close = vi.fn(async () => undefined);
  factory.Activate = vi.fn(async () => undefined);
  factory.Version = vi.fn(async () => ({
    Browser: 'HeadlessChrome/126',
    webSocketDebuggerUrl: 'ws://x',
  }));

  return { default: factory, ...factory, __lastInstance: lastInstance };
});

vi.mock('@/main/browser/chrome', () => ({
  ensureChrome: vi.fn(async () => ({
    port: 9222,
    binary: '/fake/chrome',
    pid: 1234,
    spawned: true,
  })),
  stopChrome: vi.fn(async () => undefined),
  CHROME_DEBUG_PORT: 9222,
  CHROME_PROFILE_DIR: '/tmp/chrome-profile',
  findChromeBinary: vi.fn(async () => '/fake/chrome'),
  currentHandle: vi.fn(() => null),
}));

import {
  captureScreenshot,
  clickSelector,
  closeAllSessions,
  closeSession,
  evalExpression,
  getText,
  listSessions,
  openSession,
  typeIntoSelector,
  BrowserError,
} from '@/main/browser/cdp';

beforeEach(async () => {
  await closeAllSessions();
});

afterEach(async () => {
  await closeAllSessions();
  vi.clearAllMocks();
});

describe('openSession', () => {
  it('creates a new target and registers a session', async () => {
    const session = await openSession('https://example.com/');
    expect(session.url).toBe('https://example.com/');
    expect(session.id).toMatch(/^target-/);
    expect(listSessions()).toHaveLength(1);
    expect(listSessions()[0]?.id).toBe(session.id);
  });

  it('tracks the most recent session as default', async () => {
    const a = await openSession('https://a.example/');
    const b = await openSession('https://b.example/');
    expect(listSessions()).toHaveLength(2);
    // Default-session ops should hit `b` (the most recent).
    const screenshot = await captureScreenshot({});
    expect(screenshot.session_id).toBe(b.id);
    // Pinning an id targets that session explicitly.
    const text = await getText({ sessionId: a.id });
    expect(text.session_id).toBe(a.id);
  });
});

describe('actions throw without a session', () => {
  it('captureScreenshot', async () => {
    await expect(captureScreenshot({})).rejects.toBeInstanceOf(BrowserError);
  });

  it('evalExpression', async () => {
    await expect(evalExpression('1+1', {})).rejects.toBeInstanceOf(
      BrowserError,
    );
  });

  it('clickSelector', async () => {
    await expect(clickSelector('#x', {})).rejects.toBeInstanceOf(BrowserError);
  });

  it('typeIntoSelector', async () => {
    await expect(
      typeIntoSelector('#x', 'hello', {}),
    ).rejects.toBeInstanceOf(BrowserError);
  });

  it('getText', async () => {
    await expect(getText({})).rejects.toBeInstanceOf(BrowserError);
  });
});

describe('actions throw for unknown session id', () => {
  it('throws BrowserError with browser_session_not_found', async () => {
    const err = await captureScreenshot({ sessionId: 'no-such-id' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(BrowserError);
    expect((err as BrowserError).code).toBe('browser_session_not_found');
  });
});

describe('closeSession', () => {
  it('removes the session and returns closed: true', async () => {
    const session = await openSession('https://example.com/');
    expect(listSessions()).toHaveLength(1);
    const result = await closeSession(session.id);
    expect(result.closed).toBe(true);
    expect(listSessions()).toHaveLength(0);
  });

  it('closing the last session also resets lastSessionId', async () => {
    const session = await openSession('https://example.com/');
    await closeSession(session.id);
    await expect(getText({})).rejects.toThrow(/No active browser session/);
  });

  it('returns closed: false when the session is unknown', async () => {
    const result = await closeSession('phantom-id');
    expect(result.closed).toBe(false);
  });
});

describe('clickSelector', () => {
  it('returns clicked: true when Runtime.evaluate reports ok', async () => {
    const session = await openSession('https://example.com/');
    const result = await clickSelector('button.primary', {
      sessionId: session.id,
    });
    expect(result).toEqual({ session_id: session.id, clicked: true });
  });
});
