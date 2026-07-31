# TaskPilot Chrome Extension

A Manifest V3 browser extension that captures the URL, title, h1, meta description,
and any current text selection of pages you visit, and POSTs them to your local
TaskPilot app at `http://127.0.0.1:7847/api/context/capture/batch`.

It is a **standalone npm package** — it does **not** share node_modules with the
TaskPilot root project. The root install is untouched.

## Build

```bash
cd packages/chrome-extension
npm install
npm run build
```

Output lands in `packages/chrome-extension/dist/`.

For incremental development:

```bash
npm run watch
```

## Load unpacked

1. Open Chrome / Edge / Brave and navigate to `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select `packages/chrome-extension/dist/`.
4. The "TaskPilot Context Capture" icon should appear in the toolbar.

## Configure

1. Click the toolbar icon, then click **Options** (or right-click the icon →
   *Options*).
2. Paste your local bearer token. To get it:
   - **macOS / Linux:** `cat ~/.taskpilot/api-token`
   - **Windows (PowerShell):** `Get-Content $env:USERPROFILE\.taskpilot\api-token`
3. Click **Test connection**. You should see *Connected (HTTP 200)*.
4. Adjust the URL allowlist / blocklist as needed. Defaults block banks, login
   pages, and password managers. Allowlist defaults to `.*` (everything else).

## Hotkey

`Ctrl+Shift+Y` (Windows/Linux) or `Cmd+Shift+Y` (macOS) captures the current
page immediately and flushes the queue. You can rebind this at
`chrome://extensions/shortcuts`.

## What gets sent

For each page, **only** these fields:

```jsonc
{
  "url": "https://example.com/post",
  "title": "Page title",
  "h1": "First h1 text or null",
  "meta_description": "Meta description or null",
  "selection": "First 500 chars of any selected text, or null",
  "captured_at": "2026-06-01T12:34:56.789Z",
  "tab_id": 12345
}
```

Page HTML and body text are **never** sent.

## What does not get captured

- `chrome://`, `chrome-extension://`, `about:`, `edge://`, `view-source:` URLs
- Anything matching your blocklist (banks, login pages, password managers by
  default)
- Anything when the extension is toggled off in Options

## How it works under the hood

- A background service worker listens for `chrome.tabs.onActivated`,
  `chrome.tabs.onUpdated` (status `complete`), and the `capture-current-page`
  command.
- It injects `content/page-meta.js` via `chrome.scripting.executeScript` to
  scrape the metadata fields.
- Observations are enqueued in a `chrome.storage.local`-backed ring buffer
  (max 200 entries) so they survive service-worker restarts.
- A `chrome.alarms` tick every 60 seconds flushes the queue in batches with
  exponential backoff (1s / 4s / 16s) on 5xx or network errors.
- On HTTP 401/403 the batch is dropped and the action badge turns red with
  `!`.

## Privacy

All traffic stays on `localhost` (127.0.0.1). No remote endpoints. The bearer
token is stored only in this browser's extension storage.

## Uninstall

Disable or remove the extension from `chrome://extensions`. Deleting the
extension also clears its storage.
