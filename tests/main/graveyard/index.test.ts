/**
 * Tests for the decision graveyard — append, list, search, business scope.
 */

import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

import {
  GRAVEYARD_DIR,
  GRAVEYARD_FILE,
  listGraveyardEntries,
  recordGraveyardEntry,
  searchGraveyard,
} from '@/main/graveyard';

function clear(): void {
  fs.rmSync(GRAVEYARD_DIR, { recursive: true, force: true });
}

describe('graveyard', () => {
  beforeEach(clear);
  afterEach(clear);

  it('lives under TASKPILOT_HOME', () => {
    expect(GRAVEYARD_FILE.startsWith(PATHS.TASKPILOT_HOME)).toBe(true);
  });

  it('records and lists newest-first', async () => {
    await recordGraveyardEntry({
      at: '2026-01-01T00:00:00Z',
      kind: 'killed',
      subject: 'A bad idea',
    });
    await recordGraveyardEntry({
      at: '2026-01-02T00:00:00Z',
      kind: 'abandoned',
      subject: 'A second bad idea',
    });
    const list = await listGraveyardEntries();
    expect(list).toHaveLength(2);
    expect(list[0]?.subject).toBe('A second bad idea');
    expect(list[1]?.subject).toBe('A bad idea');
  });

  it('returns empty when no file', async () => {
    expect(await listGraveyardEntries()).toEqual([]);
  });

  it('skips malformed JSONL rows', async () => {
    fs.mkdirSync(GRAVEYARD_DIR, { recursive: true });
    fs.writeFileSync(
      GRAVEYARD_FILE,
      `${JSON.stringify({ at: '2026-01-01T00:00:00Z', kind: 'killed', subject: 'real' })}\n` +
        `not-json\n`,
      'utf8',
    );
    const list = await listGraveyardEntries();
    expect(list).toHaveLength(1);
    expect(list[0]?.subject).toBe('real');
  });

  it('searches case-insensitive across subject and reason', async () => {
    await recordGraveyardEntry({
      at: '2026-01-01T00:00:00Z',
      kind: 'killed',
      subject: 'Pricing experiment',
      reason: 'Too risky given churn',
    });
    await recordGraveyardEntry({
      at: '2026-01-02T00:00:00Z',
      kind: 'rejected',
      subject: 'Slack bot',
      reason: 'Not enough demand',
    });
    expect(
      (await searchGraveyard({ query: 'PRICING' })).map((e) => e.subject),
    ).toEqual(['Pricing experiment']);
    expect(
      (await searchGraveyard({ query: 'churn' })).map((e) => e.subject),
    ).toEqual(['Pricing experiment']);
    expect(
      (await searchGraveyard({ query: 'no match anywhere' })),
    ).toEqual([]);
  });

  it('scopes search by business when provided', async () => {
    await recordGraveyardEntry({
      at: '2026-01-01T00:00:00Z',
      kind: 'killed',
      subject: 'X',
      business: 'leal-health',
    });
    await recordGraveyardEntry({
      at: '2026-01-02T00:00:00Z',
      kind: 'killed',
      subject: 'X',
      business: 'indexthread',
    });
    expect(
      (await searchGraveyard({ query: 'X', business: 'leal-health' })).length,
    ).toBe(1);
  });
});
