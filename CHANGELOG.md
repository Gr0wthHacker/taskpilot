# Changelog

All notable changes to TaskPilot. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-05-28

First complete build. TaskPilot is a local-first desktop task & calendar manager that treats Claude as a first-class operator: humans direct, Claude operates through a structured file/API/GUI workspace rather than an embedded API wrapper.

Built in 17 waves of parallel agent work. End state: **892 passing tests**, clean typecheck, clean production build, zero boot warnings, ~83,000 lines across 287 source files.

### Architecture

- **Runtime:** Electron 33 (main + renderer), Vite-built renderer, tsup-built main + CLI
- **UI:** React 18, Tailwind, shadcn/ui, Zustand, TanStack Query, react-router (HashRouter)
- **Data:** better-sqlite3 + Drizzle ORM, schema-versioned migrations (currently v4)
- **API:** Express on `127.0.0.1:7847`, per-install bearer auth, DNS-rebind host check, strict CORS
- **Agent bridge:** file-based I/O protocol at `~/.taskpilot/io/` (derive → derived → execute → results), chokidar watcher + 3s polling fallback
- **Native modules:** dual better-sqlite3 ABI (Node + Electron) auto-selected at runtime

### Core task management

- Task model: status, priority, due, tags, agent_method, agent_instructions, permissions, recurrence, links, phase, goal, attachments, context
- **Inbox · Board · Task Detail** views; **Daily Plan** with auto-generator; **Calendar** week view with drag-to-schedule
- **Derive → Execute pipeline:** auto-derive on creation; trust-by-default approval (only `review_required` + destructive + low-confidence work stops at /review); auto-execute for cli/either methods
- **Review queue** with approve/reject/requeue
- **Templates** with `{{variable}}` substitution; **Archive**; **Recurrence** engine (daily/weekdays/weekly/monthly)
- **Task linking:** blocks / related / duplicate-of
- **Permissions:** per-task `PermissionSet` (workspace, allowed_tools, denied_patterns, network, confirm_destructive, github scope) with inheritance + 4 profiles (trusted-local, sandboxed, read-only-research, github-pr)

### Claude operation surfaces

- **MCP server** — 13 tools over stdio for Claude Code / Claude Desktop
- **CLI** (`taskpilot`) — auth-aware, full task/cal/io command set
- **`/tp-process` + `/tp-watch`** slash commands for Claude Code runner mode (`/loop 60s /tp-watch`)
- **Cowork** — stable ARIA-labeled GUI for screen-driven operation
- **`taskpilot` skill** at `~/.claude/skills/taskpilot/` with 20+ reference docs

### Integrations

- **Google Calendar** — OAuth2 with localhost callback, bidirectional sync, availability, smart scheduling
- **GitHub** — PAT (encrypted via safeStorage), branches/commits/PRs/issues, two-way issue sync, PR webhooks, create-repo, context-based repo resolver
- **Slack** — capture from starred messages, post status updates
- **Gmail** — capture from labels/stars, draft creation, opt-in send
- **Reddit** — read-only JSON API (subreddit posts, comments, search)
- **Lovable** — task→project bridge to the lovable-builder skill
- **Notion** — one-way task mirror to a database
- **Generic webhooks** — `/api/webhooks/incoming/:name` with HMAC + mapping rules (Stripe, Cal.com, Linear, etc.)
- **Bulk import** — CSV + Notion export with preview→commit wizard

### Visibility & documentation

