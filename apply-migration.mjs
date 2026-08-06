import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(process.env.HOME || process.env.USERPROFILE, '.taskpilot', 'taskpilot.db');

console.log(`Opening database at: ${dbPath}`);
const db = new Database(dbPath);

// Read the migration file
const migrationFile = path.join(__dirname, 'drizzle', '0006_add_observer_v2_schema.sql');
const sql = fs.readFileSync(migrationFile, 'utf-8');

console.log('\n=== Applying Migration 0006 ===');
try {
  db.exec(sql);
  console.log('✓ Migration applied successfully');
} catch (e) {
  console.error('✗ Error applying migration:', e.message);
}

console.log('\n=== Verifying Tables ===');
const observerTables = [
  'observation_events',
  'context_state', 
  'research_threads',
  'suggestions',
  'auto_approvals',
  'briefing_histories'
];

observerTables.forEach(table => {
  try {
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get();
    console.log(`✓ ${table}: ${count.cnt} rows`);
  } catch (e) {
    console.log(`✗ ${table}: NOT FOUND - ${e.message}`);
  }
});

db.close();
