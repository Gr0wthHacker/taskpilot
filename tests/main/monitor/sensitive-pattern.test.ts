/**
 * Tests for the screenshot privacy filter — `matchesSensitivePattern()`.
 *
 * Pure matcher + a lazy-compiled regex cache. The cache reads settings via
 * `settingsRepository.get(...)`, so we mock the repository module to drive
 * the "invalid regex falls back to default" path. No DB, no I/O, no Electron.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the settings repository BEFORE importing the module under test, so the
// lazy `getSensitivePattern()` reads our stub instead of touching SQLite.
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

// Avoid pulling drizzle/sqlite when the monitor module imports
// `contextObservationsRepository` transitively — that repository calls
// `getDb()` at request time, not at import time, so mocking the module body
// is sufficient for the matcher tests.
vi.mock('@/main/db/repositories/context-observations', () => ({
  contextObservationsRepository: {
    create: vi.fn(),
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

import {
  __resetSensitivePatternCacheForTests,
  matchesSensitivePattern,
} from '@/main/monitor/index';

const SETTING_KEY = 'ambient_screenshot_sensitive_pattern';

beforeEach(() => {
  for (const key of Object.keys(settingsStore)) {
    delete settingsStore[key];
  }
  __resetSensitivePatternCacheForTests();
});

afterEach(() => {
  __resetSensitivePatternCacheForTests();
});

describe('matchesSensitivePattern (default pattern)', () => {
  it('matches a 1password window title', () => {
    expect(matchesSensitivePattern(null, '1Password — Vault')).toBe(true);
    expect(matchesSensitivePattern('1Password', null)).toBe(true);
    expect(matchesSensitivePattern(null, 'https://my.1password.com/')).toBe(
      true,
    );
  });

  it('matches a banking window title', () => {
    expect(
      matchesSensitivePattern('chrome', 'Bank of America | Sign In'),
    ).toBe(true);
    expect(matchesSensitivePattern(null, 'Chase Online Banking')).toBe(true);
  });

  it('matches OAuth/login flows', () => {
    expect(matchesSensitivePattern(null, 'Sign in - Google Accounts')).toBe(
      true,
    );
    expect(matchesSensitivePattern(null, 'Sign-in to GitHub')).toBe(true);
    expect(matchesSensitivePattern(null, 'OAuth Authorize')).toBe(true);
    expect(matchesSensitivePattern(null, 'Login | Notion')).toBe(true);
  });

  it('matches password-manager apps regardless of case', () => {
    expect(matchesSensitivePattern('bitwarden', null)).toBe(true);
    expect(matchesSensitivePattern('LastPass Desktop', null)).toBe(true);
    expect(matchesSensitivePattern(null, 'Authenticator App')).toBe(true);
  });

  it('matches secret/token/api-key language', () => {
    expect(matchesSensitivePattern(null, 'API Key Settings — Stripe')).toBe(
      true,
    );
    expect(matchesSensitivePattern(null, 'Reveal Secret')).toBe(true);
    expect(matchesSensitivePattern(null, 'Personal Access Token')).toBe(true);
  });

  it('does NOT match neutral GitHub pages', () => {
    expect(
      matchesSensitivePattern('chrome', 'jackgierlich/taskpilot — GitHub'),
    ).toBe(false);
    expect(matchesSensitivePattern('chrome', 'GitHub.com')).toBe(false);
  });

  it('does NOT match normal app titles', () => {
    expect(matchesSensitivePattern('vscode', 'src/main.ts - taskpilot')).toBe(
      false,
    );
    expect(matchesSensitivePattern('chrome', 'Inbox — Gmail')).toBe(false);
    expect(matchesSensitivePattern('slack', 'general | TaskPilot')).toBe(
      false,
    );
    expect(
      matchesSensitivePattern('chrome', 'Hacker News'),
    ).toBe(false);
  });

  it('treats null fields as non-matching', () => {
    expect(matchesSensitivePattern(null, null)).toBe(false);
  });

  it('treats empty strings as non-matching', () => {
    expect(matchesSensitivePattern('', '')).toBe(false);
  });
});

describe('matchesSensitivePattern (cached + setting-driven)', () => {
  it('uses a user-supplied valid pattern when present', () => {
    settingsStore[SETTING_KEY] = '^secret-project$';
    // Default would NOT match this, but the custom one does — exact word.
    expect(matchesSensitivePattern(null, 'secret-project')).toBe(true);
    // And the custom pattern is intentionally narrow; "secret" alone shouldn't trip it.
    expect(matchesSensitivePattern(null, 'secret stuff')).toBe(false);
  });

  it('falls back to the default pattern when the stored regex is invalid', () => {
    settingsStore[SETTING_KEY] = '([unterminated';
    // Default still catches "1Password" via the fallback path.
    expect(matchesSensitivePattern(null, '1Password — Vault')).toBe(true);
    // And neutral titles still don't match.
    expect(matchesSensitivePattern('vscode', 'src/main.ts')).toBe(false);
  });

  it('picks up a new pattern when the setting changes (cache keyed by source)', () => {
    settingsStore[SETTING_KEY] = '^never-match-anything-xyz$';
    expect(matchesSensitivePattern(null, '1Password')).toBe(false);

    // Live-toggle: changing the setting source invalidates the cache on the
    // next read, so the new pattern takes effect without an explicit reset.
    settingsStore[SETTING_KEY] = '1password';
    expect(matchesSensitivePattern(null, '1Password')).toBe(true);

    // Explicit reset also clears the cache (used by tests + future
    // settings-change hooks).
    __resetSensitivePatternCacheForTests();
    settingsStore[SETTING_KEY] = '^never-match-anything-xyz$';
    expect(matchesSensitivePattern(null, '1Password')).toBe(false);
  });

  it('falls back to the default when the setting is empty', () => {
    settingsStore[SETTING_KEY] = '';
    expect(matchesSensitivePattern(null, 'login.microsoftonline.com')).toBe(
      true,
    );
  });
});
