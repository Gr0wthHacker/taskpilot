/**
 * Tests for the file-backed storage layer (updates.jsonl + status.json + STATUS.md).
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

import {
  appendUpdate,
  BUSINESSES_DIR,
  readUpdates,
  statusJsonPath,
  statusMdPath,
  updatesFilePath,
  writeSnapshot,
} from '@/main/businesses/storage';

function clear(): void {
  fs.rmSync(BUSINESSES_DIR, { recursive: true, force: true });
}

describe('businesses/storage', () => {
  beforeEach(clear);
  afterEach(clear);

  it('rejects an invalid tag', async () => {
    await expect(
      appendUpdate('not a valid tag!', {
        at: '2026-01-01T00:00:00Z',
        headline: 'x',
      }),
    ).rejects.toThrow(/Invalid business tag/);
  });

  it('appends updates and reads them newest-first', async () => {
    await appendUpdate('leal-health', {
      at: '2026-01-01T00:00:00.000Z',
      headline: 'First',
    });
    await appendUpdate('leal-health', {
      at: '2026-01-02T00:00:00.000Z',
      headline: 'Second',
    });
    const list = await readUpdates('leal-health');
    expect(list).toHaveLength(2);
    expect(list[0]?.headline).toBe('Second');
    expect(list[1]?.headline).toBe('First');
  });

  it('reads an empty list when no updates file exists yet', async () => {
    expect(await readUpdates('leal-health')).toEqual([]);
  });

  it('skips malformed lines without throwing', async () => {
    fs.mkdirSync(path.join(BUSINESSES_DIR, 'leal-health'), { recursive: true });
    fs.writeFileSync(
      updatesFilePath('leal-health'),
      `${JSON.stringify({ at: '2026-01-01T00:00:00Z', headline: 'good' })}\n` +
        `not-json\n` +
        `${JSON.stringify({ at: '2026-01-02T00:00:00Z', headline: 'second' })}\n`,
      'utf8',
    );
    const list = await readUpdates('leal-health');
    expect(list.map((u) => u.headline)).toEqual(['second', 'good']);
  });

  it('writeSnapshot persists status.json + STATUS.md to disk', async () => {
    await writeSnapshot('leal-health', { tag: 'leal-health', headline: 'x' }, '# md');
    expect(fs.existsSync(statusJsonPath('leal-health'))).toBe(true);
    expect(fs.existsSync(statusMdPath('leal-health'))).toBe(true);
    expect(fs.readFileSync(statusMdPath('leal-health'), 'utf8')).toBe('# md');
    expect(JSON.parse(fs.readFileSync(statusJsonPath('leal-health'), 'utf8'))).toEqual({
      tag: 'leal-health',
      headline: 'x',
    });
  });

  it('businesses dir lives under TASKPILOT_HOME', () => {
    expect(BUSINESSES_DIR.startsWith(PATHS.TASKPILOT_HOME)).toBe(true);
  });
});
