// Injected into the active tab via chrome.scripting.executeScript on demand.
// Extracts a fixed, privacy-conscious set of page metadata fields.
//
// IMPORTANT: this script is injected as `func` via chrome.scripting.executeScript,
// so it is loaded as an executable function context but esbuild still bundles it
// into an IIFE in case Chrome falls back to file-based injection or future
// versions wire it as a registered content script.

import { PageMeta, SELECTION_MAX_CHARS } from "../shared/types.js";

function readPageMeta(): PageMeta {
  const url = window.location.href;
  const title = document.title || "";
  const h1Element = document.querySelector("h1");
  const h1 = h1Element?.textContent?.trim() ?? null;
  const metaDescEl = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  const meta_description = metaDescEl?.content?.trim() ?? null;
  const selectionRaw = window.getSelection()?.toString() ?? "";
  const selection = selectionRaw.trim().slice(0, SELECTION_MAX_CHARS) || null;
  return { url, title, h1, meta_description, selection };
}

// Expose for chrome.scripting.executeScript({ func: ... }) — esbuild will name it
// in the IIFE bundle. We also auto-run-on-load in case the manifest is ever
// switched to a registered content script entry (no-op otherwise: it just posts
// a message that nobody listens to and the page continues).
const meta = readPageMeta();
try {
  chrome.runtime.sendMessage({ type: "tp:page-meta", meta }, () => {
    // Swallow lastError — no receiver is fine when injected on demand.
    void chrome.runtime.lastError;
  });
} catch {
  // chrome.runtime may be absent in some injection contexts; ignore.
}

// Make the function the IIFE's evaluation result for chrome.scripting return-value pickup.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
meta;
