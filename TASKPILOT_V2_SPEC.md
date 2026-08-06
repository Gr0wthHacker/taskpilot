# TaskPilot v2: Ambient Technical Companion

**Version:** 2.0 (Design Phase)  
**Status:** Architecture & Rollout Plan  
**Last Updated:** 2026-08-06

---

## I. VISION

TaskPilot v2 is a **technical companion that watches your work and helps you move faster**.

**v1 (current):** You tell it what to do → it executes (task manager)

**v2 (new):** It watches what you're doing → suggests next steps → executes safely (ambient assistant)

### Core Promise

- **Observes** your browser, code, GitHub, searches, notes in real-time
- **Understands context** — what project, what problem, what's the goal
- **Suggests proactively** — next steps, risks, related research, task breakdowns
- **Surfaces reactively** — toasts, briefings, prompts (not silent)
- **Executes intelligently** — auto-derives and queues based on context, not manual trigger

---

## II. ARCHITECTURE: 6 LAYERS

```
┌─────────────────────────────────────────────────────────────┐
│                  PROACTIVE SURFACING                        │
│        (Toasts, Briefing, "What's Next?", Synthesis)        │
└────────────┬────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────┐
│             SUGGESTION ENGINE (ranked 3-5)                  │
│  Next Steps | Related Research | Risks/Gaps | Connections  │
└────────────┬────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────┐
│           CONTEXT ENGINE (live model)                       │
│  Current Project | Research Threads | Goals | Blockers      │
└────────────┬────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────┐
│         OBSERVATION LAYER (event stream)                    │
│  Browser | GitHub | Code | Searches | Notes | Commits       │
└──────────────────────────────────────────────────────────────┘
             │
        (All Local)
             │
┌────────────▼────────────────────────────────────────────────┐
│       TASK CURATION & EXECUTION (v1 pipeline)               │
│  Auto-Derive | Auto-Approve | Queue | Execute               │
│         + 17 MCP Tools (unchanged)                           │
└──────────────────────────────────────────────────────────────┘
```

### Layer Details

#### 1. Observation Layer (`:5713/api/observe/*`)

**Purpose:** Collect ambient signals about your work.

**Data sources:**

| Source | Method | Event | Frequency |
|--------|--------|-------|-----------|
| **Browser** | Chrome DevTools Protocol (CDP) / local history | Page visit, search query, tab focus | Real-time |
| **GitHub** | GraphQL API (authenticated) | PR activity, issue comment, push, workflow | 60s polling |
| **Code** | Chokidar (local file watcher) | File modified, git commit, branch change | Real-time |
| **Searches** | Browser history query parsing | Search query text, timestamp | Real-time |
| **Notes** | File watcher on ~/Notes, ~/Docs, Notion | Note created, updated, tagged | Real-time |
| **Terminal** (optional) | Shell history or subprocess exec | Command run (filtered: build, test, deploy) | On event |

**Event model:**
```typescript
interface ObservationEvent {
  id: string;
  timestamp: string; // ISO 8601
  source: 'browser' | 'github' | 'code' | 'search' | 'notes' | 'terminal';
  type: string; // e.g., 'page_visit', 'search_query', 'file_change', 'commit', 'pr_activity'
  data: Record<string, unknown>;
  raw: string; // Original text (for search/notes)
  tags?: string[]; // Auto-detected: ['react', 'api', 'bug-fix', ...]
  confidence: number; // 0-1, how confident this is relevant
}
```

**Storage:** SQLite new table `observation_events` (30-day rolling window, ~10K events/day = 300K max).

**Privacy:** All collection is local. No data leaves the machine.

---

#### 2. Context Engine (`:5713/api/context/*`)

**Purpose:** Build a live model of "what is Jack working on right now?"

