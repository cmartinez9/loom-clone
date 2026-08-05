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
 */

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import electron from 'electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

/** @type {import('node:child_process').ChildProcess | null} */
let app = null;
let restartTimer = null;
let stopping = false;

function startApp() {
  app = spawn(String(electron), ['.'], { cwd: root, stdio: 'inherit' });
  app.on('exit', (code) => {
    app = null;
    // A clean quit from the app itself ends the dev session; a restart we asked
    // for is handled by the restart path below.
    if (!stopping && restartTimer === null) {
      stopping = true;
      builder.kill('SIGTERM');
      process.exit(code ?? 0);
    }
  });
}

function scheduleRestart() {
  if (stopping) return;
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (app === null) {
      startApp();
      return;
    }
    const previous = app;
    app = null;
    previous.once('exit', startApp);
    previous.kill('SIGTERM');
  }, 250);
}

const builder = spawn(process.execPath, [resolve(root, 'scripts/build.mjs'), '--watch'], {
  cwd: root,
  stdio: 'inherit',
});

builder.on('exit', (code) => {
  if (stopping) return;
  console.error(`[dev] build watcher exited with ${String(code)}`);
  stopping = true;
  app?.kill('SIGTERM');
  process.exit(code ?? 1);
});

// Wait for the first build to produce something before launching.
const ready = setInterval(() => {
  try {
    watch(dist, { recursive: true }, scheduleRestart).unref();
    clearInterval(ready);
    startApp();
    console.log('[dev] watching dist/ — edit anything under apps/ or packages/');
  } catch {
    // dist/ does not exist yet; the first build is still running.
  }
}, 200);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    app?.kill('SIGTERM');
    builder.kill('SIGTERM');
    process.exit(0);
  });
}
