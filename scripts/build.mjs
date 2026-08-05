/**
 * The build.
 *
 *   dist/main/index.cjs      esbuild — Electron main
 *   dist/preload/index.cjs   esbuild — the contextBridge surface
 *   dist/renderer/           vite    — one HTML entry per window
 *   dist/native/             clang   — the cursor and click sampler (macOS-only,
 *                                      like the rest of this app)
 *
 * Main and preload are bundled to **CommonJS**. A sandboxed preload is
 * CommonJS-only in Electron, and matching main to it keeps one module format in
 * the process that owns the user's files.
 *
 * `electron` is the only external. Everything else — `@loom/format`, `@loom/ipc`
 * — is bundled in, so the packaged app has no runtime `node_modules` to resolve
 * and no chance of a workspace symlink escaping into a release.
 *
 * `--watch` rebuilds on change and is what `scripts/dev.mjs` runs.
 */

import { context as esbuildContext, build as esbuildBuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildNativeSampler } from '../packages/sampler/native/build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

/** @type {import('esbuild').BuildOptions[]} */
const nodeBundles = [
  {
    ...common,
    entryPoints: [resolve(root, 'apps/main/src/index.ts')],
    outfile: resolve(dist, 'main/index.cjs'),
  },
  {
    ...common,
    entryPoints: [resolve(root, 'apps/main/src/preload.ts')],
    outfile: resolve(dist, 'preload/index.cjs'),
  },
];

async function main() {
  if (!watch) await rm(dist, { recursive: true, force: true });

  await Promise.all([
    // `dist/native/loom-input-sampler` — the phase-5 cursor and click sampler. One
    // `clang` call; see `packages/sampler/native/build.mjs`. In watch mode it is
    // built once, because a `.m` file changing is not something `--watch` observes.
    buildNativeSampler(),
    ...nodeBundles.map(async (options) => {
      if (!watch) return esbuildBuild(options);
      const ctx = await esbuildContext(options);
      return ctx.watch();
    }),
    viteBuild({
      configFile: resolve(root, 'apps/renderer/vite.config.ts'),
      logLevel: 'warn',
      build: watch ? { watch: {} } : {},
    }),
  ]);

  if (!watch) console.log(`built -> ${dist}`);
}

await main();
