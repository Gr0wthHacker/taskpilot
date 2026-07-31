// Thin client for the TaskPilot local API. Bearer auth, exponential backoff,
// 401 -> drop batch + surface a badge.

import { getSettings, setSyncStatus } from "../shared/storage.js";
import { CaptureBatchPayload, CaptureObservation } from "../shared/types.js";

const BACKOFF_MS = [1000, 4000, 16000];

export interface FlushResult {
  ok: boolean;
  unauthorized: boolean;
  error?: string;
  attempted: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postBatch(
  baseUrl: string,
  token: string,
  payload: CaptureBatchPayload,
): Promise<Response> {
  return fetch(`${baseUrl}/api/context/capture/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

export async function flushBatch(
  observations: CaptureObservation[],
): Promise<FlushResult> {
  if (observations.length === 0) {
    return { ok: true, unauthorized: false, attempted: 0 };
  }
  const settings = await getSettings();
  if (!settings.bearerToken) {
    return {
      ok: false,
      unauthorized: true,
      error: "No bearer token configured",
      attempted: observations.length,
    };
  }

  const payload: CaptureBatchPayload = {
    source: "browser",
    observations,
  };

  let lastError: string | undefined;
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    try {
      const response = await postBatch(settings.apiBaseUrl, settings.bearerToken, payload);
      if (response.status === 401 || response.status === 403) {
        await setSyncStatus({
          unauthorized: true,
          lastErrorAt: Date.now(),
          lastErrorMessage: `HTTP ${response.status} — token rejected`,
        });
        await updateBadge("!", "#dc2626");
        return {
          ok: false,
          unauthorized: true,
          error: `HTTP ${response.status}`,
          attempted: observations.length,
        };
      }
      if (response.status >= 500 || response.status === 429) {
        lastError = `HTTP ${response.status}`;
        await sleep(BACKOFF_MS[attempt] ?? 16000);
        continue;
      }
      if (!response.ok) {
        // 4xx other than auth — payload-level problem, drop to avoid an infinite loop.
        const body = await safeReadText(response);
        await setSyncStatus({
          lastErrorAt: Date.now(),
          lastErrorMessage: `HTTP ${response.status} ${body.slice(0, 200)}`,
        });
        return {
          ok: false,
          unauthorized: false,
          error: `HTTP ${response.status}`,
          attempted: observations.length,
        };
      }
      await setSyncStatus({
        lastSuccessAt: Date.now(),
        lastErrorAt: null,
        lastErrorMessage: null,
        unauthorized: false,
      });
      await updateBadge("", "#16a34a");
      return { ok: true, unauthorized: false, attempted: observations.length };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(BACKOFF_MS[attempt] ?? 16000);
    }
  }

  await setSyncStatus({
    lastErrorAt: Date.now(),
    lastErrorMessage: lastError ?? "Unknown error",
  });
  await updateBadge("!", "#eab308");
  return {
    ok: false,
    unauthorized: false,
    error: lastError ?? "Unknown error",
    attempted: observations.length,
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export async function pingHealth(
  baseUrl: string,
  token: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/api/health`;
    const response = await fetch(url, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await safeReadText(response);
    return { ok: response.ok, status: response.status, body: body.slice(0, 200) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  }
}

async function updateBadge(text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color });
    }
  } catch {
    // chrome.action may not be ready in tests; ignore.
  }
}
