/**
 * Convert `build/icon.svg` → `build/icon.png` (1024×1024) for electron-builder.
 *
 * electron-builder picks up `build/icon.png` automatically for win/mac/linux
 * targets and derives smaller icon sizes (.ico / .icns) from it at packaging
 * time. We commit the SVG as the source of truth and run this script once.
 *
 * Idempotent — safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'build', 'icon.svg');
const PNG_PATH = path.join(ROOT, 'build', 'icon.png');

async function main(): Promise<void> {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`Source SVG not found at ${SVG_PATH}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[generate-icon] rendering ${SVG_PATH} → ${PNG_PATH}`);

  const buffer = await sharp(SVG_PATH).resize(1024, 1024).png().toBuffer();
  fs.writeFileSync(PNG_PATH, buffer);

  const { size } = fs.statSync(PNG_PATH);
  // eslint-disable-next-line no-console
  console.log(`[generate-icon] wrote ${PNG_PATH} (${size} bytes)`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[generate-icon] failed:', err);
  process.exit(1);
});