**State model:**
```typescript
interface ContextState {
  updated_at: string;
  
  // Current focus
  current_project: {
    name: string;
    repo?: string;
    goal?: string;
    started_at: string;
    confidence: number; // 0-1
  };
  
  // What you're investigating
  research_threads: Array<{
    id: string;
    query: string; // e.g., "How to optimize React renders"
    started_at: string;
    last_active: string;
    observations: string[]; // Event IDs involved
    findings: string[]; // Notes, links, conclusions
    status: 'active' | 'paused' | 'concluded';
  }>;
  
  // What might be blocking you
  blockers: Array<{
    type: 'waiting_for_review' | 'waiting_for_feedback' | 'technical_blocker' | 'unknown';
    description: string;
    task_id?: string;
    duration_minutes: number;
    last_surfaced: string;
  }>;
  
  // Inferred next steps
  candidate_threads: Array<{
    type: 'next_file' | 'next_feature' | 'follow_up' | 'risk';
    description: string;
    priority: 'high' | 'medium' | 'low';
    evidence: string[]; // Why we think this
  }>;
}
```

**Inference rules:**

| Signal | Inference |
|--------|-----------|
| Repo file edited 5+ times in 2h | Current project = this repo |
| Same GitHub repo visited 3+ times today | Active project focus |
| Search queries on topic X all in last 2h | Research thread on X |
| File modified, PR not merged | Blocker: waiting for merge |
| Tab open to docs 30+ min, no code edit | Blocker: understanding/research |
| Commit message "WIP" or "temp" | Current project likely incomplete |
| Page visit to external tool (Vercel, Railway) | Possible deployment blocker |

**Update cycle:** Every 10 seconds (debounced), ingest new events and re-run inference.

**Storage:** SQLite table `context_state` (one row, constantly updated) + `research_threads` (normalized).

---

#### 3. Suggestion Engine (`:5713/api/suggestions/*`)

**Purpose:** "What should Jack work on next?"

**Suggestion types & ranking:**

1. **Next Steps** (highest priority)
   - Unblock critical path: "PR waiting for review", "Test failing"
   - Natural continuation: "You've done A and B, C is probably next"
   - Confidence-based: "You typically run linter after editing this file"

2. **Related Research** (context-aware)
   - Similar searches: "You searched 'React render optimization', also see: 'React.memo', 'useMemo patterns'"
   - Related files: "This component uses pattern X, so does FileY.tsx"
   - Cross-project patterns: "You solved this in ProjectA, same pattern in ProjectB"

3. **Risks & Gaps** (preventive)
   - Tests missing: "You added endpoint `/api/x` but no tests"
   - Documentation gap: "You changed schema but didn't update README"
   - Forgotten follow-ups: "You commented on this PR 3h ago, still no response"

4. **Cross-Project Connections** (opportunistic)
   - Reuse: "ProjectA has module Y that ProjectB needs"
   - Dependencies: "ProjectA depends on ProjectB, that PR might affect you"

**Ranking algorithm:**

```
score = 
  (urgency_weight * urgency_score) +
  (momentum_weight * momentum_score) +
  (relevance_weight * relevance_score) +
  (time_available_penalty)

where:
  urgency_score = blocker_severity / time_since_blocker
  momentum_score = time_in_context / 60 (up to 1.0)
  relevance_score = query_similarity + file_proximity + project_match
  time_available_penalty = if(in_flow_state) { 0 } else { 0.1 }
```

**Output:** 3–5 ranked suggestions every 5 minutes. Example:

```json
{
  "suggestions": [
    {
      "rank": 1,
      "type": "next_step",
      "title": "Unblock: PR #42 needs review",
      "description": "Your PR on TypeScript refactor has 2 approvals, waiting for 1 more. Reviewer last active 30m ago.",
      "urgency": "high",
      "action": "Review PR #42",
      "estimated_time_minutes": 10,
      "confidence": 0.95,
      "evidence": ["pr_activity_detected", "2_approvals_pending", "reviewer_online"]
    },
    {
      "rank": 2,
      "type": "related_research",
      "title": "You searched 'React render optimization'. Also see: React.memo patterns",
      "description": "Link to this blog post might help with your current research.",
      "urgency": "low",
      "action": "Read article",
      "estimated_time_minutes": 15,
      "confidence": 0.7,
      "evidence": ["search_query_match", "topic_recency"]
    }
  ],
  "timestamp": "2026-08-06T15:30:00Z"
}
```

