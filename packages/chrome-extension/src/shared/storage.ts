// Typed wrappers around chrome.storage.local.

import {
  CaptureObservation,
  DEFAULT_ALLOWLIST,
  DEFAULT_API_BASE_URL,
  DEFAULT_BLOCKLIST,
  ExtensionSettings,
  RECENT_LOG_MAX,
  STORAGE_KEYS,
  SyncStatus,
} from "./types.js";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  bearerToken: "",
  enabled: true,
  allowlist: DEFAULT_ALLOWLIST,
  blocklist: DEFAULT_BLOCKLIST,
  apiBaseUrl: DEFAULT_API_BASE_URL,
};

export const DEFAULT_SYNC_STATUS: SyncStatus = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  pendingCount: 0,
  unauthorized: false,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const stored = raw[STORAGE_KEYS.settings] as Partial<ExtensionSettings> | undefined;
  if (!stored) return { ...DEFAULT_SETTINGS };
  return {
    bearerToken: typeof stored.bearerToken === "string" ? stored.bearerToken : "",
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : true,
    allowlist:
      Array.isArray(stored.allowlist) && stored.allowlist.length > 0
        ? stored.allowlist.filter((s): s is string => typeof s === "string")
        : [...DEFAULT_ALLOWLIST],
    blocklist:
      Array.isArray(stored.blocklist)
        ? stored.blocklist.filter((s): s is string => typeof s === "string")
        : [...DEFAULT_BLOCKLIST],
    apiBaseUrl:
      typeof stored.apiBaseUrl === "string" && stored.apiBaseUrl.length > 0
        ? stored.apiBaseUrl
        : DEFAULT_API_BASE_URL,
  };
}

export async function setSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.syncStatus);
  const stored = raw[STORAGE_KEYS.syncStatus] as Partial<SyncStatus> | undefined;
  if (!stored) return { ...DEFAULT_SYNC_STATUS };
  return {
    lastSuccessAt: typeof stored.lastSuccessAt === "number" ? stored.lastSuccessAt : null,
    lastErrorAt: typeof stored.lastErrorAt === "number" ? stored.lastErrorAt : null,
    lastErrorMessage:
      typeof stored.lastErrorMessage === "string" ? stored.lastErrorMessage : null,
    pendingCount: typeof stored.pendingCount === "number" ? stored.pendingCount : 0,
    unauthorized: typeof stored.unauthorized === "boolean" ? stored.unauthorized : false,
  };
}

export async function setSyncStatus(
  patch: Partial<SyncStatus>,
): Promise<SyncStatus> {
  const current = await getSyncStatus();
  const next: SyncStatus = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.syncStatus]: next });
  return next;
}

export async function getRecentLog(): Promise<CaptureObservation[]> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.recentLog);
  const stored = raw[STORAGE_KEYS.recentLog];
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

export async function pushRecentLog(entry: CaptureObservation): Promise<void> {
  const log = await getRecentLog();
  log.unshift(entry);
  while (log.length > RECENT_LOG_MAX) log.pop();
  await chrome.storage.local.set({ [STORAGE_KEYS.recentLog]: log });
}
