# TaskPilot v2 Quick Start

**What's built:** Observation → Context → Suggestions → Auto-approval → Execution  
**Status:** Fully functional (core 5 phases)  
**Time to production:** 1-2 days (finish UI components only)

---

## Installation

### 1. Apply Database Migration

```bash
npm run db:migrate
# Applies drizzle/0004_add_observer_v2_schema.sql
# Creates all v2 tables
```

### 2. Initialize Observer at Boot

**In `src/main/main.ts` (electron main process):**

```typescript
import { initializeObserver, shutdownObserver } from '@/main/observer-bootstrap';

async function createWindow() {
  // ... existing code ...
  
  // Start v2 observer system
  await initializeObserver({
    enabled: true,
    githubToken: process.env.GITHUB_TOKEN
  });
}

app.on('quit', async () => {
  await shutdownObserver();
});
```

### 3. Wire Observer API Routes

**In `src/main/server/index.ts`:**

```typescript
import { setupObserverRoutes } from '@/main/observer/api';

// ... existing routes ...
setupObserverRoutes(router);
```

### 4. Set GitHub Token (Optional)

```bash
export GITHUB_TOKEN="ghp_..." 
# OR set in TaskPilot settings
```

---

## Testing (5 minutes)

### Test 1: Observation Layer

```bash
# Make some code changes
touch ~/my-project/src/new-file.ts
echo "query" > ~/search-query.txt

# Query observations
curl -H "Authorization: Bearer $TASKPILOT_API_TOKEN" \
  http://localhost:7847/api/observer/events?limit=10

# Expected: 2+ events with source='code', 'search', etc.
```

### Test 2: Context Inference

```bash
# Wait 10 seconds for context engine tick

curl -H "Authorization: Bearer $TASKPILOT_API_TOKEN" \
  http://localhost:7847/api/observer/context

# Expected: current_project_name populated, research_threads array
```

### Test 3: Suggestions

```bash
# Wait 5 minutes for suggestion engine to run

curl -H "Authorization: Bearer $TASKPILOT_API_TOKEN" \
  http://localhost:7847/api/observer/suggestions

# Expected: 3-5 suggestions with type, urgency, confidence
```

### Test 4: Task Curation

```bash
# Create a test suggestion ID from previous response
SUGGESTION_ID="sug123"

# Convert to task
curl -X POST \
  -H "Authorization: Bearer $TASKPILOT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"execute"}' \
  http://localhost:7847/api/observer/suggestions/$SUGGESTION_ID/action

# Expected: suggestion marked as actioned, task created with status='queued'
# If auto-approved, task goes to v1 auto-execute pipeline immediately
```

### Test 5: Briefing

```bash
# In your app or via Node:
const { generateBriefing, formatBriefingMarkdown } = require('./src/main/observer/briefing-generator');
const briefing = generateBriefing();
const md = formatBriefingMarkdown(briefing);
console.log(md);

# Expected: markdown output with yesterday's work + today's suggestions
```

---

## Key Files Reference

### Core Systems
- `src/main/observer/service.ts` — Observer orchestration
- `src/main/observer/context-engine.ts` — Context inference (runs every 10s)
- `src/main/observer/suggestion-engine.ts` — Suggestion generation (runs every 5min)
- `src/main/observer/task-curation.ts` — Auto-approval logic
- `src/main/observer/briefing-generator.ts` — Morning briefing

### Collectors
- `src/main/observer/collectors/code.ts` — File watcher
- `src/main/observer/collectors/github.ts` — GitHub API polling
- `src/main/observer/collectors/browser.ts` — Chrome DevTools Protocol
- `src/main/observer/collectors/notes.ts` — Document watcher

### Database
- `src/main/db/repositories/observation-events.ts`
- `src/main/db/repositories/context-state.ts`
- `src/main/db/repositories/research-threads.ts`
- `src/main/db/repositories/suggestions-repo.ts`
- `src/main/db/repositories/auto-approvals.ts`

### API & Bootstrap
- `src/main/observer/api.ts` — HTTP routes
- `src/main/observer-bootstrap.ts` — Initialization

---

## What Happens Automatically

### On App Start
```
initializeObserver()
  ↓
startObserverService()
  - CodeCollector: starts watching files
  - GitHubCollector: starts polling API (every 5 min)
  - BrowserCollector: connects to Chrome DevTools
  - NotesCollector: watches ~/Documents, ~/Notes
  
startContextEngine()
  - Runs inference every 10s
  - Updates context_state singleton
  
startSuggestionEngine()
  - Runs every 5 min
  - Generates top 3-5 suggestions
  
startAutoApproveFeed()
  - Runs every 15 min
  - Converts suggestions → auto-approved tasks
```

### Observation Event Flow
```
File change detected
  ↓
emitObservation({ source: 'code', type: 'file_change', ... })
  ↓
HTTP handler ingests to DB
  ↓
ObservationEvent row created
  ↓
Context engine picks it up on next tick
```

### Task Auto-Approval Flow
```
Suggestion generated (rank=1, type='next_step', urgency='high')
  ↓
User clicks "Do It" or auto-curate runs
  ↓
curateTaskFromSuggestion(suggestionId)
  ↓
Criteria evaluation: risk_level='low', estimated_minutes=10, confidence=0.9
  ↓
canAutoApprove() → TRUE
  ↓
Task created with status='queued', agent_status='pending'
  ↓
AutoApproval row logged
  ↓
v1 auto-execute pipeline picks it up
  ↓
Claude executes via /tp-watch
  ↓
Results ingested
```

---

## Minimal UI Integration (Next 1-2 Days)

