/**
 * Desktop input tests — focused on the setting gate, quoting, and the SendKeys
 * escape rules. Actual PowerShell execution is not exercised here (it would
 * require a real Windows desktop with a focused window, and would have side
 * effects). Functional coverage of the spawn path lives in the integration
 * suite, run manually on a Windows dev box.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';

mockTaskpilotPaths();

import { settingsRepository } from '@/main/db/repositories/settings';
import {
  DesktopInputDisabledError,
  ensureDesktopEnabled,
  escapeSendKeys,
} from '@/main/desktop';
import { __testing } from '@/main/desktop/input';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
  settingsRepository.delete('desktop_input_enabled');
  vi.restoreAllMocks();
});

describe('ensureDesktopEnabled', () => {
  it('throws DesktopInputDisabledError when the setting is unset', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    settingsRepository.delete('desktop_input_enabled');
    expect(() => ensureDesktopEnabled()).toThrow(DesktopInputDisabledError);
  });

  it('throws DesktopInputDisabledError when the setting is false', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    settingsRepository.set('desktop_input_enabled', false);
    expect(() => ensureDesktopEnabled()).toThrow(DesktopInputDisabledError);
  });

  it('passes when the setting is true on Windows', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    settingsRepository.set('desktop_input_enabled', true);
    expect(() => ensureDesktopEnabled()).not.toThrow();
  });

  it('throws on non-Windows platforms even when enabled', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
    settingsRepository.set('desktop_input_enabled', true);
    expect(() => ensureDesktopEnabled()).toThrow(/only supported on Windows/);
  });
});

describe('psQuote', () => {
  it('wraps plain strings in single quotes', () => {
    expect(__testing.psQuote('hello')).toBe("'hello'");
  });

  it('escapes single quotes by doubling them', () => {
    expect(__testing.psQuote("it's")).toBe("'it''s'");
  });

  it('does not interpolate variables', () => {
    expect(__testing.psQuote('$x = 1')).toBe("'$x = 1'");
  });
});

describe('escapeSendKeys', () => {
  it('wraps each SendKeys metacharacter in braces', () => {
    expect(escapeSendKeys('hello (world)')).toBe('hello {(}world{)}');
    expect(escapeSendKeys('1+1')).toBe('1{+}1');
    expect(escapeSendKeys('100%')).toBe('100{%}');
    expect(escapeSendKeys('a^b~c')).toBe('a{^}b{~}c');
    expect(escapeSendKeys('a{b}')).toBe('a{{}b{}}');
    expect(escapeSendKeys('a[b]')).toBe('a{[}b{]}');
  });

  it('leaves regular characters untouched', () => {
    expect(escapeSendKeys('hello world 123')).toBe('hello world 123');
  });
});
