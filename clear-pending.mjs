import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(os.homedir(), '.taskpilot', 'taskpilot.db');

const db = new Database(DB_PATH);

console.log('📊 Database Status:\n');

// Check observation_events
const obsCount = db.prepare('SELECT COUNT(*) as count FROM observation_events').get();
console.log(`Observation events: ${obsCount.count}`);

// Check context_state
const contextCount = db.prepare('SELECT COUNT(*) as count FROM context_state').get();
console.log(`Context state: ${contextCount.count}`);

// Check suggestions
const sugCount = db.prepare('SELECT COUNT(*) as count FROM suggestions').get();
console.log(`Suggestions: ${sugCount.count}`);

// Check deliberations
const delibCount = db.prepare('SELECT COUNT(*) as count FROM deliberations WHERE status = ?').get('pending');
console.log(`Pending deliberations: ${delibCount.count}`);

console.log('\n🧹 Clearing stale data...\n');

// Clear old observation events (keep last 100)
const oldObs = db.prepare(`
  SELECT COUNT(*) as count FROM observation_events
  WHERE id NOT IN (SELECT id FROM observation_events ORDER BY created_at DESC LIMIT 100)
`).get();

if (oldObs.count > 0) {
  db.prepare(`
    DELETE FROM observation_events
    WHERE id NOT IN (SELECT id FROM observation_events ORDER BY created_at DESC LIMIT 100)
  `).run();
  console.log(`✓ Deleted ${oldObs.count} old observation events`);
}

// Clear pending deliberations stuck for > 1 hour
const stuckDelib = db.prepare(`
  SELECT COUNT(*) as count FROM deliberations
  WHERE status = 'pending' AND datetime(requested_at) < datetime('now', '-1 hour')
`).get();

if (stuckDelib.count > 0) {
  db.prepare(`
    DELETE FROM deliberations
    WHERE status = 'pending' AND datetime(requested_at) < datetime('now', '-1 hour')
  `).run();
  console.log(`✓ Deleted ${stuckDelib.count} stuck pending deliberations`);
}

// Clear dismissed/actioned suggestions older than 7 days
const oldSugg = db.prepare(`
  SELECT COUNT(*) as count FROM suggestions
  WHERE (dismissed_at IS NOT NULL OR actioned_at IS NOT NULL)
  AND datetime(created_at) < datetime('now', '-7 days')
`).get();

if (oldSugg.count > 0) {
  db.prepare(`
    DELETE FROM suggestions
    WHERE (dismissed_at IS NOT NULL OR actioned_at IS NOT NULL)
    AND datetime(created_at) < datetime('now', '-7 days')
  `).run();
  console.log(`✓ Deleted ${oldSugg.count} old dismissed/actioned suggestions`);
}

// Reset context state to fresh
db.prepare('DELETE FROM context_state').run();
db.prepare(`
  INSERT INTO context_state (id, current_project_confidence, updated_at)
  VALUES (?, ?, datetime('now'))
`).run('singleton', 0);
console.log(`✓ Reset context state to fresh`);

console.log('\n✅ Database cleaned. New status:\n');

const obsCountNew = db.prepare('SELECT COUNT(*) as count FROM observation_events').get();
console.log(`Observation events: ${obsCountNew.count}`);

const sugCountNew = db.prepare('SELECT COUNT(*) as count FROM suggestions').get();
console.log(`Suggestions: ${sugCountNew.count}`);

const delibCountNew = db.prepare('SELECT COUNT(*) as count FROM deliberations WHERE status = ?').get('pending');
console.log(`Pending deliberations: ${delibCountNew.count}`);

db.close();
console.log('\n🎉 Done!');