**Storage:** `suggestions` table with suggestion ID, rank, type, data, created_at, dismissed_at (for analytics).

---

#### 4. Proactive Surfacing

**Purpose:** Show suggestions without being annoying.

**Channels:**

| Channel | When | Max Frequency | Content |
|---------|------|---------------|---------|
| **Toast** | Urgent suggestion arrives | 1 per 15 min | Title + action button |
| **Morning Briefing** | 8 AM (configurable) | Daily | Summary of yesterday's work, today's suggestions |
| **"What's Next?" Sidebar** | User opens app | On demand | Top 5 suggestions ranked + dismiss/defer buttons |
| **Research Synthesis** | User enters research thread view | On demand | Aggregate findings, related links, key insights |
| **Status bar** | Always visible | Live | "X queued tasks, Y blockers, 2 suggested next steps" |

**Toast logic:**
```typescript
// Only show if:
// 1. Suggestion urgency is 'high' AND 
// 2. No toast in last 15 minutes AND
// 3. User hasn't dismissed same suggestion type in last 24h
if (suggestion.urgency === 'high' && 
    !recentToast() && 
    !isDismissedToday(suggestion.type)) {
  showToast(suggestion.title, suggestion.action);
}
```

**Morning Briefing template:**
```markdown
# Good morning, Jack

## Yesterday's Work
- Completed: X, Y, Z (3 tasks)
- Spent 2.5h on React optimization research
- Merged PR #40, waiting for review on #42

## Today's Suggested Focus
1. **Unblock: PR #42 review** (10 min) — 2 approvals, ready to merge
2. **Research: Implement useMemo pattern** (30 min) — related to yesterday's work
3. **Risk: Add tests for endpoint /api/users** (25 min) — you added this yesterday

## What Changed Overnight
- No new issues on your projects
- 1 comment on your PR (needs response)
```

---

#### 5. Reactive Task Curation

**Purpose:** Convert suggestions into safe, auto-approved tasks.

**Flow:**

```
Suggestion (e.g., "Add tests for /api/users")
       ↓
    [Auto-Derive]
    Takes suggestion + context → creates 2-3 subtasks
    ↓
    Proposals:
    - Create test file (read-only, 10 min)
    - Run test suite (local execution, 5 min)
    - Commit tests (git push, risky!)
       ↓
    [Auto-Approval Check]
    For each proposal:
       ↓
       Is this risky?
       ├─ Read-only / analysis: ✅ AUTO-APPROVE
       ├─ Local execution / test: ✅ AUTO-APPROVE
       ├─ Code push / merge: ❌ REQUIRE REVIEW
       ├─ Third-party API call: ❌ REQUIRE REVIEW
       └─ Destructive op: ❌ REQUIRE REVIEW
       ↓
    [User Sees]
    1. "Add tests" — auto-queued, executing now
    2. "Commit & push" — waiting for your approval
       ↓
    [Execute]
    Queue auto-approved tasks to v1 pipeline
```

**Auto-approval heuristic:**
```typescript
interface AutoApprovalCriteria {
  method: 'cowork' | 'cli' | 'either';
  estimated_minutes: number; // < 20 min
  confidence: number; // > 0.7
  risk_level: 'low' | 'medium' | 'high'; // from suggestion data
  operation_type: string; // 'read_only', 'local_execute', 'api_call', 'code_push'
}

function canAutoApprove(proposal: DerivativeProposal): boolean {
  const criteria = extractCriteria(proposal);
  
  return (
    criteria.risk_level === 'low' &&
    criteria.estimated_minutes <= 20 &&
    criteria.confidence >= 0.7 &&
    ['read_only', 'local_execute'].includes(criteria.operation_type)
  );
}
```

**Audit trail:** Every auto-approved task is logged with reasoning.
```json
{
  "task_id": "xyz",
  "auto_approved_at": "2026-08-06T15:35:00Z",
  "reason": "suggestion-derived, low-risk, 10 min estimate, 0.85 confidence",
  "suggestion_id": "sug123",
  "user_can_reverse": true
}
```

