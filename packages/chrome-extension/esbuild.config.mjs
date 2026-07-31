// esbuild config for the TaskPilot Chrome extension.
// Each entry point is bundled separately as an IIFE targeting Chrome 120.
// Manifest + HTML files are copied into dist/ verbatim.

import { build, context } from "esbuild";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const srcDir = resolve(root, "src");
const outDir = resolve(root, "dist");

const watch = process.argv.includes("--watch");

const entryPoints = {
  "background/service-worker": "src/background/service-worker.ts",
  "content/page-meta": "src/content/page-meta.ts",
  "options/options": "src/options/options.ts",
  "popup/popup": "src/popup/popup.ts",
};

const sharedBuildOptions = {
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  platform: "browser",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
  },
};

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function copyStaticAssets() {
  await ensureDir(outDir);
  // Copy manifest.json
  await copyFile(join(srcDir, "manifest.json"), join(outDir, "manifest.json"));
  // Copy HTML files
  await ensureDir(join(outDir, "options"));
  await copyFile(join(srcDir, "options", "options.html"), join(outDir, "options", "options.html"));
  await ensureDir(join(outDir, "popup"));
  await copyFile(join(srcDir, "popup", "popup.html"), join(outDir, "popup", "popup.html"));
  // Copy icons if present
  const iconsSrc = join(srcDir, "icons");
  try {
    const entries = await readdir(iconsSrc);
    const iconsOut = join(outDir, "icons");
    await ensureDir(iconsOut);
    for (const entry of entries) {
      const s = await stat(join(iconsSrc, entry));
      if (s.isFile()) {
        await copyFile(join(iconsSrc, entry), join(iconsOut, entry));
      }
    }
  } catch {
    // icons directory is optional
  }
}

async function buildAll() {
  await rm(outDir, { recursive: true, force: true });
  await ensureDir(outDir);
  for (const [name, entry] of Object.entries(entryPoints)) {
    const outfile = join(outDir, `${name}.js`);
    await ensureDir(dirname(outfile));
    if (watch) {
      const ctx = await context({
        ...sharedBuildOptions,
        entryPoints: [resolve(root, entry)],
        outfile,
      });
      await ctx.watch();
      console.log(`watching ${entry} -> ${outfile}`);
    } else {
      await build({
        ...sharedBuildOptions,
        entryPoints: [resolve(root, entry)],
        outfile,
      });
    }
  }
  await copyStaticAssets();
  if (!watch) {
    console.log(`\nBuilt extension to ${outDir}`);
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
