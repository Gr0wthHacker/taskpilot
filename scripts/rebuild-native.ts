/**
 * Build better-sqlite3 for both Node and Electron ABIs and keep both
 * binaries side-by-side under `node_modules/better-sqlite3/build/Release/`.
 *
 *   better_sqlite3.node           → Node prebuild (whatever your local Node ABI is)
 *   better_sqlite3-electron.node  → Electron build (used by the app at runtime)
 *
 * Runs as a `postinstall` hook so a clean clone + `npm install` produces a
 * working dev environment without manual steps. Idempotent: safe to re-run.
 *
 * Skips silently if `better-sqlite3` isn't installed yet (the first half of
 * `npm install` may invoke this before all packages are unpacked — npm
 * orders postinstall after package install, but be defensive).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(
  ROOT,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
);
const NODE_BINARY = path.join(RELEASE_DIR, 'better_sqlite3.node');
const ELECTRON_BINARY = path.join(RELEASE_DIR, 'better_sqlite3-electron.node');

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[rebuild-native] ${msg}`);
}

function run(cmd: string, args: string[], cwd = ROOT): boolean {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3'))) {
    log('better-sqlite3 not installed yet, skipping');
    return;
  }

  // 1. Ensure the Node-ABI prebuild is in place. If the current binary was
  //    built for Electron, refetch the Node prebuild.
  const nodeAbiValid = (() => {
    try {
      const proc = spawnSync(
        process.execPath,
        ['-e', 'require("better-sqlite3"); console.log("ok");'],
        { cwd: ROOT, stdio: 'pipe' },
      );
      return proc.status === 0;
    } catch {
      return false;
    }
  })();

  if (!nodeAbiValid) {
    log('Node-ABI binary missing or mismatched; fetching prebuild');
    const fetched = run(
      'npx',
      ['--yes', 'prebuild-install', '--runtime=node', `--target=${process.versions.node}`],
      path.join(ROOT, 'node_modules', 'better-sqlite3'),
    );
    if (!fetched) {
      log('prebuild-install failed — leaving as-is. Run `npm run rebuild:native` manually.');
    }
  } else {
    log(`Node-ABI binary OK (${fileSize(NODE_BINARY)} bytes)`);
  }

  // 2. Build the Electron-ABI binary aside.
  if (fs.existsSync(ELECTRON_BINARY)) {
    log(`Electron-ABI binary already present (${fileSize(ELECTRON_BINARY)} bytes); skipping rebuild`);
    return;
  }

  log('Building better-sqlite3 for Electron ABI...');
  // Backup the Node binary
  const backup = NODE_BINARY + '.node-backup';
  if (fs.existsSync(NODE_BINARY)) {
    fs.copyFileSync(NODE_BINARY, backup);
  }

  const rebuilt = run('npx', [
    '--yes',
    '@electron/rebuild',
    '-f',
    '-w',
    'better-sqlite3',
  ]);

  if (rebuilt && fs.existsSync(NODE_BINARY)) {
    // The rebuilt .node IS the Electron one. Move it aside.
    fs.copyFileSync(NODE_BINARY, ELECTRON_BINARY);
    log(`Electron-ABI binary saved (${fileSize(ELECTRON_BINARY)} bytes)`);
  } else {
    log('@electron/rebuild failed — Electron app may fail to load sqlite');
  }

  // Restore the Node binary so npm test/smoke still work.
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, NODE_BINARY);
    fs.unlinkSync(backup);
    log(`Node-ABI binary restored (${fileSize(NODE_BINARY)} bytes)`);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[rebuild-native] failed:', err);
  process.exit(1);
});