---

#### 6. Integration with v1 Pipeline (Unchanged)

**The execution layer stays the same:**
- Auto-derived tasks → `/io/execute/` (write request)
- Claude reads via `/tp-watch` (existing skill)
- Results → `/io/results/` (existing ingestion)
- Execution logs recorded (existing)

**What changes:**
- Tasks come from two sources: manual creation + auto-derivation from suggestions
- Auto-derived tasks skip the manual approval UI (go straight to queue if low-risk)
- Result ingestion now also updates `research_threads` (new findings logged)
- 17 MCP tools unchanged, but now called from suggestion engine too

---

## III. NEW DATA MODELS

### Database Schema Additions

```sql
-- Observation events (30-day rolling window)
CREATE TABLE observation_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL, -- browser, github, code, search, notes, terminal
  type TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON
  raw TEXT,
  tags TEXT, -- JSON array
  confidence REAL,
  created_at TEXT NOT NULL,
  INDEX (timestamp DESC, source)
);

-- Context state (single row, constantly updated)
CREATE TABLE context_state (
  id TEXT PRIMARY KEY,
  current_project_name TEXT,
  current_project_repo TEXT,
  current_project_goal TEXT,
  current_project_started_at TEXT,
  current_project_confidence REAL,
  research_threads TEXT, -- JSON array (denormalized for performance)
  blockers TEXT, -- JSON array
  candidate_threads TEXT, -- JSON array
  updated_at TEXT NOT NULL
);

-- Research threads (normalized)
CREATE TABLE research_threads (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_active TEXT NOT NULL,
  status TEXT, -- active, paused, concluded
  findings TEXT, -- JSON array of {link, text, source, timestamp}
  observation_event_ids TEXT, -- JSON array
  created_at TEXT NOT NULL,
  INDEX (status, last_active DESC)
);

-- Suggestions (for history & analytics)
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  rank INTEGER,
  type TEXT, -- next_step, related_research, risk, connection
  title TEXT NOT NULL,
  description TEXT,
  urgency TEXT, -- high, medium, low
  action TEXT,
  estimated_minutes INTEGER,
  confidence REAL,
  evidence TEXT, -- JSON array
  dismissed_at TEXT,
  actioned_at TEXT,
  created_at TEXT NOT NULL,
  INDEX (created_at DESC, dismissed_at)
);

-- Auto-approval audit log
CREATE TABLE auto_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  suggestion_id TEXT,
  reason TEXT,
  risk_level TEXT,
  operation_type TEXT,
  auto_approved_at TEXT NOT NULL,
  user_reversed_at TEXT,
  INDEX (task_id)
);
```

---

## IV. NEW HTTP ENDPOINTS

All at `:5713/api/` (separate port to avoid v1 collision).

### Observation
- `POST /observe/event` — Log a manual observation
- `GET /observe/events` — Query events (filter by source, time, tags)
- `GET /observe/summary` — 30-day summary by source

### Context
- `GET /context/state` — Current context model
- `GET /context/threads` — All research threads
- `GET /context/blockers` — Current blockers

### Suggestions
- `GET /suggestions/next` — Top suggestions ranked
- `POST /suggestions/{id}/dismiss` — Dismiss for 24h
- `POST /suggestions/{id}/defer` — Defer to tomorrow
- `POST /suggestions/{id}/execute` — Convert to task (if auto-approvable, queue immediately)

### Briefing
- `GET /briefing/morning` — Generate morning briefing
- `GET /briefing/synthesis?thread_id=X` — Synthesize a research thread

### Runner Control (Integration)
- `POST /execute-suggestion` — Convert suggestion to v1 task, queue it

---

## V. NEW UI COMPONENTS

### In Electron App

#### 1. **Toast Notifications**
```
┌─────────────────────────────────┐
│ ✓ Unblock: PR #42 needs review  │
│       [Take Action]  [Dismiss]  │
└─────────────────────────────────┘
```

