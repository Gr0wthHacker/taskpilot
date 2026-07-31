# TaskPilot

**A local-first desktop task & calendar manager built to treat an AI agent as a first-class operator — not a chat bolted onto a to-do list.**

TaskPilot runs entirely on your machine. Your tasks, calendar, and history live in a local SQLite database; an AI agent can read and act on them through a real API and a permissions model — the same way you can. It's what a task manager looks like when you design for a human *and* an agent working the same queue.

![TaskPilot screenshot](docs/screenshot.png) <!-- add a real screenshot before publishing -->

## Why it exists

Most "AI to-do apps" are a chat window that returns text. TaskPilot inverts that: the agent gets first-class, permissioned access to the same surfaces you use — create tasks, derive sub-tasks, execute agent-eligible work, manage your calendar — through four interfaces that all hit the same core:

- **MCP server** — 13 tools, so any MCP-aware client (Claude, etc.) can operate TaskPilot directly.
- **HTTP API** — a local REST API on `:7847` with bearer auth.
- **File I/O protocol** — a watched `io/` directory, so agents can work even when the app is closed.
- **Desktop GUI** — an Electron app with a keyboard-first, review-gated workflow.

## Features

- **Local-first & private** — SQLite on disk, no cloud dependency, no account required.
- **Agent runner with a permissions model** — every agent action is scoped by an explicit permission profile (allowed tools, workspace, network, denied globs). Nothing runs unsandboxed.
- **Derive → review → execute loop** — break a task into sub-tasks, approve them, and let an agent execute the agent-eligible ones. Irreversible actions are gated behind human review.
- **Calendar + availability** — events, free/busy, and scheduling that tasks can hook into.
- **Goals & projects** — group work into initiatives and track progress.
- **Integrations** — GitHub, Gmail (draft-only by default), Slack, Notion (one-way mirror), calendar.
- **Full-text search, cost tracking, decision logs, phase pipelines** for content/dev work.

## Stack

TypeScript (strict) · Electron · React + Tailwind · better-sqlite3 + Drizzle · Model Context Protocol SDK · Vite · Vitest

## Getting started

```bash
npm install
npm run dev        # Vite + Electron in dev
# or build and run:
npm run build && ELECTRON_PROD=1 npx electron .
```

The HTTP API comes up on `http://localhost:7847`; MCP server via `npm run mcp`.

## Architecture

```
┌─────────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────┐
│  Electron   │   │  HTTP API    │   │  MCP server │   │  File I/O    │
│  GUI        │   │  :7847       │   │  (13 tools) │   │  io/ watcher │
└──────┬──────┘   └──────┬───────┘   └──────┬──────┘   └──────┬───────┘
       └─────────────────┴──────────────────┴─────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Core: tasks, calendar,  │
                    │  goals, permissions,     │
                    │  agent runner (SQLite)   │
                    └──────────────────────────┘
```

## License

MIT

---

_Built by [Jack Gierlich](https://github.com/Gr0wthHacker). TaskPilot is a working tool I use daily; it's shared as an example of local-first, agent-operable software design._
