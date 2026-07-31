// TaskPilot extension background service worker.
//
// Responsibilities:
// - Listen for tab activation/update + the capture-current-page command + the popup
//   "capture now" message.
// - Scrape page meta via chrome.scripting.executeScript.
// - Apply allow/blocklist filters.
// - Enqueue observations and flush in batches on a 60s alarm tick (or immediately
//   when the popup asks).

import { flushBatch } from "./api-client.js";
import { drain, enqueue, peekAll, requeueFront, size } from "./queue.js";
import {
  DEFAULT_SETTINGS,
  getSettings,
  pushRecentLog,
  setSyncStatus,
} from "../shared/storage.js";
import {
  CaptureObservation,
  ExtensionSettings,
  PageMeta,
  SELECTION_MAX_CHARS,
  STORAGE_KEYS,
} from "../shared/types.js";

const FLUSH_ALARM = "tp-flush";
const FLUSH_INTERVAL_MIN = 1; // 60s

// ---- Lifecycle ------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_INTERVAL_MIN });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_INTERVAL_MIN });
});

async function ensureDefaults(): Promise<void> {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!existing[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  }
}

// ---- Filtering ------------------------------------------------------------

function compileRegexList(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    try {
      out.push(new RegExp(trimmed, "i"));
    } catch {
      // Skip invalid regex; user gets feedback in options page if they paste garbage.
    }
  }
  return out;
}

function shouldCapture(url: string, settings: ExtensionSettings): boolean {
  if (!settings.enabled) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  const allow = compileRegexList(settings.allowlist);
  const block = compileRegexList(settings.blocklist);
  const allowed = allow.length === 0 ? true : allow.some((re) => re.test(url));
  if (!allowed) return false;
  const blocked = block.some((re) => re.test(url));
  if (blocked) return false;
  return true;
}

// ---- Capture pipeline -----------------------------------------------------

async function scrapeTabMeta(tabId: number): Promise<PageMeta | null> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/page-meta.js"],
    });
    if (!result || result.result === undefined || result.result === null) return null;
    const meta = result.result as Partial<PageMeta>;
    if (typeof meta.url !== "string" || typeof meta.title !== "string") return null;
    return {
      url: meta.url,
      title: meta.title,
      h1: typeof meta.h1 === "string" ? meta.h1 : null,
      meta_description:
        typeof meta.meta_description === "string" ? meta.meta_description : null,
      selection:
        typeof meta.selection === "string"
          ? meta.selection.slice(0, SELECTION_MAX_CHARS)
          : null,
    };
  } catch {
    // Frequent when the tab is chrome://, the Web Store, or in a sleeping state.
    return null;
  }
}

async function captureTab(tabId: number, fallbackUrl?: string): Promise<boolean> {
  const settings = await getSettings();
  let url = fallbackUrl ?? "";
  if (!url) {
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab.url ?? "";
    } catch {
      return false;
    }
  }
  if (!url || !shouldCapture(url, settings)) return false;

  const meta = await scrapeTabMeta(tabId);
  if (!meta) return false;
  // Re-check the URL the page reported (handles client-side redirects).
  if (!shouldCapture(meta.url, settings)) return false;

  const observation: CaptureObservation = {
    ...meta,
    captured_at: new Date().toISOString(),
    tab_id: tabId,
  };

  const queueLen = await enqueue(observation);
  await pushRecentLog(observation);
  await setSyncStatus({ pendingCount: queueLen });
  return true;
}

// ---- Flush ----------------------------------------------------------------

async function flushQueue(): Promise<void> {
  const pending = await size();
  if (pending === 0) {
    await setSyncStatus({ pendingCount: 0 });
    return;
  }
  const batch = await drain(50);
  if (batch.length === 0) return;
  const result = await flushBatch(batch);
  if (!result.ok) {
    if (!result.unauthorized) {
      await requeueFront(batch);
    }
    // On 401 we drop the batch (token won't fix itself by retrying).
  }
  const remaining = await size();
  await setSyncStatus({ pendingCount: remaining });
}

// ---- Event wiring ---------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    await flushQueue();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await captureTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    await captureTab(tabId, tab.url);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-current-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await captureTab(tab.id, tab.url);
  await flushQueue();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Popup -> background channel. Returns true to keep the channel open.
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  if (type === "tp:capture-now") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      const captured = await captureTab(tab.id, tab.url);
      await flushQueue();
      sendResponse({ ok: captured });
    })();
    return true;
  }
  if (type === "tp:flush-now") {
    (async () => {
      await flushQueue();
      const recent = await peekAll();
      sendResponse({ ok: true, pending: recent.length });
    })();
    return true;
  }
  return false;
});