#### 2. **Morning Briefing Modal** (8 AM)
```
┌─────────────────────────────────────┐
│ Good morning! Here's what's next:   │
├─────────────────────────────────────┤
│ ✓ Yesterday: 3 tasks completed      │
│ ⏳ Today's focus:                    │
│   1. Unblock: PR review (10 min)    │
│   2. Research: React patterns (30)  │
│   3. Risk: Add tests (25 min)       │
│                                     │
│ [Got it] [View Suggestions]        │
└─────────────────────────────────────┘
```

#### 3. **"What's Next?" Sidebar**
```
Suggestions (5)

1. Unblock: PR #42 [high]
   You typically review within 1h
   [Do It]  [Defer]  [Dismiss]

2. Research: useMemo patterns [medium]
   Related to yesterday's work
   [Read]  [Add Task]  [Dismiss]

3. Risk: Add tests [medium]
   You added /api/users endpoint
   [Create Task]  [Remind Later]

[View All] [Settings]
```

#### 4. **Research Synthesis View**
```
Research Thread: "React Render Optimization"
Started: 2 days ago, Last active: 1h ago

Findings:
• React.memo for component memoization
  Source: blog post + your experiment
• useMemo for expensive computations
  Source: official docs + GitHub issue
• Avoid inline object literals
  Source: your commit message notes

Related Files:
• components/OptimizedList.tsx (modified)
• hooks/useCache.ts (created)
• tests/performance.test.ts (pending)

Suggested Next: Run benchmarks, then document pattern
```

#### 5. **Status Bar**
```
TaskPilot | 2 queued tasks | 1 blocker | 3 suggested | 🟢 Observer active
```

---

## VI. ALGORITHMS (Pseudocode)

### Thread Linking Algorithm
```typescript
function linkObservationsToThreads(event: ObservationEvent): void {
  // For a new event, find or create research threads
  
  if (event.type === 'search_query') {
    const query = event.data.query;
    
    // Check: does this match an existing thread?
    let thread = findThreadByQuery(query, similarityThreshold=0.7);
    
    if (!thread) {
      // New thread
      thread = createThread(query);
    }
    
    // Update thread recency
    thread.last_active = now();
    thread.observation_event_ids.push(event.id);
    thread.save();
  }
  
  if (event.type === 'file_change') {
    // Try to infer project + thread from file path
    const filePath = event.data.path;
    const project = inferProject(filePath);
    
    // Is this file related to an active research thread?
    const relatedThreads = findThreads({
      project,
      tags: extractTags(filePath)
    });
    
    for (const thread of relatedThreads) {
      thread.observation_event_ids.push(event.id);
      thread.last_active = now();
      thread.save();
    }
  }
}
```

### Context Inference
```typescript
function inferContextState(): ContextState {
  // Recent events (last 2h)
  const recentEvents = observationEvents.where(
    timestamp > now() - 2h
  );
  
  // Most-edited project
  const fileChangeEvents = recentEvents.filter(e => e.type === 'file_change');
  const currentProject = groupBy(fileChangeEvents, 'project')
    .map(g => ({ project: g[0], count: g.length }))
    .sort((a, b) => b.count - a.count)[0];
  
  // Active research threads (last active < 1h)
  const activeThreads = researchThreads.where(
    status = 'active' AND
    last_active > now() - 1h
  );
  
  // Blockers (tasks waiting or events with 'waiting_for' pattern)
  const blockers = [
    ...tasks.where(status IN ('blocked', 'in_progress') AND updated_at < now() - 1h),
    ...detectBlockersFromEvents(recentEvents)
  ];
  
  return {
    updated_at: now(),
    current_project: currentProject,
    research_threads: activeThreads,
    blockers: blockers,
    candidate_threads: inferNextSteps(currentProject, activeThreads)
  };
}
```

