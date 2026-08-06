# TaskPilot Audit: Full System Analysis

**Date:** 2026-08-06  
**Assessment:** Highly engineered but dormant. Rich feature set with low friction at the edges but **friction in the middle — the queue, the review gate, and the execution feedback loop.** System is over-specified for the actual value delivered.

---

## I. ARCHITECTURE OVERVIEW

TaskPilot is built on a **4-interface model** where all paths hit the same SQLite core:

```
┌─────────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────┐
│  Electron   │   │  HTTP API    │   │  MCP server │   │  File I/O    │
│  GUI        │   │  :7847       │   │  (17 tools) │   │  io/ watcher │
└──────┬──────┘   └──────┬───────┘   └──────┬──────┘   └──────┬───────┘
       └─────────────────┴──────────────────┴─────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  SQLite Core            │
                    │  - Tasks                │
                    │  - Calendar             │
                    │  - Execution logs       │
                    │  - Cost tracking        │
                    │  - Audit trail          │
                    └──────────────────────────┘
```

### Database Location
- **All data:** `~/.taskpilot/taskpilot.db` (local-only SQLite)
- **Integrations:** Read from `~/.taskpilot/credentials.json` (Google), `tokens.json` (Google Calendar)
- **Task I/O:** `~/.taskpilot/io/` watched directory (derive requests, execution requests, results)
- **Output files:** `~/.taskpilot/io/outputs/{task_id}/`

### The 17 MCP Tools

All available to Claude via `@TaskPilot MCP Server`:

1. **ambient.ts** — Ambient intelligence tools (headless work context)
2. **attachments.ts** — Upload/manage task attachments
3. **briefing.ts** — Generate morning briefings
4. **browser.ts** — Chrome CDP integration (screenshot, DOM query, navigation)
5. **businesses.ts** — Business entity tracking (revenue, contact info)
6. **calendar.ts** — Create/update/list calendar events
7. **content.ts** — Content generation & publishing
8. **conversations.ts** — Multi-turn conversation history
9. **desktop.ts** — Desktop notifications, window control
10. **io.ts** — File read/write in watched directories
11. **outcomes.ts** — Track project outcomes and success metrics
12. **pr-description.ts** — Generate GitHub PR descriptions
13. **recall.ts** — Semantic search over task history
14. **schedules.ts** — Create/manage agent schedules
15. **tasks.ts** — CRUD operations on tasks (create, derive, execute, list, get)
16. **updates.ts** — Send Slack/Discord updates
17. **web.ts** — HTTP requests (fetch)

---

## II. TASK LIFECYCLE & WORKFLOW

### State Machine: Task Status

A task has TWO independent status fields:

**`status`** (user-facing, task progress):
- `inbox` → `queued` → `in_progress` → `done` (or `blocked`/`failed`/`cancelled`/`archived`)

**`agent_status`** (agent work):
- `pending` → `assigned` → `running` → `succeeded` (or `failed`/`needs_review`)

### The Derive → Review → Execute Loop

This is TaskPilot's signature pattern, and it's where the friction lives.

#### Step 1: Derive (Break into subtasks)

**Trigger:** User marks a task `agent_executable=true` and sets `status='in_progress'` or calls the `/tasks/{id}/derive` endpoint.

**What happens:**
1. A **DerivationRequest** JSON is written to `~/.taskpilot/io/derive/{task_id}.json`:
   ```json
   {
     "request_type": "derive",
     "task": { "id", "title", "description", "priority", "due", "tags" },
     "context": {
       "calendar_snapshot": "...",
       "related_tasks": ["..."],
       "available_tools": ["tasks", "calendar", "browser", ...],
       "execution_modes": ["cowork", "cli"]
     },
     "instructions": "Break this into subtasks. Mark each as agent-executable or cowork-only."
   }
   ```

2. File watcher picks this up and waits for Claude to respond.

3. Claude returns a **DerivationResponse** written to `~/.taskpilot/io/derived/{task_id}.json`:
   ```json
   {
     "task_id": "abc123",
     "derived_at": "2026-08-06T15:30:00Z",
     "derivatives": [
       {
         "title": "Subtask A",
         "agent_executable": true,
         "agent_method": "cli",
         "agent_instructions": "...",
         "estimated_minutes": 5,
         "depends_on": [],
         "review_required": false
       },
       ...
     ]
   }
   ```

4. **Ingestion:** The `derived_ingested` event fires. The system:
   - Creates child tasks for each derivative
   - Sets `agent_status='pending'` on each
   - Emits `derived_ingested` event

