/**
 * Tests for the window-tick redaction path in `src/main/monitor/index.ts`.
 *
 * The window poller persists EVERY tick — even when the title trips the
 * sensitive-content regex — because the batcher's context-shift counter
 * needs the row and the Watch view shows a "redacted" badge so the user
 * can see what just got masked. The contract:
 *
 *   - Sensitive title (e.g. "1Password — Vault") → `window_title` is
 *     replaced with the literal placeholder `[redacted-sensitive]` and
 *     `metadata.sensitive_pattern_match` is set to `true`.
 *   - Neutral title (e.g. "vscode - main.ts") → row is passed through
 *     untouched; metadata only carries `process_path` if the probe had one.
 *   - `app_name` is left intact in BOTH cases (low PII, and the matcher
 *     already factored it in when deciding whether to redact).
 *
 * We exercise the tick by mocking `getActiveWindow` to return canned
 * probes, mocking `contextObservationsRepository.create` to capture the
 * row the tick would persist, then driving the timer with vitest's fake
 * timers. No DB, no Electron, no PowerShell — just the redaction logic
 * end-to-end through the public `startMonitor()` surface.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/* -------------------------------------------------------------------------- */
/*  Mocks (must be set up BEFORE the module under test is imported)           */
/* -------------------------------------------------------------------------- */

const settingsStore: Record<string, unknown> = {};
vi.mock('@/main/db/repositories/settings', () => ({
  settingsRepository: {
    get: <T = unknown>(key: string): T | null => {
      const value = settingsStore[key];
      return value === undefined ? null : (value as T);
    },
    set: (key: string, value: unknown): void => {
      settingsStore[key] = value;
    },
    delete: (key: string): boolean => {
      const had = key in settingsStore;
      delete settingsStore[key];
      return had;
    },
    getAll: (): Record<string, unknown> => ({ ...settingsStore }),
  },
}));

// The repository is mocked to a spy so we can read back the exact row the
// tick would have persisted.
const createMock = vi.fn();
vi.mock('@/main/db/repositories/context-observations', () => ({
  contextObservationsRepository: {
    create: (...args: unknown[]) => createMock(...args),
    insertMany: vi.fn(),
    markBatched: vi.fn(),
    delete: vi.fn(),
    deleteOlderThan: vi.fn(),
    get: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    count: vi.fn(),
    getLast: vi.fn(),
  },
}));

// Drive `getActiveWindow()` from the test by swapping its mock per-case.
const getActiveWindowMock = vi.fn();
vi.mock('@/main/monitor/active-window', () => ({
  getActiveWindow: () => getActiveWindowMock(),
}));

// Don't run real screenshot capture; the screenshot tick is irrelevant here
// but the monitor still imports the module.
vi.mock('@/main/monitor/screenshot', () => ({
  captureScreenshots: vi.fn(async () => ({
    results: [],
    skipped_count: 0,
    total_displays: 0,
  })),
  captureScreenshot: vi.fn(async () => null),
  MAX_DISPLAYS: 4,
}));

// Don't run real retention sweeps either.
vi.mock('@/main/monitor/retention', () => ({
  runRetentionSweep: vi.fn(async () => ({
    rows_deleted: 0,
    files_deleted: 0,
    orphans_deleted: 0,
  })),
}));

// Quiet console output from the monitor's logInfo/logWarn.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

import { startMonitor, __resetSensitivePatternCacheForTests } from '@/main/monitor/index';
import { REDACTION_PLACEHOLDER } from '@/main/monitor/sensitive-pattern';

/* -------------------------------------------------------------------------- */
/*  Shared state                                                              */
/* -------------------------------------------------------------------------- */

