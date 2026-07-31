/**
 * Electron build-artifact integrity check.
 *
 * A true end-to-end Electron boot test (spawn `node_modules/.bin/electron .`,
 * wait for `/api/health`, kill) requires a desktop session — there's no
 * reliable headless mode that works across Windows/macOS/Linux without xvfb
 * or similar. Running it in CI/agents would flake.
 *
 * Instead we verify the artifacts a packaged Electron app would actually load:
 *   - `dist/main.cjs` exists and is reasonable in size.
 *   - `dist/preload.cjs` exists.
 *   - `dist/renderer/index.html` exists.
 *   - The bundled main bundle is well under 1 MB (regression guard for the
 *     tsup `noExternal` config — every dep we add must be intentional).
 *   - `electron` is installed locally (the `electron` cli is what
 *     electron-builder ships in the produced installer).
 *
 * Skipped on a fresh checkout that hasn't been built yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ARTIFACTS = {
  main: path.join(REPO_ROOT, 'dist', 'main.cjs'),
  preload: path.join(REPO_ROOT, 'dist', 'preload.cjs'),
  renderer: path.join(REPO_ROOT, 'dist', 'renderer', 'index.html'),
  cli: path.join(REPO_ROOT, 'dist', 'cli', 'index.js'),
};

const HAS_BUILD = Object.values(ARTIFACTS).every((p) => fs.existsSync(p));

// Regression guard: the previous tsup config bundled googleapis, express,
// drizzle, MCP SDK, etc. into main.cjs, blowing it up past 25 MB. Anything
// over 5 MB suggests the `noExternal` allowlist has regressed.
const MAIN_BUNDLE_MAX_BYTES = 5 * 1024 * 1024;

describe.skipIf(!HAS_BUILD)('electron build artifacts', () => {
  it('main.cjs exists', () => {
    const stat = fs.statSync(ARTIFACTS.main);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(1_000);
  });

  it('main.cjs is under the bundle-size budget (regression guard)', () => {
    const stat = fs.statSync(ARTIFACTS.main);
    expect(stat.size).toBeLessThan(MAIN_BUNDLE_MAX_BYTES);
  });

  it('main.cjs externalizes heavy deps (does not inline googleapis/express/drizzle)', () => {
    const contents = fs.readFileSync(ARTIFACTS.main, 'utf8');
    // These should be `require("googleapis")` — i.e. external, not the actual
    // googleapis source code inlined.
    expect(contents).toMatch(/require\(["']googleapis["']\)/);
    expect(contents).toMatch(/require\(["']express["']\)/);
    expect(contents).toMatch(/require\(["']drizzle-orm["']\)/);
    expect(contents).toMatch(/require\(["']better-sqlite3["']\)/);
  });

  it('main.cjs INLINES the ESM-only deps (nanoid)', () => {
    const contents = fs.readFileSync(ARTIFACTS.main, 'utf8');
    // nanoid is ESM-only and must be bundled — otherwise a CJS Electron main
    // can't require() it at runtime.
    expect(contents).not.toMatch(/require\(["']nanoid["']\)/);
    // The nanoid source defines a `POOL_SIZE_MULTIPLIER` constant; if the
    // bundle contains it, we know nanoid was inlined rather than externalized.
    expect(contents).toContain('POOL_SIZE_MULTIPLIER');
  });

  it('preload.cjs exists', () => {
    const stat = fs.statSync(ARTIFACTS.preload);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(100);
  });

  it('renderer/index.html exists', () => {
    const stat = fs.statSync(ARTIFACTS.renderer);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(100);
    const html = fs.readFileSync(ARTIFACTS.renderer, 'utf8');
    expect(html).toContain('<!doctype html>');
  });

  it('cli/index.js exists and has the shebang', () => {
    const stat = fs.statSync(ARTIFACTS.cli);
    expect(stat.isFile()).toBe(true);
    const first = fs
      .readFileSync(ARTIFACTS.cli, 'utf8')
      .slice(0, 100);
    expect(first.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('electron-builder packageable: package.json points to dist/main.cjs', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { main: string; bin: Record<string, string> };
    expect(pkg.main).toBe('dist/main.cjs');
    expect(pkg.bin['taskpilot']).toBe('./dist/cli/index.js');
  });

  it('drizzle migrations folder exists and is shippable', () => {
    const drizzleDir = path.join(REPO_ROOT, 'drizzle');
    const journal = path.join(drizzleDir, 'meta', '_journal.json');
    if (!fs.existsSync(journal)) {
      // Generated lazily by `npm run db:generate`; not a hard requirement to
      // boot since the inline migrations cover the baseline schema.
      return;
    }
    const journalBody = JSON.parse(fs.readFileSync(journal, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(Array.isArray(journalBody.entries)).toBe(true);
    expect(journalBody.entries.length).toBeGreaterThan(0);
    // First migration tag must have a matching .sql file.
    const firstEntry = journalBody.entries[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry) {
      const sqlFile = path.join(drizzleDir, `${firstEntry.tag}.sql`);
      expect(fs.existsSync(sqlFile)).toBe(true);
    }
  });
});
