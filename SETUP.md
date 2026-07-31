# TaskPilot Setup

## Google Calendar credentials

TaskPilot connects to Google Calendar via OAuth2. You need to create your own
OAuth client and place the credentials file at `~/.taskpilot/credentials.json`.

### 1. Create the OAuth client

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Click **Create credentials → OAuth client ID**.
3. Choose **Web application** (recommended) or **Desktop app**.
4. Under **Authorized redirect URIs**, add this exact URL:

   ```
   http://localhost:7847/oauth/callback
   ```

   This is **required**. TaskPilot runs a local callback endpoint on port
   `7847` that receives the redirect from Google and finishes the auth
   exchange automatically. If this URI is missing or differs (e.g. wrong
   port, `127.0.0.1` instead of `localhost`, trailing slash), Google will
   return `redirect_uri_mismatch` and the flow will fail.
5. Name it something like `TaskPilot Local`.
6. Click **Create**, then **Download JSON**.

### 2. Enable the Calendar API

1. In the Google Cloud Console, go to **APIs & Services → Library**.
2. Search for **Google Calendar API** and click **Enable**.

### 3. Drop the file in place

Save the downloaded JSON to:

```
~/.taskpilot/credentials.json
```

Both export shapes are accepted:

```json
{
  "installed": {
    "client_id": "...",
    "client_secret": "...",
    "redirect_uris": ["http://localhost:7847/oauth/callback"]
  }
}
```

or:

```json
{
  "web": {
    "client_id": "...",
    "client_secret": "...",
    "redirect_uris": ["http://localhost:7847/oauth/callback"]
  }
}
```

### 4. Complete the OAuth flow

Open the desktop app → Settings → **Connect Google Calendar**. The happy
path is now fully automatic:

1. TaskPilot generates a consent URL via `POST /api/calendar/auth/start` and
   opens it in your default browser.
2. You grant the requested scopes:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.readonly`
3. Google redirects back to `http://localhost:7847/oauth/callback`.
   TaskPilot's local server receives the code, exchanges it for tokens, and
   writes them to `~/.taskpilot/tokens.json`. The browser tab shows a
   "Connected" page and closes itself a few seconds later.
4. The Settings view polls `/api/calendar/status` every 2 seconds while the
   flow is in progress, so it switches to "Connected" on its own — no
   copy-paste required.

If anything blocks the redirect (firewall, browser tab closed mid-flow,
port collision), there's a fallback:

- The error page on `/oauth/callback` surfaces the raw `code` with a copy
  button.
- Paste that code into the **manual code** input next to the auth URL in
  Settings → Calendar and click **Submit code**. The app calls
  `POST /api/calendar/auth/complete` with it and you're connected.

After either path, `npm run cli -- cal today` and `npm run cli -- cal sync`
work.

### Security notes

- `tokens.json` is plaintext JSON. Treat it as a secret. A future release
  will encrypt with the OS keychain.
- `credentials.json` and `tokens.json` are both in `.gitignore` patterns
  by default (`~/.taskpilot/` is outside the repo).

### Disconnecting

`POST /api/calendar/auth/disconnect` clears the in-memory client and
deletes `~/.taskpilot/tokens.json`. `credentials.json` is left in place
so reconnecting doesn't require recreating the OAuth client.

## Database

The SQLite database lives at `~/.taskpilot/taskpilot.db`. It is created on
first boot via inline migrations. To regenerate from drizzle-kit:

```bash
npm run db:generate   # generate new migrations from src/shared/schema.ts
npm run db:migrate    # apply them
```

The runtime always runs inline migrations first (idempotent), then layers
drizzle-generated ones on top, so the app boots even if `drizzle-kit` has
never been run.

## Troubleshooting

- **`TaskPilot app not running` from the CLI** — start the API with
  `npm run dev` or `npm run server`.
- **`calendar_not_initialized` from `/api/calendar/*`** — the credentials
  file is missing or malformed.
- **`redirect_uri_mismatch` from Google** — your OAuth client doesn't have
  `http://localhost:7847/oauth/callback` registered as an authorized
  redirect URI. Re-check step 1 above.
- **Browser tab opens to "Connection error" with a code visible** — the
  local callback couldn't complete the exchange (often because the API
  server restarted mid-flow). Copy the code and paste it into Settings →
  Calendar → manual code input.
- **Stuck on "Waiting for Google…"** — make sure TaskPilot is running on
  port `7847` (`curl http://localhost:7847/api/health`). Polling times out
  after 60 seconds; if it does, fall back to the manual code paste.
- **Files stuck in `~/.taskpilot/io/derive/` or `execute/`** — Claude
  hasn't picked them up yet, or hasn't written a response. The watcher
  only cleans these up after a valid response lands in `derived/` or
  `results/`.
- **Files in `~/.taskpilot/io/_invalid/`** — Zod validation failed.
  Inspect the file; the timestamped name preserves the original.