beforeEach(() => {
  for (const key of Object.keys(settingsStore)) delete settingsStore[key];
  createMock.mockReset();
  getActiveWindowMock.mockReset();
  __resetSensitivePatternCacheForTests();
  // The monitor must be enabled for tickWindow to do anything.
  settingsStore.ambient_monitor_enabled = true;
  // Use a 10-second window-poll interval (the minimum the monitor will clamp
  // to) so the fake-timer advance below is small and bounded.
  settingsStore.ambient_window_poll_interval_ms = 10_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Spin up the monitor, advance the fake clock past the first window-poll
 * tick, and return the row that `contextObservationsRepository.create()`
 * was called with. The handle is stopped before we return so tests don't
 * leak timers across cases.
 */
async function runOneWindowTick(): Promise<Record<string, unknown>> {
  const flush = vi.fn();
  const handle = startMonitor({ flush });
  // First setTimeout(10_000) schedules the window tick; advance past it.
  // `advanceTimersByTimeAsync` only fires timers due in that window, so the
  // self-rescheduled next tick (another +10s) won't fire here.
  await vi.advanceTimersByTimeAsync(10_500);
  // Drain microtasks queued by tickWindow's awaits (getActiveWindow,
  // contextObservationsRepository.create) without advancing the clock.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  handle.stop();
  if (createMock.mock.calls.length === 0) {
    throw new Error('Expected contextObservationsRepository.create to be called');
  }
  return createMock.mock.calls[0]![0] as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe('tickWindow redaction', () => {
  it('redacts a 1Password window title and sets sensitive_pattern_match', async () => {
    getActiveWindowMock.mockResolvedValue({
      app_name: '1Password',
      window_title: '1Password — Vault',
      process_path: 'C:/Program Files/1Password/1Password.exe',
    });

    const row = await runOneWindowTick();

    expect(row.source).toBe('window');
    expect(row.window_title).toBe(REDACTION_PLACEHOLDER);
    // app_name is intentionally NOT redacted — it's a process name (low PII)
    // and the matcher already factored it in.
    expect(row.app_name).toBe('1Password');
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.sensitive_pattern_match).toBe(true);
    expect(meta.process_path).toBe('C:/Program Files/1Password/1Password.exe');
  });

  it('redacts a banking title even when the app name is neutral (chrome)', async () => {
    getActiveWindowMock.mockResolvedValue({
      app_name: 'chrome',
      window_title: 'Bank of America | Sign In',
      process_path: null,
    });

    const row = await runOneWindowTick();

    expect(row.window_title).toBe(REDACTION_PLACEHOLDER);
    expect(row.app_name).toBe('chrome');
    expect((row.metadata as Record<string, unknown>).sensitive_pattern_match).toBe(
      true,
    );
  });

  it('redacts when only the app_name trips the matcher', async () => {
    // A title like "Welcome" is benign but the app name (Bitwarden) is not.
    getActiveWindowMock.mockResolvedValue({
      app_name: 'Bitwarden',
      window_title: 'Welcome',
      process_path: null,
    });

    const row = await runOneWindowTick();

    expect(row.window_title).toBe(REDACTION_PLACEHOLDER);
    expect(row.app_name).toBe('Bitwarden');
    expect((row.metadata as Record<string, unknown>).sensitive_pattern_match).toBe(
      true,
    );
  });

  it('leaves a neutral title untouched and does NOT set sensitive_pattern_match', async () => {
    getActiveWindowMock.mockResolvedValue({
      app_name: 'vscode',
      window_title: 'src/main.ts - taskpilot',
      process_path: 'C:/Users/jack/AppData/Local/Programs/Microsoft VS Code/Code.exe',
    });

    const row = await runOneWindowTick();

    expect(row.window_title).toBe('src/main.ts - taskpilot');
    expect(row.app_name).toBe('vscode');
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.sensitive_pattern_match).toBeUndefined();
    // process_path still flows through.
    expect(meta.process_path).toBe(
      'C:/Users/jack/AppData/Local/Programs/Microsoft VS Code/Code.exe',
    );
  });

  it('returns null metadata when there is no process_path AND nothing sensitive', async () => {
    getActiveWindowMock.mockResolvedValue({
      app_name: 'chrome',
      window_title: 'Hacker News',
      process_path: null,
    });

    const row = await runOneWindowTick();

    expect(row.window_title).toBe('Hacker News');
    expect(row.metadata).toBeNull();
  });

  it('still persists the row when redacted (does NOT drop it)', async () => {
    getActiveWindowMock.mockResolvedValue({
      app_name: 'chrome',
      window_title: 'OAuth Authorize - Acme SaaS',
      process_path: null,
    });

    // The point of this test is that `create()` was invoked at all when a
    // sensitive context is encountered — the row must reach the DB so the
    // batcher's context-shift counter and the Watch view's "redacted"
    // badge both get to see it.
    await runOneWindowTick();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('respects a user-supplied custom pattern in the redaction path', async () => {
    settingsStore.ambient_screenshot_sensitive_pattern = '^project-mercury$';

    getActiveWindowMock.mockResolvedValue({
      app_name: 'chrome',
      window_title: 'project-mercury',
      process_path: null,
    });

    const row = await runOneWindowTick();
    expect(row.window_title).toBe(REDACTION_PLACEHOLDER);
    expect((row.metadata as Record<string, unknown>).sensitive_pattern_match).toBe(
      true,
    );
  });
});

describe('REDACTION_PLACEHOLDER contract', () => {
  it('is the documented literal so the renderer can match exactly', () => {
    // If this ever changes, the Watch view's badge logic + any persisted
    // rows from older builds need a migration. Lock the value down here.
    expect(REDACTION_PLACEHOLDER).toBe('[redacted-sensitive]');
  });
});

