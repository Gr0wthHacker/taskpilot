// Popup UI: status pill, recent captures, "capture now" button.

import { getRecentLog, getSettings, getSyncStatus } from "../shared/storage.js";
import { CaptureObservation, StatusColor, SyncStatus } from "../shared/types.js";

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

function relativeTime(ms: number | null): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function computeStatus(
  status: SyncStatus,
  hasToken: boolean,
): { color: StatusColor; label: string } {
  if (!hasToken) return { color: "grey", label: "not configured" };
  if (status.unauthorized) return { color: "red", label: "unauthorized" };
  if (status.lastSuccessAt) {
    const ageMs = Date.now() - status.lastSuccessAt;
    if (ageMs < 5 * 60 * 1000) return { color: "green", label: "synced" };
    if (ageMs < 30 * 60 * 1000) return { color: "yellow", label: "stale" };
    return { color: "red", label: "behind" };
  }
  if (status.lastErrorAt) return { color: "red", label: "error" };
  return { color: "grey", label: "idle" };
}

function renderStatus(status: SyncStatus, hasToken: boolean): void {
  const { color, label } = computeStatus(status, hasToken);
  const dot = $<HTMLSpanElement>("status-dot");
  dot.className = `dot ${color}`;
  $<HTMLSpanElement>("status-text").textContent = label;
  $<HTMLSpanElement>("pending").textContent = `${status.pendingCount} pending`;
}

function renderEntries(entries: CaptureObservation[]): void {
  const container = $<HTMLDivElement>("entries");
  container.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No captures yet. Visit a page or hit Ctrl+Shift+Y.";
    container.appendChild(empty);
    return;
  }
  for (const entry of entries.slice(0, 10)) {
    const wrap = document.createElement("div");
    wrap.className = "entry";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = entry.title || entry.h1 || entry.url;
    wrap.appendChild(title);

    const url = document.createElement("div");
    url.className = "url";
    url.textContent = entry.url;
    wrap.appendChild(url);

    const ts = document.createElement("div");
    ts.className = "ts";
    const date = new Date(entry.captured_at);
    ts.textContent = Number.isNaN(date.getTime())
      ? entry.captured_at
      : `${date.toLocaleTimeString()} — ${relativeTime(date.getTime())}`;
    wrap.appendChild(ts);

    container.appendChild(wrap);
  }
}

async function refresh(): Promise<void> {
  const [status, recent, settings] = await Promise.all([
    getSyncStatus(),
    getRecentLog(),
    getSettings(),
  ]);
  renderStatus(status, Boolean(settings.bearerToken));
  renderEntries(recent);
}

function sendMessage<T>(payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response: T) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  refresh().catch(() => {
    // Ignore — popup will still render with defaults.
  });

  $<HTMLButtonElement>("capture-now").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("capture-now");
    btn.disabled = true;
    btn.textContent = "Capturing…";
    try {
      await sendMessage({ type: "tp:capture-now" });
    } catch {
      // Background may have gone to sleep; the user can hit it again.
    } finally {
      btn.textContent = "Capture this page now";
      btn.disabled = false;
      await refresh();
    }
  });

  const openOptions = (): void => {
    chrome.runtime.openOptionsPage();
  };
  $<HTMLButtonElement>("open-options").addEventListener("click", openOptions);
  $<HTMLAnchorElement>("open-options-link").addEventListener("click", (event) => {
    event.preventDefault();
    openOptions();
  });
});