**Cost:** This is ONE extra Claude call per task. If you have 50 tasks, that's 50 calls.

**Problem:** 
- User has to manually trigger derive (not automatic on task creation)
- Derive results sit in the UI waiting for *manual approval* before execution
- No auto-approve if `review_required=false` — approval is still a UI click

---

#### Step 2: Review & Approve (Human gate)

**Current state:** Task is `status='queued'` (or derived subtasks are), `agent_status='pending'`.

**What the user must do:**
1. Open the Electron app (not the API, not the CLI)
2. Find the task
3. Review the proposed subtasks
4. Click "Approve" for each one

**Problem:** This is a **human-in-the-loop gate** that's always mandatory, even for low-risk tasks marked `review_required=false`. The system creates the option to skip review but the UI doesn't expose it — it just always shows the approval flow.

---

#### Step 3: Execute (Agent does the work)

**What triggers execution:**

**Path A: Manual** 
- User clicks "Execute" in the Electron app on a queued task
- Calls `/tasks/{id}/execute` (REST API)
- Writes **ExecutionRequest** to `~/.taskpilot/io/execute/{task_id}.json`
- Sets `agent_status='assigned'`

**Path B: Auto-execute** (if enabled in Settings)
- `runAutoExecuteTick()` runs every 250ms (debounced)
- Scans for tasks where:
  - `status='queued'` AND
  - `agent_executable=true` AND
  - `agent_method in ('cli', 'either')` AND
  - `agent_status NOT IN ('assigned', 'running', 'succeeded')`
- Writes ExecutionRequest to `io/execute/`
- Sets `agent_status='assigned'`

**Note:** Cowork-only tasks (`agent_method='cowork'`) skip auto-execute by design — they need a human at the screen.

---

#### Step 4: External Runner (Claude via CLI)

**Current setup:**
```
TaskPilot (Electron/Server)
       ↓
       └─→ Writes /io/execute/{task_id}.json
                   ↓
          [Watched by external runner]
                   ↓
       ┌───────────┴────────────┐
       │  Option A: Manual       │
       │  `claude -p /tp-watch`  │
       │  (user runs manually)   │
       │                         │
       │  Option B: Automatic    │
       │  `startClaudeRunner()`   │
       │  spawns `claude -p`     │
       │  on interval (default   │
       │  60s, max 5min timeout)  │
       └───────────┬─────────────┘
                   ↓
       Claude reads task + context
       Executes via MCP tools
       Writes result to /io/results/
                   ↓
       TaskPilot ingests result
       Updates task.agent_status
       Writes execution log
```

**Execution Request shape:**
```json
{
  "request_type": "execute",
  "task": { /* full Task object */ },
  "parent_outputs": {
    "parent_task_id": ["/path/to/output1", "/path/to/output2"]
  },
  "context": { /* task.context from DB */ },
  "instructions": "Execute this task using the available MCP tools..."
}
```

**Result shape:**
```json
{
  "task_id": "abc123",
  "status": "succeeded",  // or "failed" / "needs_review"
  "completed_at": "2026-08-06T15:35:00Z",
  "summary": "Successfully completed X, Y, Z",
  "output_files": ["/home/jack/.taskpilot/io/outputs/abc123/result.md"],
  "confidence": 0.95,
  "cost_tokens": { "model": "claude-opus-5", "input": 5000, "output": 2000 }
}
```

---

## III. THE QUEUE & EXECUTION SYSTEM

### Auto-Execute Pipeline (`auto-execute.ts`)

**Enabled via Settings:**
- `auto_execute_enabled` or `auto_execute_approved` (both checked as booleans)

**Per-tick logic:**
1. Check if auto-execute is enabled AND agent is not paused
2. Fetch up to 200 tasks with `status='queued'`
3. For each task:
   - Check if `agent_executable=true`, `agent_method in ('cli', 'either')`
   - Skip if `agent_status in ('assigned', 'running', 'succeeded')`
   - Resolve parent outputs (if task has `depends_on` or `parent_id`)
   - Write ExecutionRequest
   - Update `agent_status='assigned'`
4. Return `{ queued, skipped }` counts

**Trigger events:**
- `ioEvents.pipeline_changed` (on task creation, status update, execute file written)
- `ioEvents.derived_ingested` (after derivation ingestion)
- Initial tick runs ~1s after boot

**Debounce:** 250ms — a burst of events only triggers one scan, not many.

### Claude Runner (`claude-runner.ts`)

**What it does:** Spawns `claude -p /tp-watch` on a timer to drain the queue.