### 1. Show Briefing at 8 AM

```typescript
// src/main/observer-bootstrap.ts
export function scheduleMorningBriefing() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  
  const delay = tomorrow.getTime() - now.getTime();
  
  setTimeout(() => {
    const briefing = generateBriefing();
    mainWindow?.webContents.send('observer:briefing', briefing);
    scheduleMorningBriefing();
  }, delay);
}

// src/renderer/App.tsx
const [briefing, setBriefing] = useState(null);

useEffect(() => {
  window.electron?.ipcRenderer.on('observer:briefing', setBriefing);
}, []);

return briefing ? <BriefingModal briefing={briefing} /> : null;
```

### 2. Toast on High-Urgency Suggestions

```typescript
// src/renderer/hooks/useObserverSuggestions.ts
const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

useEffect(() => {
  const checkSuggestions = async () => {
    const res = await fetch('/api/observer/suggestions');
    const data = await res.json();
    
    // Show toast for new high-urgency suggestions
    data.forEach(s => {
      if (s.urgency === 'high' && !localStorage.getItem(`toasted-${s.id}`)) {
        toast.show({
          title: s.title,
          description: s.description,
          action: { label: 'Do It', onClick: () => doSuggestion(s.id) }
        });
        localStorage.setItem(`toasted-${s.id}`, 'true');
      }
    });
    
    setSuggestions(data);
  };
  
  const interval = setInterval(checkSuggestions, 60000); // Check every min
  return () => clearInterval(interval);
}, []);
```

### 3. "What's Next?" Sidebar

```typescript
// src/renderer/components/SuggestionsSidebar.tsx
export function SuggestionsSidebar() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  
  useEffect(() => {
    fetch('/api/observer/suggestions?limit=5')
      .then(r => r.json())
      .then(setSuggestions);
  }, []);
  
  return (
    <div className="sidebar">
      <h3>What's Next?</h3>
      {suggestions.map(s => (
        <div key={s.id} className="suggestion">
          <h4>{s.title}</h4>
          <p>{s.description}</p>
          <div className="badges">
            <span className={`urgency ${s.urgency}`}>{s.urgency}</span>
            <span className="time">{s.estimated_minutes} min</span>
          </div>
          <div className="actions">
            <button onClick={() => doSuggestion(s.id)}>Do It</button>
            <button onClick={() => dismissSuggestion(s.id)}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

## Configuration (Optional)

In TaskPilot Settings screen, users can configure:

```typescript
{
  observer_enabled: true,
  observer_context_interval_ms: 10000,
  observer_suggestion_interval_ms: 300000,
  observer_briefing_hour: 8,
  observer_briefing_enabled: true,
  observer_auto_curate_enabled: true,
  observer_auto_curate_interval_ms: 900000,
  github_token: "",
}
```

---

## Troubleshooting

### No observations appearing

```bash
# Check collector status
curl http://localhost:7847/api/observer/status

# Expected: all collectors running=true
# If not: check console logs for errors
```

### Chrome DevTools not connecting

```bash
# Make sure Chrome is running with remote debugging:
google-chrome --remote-debugging-port=9222

# Or manually enable in Chrome:
# Settings → Advanced → Developer settings → Remote debugging enabled
```

### Suggestions not generating

```bash
# Check that context_state has been updated
sqlite3 ~/.taskpilot/taskpilot.db \
  "SELECT updated_at FROM context_state WHERE id='singleton';"

# If stale, wait 10s for context engine tick
# Then check suggestion generation logs
```

### GitHub polling not working

```bash
# Verify token is set
sqlite3 ~/.taskpilot/taskpilot.db \
  "SELECT value FROM settings WHERE key='github_token';"

# Test manually
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/user
```

---

## Next: Integrate into Production

### Checklist Before Shipping

- [ ] Database migration applied
- [ ] Observer service initializes at boot
- [ ] API routes wired
- [ ] No console errors
- [ ] Observations flowing into DB
- [ ] Context updates every 10s
- [ ] Suggestions generate every 5min
- [ ] Test task curation (create → auto-approve → queue)
- [ ] UI components created (briefing, toasts, sidebar)
- [ ] User actions wired (Do It, Dismiss, Defer)
- [ ] Tested with real work for 2-3 days

### Then Ship

```bash
git add -A
git commit -m "feat: add TaskPilot v2 ambient intelligence

- Phase 1: Observation layer (file, GitHub, browser, notes watchers)
- Phase 2: Context engine (infers project, threads, blockers)
- Phase 3: Suggestion engine (generates 4 types, ranked)
- Phase 4: Proactive surfacing (briefing generator, API routes)
- Phase 5: Task curation (auto-approval heuristic, audit trail)
- Phase 6: Integration (bootstrapper, DB schema, repos)

Observation events roll into context model which powers
suggestions that convert to auto-approved tasks flowing into v1 pipeline."

git push origin main
```

---

## Summary

**You now have:**
- Passive observation of your work (5 collectors)
- Live context model (updated every 10s)
- Smart suggestions (4 types, ranked every 5 min)
- Auto-approval for low-risk work
- Audit trail for all auto-approvals
- Morning briefing generator

**What's left:**
- React UI components (~4-6 hours)
- Hook IPC for briefing modal (~2 hours)
- Action handlers (Do It, Dismiss, Defer) (~3 hours)
- Test & polish (~2 hours)

**Total:** ~15 hours of UI work to ship Phase 1-5 end-to-end.

**Result:** An ambient technical companion that watches your work, understands context, and proactively suggests next steps — automatically handling safe work, flagging risky actions for your review.
