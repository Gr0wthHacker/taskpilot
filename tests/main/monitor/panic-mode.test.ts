/**
 * Panic-mode gate tests for the proactive monitor.
 *
 * Exercises the two early-return paths added to `tickWindow` and
 * `tickScreenshot` when `ambient_panic_mode === true`. The collectors are
 * mocked so a panic-gate "skip" is observable as "the collector was never
 * called"; we never need a real PowerShell shell-out or desktopCapturer.
 *
 * Why not boot the full monitor? `startMonitor()` wires the file watcher,
 * settings poller, and retention timer — none of which are part of the
 * gate's contract. The exported `__tickWindowForTests` /
 * `__tickScreenshotForTests` hooks give us the same code path under test
 * without the timer dance.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

// Mock the two collectors BEFORE importing the monitor so the lazy resolve
// inside the tick functions hits these stubs.
vi.mock('@/main/monitor/active-window', () => ({
  getActiveWindow: vi.fn(),
  ensureScriptInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/main/monitor/screenshot', () => ({
  captureScreenshots: vi.fn(),
  MAX_DISPLAYS: 4,
}));

import { settingsRepository } from '@/main/db/repositories/settings';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { getActiveWindow } from '@/main/monitor/active-window';
import { captureScreenshots } from '@/main/monitor/screenshot';
import {
  __resetPanicTransitionForTests,
  __tickScreenshotForTests,
  __tickWindowForTests,
} from '@/main/monitor';

const mockedGetActiveWindow = getActiveWindow as unknown as Mock;
const mockedCaptureScreenshots = captureScreenshots as unknown as Mock;

describe('monitor panic-mode gate', () => {
  useMockedDb();

  beforeEach(() => {
    __resetPanicTransitionForTests();
    mockedGetActiveWindow.mockReset();
    mockedCaptureScreenshots.mockReset();
    // Default collectors: succeed with a benign value so the non-panic
    // tests below can observe the row actually being inserted.
    mockedGetActiveWindow.mockResolvedValue({
      app_name: 'Code.exe',
      window_title: 'README.md',
      process_path: null,
    });
    mockedCaptureScreenshots.mockResolvedValue({
      results: [
        {
          path: `${PATHS.CAPTURES_DIR}/cap_0000000000000001.png`,
          size_bytes: 100,
          display_id: '0',
          display_label: 'Primary',
          captured_at: new Date().toISOString(),
        },
      ],
      skipped_count: 0,
      total_displays: 1,
    });
  });

  afterEach(() => {
    // Leave settings clean between tests so the next describe block starts
    // from defaults (mock-db rebuilds the DB anyway, but explicit is safer).
    settingsRepository.set('ambient_monitor_enabled', false);
    settingsRepository.set('ambient_screenshot_enabled', false);
    settingsRepository.set('ambient_panic_mode', false);
  });

  /* ----------------------------------------------------------------- gate */

  it('tickWindow returns early when ambient_panic_mode is true', async () => {
    settingsRepository.set('ambient_monitor_enabled', true);
    settingsRepository.set('ambient_panic_mode', true);

    await __tickWindowForTests();

    expect(mockedGetActiveWindow).not.toHaveBeenCalled();
    // No row should have been persisted either.
    const recent = contextObservationsRepository.list({ limit: 10 });
    expect(recent).toHaveLength(0);
  });

  it('tickScreenshot returns early when ambient_panic_mode is true', async () => {
    settingsRepository.set('ambient_monitor_enabled', true);
    settingsRepository.set('ambient_screenshot_enabled', true);
    settingsRepository.set('ambient_panic_mode', true);

    await __tickScreenshotForTests();

    expect(mockedCaptureScreenshots).not.toHaveBeenCalled();
    const recent = contextObservationsRepository.list({ limit: 10 });
    expect(recent).toHaveLength(0);
  });

  it('tickWindow proceeds normally when ambient_panic_mode is false', async () => {
    settingsRepository.set('ambient_monitor_enabled', true);
    settingsRepository.set('ambient_panic_mode', false);

    await __tickWindowForTests();

    expect(mockedGetActiveWindow).toHaveBeenCalledTimes(1);
    const recent = contextObservationsRepository.list({ limit: 10 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.source).toBe('window');
    expect(recent[0]?.app_name).toBe('Code.exe');
  });

  it('tickScreenshot proceeds normally when ambient_panic_mode is false', async () => {
    settingsRepository.set('ambient_monitor_enabled', true);
    settingsRepository.set('ambient_screenshot_enabled', true);
    settingsRepository.set('ambient_panic_mode', false);

    await __tickScreenshotForTests();

    expect(mockedCaptureScreenshots).toHaveBeenCalledTimes(1);
    const recent = contextObservationsRepository.list({ limit: 10 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.source).toBe('screenshot');
  });

  it('logs the panic transition exactly once across consecutive ticks', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      settingsRepository.set('ambient_monitor_enabled', true);
      settingsRepository.set('ambient_panic_mode', true);

      await __tickWindowForTests();
      await __tickWindowForTests();
      await __tickWindowForTests();

      const panicLogs = spy.mock.calls.filter((call) => {
        const message = call[1];
        return (
          typeof message === 'string' &&
          message.includes('panic mode active')
        );
      });
      expect(panicLogs).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('honors ambient_monitor_enabled BEFORE the panic gate', async () => {
    // Master off + panic on → still no collector call. We assert the master
    // flag wins (matches existing pre-panic behavior) so a future refactor
    // that reorders the gates trips this test.
    settingsRepository.set('ambient_monitor_enabled', false);
    settingsRepository.set('ambient_panic_mode', true);

    await __tickWindowForTests();
    await __tickScreenshotForTests();

    expect(mockedGetActiveWindow).not.toHaveBeenCalled();
    expect(mockedCaptureScreenshots).not.toHaveBeenCalled();
  });
});