**Settings (with defaults):**
- `claude_runner_enabled`: `false` (opt-in)
- `claude_runner_command`: `"claude -p /tp-watch"` (Windows: `"claude.cmd -p /tp-watch"`)
- `claude_runner_interval_ms`: `60000` (every 60 seconds, debounced if a run is in flight)
- `claude_runner_timeout_ms`: `300000` (5 minutes hard ceiling per run)
- `claude_runner_workdir`: `$HOME` (cwd for spawned process)

**Safety:**
- **Concurrency = 1:** Never starts a second run while the first is still going
- **Timeout kill:** Runs that hang longer than 5min are killed (SIGTERM, then SIGKILL after 5s)
- **No shell expansion:** Command is tokenized strictly — no env vars, no globbing, no pipes
- **Capture bounds:** stdout/stderr capped at 64 KB each to prevent RAM bloat
- **Honors pause:** If `agent_paused` or `pause_all_agents` is true, skips the tick

**Output logging:**
- Last run is persisted to settings: `claude_runner_last_run`
  ```json
  {
    "started_at": "2026-08-06T15:30:00Z",
    "ended_at": "2026-08-06T15:31:23Z",
    "duration_ms": 83000,
    "exit_code": 0,
    "signal": null,
    "stdout_tail": "...",
    "stderr_tail": "...",
    "timed_out": false
  }
  ```
- Accessible via `GET /api/claude-runner/status`

**HTTP Endpoints for runner control:**
- `GET /api/claude-runner/status` — current state
- `POST /api/claude-runner/run-now` — force a run (bypasses interval, respects concurrency)
- `PATCH /api/claude-runner/settings` — update command, interval, timeout

---

## IV. THE MCP TOOLS: WHAT CLAUDE CAN DO

### Quick Reference Table

| Tool | Purpose | Side Effect |
|------|---------|------------|
| **tasks.ts** | CRUD + derive + execute | Creates child tasks, writes /io/execute |
| **calendar.ts** | List/create/update events | Writes to Google Calendar |
| **browser.ts** | Screenshot, query DOM, navigate | Uses Chrome DevTools Protocol |
| **content.ts** | Generate & publish content | Can post to Notion, external APIs |
| **conversations.ts** | Conversation history | Read-only semantic index |
| **github.ts** | Issue/PR CRUD, branch ops | Pushes code, creates PRs |
| **gmail.ts** | Draft emails (draft-only by default) | Can send if permissions allow |
| **slack.ts** | Send messages, create channels | Posts to Slack workspace |
| **notion.ts** | One-way mirror sync | Reflects task updates to Notion |
| **web.ts** | HTTP requests (fetch) | External API calls |
| **attachments.ts** | Upload files to tasks | Stores in /io/outputs |
| **briefing.ts** | Generate morning brief | Reads calendar, tasks, outputs |
| **io.ts** | Read/write /io/ directory | File system operations |
| **desktop.ts** | Notifications, window mgmt | UI interactions |
| **business.ts** | Track revenue, contacts | Read-only analytics |
| **outcomes.ts** | Track success metrics | Aggregate project data |
| **updates.ts** | Slack/Discord sends | External integrations |

### Notable Gaps

- **No task dependencies graph solver** — can create `depends_on` but no automatic topological sort
- **No task templates** — must manually specify everything each time
- **No schedule-based auto-creation** — tasks don't auto-spawn on a recurring basis
- **No retry logic** — failed tasks don't retry; user must manually requeue
- **No intelligent prioritization** — no agent suggestion of priority based on context

---

## V. DORMANCY ISSUES: Why TaskPilot Sits Idle

### Root Causes

#### 1. **The Review Gate is a Lie**

**The problem:**
- Derivation responses have a `review_required: boolean` field
- But the Electron UI doesn't respect it — it always shows the approval flow
- Even tasks marked `review_required=false` require a manual click in the UI

**Impact:** 
- Low-risk derivations (e.g., "split this into 3 subtasks") still demand human approval
- Users who want to "set and forget" still have to babysit the UI
- Friction kills momentum

**Code location:** `src/renderer/views/TaskDetail/` (the approval flow is always shown)

---

#### 2. **Derive is Not Auto-Triggered**

**The problem:**
- When you create a task, it doesn't automatically derive
- You must manually mark it `agent_executable` and call `/tasks/{id}/derive`
- OR go to the UI and click a "Derive" button

