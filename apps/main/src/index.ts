/**
 * The Electron main process.
 *
 * Boot order matters and is not arbitrary:
 *
 * 1. **identity first** — `app.setName` and the app-user-model id, before anything
 *    resolves `userData`, so preferences never land in a directory named after the
 *    npm package;
 * 2. **`registerLoomScheme()` before `whenReady`** — Electron reads the privileged
 *    scheme table when the first renderer starts, and registering later silently
 *    does nothing;
 * 3. **the single-instance lock** — two copies of this app pointed at one
 *    recordings root is precisely the case the bundle `.lock` exists to refuse, and
 *    refusing it here is friendlier;
 * 4. **`ProjectStore` before any window** — the store is the only writer, and a
 *    window that could ask for a recording before the store existed would be a
 *    race with the user's data.
 */

import { app, BrowserWindow, shell } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RECORDINGS_SUBPATH, LOOM_BUNDLE_ID, LOOM_PRODUCT_NAME } from './identity.ts';
import { ProjectStore } from './project-store.ts';
import { installLoomProtocol, registerLoomScheme } from './protocol.ts';
import { registerIpc, unregisterIpc } from './ipc.ts';
import { RecorderSession } from './recorder/session.ts';
import { WindowRegistry } from './windows.ts';

// ---- identity, before anything reads a path ---------------------------------
app.setName(LOOM_PRODUCT_NAME);
app.setAppUserModelId(LOOM_BUNDLE_ID);

// ---- the privileged scheme, before app.whenReady() --------------------------
registerLoomScheme();

/**
 * `dist/` layout at runtime:
 *   dist/main/index.cjs      ← this file, bundled
 *   dist/preload/index.cjs
 *   dist/renderer/*.html
 */
const distRoot = join(__dirname, '..');
const preloadPath = join(distRoot, 'preload', 'index.cjs');
const rendererRoot = join(distRoot, 'renderer');

const store = new ProjectStore({
  recordingsRoot: join(homedir(), ...DEFAULT_RECORDINGS_SUBPATH),
  settingsPath: join(app.getPath('userData'), 'settings.json'),
  appVersion: app.getVersion(),
  // The one platform capability the store needs. Injected so the store itself
  // stays plain Node and unit-testable.
  trash: (path: string) => shell.trashItem(path),
});

const windows = new WindowRegistry({ preloadPath });

const recorder = new RecorderSession({
  store,
  windows,
  appVersion: app.getVersion(),
  // `process.getSystemVersion()` is the marketing version ("26.5.1"), which is
  // what `recording.json` should carry; `os.release()` is the Darwin kernel
  // version, which nobody can act on.
  osVersion: process.getSystemVersion(),
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windows.show('library');
  });

  app.whenReady().then(main, (error: unknown) => {
    console.error('[main] failed to start:', error);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  await store.loadSettings();

  installLoomProtocol({ store, rendererRoot });
  registerIpc({ store, appVersion: app.getVersion() });
  recorder.install();

  // Before any window can ask for a recording: a bundle still saying
  // `state: "recording"` means we crashed mid-capture, and it is repaired to the
  // last complete fragment rather than left for the library to stumble into
  // (architecture report §7.1).
  await recorder.recoverOnLaunch().catch((error: unknown) => {
    console.error('[main] crash recovery failed:', error);
  });

  windows.show('library');

  // macOS: clicking the dock icon with no windows open reopens the library.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.show('library');
  });
}

// macOS keeps the app running with no windows; that is the platform convention and
// this app is macOS-only, so there is no `window-all-closed` quit.

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  // Flush open journals and release bundle locks before the process goes away.
  // Without this a quit during an edit would leave a `.lock` behind and cost the
  // last two seconds of ops.
  event.preventDefault();
  shuttingDown = true;
  unregisterIpc();
  // The recorder first: a recording in flight is finalized properly rather than
  // left for the next launch to recover. If it cannot be, the bundle keeps
  // `state: "recording"` and recovery handles it — the same path a crash takes.
  recorder
    .shutdown()
    .then(() => store.closeAll())
    .catch((error: unknown) => {
      console.error('[main] shutdown flush failed:', error);
    })
    .finally(() => {
      app.quit();
    });
});
