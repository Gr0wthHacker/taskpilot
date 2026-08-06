# TaskPilot v2 - Comprehensive Audit Report
**Date:** August 6, 2026  
**Status:** CRITICAL ISSUES FOUND

---

## Executive Summary

TaskPilot v2 Observer system is **60% operational**. The backend is mostly complete and collecting data, but there are critical routing bugs preventing the UI from displaying suggestions and briefings. The system is currently non-functional for end users despite the core logic working.

**Key Finding:** Suggestions ARE being generated and stored in the database, but the UI cannot retrieve them due to API routing mismatches.

---

## 1. DATABASE AUDIT ✓ HEALTHY

### v2 Observer Tables - All Created
| Table | Rows | Status |
|-------|------|--------|
| observation_events | 3,693 | ✓ Active - collecting code change events |
| context_state | 1 | ✓ Active - tracking current project context |
| research_threads | 0 | ✓ Created - no threads yet |
| suggestions | 2 | ✓ Active - generating suggestions |
| auto_approvals | 0 | ✓ Created - none queued yet |
| briefing_histories | 0 | ✓ Created - scheduler not run yet |

### Migration Status
- Migration 0006_add_observer_v2_schema.sql applied ✓
- All indices created ✓
- v1 tables intact (tasks, conversations, execution_logs, etc.) ✓

**Finding:** Database fully migrated and healthy. No schema issues.

---

## 2. BACKEND SYSTEMS - WORKING

### Context Engine ✓
- Status: Running (10-second updates active)
- Last Update: 2026-08-06T23:30:54.247Z (current)
- Data: Tracking current project as "unknown" with confidence 1.0
- Collectors Running: Code Changes, Notes & Docs

### Observation Events ✓
- Total Collected: 3,693 events
- Source: Code collector (all 3,693 from file watcher)
- Not Running: GitHub (no token), Browser (Chrome not running with CDP)
- Status: Core collectors working, fetching new changes

### Suggestion Engine ✓
- Total Generated: 2 suggestions
- Active: 2 (not dismissed or actioned)
- Status: Engine running and ranking suggestions
- Issue: Very low count suggests infrequent ranking runs or early in cycle

### Auto-Approval System
- Entries: 0
- Status: Waiting for high-confidence suggestions to queue
- Note: No critical operations attempted yet

### Briefing Generator
- Entries: 0  
- Status: Scheduler active (morning briefing scheduled for 8 AM)
- Note: Not yet triggered due to time or conditions

---

## 3. CRITICAL ISSUES - ROUTING MISMATCH

### ISSUE #1: API Routes Registered at Wrong Path
**Severity:** CRITICAL - Breaks all UI fetches

