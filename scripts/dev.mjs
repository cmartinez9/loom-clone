/**
 * Development loop.
 *
 * There is deliberately **no dev server**. Windows load from `loom://app` in
 * development exactly as they do in a packaged app, so the origin, the CSP and the
 * asset paths are the same in both — and "works in dev, breaks when packaged" has
 * one fewer place to hide. The research report makes the same point about TCC in
 * §7 trap 6: dev inheriting the terminal's environment is how you ship a build that
 * behaves differently for real users than it did for you.
 *
 * So: rebuild into `dist/` on change, and restart Electron when `dist/` changes.
 * A restart is a blunter instrument than hot reload, and for a window that renders
 * a list it is also faster than the alternative would be to maintain.
 *
 * **The two decisions this loop turns on are in `dev-loop.mjs`, and both of them
 * were wrong for the whole life of this project**: on a cold tree `npm run dev`
 * launched Electron against a half-written `dist/`, then read its own restart's
 * `SIGTERM` as the app quitting and ended the session with `process.exit(0)` —
 * no window, no error, exit status 0. That file's header has the mechanism and
 * `test/dev-loop.test.ts` holds it. Everything here is the wiring around it, plus
 * one rule this file owns: **say something on every exit.** A dev loop that ends in
 * silence is indistinguishable from a product that opened nothing, which is exactly
 * the confusion that cost the first person to run this app an afternoon.
 */

import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import electron from 'electron';
import { DevLoop, missingLaunchRequirements } from './dev-loop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

/** How long a rebuild has to stop writing before the app is restarted. */
const RESTART_DEBOUNCE_MS = 250;

/**
 * How quiet `dist/` has to be before the **first** launch.
 *
 * The first build finishes in stages — esbuild's two bundles, then vite's renderer,
 * then `clang` — and each stage's last write can land after the one before it has
 * reported "finished". Launching between two of them opens a window against a
 * renderer bundle that is being replaced underneath it, and then immediately
 * restarts it. Waiting for the writes to stop costs half a second once and buys a
 * single clean launch.
 *
 * It is measured from the moment the watcher was armed, never from before it: writes
 * that happened while nobody was watching are not facts this process has.
 */
const BUILD_SETTLE_MS = 500;

/** How often to look at `dist/` while waiting for the first build. */
const POLL_MS = 200;

const loop = new DevLoop();

/** @type {import('node:child_process').ChildProcess | null} */
let app = null;
/** @type {NodeJS.Timeout | null} */
let restartTimer = null;
/** @type {import('node:fs').FSWatcher | null} */
let watcher = null;
let lastDistWriteMs = 0;
let waitingSaid = false;

function startApp() {
  app = spawn(String(electron), ['.'], { cwd: root, stdio: 'inherit' });
  loop.launched();
  app.on('exit', (code, signal) => {
    app = null;
    const next = loop.exited();
    if (next === 'ignore') return;
    if (next === 'relaunch') {
      startApp();
      return;
    }
    // The one exit that ends the session, and it is announced. `code` is `null` for
    // a signalled exit, which is what a user pressing Cmd-Q on a window the OS then
    // SIGTERMs looks like — so both are named rather than folded into one number.
    const how = code === null ? `signal ${String(signal)}` : `code ${String(code)}`;
    console.log(`[dev] the app exited (${how}) — ending the dev session`);
    builder.kill('SIGTERM');
    process.exit(code ?? 0);
  });
}

function onDistWrite() {
  lastDistWriteMs = Date.now();
  if (loop.changed() !== 'schedule') return;
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (loop.restartDue() !== 'kill') return;
    console.log('[dev] dist/ changed — restarting the app');
    if (app === null) {
      // Nothing to kill, so there is no exit coming to carry the relaunch. Take the
      // transition ourselves rather than waiting for one that cannot arrive.
      if (loop.exited() === 'relaunch') startApp();
      return;
    }
    app.kill('SIGTERM');
  }, RESTART_DEBOUNCE_MS);
}

const builder = spawn(process.execPath, [resolve(root, 'scripts/build.mjs'), '--watch'], {
  cwd: root,
  stdio: 'inherit',
});

builder.on('exit', (code) => {
  if (loop.phase === 'stopped') return;
  console.error(`[dev] build watcher exited with ${String(code)}`);
  loop.stopping();
  app?.kill('SIGTERM');
  process.exit(code ?? 1);
});

// Wait for the first build to produce something the app can actually be launched
// against — and then for it to stop writing. `dist/` existing is not that: on a cold
// tree the directory is created by the first build step and `dist/main/index.cjs`
// arrives minutes later.
const ready = setInterval(() => {
  if (!existsSync(dist)) return;
  if (watcher === null) {
    watcher = watch(dist, { recursive: true }, onDistWrite);
    watcher.unref();
    lastDistWriteMs = Date.now();
  }

  const missing = missingLaunchRequirements((path) => existsSync(join(dist, path)));
  if (missing.length > 0) {
    if (!waitingSaid) {
      waitingSaid = true;
      console.log(`[dev] waiting for the first build — dist/ still needs ${missing.join(', ')}`);
    }
    return;
  }
  if (Date.now() - lastDistWriteMs < BUILD_SETTLE_MS) return;

  clearInterval(ready);
  console.log('[dev] watching dist/ — edit anything under apps/ or packages/');
  startApp();
}, POLL_MS);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    loop.stopping();
    app?.kill('SIGTERM');
    builder.kill('SIGTERM');
    process.exit(0);
  });
}
