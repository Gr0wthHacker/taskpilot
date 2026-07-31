// A persistent FIFO ring buffer of capture observations backed by chrome.storage.local.
// Service workers can be torn down at any moment, so we never hold state in memory.

import { CaptureObservation, QUEUE_MAX, STORAGE_KEYS } from "../shared/types.js";

async function readQueue(): Promise<CaptureObservation[]> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.queue);
  const stored = raw[STORAGE_KEYS.queue];
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is CaptureObservation => {
    return (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as CaptureObservation).url === "string" &&
      typeof (entry as CaptureObservation).captured_at === "string"
    );
  });
}

async function writeQueue(queue: CaptureObservation[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.queue]: queue });
}

export async function enqueue(entry: CaptureObservation): Promise<number> {
  const queue = await readQueue();
  queue.push(entry);
  // Ring buffer: drop oldest when over QUEUE_MAX.
  while (queue.length > QUEUE_MAX) queue.shift();
  await writeQueue(queue);
  return queue.length;
}

export async function peekAll(): Promise<CaptureObservation[]> {
  return readQueue();
}

export async function size(): Promise<number> {
  const queue = await readQueue();
  return queue.length;
}

// Atomic-ish drain: returns the head batch and removes them from the queue.
// Because reads/writes are sequential within a single SW invocation, we are
// safe from interleaving in practice (only one alarm/handler runs at a time
// within a single SW). If a write fails the caller can re-enqueue.
export async function drain(max: number): Promise<CaptureObservation[]> {
  const queue = await readQueue();
  if (queue.length === 0) return [];
  const batch = queue.splice(0, Math.max(1, Math.min(max, queue.length)));
  await writeQueue(queue);
  return batch;
}

// Push items back to the front (used when a flush fails and we want to retry later).
export async function requeueFront(items: CaptureObservation[]): Promise<void> {
  if (items.length === 0) return;
  const queue = await readQueue();
  const merged = [...items, ...queue];
  while (merged.length > QUEUE_MAX) merged.shift();
  await writeQueue(merged);
}

export async function clear(): Promise<void> {
  await writeQueue([]);
}
