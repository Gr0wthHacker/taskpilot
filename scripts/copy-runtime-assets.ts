/**
 * Postbuild: copy non-TS runtime assets the main bundle expects to find next
 * to itself in dist/. tsup only emits the JS bundle; anything resolved via
 * __dirname/<relative-path> at runtime (PowerShell scripts, vendored binaries,
 * etc.) has to be copied separately.
 *
 * Currently: the monitor's get-active-window.ps1 script. Adding new assets?
 * append to ASSETS and the build will pick them up.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

interface Asset {
  from: string;
  to: string;
}

const ROOT = path.resolve(import.meta.dirname, '..');

const ASSETS: Asset[] = [
  {
    from: 'src/main/monitor/scripts/get-active-window.ps1',
    to: 'dist/scripts/get-active-window.ps1',
  },
];

async function copyAsset(asset: Asset): Promise<void> {
  const src = path.join(ROOT, asset.from);
  const dst = path.join(ROOT, asset.to);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  // eslint-disable-next-line no-console
  console.log(`copied ${asset.from} -> ${asset.to}`);
}

async function main(): Promise<void> {
  for (const asset of ASSETS) {
    await copyAsset(asset);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('copy-runtime-assets failed:', err);
  process.exit(1);
});
