import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(process.env.HOME || process.env.USERPROFILE, '.taskpilot', 'taskpilot.db');

console.log(`Opening database at: ${dbPath}`);

const db = new Database(dbPath);

console.log('\n=== Database Tables ===');
const tables = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='table' 
  ORDER BY name
`).all();

tables.forEach(t => {
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get();
  console.log(`${t.name}: ${count.cnt} rows`);
});

console.log('\n=== Observer v2 Tables ===');
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
    console.log(`✗ ${table}: TABLE NOT FOUND`);
  }
});

db.close();