Problem:
- Routes defined in /src/main/observer/api.ts use /observer/* paths
- Called from server with: setupObserverRoutes(app) (line 343 of src/main/server/index.ts)
- Routes registered at: /observer/context, /observer/suggestions, etc.
- React hook expects: /api/observer/context, /api/observer/suggestions

Current State:
- Endpoint works at: GET http://localhost:7847/observer/status
- Endpoint NOT at: GET http://localhost:7847/api/observer/status

Root Cause:
setupObserverRoutes passes app directly instead of a sub-router mounted under /api/.

File: src/main/server/index.ts:343

Current code:
```
setupObserverRoutes(app);  // WRONG - routes go to root
```

Should be:
```
const observerRouter = express.Router();
setupObserverRoutes(observerRouter);
app.use('/api', observerRouter);
```

### ISSUE #2: React Hook Has Wrong API Base
**Severity:** CRITICAL - UI cannot fetch

Problem:
- Hook file: /src/renderer/hooks/useObserver.ts:11
- Configured for: const API_BASE = '/api/observer'
- Actual working endpoint: /observer
- Result: All fetch() calls in UI fail silently

File: src/renderer/hooks/useObserver.ts:11

Current:
```
const API_BASE = '/api/observer';  // This path does not exist
```

Impact: 
- SuggestionsSidebar component tries to fetch suggestions → 404 → shows nothing
- SuggestionToast component tries to fetch → 404 → never displays
- useObserverContext() hook fails → context data unavailable
- All UI interactivity broken

### ISSUE #3: API Token Retrieval
**Severity:** MEDIUM - Authentication not wired

Problem:
- Hook hardcodes: const API_TOKEN = localStorage.getItem('api_token') || ''
- localStorage is not populated in Electron renderer
- API token lives in filesystem: ~/.taskpilot/api-token
- Result: All API calls fail with 401 Unauthorized

File: src/renderer/hooks/useObserver.ts:10

---

## 4. UI COMPONENTS - IMPLEMENTED BUT NOT FUNCTIONAL

### Components Implemented
| Component | File | Status |
|-----------|------|--------|
| SuggestionToast | src/renderer/components/Observer/SuggestionToast.tsx | Coded |
| SuggestionsSidebar | src/renderer/components/Observer/SuggestionsSidebar.tsx | Coded |
| MorningBriefing | src/renderer/components/Observer/MorningBriefing.tsx | Coded |
| useObserverHook | src/renderer/hooks/useObserver.ts | Coded but broken |

### Integration Status
- All components imported in App.tsx ✓
- useObserverSuggestions() hook wired ✓
- useObserverBriefing() hook wired ✓
- Layout and styling complete ✓

### Runtime Status
- Sidebar renders but shows no suggestions (fetch fails 404)
- Toast never appears (fetch fails 404)
- Briefing modal code runs but no briefings generated yet
- User sees empty UI with no indication of observer system

---

## 5. COLLECTORS STATUS

### Code Collector ✓
- Status: Running
- Events: 3,693 collected
- Files Watched: Source directory with chokidar
- Health: Healthy

### Notes Collector ✓
- Status: Running
- Health: Healthy

### Browser Collector ✗
- Status: Offline
- Reason: Chrome DevTools Protocol (CDP) not available at localhost:9222
- Fix Required: Launch Chrome with --remote-debugging-port=9222

### GitHub Collector ✗
- Status: Skipped (no token)
- Reason: GitHub PAT not configured in app
- Fix Required: Add GitHub token to environment or settings

---

## 6. QUICK FIXES NEEDED

### Fix #1: Correct API Route Registration (CRITICAL)
File: src/main/server/index.ts:343

Replace:
```
setupObserverRoutes(app);
```

With:
```
const observerRouter = express.Router();
setupObserverRoutes(observerRouter);
app.use('/api', observerRouter);
```

### Fix #2: Update React Hook API Base (CRITICAL)
File: src/renderer/hooks/useObserver.ts:11

Change:
```
const API_BASE = '/api/observer';
```

To:
```
const API_BASE = '/observer';  // Temporary until server routing is fixed
```

### Fix #3: Wire API Token (MEDIUM)
File: src/renderer/hooks/useObserver.ts:10

Need to pass API token from main process to renderer. Currently trying to get from localStorage which is empty.

---

## 7. TEST RESULTS

### API Endpoint Tests
- GET /observer/status → 200 OK (working)
- GET /observer/context → 200 OK (returns context data)
- GET /observer/suggestions → 200 OK (returns 0-2 suggestions)
- GET /observer/events → 200 OK (returns 3,693+ events)

- GET /api/observer/status → 404 (BROKEN - expected path)
- GET /api/observer/context → 404 (BROKEN - expected path)
- GET /api/observer/suggestions → 404 (BROKEN - expected path)

### Database Tests
- observation_events table: 3,693 rows ✓
- context_state table: 1 row (active) ✓
- suggestions table: 2 rows (both active) ✓
- All indices created ✓

### UI Tests
- Sidebar renders but empty (cannot fetch suggestions)
- Toast never appears (cannot fetch suggestions)
- Briefing modal code works but no data

---

## SUMMARY

Backend: 90% complete, data flowing correctly
Database: 100% migrated, healthy  
UI: 80% built but 0% functional (routing/auth issues)

**To Ship:** Fix routing issues (30 min) → test end-to-end (1 hour) → deploy

**Blocker:** API route registration needs immediate fix before UI can communicate with backend.