### Suggestion Ranking
```typescript
function rankSuggestions(): Suggestion[] {
  const context = getCurrentContext();
  const allSuggestions = [
    ...generateNextStepSuggestions(context),
    ...generateRelatedResearchSuggestions(context),
    ...generateRiskSuggestions(context),
    ...generateConnectionSuggestions(context)
  ];
  
  for (const suggestion of allSuggestions) {
    // Urgency score
    const urgencyScore = calculateUrgency(suggestion);
    
    // Momentum score (how long in current context)
    const timeInContext = now() - context.current_project.started_at;
    const momentumScore = min(timeInContext / 60, 1.0); // 0-1, peaks at 1h
    
    // Relevance score
    const relevanceScore = calculateRelevance(suggestion, context);
    
    // Time penalty (if in deep flow, lower score)
    const timeAvailablePenalty = isInFlowState() ? 0 : 0.1;
    
    // Final rank
    suggestion.score =
      (0.4 * urgencyScore) +
      (0.3 * momentumScore) +
      (0.2 * relevanceScore) -
      (0.1 * timeAvailablePenalty);
  }
  
  return allSuggestions.sort((a, b) => b.score - a.score).slice(0, 5);
}
```

---

## VII. ROLLOUT PLAN (12 Weeks)

### Phase 1: Observation Layer (Weeks 1-2)
- Browser history scraper (Chrome CDP or local history parse)
- Search query interceptor
- GitHub API poller
- File watcher
- **Output:** 100K observation events/week, no UI yet

### Phase 2: Context Engine (Weeks 3-4)
- Inference rules → project detection, thread linking
- State model persistence
- Manual testing of context inference
- **Output:** Live context updates, query via API

### Phase 3: Suggestion Engine (Weeks 5-6)
- Implement ranking algorithm
- Generate 4 suggestion types
- Test with 1-week context history
- **Output:** Ranked suggestions via API, no UI

### Phase 4: Proactive Surfacing (Weeks 7-9)
- Toast notifications (Electron)
- Morning briefing generation & modal
- "What's Next?" sidebar
- Research synthesis view
- **Output:** UI fully wired, manually testable

### Phase 5: Task Curation (Weeks 10-11)
- Wire suggestion → task conversion
- Auto-approval heuristic
- Audit trail logging
- Edge case testing (risky operations)
- **Output:** Suggestions can auto-queue tasks

### Phase 6: Integration & Polish (Week 12)
- Port 5713 observer service into main Electron app (single process)
- Tune debounces, ranking weights
- User testing with you
- **Output:** v2 GA candidate

---

## VIII. RISK MITIGATION

| Risk | Mitigation |
|------|-----------|
| **Observer is resource hog** | Event debouncing, 30-day window retention, index on timestamp |
| **Auto-approval queues risky work** | Strict heuristic + audit trail + user can reverse |
| **Suggestions are spam** | Max 1 toast per 15min, dismiss for 24h, low-confidence threshold |
| **Context inference is wrong** | Confidence scores on all inferences, manual override, user can force project |
| **Privacy leak** | All local, never send code/secrets to cloud, audit chrome extensions |
| **v1 pipeline overload** | Cap auto-queued tasks to 5/min, queue limit monitoring |

---

## IX. POST-GA ROADMAP

### Phase 7+: Intelligence (ML, 2-3 months out)
- Embeddings for semantic thread linking
- Predictive blocker detection ("PR waiting >2h, needs @reviewer")
- Priority learning (rank suggestions by your historical "took this action" patterns)

### Phase 8+: Collaboration (6 months out)
- Team presence signals ("Your colleague is also working on ProjectX")
- Async hand-off ("Jack's context → Bob's inbox")
- Shared blockers ("Review PR #42 that affects both of us")

### Phase 9+: Analytics (6 months out)
- "What took longest this month? Why?"
- "Which types of suggestions do you act on most?"
- "How much time do suggestions save?"

---

## X. SUMMARY

**TaskPilot v2 = v1 + Ambient Intelligence Layer**

✅ Keeps existing task execution pipeline  
✅ Adds proactive observation & suggestion  
✅ Local-first, privacy-safe  
✅ Layered, independent components (can test/deploy separately)  
✅ Low friction (toasts, not interrupts; dismissible, not mandatory)  
✅ Safe (auto-approval heuristic + audit trail)  
✅ 12-week rollout, incremental value delivery

**Expected outcome:** Tasks flow automatically from observation → derivation → execution. You spend less time saying "what should I work on" and more time doing the work.
