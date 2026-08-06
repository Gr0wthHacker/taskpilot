import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const dbPath = path.join(process.env.HOME || process.env.USERPROFILE, '.taskpilot', 'taskpilot.db');
const db = new Database(dbPath);

console.log('\n=== TASKPILOT V2 AUDIT ===\n');

// Observer tables
const tables = ['observation_events', 'context_state', 'research_threads', 'suggestions', 'auto_approvals', 'briefing_histories'];
console.log('Observer v2 Tables:');
tables.forEach(t => {
  try {
    const count = db.prepare(`SELECT COUNT(*) FROM "${t}"`).pluck().get();
    console.log(`  ${t}: ${count} rows`);
  } catch {
    console.log(`  ${t}: MISSING`);
  }
});

// Context engine
console.log('\nContext Engine:');
const ctx = db.prepare('SELECT * FROM context_state LIMIT 1').all();
if (ctx.length > 0) {
  console.log(`  Status: Active`);
  console.log(`  Project: ${ctx[0].current_project_name}`);
  console.log(`  Updated: ${ctx[0].updated_at}`);
} else {
  console.log('  Status: Not initialized');
}

// Observations
console.log('\nObservation Events:');
const events = db.prepare('SELECT source, COUNT(*) as cnt FROM observation_events GROUP BY source').all();
if (events.length === 0) {
  console.log('  None collected');
} else {
  events.forEach(e => console.log(`  ${e.source}: ${e.cnt}`));
}

// Suggestions
console.log('\nSuggestions:');
const total = db.prepare('SELECT COUNT(*) FROM suggestions').pluck().get();
const active = db.prepare('SELECT COUNT(*) FROM suggestions WHERE dismissed_at IS NULL AND actioned_at IS NULL').pluck().get();
console.log(`  Total: ${total}`);
console.log(`  Active: ${active}`);

db.close();
