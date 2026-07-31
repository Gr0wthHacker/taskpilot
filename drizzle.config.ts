import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

const dbPath = path.join(os.homedir(), '.taskpilot', 'taskpilot.db');

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/shared/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: dbPath,
  },
  strict: true,
  verbose: true,
});