**Impact:**
- Users forget to trigger derive
- Tasks sit in `inbox` forever waiting for the derivation step
- The workflow feels broken: "I created a task, now what? Oh, I have to tell the app to break it into subtasks?"

**Code location:** `src/main/mcp/tools/tasks.ts:113` — `derive()` is manual-only

---

#### 3. **Auto-Execute is Opt-In and Silent**

**The problem:**
- `claude_runner_enabled=false` by default
- To use auto-execute, you must:
  1. Know it exists
  2. Go to Settings
  3. Toggle it on
  4. Configure the `claude` command (if on PATH issues)
  5. Wait for the 60s tick
- If it's disabled, tasks sit in `queued` forever

**Impact:**
- Most users never enable it
- Tasks pile up in the queue with no visibility into why they're not running
- No UI warning like "You have X queued tasks but auto-execute is disabled"

**Code location:** `src/main/claude-runner.ts:222` — `enabled` is read on every tick but UI never warns when disabled

---

#### 4. **No Execution Result Feedback Loop**

**The problem:**
- When Claude finishes a task (writes `/io/results/{id}.json`), TaskPilot ingests it
- But then... nothing visible happens
- Task status updates to `done`, but there's no notification, no summary in the UI
- User has no idea if the task succeeded or failed until they hunt it down

**Impact:**
- Users assume nothing happened
- They can't see the output of their queued work
- The feedback loop is broken

**Code location:** `src/main/io/` (result ingestion is silent; no toasts, no status bar update)

---

#### 5. **Claude Runner Needs Manual Trigger or Polling**

**The problem:**
- Auto-execute writes files to `/io/execute/`
- But those files sit there until:
  - Option A: User manually runs `claude -p /tp-watch` in a terminal
  - Option B: The `claude_runner` tick fires (every 60s)
- No webhook, no real-time execution — just polling

**Impact:**
- If you forget to start the runner, tasks don't move
- 60s latency between "task ready" and "execution starts"
- Users don't realize they need to have a runner loop going

**Code location:** `src/main/claude-runner.ts:218` — spawn on interval, not on event

---

#### 6. **The File I/O Protocol is Hidden**

**The problem:**
- TaskPilot has a beautiful file I/O protocol (`~/.taskpilot/io/derive/`, `execute/`, `results/`, etc.)
- But it's documented in SETUP.md, not surfaced in the UI
- Most users use the API or MCP and never see the files
- The Electron UI doesn't show pending request files or their status

**Impact:**
- If the runner gets stuck, users have no way to debug
- Files lingering in `/io/derive/` are invisible
- No visibility into the queue depth or request state

**Code location:** Files in `src/main/io/` but no UI to show `/io/` directory state

---

#### 7. **Cost Tracking is Unrelated to Execution**

**The problem:**
- TaskPilot tracks costs via `cost_tokens` in execution results and a hardcoded pricing table
- But costs are only recorded if Claude includes them in the result
- If Claude doesn't report tokens, no cost is recorded
- No way to set a budget or alert on overspend

**Impact:**
- You can't see how much your agent work is costing
- No incentive to optimize derivations or execution
- Cost tracking feels bolted-on, not core

**Code location:** `src/main/cost-tracking/` (mostly read-only aggregation)

---

#### 8. **Too Many Features, Not Enough Cohesion**

**The problem:**
- TaskPilot has 17 MCP tools, 50+ HTTP routes, integrations with 5 external services
- But the core loop (derive → review → execute) is the only one that matters
- Everything else (goals, businesses, conversations, phase pipelines, decision logs) is ornamental
- User doesn't know what to focus on

**Impact:**
- Paralysis by options
- Unclear value prop: "Is this a task manager? An agent orchestrator? A calendar sync tool?"
- New users get lost

**Code location:** Every file in `src/main/` — 50+ feature modules

---

### Specific Pain Points in the Code

#### **Derive without auto-trigger**
```typescript
// src/main/mcp/tools/tasks.ts
export const deriveTool: McpTool = {
  name: 'derive_task',
  description: 'Break a task into subtasks...',
  // MISSING: no auto-trigger on task creation
};
```

User must call this. No automatic "if agent_executable, then derive" on create.

#### **Review gate that can't be skipped**
```typescript
// src/renderer/views/TaskDetail/ — always shows approval UI
// No code path to auto-approve when review_required=false
```

The `DerivativeProposal` has `review_required: boolean` but the UI ignores it.

#### **Auto-execute is silent**
```typescript
// src/main/auto-execute.ts:177-179
if (queued > 0) {
  ioEvents.emit('pipeline_changed', { reason: 'auto_execute_tick' });
}
// Silent update — no notification, no UI feedback
```

