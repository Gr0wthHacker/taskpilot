import { defineConfig, type Options } from 'tsup';

// tsup is invoked twice from package.json scripts:
//   1. `tsup` (default entry → src/main/main.ts + preload.ts)  → CJS Electron main
//   2. `tsup src/cli/index.ts --out-dir dist/cli`              → ESM CLI
//
// We branch on the CLI-passed entry. For the main build we ADD preload.ts as a
// second entry so dist/ ends up with both main.cjs and preload.cjs.
//
// Bundle-size note: tsup externalizes anything in `dependencies` by default,
// which keeps main.cjs small (<1MB) and lets Electron load modules from
// node_modules at runtime. We only force-bundle (`noExternal`) ESM-only
// packages that a CJS Electron main otherwise can't `require()` —
// specifically nanoid v5 and @modelcontextprotocol/sdk. Everything else
// (express, drizzle-orm, googleapis, date-fns, zod, etc.) ships dual CJS/ESM
// and is loaded normally from node_modules.
export default defineConfig((options): Options => {
  const entry = options.entry as string[] | Record<string, string> | undefined;
  const entryStr = Array.isArray(entry) ? entry.join(',') : JSON.stringify(entry ?? '');

  const isCli = entryStr.includes('cli');

  if (isCli) {
    return {
      // Keep CLI-passed entry intact; tsup CLI args drive this build.
      format: ['esm'],
      target: 'node20',
      platform: 'node',
      clean: false,
      sourcemap: true,
      splitting: false,
      shims: true,
      dts: false,
      external: ['better-sqlite3'],
    };
  }

  // Electron main build.
  return {
    entry: {
      main: 'src/main/main.ts',
      preload: 'src/main/preload.ts',
    },
    outDir: 'dist',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    clean: false,
    sourcemap: true,
    splitting: false,
    shims: true,
    dts: false,
    external: ['electron', 'better-sqlite3'],
    // Only ESM-only deps need to be bundled into the CJS main bundle.
    // - nanoid v5: ESM-only (`"type": "module"`, no CJS export)
    // - @modelcontextprotocol/sdk: ESM-only
    // Everything else has CJS entry points and loads fine via require().
    //
    // Use regex form for noExternal so it matches the resolved module name
    // including any subpaths (e.g. `nanoid/non-secure`).
    noExternal: [
      /^nanoid(\/.*)?$/,
      /^@modelcontextprotocol\/sdk(\/.*)?$/,
      // @octokit/* are ESM-only as of v21 — bundle the whole ecosystem.
      /^@octokit\//,
      /^before-after-hook$/,
      /^universal-user-agent$/,
    ],
  };
});
