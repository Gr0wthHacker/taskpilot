/**
 * Orchestrator tests — the producer side of the two-agent deliberation.
 *
 * Verifies that `requestDeliberation`:
 *   - writes a schema-valid file to IO_DELIBERATE/<batch_id>.json
 *   - inserts a pending `deliberations` row
 *   - tags the bundled observations with the new batch_id
 *   - resolves observations from explicit ids OR from the unbatched pool
 *   - emits `deliberation_requested` on the ioEvents bus
 *   - honours the quiet-hours setting
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import { requestDeliberation, isQuietHoursActive } from '@/main/deliberation/orchestrator';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { deliberationsRepository } from '@/main/db/repositories/deliberations';
import { settingsRepository } from '@/main/db/repositories/settings';
import { ioEvents } from '@/main/io/events';
import {
  deliberationRequestSchema,
} from '@/shared/io-schemas';

function seedObservation(idHint: string): string {
  const created = contextObservationsRepository.create({
    id: idHint,
    source: 'browser',
    url: 'https://example.com',
    page_title: `Example ${idHint}`,
  });
  return created.id;
}

describe('orchestrator — requestDeliberation', () => {
  useMockedDb();

  it('writes a schema-valid request file and inserts a pending row', async () => {
    const obs1 = seedObservation('obsA1234567');
    const obs2 = seedObservation('obsB1234567');

    const result = await requestDeliberation({
      observation_ids: [obs1, obs2],
      trigger_reason: 'manual',
    });

    expect(result.batch_id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.deliberation.status).toBe('pending');
    expect(result.deliberation.batch_id).toBe(result.batch_id);
    expect(result.deliberation.observation_ids).toEqual([obs1, obs2]);

    // File on disk validates against the schema.
    const filePath = path.join(PATHS.IO_DELIBERATE, `${result.batch_id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const parsed = deliberationRequestSchema.parse(raw);
    expect(parsed.id).toBe(result.batch_id);
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.trigger_reason).toBe('manual');
    expect(parsed.instructions.interrupter_role.length).toBeGreaterThan(0);
    expect(parsed.instructions.waiter_role.length).toBeGreaterThan(0);
    expect(parsed.instructions.scoring_rubric.length).toBeGreaterThan(0);

    // Row in the DB.
    const stored = deliberationsRepository.get(result.deliberation.id);
    expect(stored?.status).toBe('pending');
  });

  it('tags the bundled observations with the batch_id', async () => {
    const obs1 = seedObservation('obsT1111111');
    const obs2 = seedObservation('obsT2222222');

    const result = await requestDeliberation({
      observation_ids: [obs1, obs2],
      trigger_reason: 'batch_size',
    });

    const after1 = contextObservationsRepository.get(obs1);
    const after2 = contextObservationsRepository.get(obs2);
    expect(after1?.batch_id).toBe(result.batch_id);
    expect(after2?.batch_id).toBe(result.batch_id);
  });

  it('falls back to the most recent unbatched observations when none are passed', async () => {
    const obs1 = seedObservation('obsU1111111');
    const obs2 = seedObservation('obsU2222222');

    const result = await requestDeliberation({
      trigger_reason: 'batch_size',
      max_observations: 5,
    });

    expect(result.deliberation.observation_ids).toContain(obs1);
    expect(result.deliberation.observation_ids).toContain(obs2);
  });

  it('emits a deliberation_requested event with the new ids', async () => {
    const obs1 = seedObservation('obsE1111111');
    const events: Array<{ batchId: string; deliberationId: string }> = [];
    const listener = (e: { batchId: string; deliberationId: string }): void => {
      events.push({ batchId: e.batchId, deliberationId: e.deliberationId });
    };
    ioEvents.on('deliberation_requested', listener);
    try {
      const result = await requestDeliberation({
        observation_ids: [obs1],
        trigger_reason: 'hotkey',
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.batchId).toBe(result.batch_id);
      expect(events[0]?.deliberationId).toBe(result.deliberation.id);
    } finally {
      ioEvents.off('deliberation_requested', listener);
    }
  });

  it('throws when no observations can be resolved', async () => {
    await expect(
      requestDeliberation({ trigger_reason: 'manual' }),
    ).rejects.toThrow(/no observations resolved/i);
  });
});

describe('orchestrator — isQuietHoursActive', () => {
  useMockedDb();

  it('returns false when no setting is configured', () => {
    expect(isQuietHoursActive()).toBe(false);
  });

  it('returns true inside the configured window', () => {
    settingsRepository.set('ambient_deliberation_quiet_hours', '22:00-07:00');
    // Inside the wrap-around window.
    expect(isQuietHoursActive(new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(isQuietHoursActive(new Date(2026, 0, 1, 6, 0))).toBe(true);
    // Outside it.
    expect(isQuietHoursActive(new Date(2026, 0, 1, 14, 0))).toBe(false);
  });

  it('handles non-wrap windows correctly', () => {
    settingsRepository.set('ambient_deliberation_quiet_hours', '09:00-12:00');
    expect(isQuietHoursActive(new Date(2026, 0, 1, 10, 30))).toBe(true);
    expect(isQuietHoursActive(new Date(2026, 0, 1, 13, 0))).toBe(false);
    expect(isQuietHoursActive(new Date(2026, 0, 1, 8, 0))).toBe(false);
  });

  it('fails safe on malformed setting', () => {
    settingsRepository.set('ambient_deliberation_quiet_hours', 'not-a-window');
    expect(isQuietHoursActive()).toBe(false);
  });
});