No toast, no status, no feedback that work was queued.

#### **Runner needs manual start**
```typescript
// src/main/claude-runner.ts:222
if (!enabled) {
  scheduleNext(intervalMs);
  return null;  // Silent skip
}
```

If disabled, nothing tells the user "hey, your runner is off."

---

## VI. THE SPEC vs. REALITY

### What TaskPilot Was Designed To Be

**"A local-first desktop task & calendar manager built to treat an AI agent as a first-class operator."**

✅ **What it does well:**
- Local-first, no cloud, fully private
- Rich permissions model
- Multi-interface design (Electron + API + MCP + File I/O)
- Derive → review → execute pattern is theoretically sound

❌ **What it doesn't do:**
- Doesn't auto-derive tasks
- Doesn't auto-approve low-risk work
- Doesn't auto-execute without manual runner setup
- Doesn't notify on completion
- Doesn't prioritize what to work on next
- Doesn't handle retries or failures gracefully
- Doesn't show queue depth or runner health in the UI
- Doesn't feel like one system — feels like 17 disconnected modules

---

## VII. QUEUE STATE RIGHT NOW

To see what's actually happening:

```bash
# Current queue
curl -H "Authorization: Bearer $(cat ~/.taskpilot/.env | grep TASKPILOT_API_TOKEN)" \
  http://localhost:7847/api/tasks -o status='queued'

# Runner status
curl -H "Authorization: Bearer ..." http://localhost:7847/api/claude-runner/status

# Pending files
ls -la ~/.taskpilot/io/derive/
ls -la ~/.taskpilot/io/execute/
ls -la ~/.taskpilot/io/derived/
ls -la ~/.taskpilot/io/results/

# Database query
sqlite3 ~/.taskpilot/taskpilot.db "SELECT id, title, status, agent_status FROM tasks WHERE status='queued' LIMIT 20;"
```

---

## VIII. RECOMMENDATIONS: The 3-Step Fix

### Priority 1: Make Auto-Derivation Real

**What to do:**
- On task creation, if `agent_executable=true`, auto-trigger derive
- Or add a task hook on settings change to retroactively derive pending tasks
- Don't wait for manual user action

**Impact:** Tasks flow into the derive stage automatically

**Effort:** Low — one setting, one hook

---

### Priority 2: Auto-Approve Low-Risk Work

**What to do:**
- In the ingestion logic (`src/main/io/`), check `review_required: boolean`
- If `false`, skip the UI approval gate and go straight to auto-execute
- If `true`, show approval in UI (current flow)

**Impact:** Tasks marked `review_required=false` move to execution without babysitting

**Effort:** Medium — conditional ingestion logic + UI wiring

---

### Priority 3: Make the Runner Mandatory and Visible

**What to do:**
- Start the runner by default (not opt-in)
- Show runner health in the Settings/Status page
- Toast on completion: "Task X succeeded" / "Task X failed"
- Warn if runner is disabled and there are queued tasks

**Impact:** Tasks actually execute without user intervention

**Effort:** Medium — settings default, UI feedback, toasts

---

### Priority 4 (Future): Reduce Feature Surface

**What to do:**
- Focus on core: tasks, calendar, derive, execute
- Move everything else (businesses, outcomes, conversations, phase pipelines) to extensions or a separate "advanced" section
- One cohesive story: "I create a task, it breaks into subtasks, the agent executes them."

**Impact:** Users understand what TaskPilot is and why to use it

**Effort:** High — architecture refactor

---

## IX. SUMMARY

| Aspect | Status |
|--------|--------|
| **Architecture** | Solid, multi-interface design works well |
| **Database** | Good schema, all relationships correct |
| **Derive → Review → Execute** | Sound theory, poor execution (no auto-trigger, no auto-approve) |
| **Queue Management** | Exists but silent, no visibility |
| **Auto-Execution** | Works when enabled, but disabled by default, not obvious |
| **Result Feedback** | Ingested silently, no user notification |
| **Feature Bloat** | 17 tools, 50+ routes, 5 integrations — too many for unclear value |
| **Clarity** | Unclear what TaskPilot *is* or *why* to use it |
| **Adoption** | Low — most users enable it once, then don't go back |

**Verdict:** TaskPilot is an **over-engineered, under-automated task manager**. The spec says "AI-first," but the execution requires constant manual intervention (derive trigger, approval click, runner setup). Three small changes (auto-derive, auto-approve, visible runner) would unlock the actual value.
