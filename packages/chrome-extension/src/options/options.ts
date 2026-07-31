// Options page wiring — load/save settings + test connection against /api/health.

import { pingHealth } from "../background/api-client.js";
import { DEFAULT_SETTINGS, getSettings, setSettings } from "../shared/storage.js";
import { ExtensionSettings } from "../shared/types.js";

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function joinLines(items: string[]): string {
  return items.join("\n");
}

function setStatus(text: string, kind: "ok" | "err" | "info"): void {
  const status = $<HTMLDivElement>("status");
  status.textContent = text;
  status.classList.remove("ok", "err");
  if (kind === "ok") status.classList.add("ok");
  if (kind === "err") status.classList.add("err");
}

async function load(): Promise<void> {
  const settings = await getSettings();
  $<HTMLTextAreaElement>("bearer-token").value = settings.bearerToken;
  $<HTMLInputElement>("enabled").checked = settings.enabled;
  $<HTMLInputElement>("api-base-url").value = settings.apiBaseUrl;
  $<HTMLTextAreaElement>("allowlist").value = joinLines(settings.allowlist);
  $<HTMLTextAreaElement>("blocklist").value = joinLines(settings.blocklist);
  $<HTMLSpanElement>("base-url-label").textContent = settings.apiBaseUrl;
}

function readForm(): ExtensionSettings {
  const bearerToken = $<HTMLTextAreaElement>("bearer-token").value.trim();
  const enabled = $<HTMLInputElement>("enabled").checked;
  const apiBaseUrlRaw = $<HTMLInputElement>("api-base-url").value.trim();
  const apiBaseUrl = apiBaseUrlRaw.replace(/\/$/, "") || DEFAULT_SETTINGS.apiBaseUrl;
  const allowlist = parseLines($<HTMLTextAreaElement>("allowlist").value);
  const blocklist = parseLines($<HTMLTextAreaElement>("blocklist").value);
  return {
    bearerToken,
    enabled,
    apiBaseUrl,
    allowlist: allowlist.length > 0 ? allowlist : [...DEFAULT_SETTINGS.allowlist],
    blocklist,
  };
}

async function save(): Promise<void> {
  const settings = readForm();
  await setSettings(settings);
  $<HTMLSpanElement>("base-url-label").textContent = settings.apiBaseUrl;
  setStatus("Saved.", "ok");
}

async function test(): Promise<void> {
  const settings = readForm();
  setStatus("Testing…", "info");
  const result = await pingHealth(settings.apiBaseUrl, settings.bearerToken);
  if (result.ok) {
    setStatus(`Connected (HTTP ${result.status}).`, "ok");
  } else if (result.status === 0) {
    setStatus(
      `Could not reach ${settings.apiBaseUrl}. Is TaskPilot running? (${result.body})`,
      "err",
    );
  } else if (result.status === 401 || result.status === 403) {
    setStatus(`Token rejected (HTTP ${result.status}).`, "err");
  } else {
    setStatus(`HTTP ${result.status}: ${result.body}`, "err");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  load().catch((err) => setStatus(`Failed to load: ${String(err)}`, "err"));
  $<HTMLButtonElement>("save").addEventListener("click", () => {
    save().catch((err) => setStatus(`Save failed: ${String(err)}`, "err"));
  });
  $<HTMLButtonElement>("test").addEventListener("click", () => {
    test().catch((err) => setStatus(`Test failed: ${String(err)}`, "err"));
  });
});
