/**
 * Renderer build.
 *
 * Windows are served from `loom://app` in development and in a packaged app
 * alike, so `base: './'` — relative asset URLs work under either without a
 * `file://` special case. There is no dev server; `npm run dev` runs this build
 * in watch mode and reloads the windows, which keeps origin, CSP and asset paths
 * identical to production.
 *
 * Later phases add an entry here per window: `recorder.html`, `countdown.html`,
 * `overlay.html`, `editor.html`, plus the two hidden pages `capture.html` and
 * `export.html` (architecture report §1.2).
 */

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, 'src');

export default defineConfig({
  root,
  base: './',
  build: {
    outDir: resolve(here, '../../dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    // Fonts must be emitted as files, not inlined as data: URIs — five variable
    // woff2 faces are 271 KB and inlining them would block first paint on parse.
    assetsInlineLimit: 0,
    // Every byte is served from disk over `loom://`; a sourcemap costs nothing at
    // runtime and turns a renderer stack trace into a real file and line.
    sourcemap: true,
    rollupOptions: {
      input: {
        library: resolve(root, 'library.html'),
      },
    },
  },
});
