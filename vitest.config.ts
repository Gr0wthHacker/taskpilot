import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/helpers/setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    // Integration tests boot a real HTTP server + spawn subprocesses, so
    // allow a generous per-test timeout. Unit tests still run in tens of ms.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@/shared': path.resolve(__dirname, 'src/shared'),
      '@/main': path.resolve(__dirname, 'src/main'),
      '@/renderer': path.resolve(__dirname, 'src/renderer'),
      '@/cli': path.resolve(__dirname, 'src/cli'),
    },
  },
});