- **Task Journal** — chronological narrative per task (22 event kinds: created, derived, executed, attachments, feedback, cost, PR events, calendar, integrations, child completions)
- **Outputs panel** — unified view of files + external artifacts + metrics + summary; **briefing-pack** zip export
- **Phase / Stage model** — configurable pipelines (code, content, meeting, deal, research, launch, personal) with auto-advance on execute
- **Decision log** — append-only categorized notes per task (decision/context/reference/rationale/risk/note)
- **Auto-summary at completion** — heuristic one-liner on done tasks
- **Reports dashboard** — throughput, agent success rate, time-to-done, tag heat map, cost breakdown, review trend
- **Weekly status report** — markdown summary → Slack / Notion / Gmail draft / disk, cron-scheduled
- **Cross-task knowledge graph** — force-directed SVG of parent/blocks/related/produces edges
- **Full-text search** — SQLite FTS5 (LIKE fallback) over titles, descriptions, decisions, execution outputs, attachments; surfaced in command palette + `/search`

### Agent intelligence

- **Derive memory** — similar prior tasks inform new derivations
- **Skill binding** — registry of installed skills; tasks declare which skills to use
- **Cost tracking** — per-task LLM token + third-party cost (pricing table for Claude Opus/Sonnet/Haiku, GPT-4o family)
- **Confidence scoring** — low-confidence results auto-route to review (threshold default 0.7)
- **Feedback loop** — rejections feed `---PAST-REJECTIONS---` into future derive context

### Goals & organization

- **Goals / Initiatives tier** — tasks roll up via `goal_id` + tag membership; progress aggregation; `/goals` + `/goals/:id`
- **Workspaces** — per-business filter (IndexThread, Actually Health, Leal Health, HABA, MultiStateMD, Whitecoat Alliance)
- **Projects** — tag-aggregated dashboard

### Capture & productivity

- **Quick-capture** — global `Ctrl/Cmd+Shift+Space` opens a frameless capture window from any app
- **Inbox triage mode** — `/triage`, full-screen keyboard zero-inbox walk (1-4 priority, d/a/t/r/e/w/g, undo, session summary)
- **Command palette** — `⌘K` with navigation, actions, task search, full-text content search
- **Keyboard shortcuts** — vim-style `g`+letter navigation, `n` new task, `t` triage, `?` help

### Operations

- **Onboarding** — 5-step first-launch wizard (welcome → sample data → calendar → Claude wiring → done)
- **System tray** — quick actions, Cowork-queue badge, agent pause toggle
- **Notifications** — desktop alerts for review-needed, agent-complete, watcher errors
- **Backups** — daily DB snapshots with 14-day rotation, restore safety (`.pre-restore` rename)
- **Telemetry** — opt-in (default off), local jsonl always, upload only when enabled + endpoint set
- **Auto-launch** at login; **export/import** JSON; **diagnostic info** copy; **electron-log** to `~/.taskpilot/logs/`
- **Single-instance lock**, crash dialogs, React error boundary

### Security

- Per-install bearer token (`~/.taskpilot/api-token`, 0600), required on all routes except health/oauth-callback/webhooks
- DNS-rebinding host-header guard; strict CORS allowlist
- Path-traversal protection (`safeJoin`, task-id regex) across all filesystem writes
- OAuth tokens, GitHub PAT, Slack/Notion tokens encrypted at rest via Electron safeStorage
- OAuth state parameter (CSRF); HMAC webhook verification with constant-time compare
- Symlink rejection in the I/O watcher; tokens never logged or returned in responses
- Electron sandbox + contextIsolation; `setWindowOpenHandler` + `will-navigate` guards

### Known limitations / not in scope

- **Code signing** — not configured (needs paid certs); installers will trip Gatekeeper/SmartScreen
- **Auto-updater** — `electron-updater` not wired (needs a release host decision)
- **Linear sync** — skipped (not in active use)
- **Headless API runner** — intentionally omitted; Claude Code is the agent runtime
- Multi-account (single Google/Notion account per install); Notion mirror is one-way; Reddit is read-only

### Build provenance

Built across 17 waves with up to 4 parallel agents per wave. Test count grew 154 → 892. Two waves hit Anthropic session rate limits mid-flight and were cleanly re-dispatched. Full wave-by-wave history is in `INTEGRATION_NOTES.md`.
