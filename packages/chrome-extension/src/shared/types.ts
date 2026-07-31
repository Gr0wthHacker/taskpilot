// Shared types between extension entry points.
// Kept tiny on purpose — bundles are duplicated per entry, so size matters.

export interface PageMeta {
  url: string;
  title: string;
  h1: string | null;
  meta_description: string | null;
  selection: string | null;
}

export interface CaptureObservation extends PageMeta {
  captured_at: string; // ISO 8601
  tab_id: number | null;
}

export interface CaptureBatchPayload {
  source: "browser";
  observations: CaptureObservation[];
}

export interface ExtensionSettings {
  bearerToken: string;
  enabled: boolean;
  allowlist: string[]; // regex strings, OR'd
  blocklist: string[]; // regex strings, OR'd
  apiBaseUrl: string; // e.g. http://127.0.0.1:7847
}

export interface SyncStatus {
  lastSuccessAt: number | null; // epoch ms
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  pendingCount: number;
  unauthorized: boolean;
}

export type StatusColor = "green" | "yellow" | "red" | "grey";

export const DEFAULT_ALLOWLIST = [".*"];

// Common URLs we should never capture by default — banking, login, incognito hints,
// healthcare portals, password managers. Users can edit in options.
export const DEFAULT_BLOCKLIST = [
  "^https?://[^/]*\\bbank\\b",
  "^https?://[^/]*\\.bank/",
  "^https?://[^/]*\\bchase\\.com",
  "^https?://[^/]*\\bwellsfargo\\.com",
  "^https?://[^/]*\\bbankofamerica\\.com",
  "^https?://[^/]*\\bcapitalone\\.com",
  "^https?://[^/]*/login",
  "^https?://[^/]*/signin",
  "^https?://[^/]*/sign-in",
  "^https?://[^/]*/auth/",
  "^https?://[^/]*/oauth/",
  "^https?://accounts\\.google\\.com",
  "^https?://login\\.microsoftonline\\.com",
  "^https?://[^/]*\\bpaypal\\.com",
  "^https?://[^/]*\\b1password\\.com",
  "^https?://[^/]*\\blastpass\\.com",
  "^https?://[^/]*\\bbitwarden\\.com",
  "^chrome://",
  "^chrome-extension://",
  "^about:",
  "^edge://",
  "^view-source:",
];

export const DEFAULT_API_BASE_URL = "http://127.0.0.1:7847";

export const STORAGE_KEYS = {
  settings: "tp_settings",
  queue: "tp_queue",
  recentLog: "tp_recent_log",
  syncStatus: "tp_sync_status",
} as const;

export const QUEUE_MAX = 200;
export const RECENT_LOG_MAX = 10;
export const SELECTION_MAX_CHARS = 500;
