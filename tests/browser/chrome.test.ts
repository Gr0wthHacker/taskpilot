/**
 * Chrome lifecycle tests.
 *
 * Tests against the pure functions — binary discovery + override handling.
 * We do not spawn a real Chrome here; the integration coverage for that
 * lives in tests/integration/ and requires Chrome to be installed.
 */

import path from 'node:path';
import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findChromeBinary } from '@/main/browser/chrome';

const originalEnv = process.env;
const originalPlatform = process.platform;

afterEach(() => {
  process.env = originalEnv;
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe('findChromeBinary/override', () => {
  it('returns TASKPILOT_CHROME_PATH when the file exists', async () => {
    const fakeBin = path.join(os.tmpdir(), 'taskpilot-test-chrome-override.tmp');
    const fs = await import('node:fs/promises');
    await fs.writeFile(fakeBin, '#!/usr/bin/env bash\necho stub');
    try {
      process.env = { ...originalEnv, TASKPILOT_CHROME_PATH: fakeBin };
      const result = await findChromeBinary();
      expect(result).toBe(fakeBin);
    } finally {
      await fs.unlink(fakeBin).catch(() => undefined);
    }
  });

  it('throws when TASKPILOT_CHROME_PATH points to a missing file', async () => {
    process.env = {
      ...originalEnv,
      TASKPILOT_CHROME_PATH: path.join(
        os.tmpdir(),
        'taskpilot-does-not-exist.bin',
      ),
    };
    await expect(findChromeBinary()).rejects.toThrow(
      /does not exist/,
    );
  });
});
