/**
 * Tests for the observation batcher.
 *
 * Pure deterministic logic: feed observations in, assert when (and why) the
 * batcher flushes. Doesn't touch the DB, electron, fs, or any global event
 * bus — just the dependencies declared by `createObservationBatcher`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createObservationBatcher,
  type BatcherFlush,
  type BatcherObservation,
  type BatcherSettings,
} from '@/main/monitor/batcher';

function obs(id: string, fields: Partial<BatcherObservation> = {}): BatcherObservation {
  return {
    id,
    captured_at: new Date().toISOString(),
    app_name: fields.app_name ?? null,
    window_title: fields.window_title ?? null,
    url: fields.url ?? null,
    page_title: fields.page_title ?? null,
  };
}

function settings(partial: Partial<BatcherSettings> = {}): () => BatcherSettings {
  return () => ({
    batchSize: partial.batchSize ?? 3,
    contextShiftThreshold: partial.contextShiftThreshold ?? 0.95,
  });
}

describe('createObservationBatcher', () => {
  it('flushes once the batch size is reached', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 3 }),
      flush,
    });

    b.record(obs('a', { app_name: 'chrome' }));
    b.record(obs('b', { app_name: 'chrome' }));
    expect(flush).not.toHaveBeenCalled();
    expect(b.size()).toBe(2);

    b.record(obs('c', { app_name: 'chrome' }));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a', 'b', 'c'], 'batch_size');
    expect(b.size()).toBe(0);
  });

  it('flushes when the context-shift threshold is exceeded', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      // Big batch size so size never trips; tiny shift threshold so any change wins.
      readSettings: settings({ batchSize: 100, contextShiftThreshold: 0.1 }),
      flush,
    });

    b.record(obs('a', { app_name: 'chrome', window_title: 'Gmail Inbox' }));
    expect(flush).not.toHaveBeenCalled();

    // Wildly different context — vscode editing a Rust file — should trip the shift.
    b.record(
      obs('b', { app_name: 'vscode', window_title: 'src/main.rs - taskpilot' }),
    );
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a', 'b'], 'context_shift');
  });

  it('does NOT flush on the very first observation even if shift threshold is 0', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 100, contextShiftThreshold: 0 }),
      flush,
    });

    b.record(obs('first', { app_name: 'chrome' }));
    expect(flush).not.toHaveBeenCalled();
    expect(b.size()).toBe(1);
  });

  it('does NOT flush when context is unchanged', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 100, contextShiftThreshold: 0.1 }),
      flush,
    });

    b.record(obs('a', { app_name: 'chrome', window_title: 'Gmail Inbox' }));
    b.record(obs('b', { app_name: 'chrome', window_title: 'Gmail Inbox' }));
    expect(flush).not.toHaveBeenCalled();
    expect(b.size()).toBe(2);
  });

  it('flushNow drains the queue with a manual reason', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 100, contextShiftThreshold: 1 }),
      flush,
    });

    b.record(obs('a'));
    b.record(obs('b'));
    b.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a', 'b'], 'manual');
    expect(b.size()).toBe(0);
  });

  it('flushNow is a no-op when the queue is empty', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings(),
      flush,
    });
    b.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });

  it('re-reads settings on every record (no caching)', () => {
    const flush = vi.fn<BatcherFlush>();
    let batchSize = 100;
    const b = createObservationBatcher({
      readSettings: () => ({ batchSize, contextShiftThreshold: 1 }),
      flush,
    });

    b.record(obs('a'));
    b.record(obs('b'));
    expect(flush).not.toHaveBeenCalled();

    // User lowered batch size mid-stream — next record should flush immediately.
    batchSize = 3;
    b.record(obs('c'));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a', 'b', 'c'], 'batch_size');
  });

  it('clamps a sub-1 batch size to flush-every-record', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 0, contextShiftThreshold: 1 }),
      flush,
    });
    b.record(obs('a'));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a'], 'batch_size');
  });

  it('reset drops queued observations without flushing', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 100, contextShiftThreshold: 1 }),
      flush,
    });
    b.record(obs('a'));
    b.record(obs('b'));
    b.reset();
    expect(b.size()).toBe(0);
    b.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });

  it('reset clears the "previous observation" so shift can re-arm', () => {
    const flush = vi.fn<BatcherFlush>();
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 100, contextShiftThreshold: 0.1 }),
      flush,
    });

    b.record(obs('a', { app_name: 'chrome', window_title: 'Gmail' }));
    b.reset();
    // After reset, the next observation is treated as the first again — no flush.
    b.record(obs('b', { app_name: 'vscode', window_title: 'main.rs' }));
    expect(flush).not.toHaveBeenCalled();
  });

  it('swallows a rejected flush promise so the batcher stays alive', async () => {
    const flush: BatcherFlush = () => Promise.reject(new Error('boom'));
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 1, contextShiftThreshold: 1 }),
      flush,
    });

    // Should not throw.
    expect(() => b.record(obs('a'))).not.toThrow();

    // Let the rejected promise settle without producing an unhandled rejection.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(b.size()).toBe(0);
  });

  it('swallows a thrown flush callback so the batcher stays alive', () => {
    const flush: BatcherFlush = () => {
      throw new Error('boom');
    };
    const b = createObservationBatcher({
      readSettings: settings({ batchSize: 1, contextShiftThreshold: 1 }),
      flush,
    });
    expect(() => b.record(obs('a'))).not.toThrow();
    expect(b.size()).toBe(0);
  });
});
