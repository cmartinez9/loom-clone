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
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL, type PermissionReport } from '@loom/ipc';
import { probeInput } from '@loom/sampler';
import { EditorWindows } from './editor.ts';
import { DEFAULT_RECORDINGS_SUBPATH, LOOM_BUNDLE_ID, LOOM_PRODUCT_NAME } from './identity.ts';
import { helperPathFor } from './input-sampler.ts';
import { PermissionManager } from './permissions.ts';
import { ProjectStore } from './project-store.ts';
import { installLoomProtocol, registerLoomScheme } from './protocol.ts';
import { registerIpc, unregisterIpc } from './ipc.ts';
import { OverlayController } from './overlay.ts';
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

/**
 * Markers the runner script slices the machine-readable report out of stdout with.
 * Exported so the script and this file cannot disagree about them.
 */
export const VERIFY_JSON_BEGIN = '---loom-verify-json-begin---';
export const VERIFY_JSON_END = '---loom-verify-json-end---';
export const VERIFY_SCRATCH_MARK = '---loom-verify-scratch:';

/**
 * `--verify-permissions` runs the phase 2 gate instead of the app.
 *
 * It has to be *this* bundle, because macOS keys every grant on the bundle
 * identifier — a separate test binary would have different permissions and prove
 * nothing about the shipped app (`identity.ts`). So the harness ships inside the
 * app, behind a flag, and `scripts/verify-permissions.mjs` is what invokes it.
 *
 * A verification run must not touch the user's recordings or settings, so it gets
 * its own temporary root: it opens windows, paints them and captures the screen, and
 * none of that belongs in somebody's library. The runner script removes the scratch
 * directory afterwards — main has no filesystem to remove it with.
 */
const verifying = process.argv.includes('--verify-permissions');
const verifyScratch = join(tmpdir(), `loom-verify-${String(process.pid)}`);

const store = new ProjectStore({
  recordingsRoot: verifying
    ? join(verifyScratch, 'recordings')
    : join(homedir(), ...DEFAULT_RECORDINGS_SUBPATH),
  settingsPath: verifying
    ? join(verifyScratch, 'settings.json')
    : join(app.getPath('userData'), 'settings.json'),
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
  // The cursor and click sampler every recording runs. Same reason the permission
  // probe is handed a path rather than left to the package default: only `dist/`
  // knows its own layout, and inside a packaged app the binary lives in
  // `app.asar.unpacked/` (`input-sampler.ts`).
  inputHelperPath: helperPathFor(distRoot),
});

/**
 * The live drawing overlay (phase 12).
 *
 * Built after the recorder because it reads the recording clock, and attached back
 * to it because the recorder has to ask it what to put in `recording.json`. Both
 * halves are optional from the recorder's side — a `RecorderSession` with nothing
 * attached behaves exactly as it did before this phase, which is the structural
 * half of *"a drawing overlay must never break the recording"*.
 */
const overlay = new OverlayController({ store, windows, recorder });
recorder.attachDrawing(overlay);

/**
 * The editor windows, and the bundle lock each one holds while it is open.
 *
 * `activeRecordingId` comes off the live recorder rather than being cached: an
 * editor may be closed at any instant, including while a recording is running, and
 * the question this answers — "would closing this project pull a file descriptor
 * out from under capture" — has no true answer that is older than now.
 */
const editors = new EditorWindows({
  store,
  windows,
  activeRecordingId: () => recorder.status().recordingId,
});

/**
 * The permission manager — built inside {@link main}, after `settings.json` has been
 * read, and never at module scope.
 *
 * That is ordering, not style. The manager answers "have we already sent this user to
 * the Accessibility pane" from `store.setup`, and a store that has not loaded yet
 * answers with the fresh-install default. A manager built before the load would come
 * back from the relaunch it just asked for having forgotten that it asked.
 */
function createPermissionManager(): PermissionManager {
  return new PermissionManager({
    store,
    // Phase 5's `probeInput`, which is the whole of the wiring. It runs the native
    // helper once, with no side effects and no prompt, and reports whether a real
    // `CGEventTap` can be built — the half of the Accessibility answer that
    // `AXIsProcessTrusted()` cannot give, because the tap API succeeds without the
    // permission and then delivers nothing.
    //
    // The helper path is passed rather than left to the package's default: only
    // `dist/` knows its own layout, and inside a packaged app the binary lives in
    // `app.asar.unpacked/` (`input-sampler.ts`).
    clickTapProbe: () => probeInput({ helperPath: helperPathFor(distRoot) }),
    relaunchApp: relaunchGracefully,
    broadcast: (report: PermissionReport) => {
      for (const window of windows.all()) {
        window.webContents.send(CHANNEL.permissionsChanged, report);
      }
    },
    onSetupComplete: () => {
      windows.show('library');
      windows.get('setup')?.close();
    },
    // The route back. Setup is not only a first run: a user who continued with
    // Screen Recording refused has a recorder that cannot record, and the library
    // is where they find that out.
    onOpenSetup: () => {
      windows.show('setup');
    },
  });
}

/**
 * Quit and come back, through the same shutdown the user quitting gets.
 *
 * An Accessibility grant does not reach a running process, so a relaunch is part of
 * the permission flow rather than an edge case — which makes it exactly the kind of
 * quit that must not skip flushing journals and releasing bundle locks.
 * `app.relaunch()` only schedules the restart; `app.quit()` runs `before-quit`
 * below, which stops producers before it closes anything.
 */
function relaunchGracefully(): void {
  app.relaunch();
  app.quit();
}

// A verification run does not take the lock, and does not need it: it has its own
// scratch recordings root and settings file, so it shares nothing with a copy of the
// app the captain happens to have open. Quitting here instead would print no report
// at all, and `scripts/verify-permissions.mjs` would diagnose that as "the app
// produced no machine-readable report" — a sentence about the wrong problem, from the
// one tool whose whole value is saying precisely what is blocking it.
if (verifying || app.requestSingleInstanceLock()) {
  if (!verifying) {
    app.on('second-instance', () => {
      // The same gate the launch path and `activate` use. A second launch during
      // first run must not open the library beside the setup window, which is the
      // "one deliberate onboarding step" the captain's decision asks for.
      windows.show(store.setup.completedAt === null ? 'setup' : 'library');
    });
  }

  app.whenReady().then(main, (error: unknown) => {
    console.error('[main] failed to start:', error);
    app.exit(1);
  });
} else {
  app.quit();
}

async function main(): Promise<void> {
  await store.loadSettings();

  const permissions = createPermissionManager();

  installLoomProtocol({ store, rendererRoot });
  registerIpc({ store, appVersion: app.getVersion() });
  windows.installHudNoticeFit();
  permissions.install();
  recorder.install();
  overlay.install();
  editors.install();

  // macOS never tells an app that a grant was given: the user leaves for System
  // Settings, flips a switch and comes back. Regaining focus is the closest thing to
  // an event there is, and this is what turns it into one.
  app.on('browser-window-focus', () => {
    void permissions.refresh();
  });

  if (verifying) {
    await runVerifyMode(permissions);
    return;
  }

  // Before any window can ask for a recording: a bundle still saying
  // `state: "recording"` means we crashed mid-capture, and it is repaired to the
  // last complete fragment rather than left for the library to stumble into
  // (architecture report §7.1).
  await recorder.recoverOnLaunch().catch((error: unknown) => {
    console.error('[main] crash recovery failed:', error);
  });

  // First run gets the setup window instead of the library. The captain's decision
  // (`data/loom-scope/decision-accessibility-clicks.md`) is "ask up front": all four
  // permissions, explained, as one deliberate onboarding step, before the first
  // recording rather than in the middle of it.
  windows.show(store.setup.completedAt === null ? 'setup' : 'library');

  // macOS: clicking the dock icon with no windows open reopens where we left off.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    windows.show(store.setup.completedAt === null ? 'setup' : 'library');
  });
}

/**
 * Run a real sampler for a while and report every click it saw, with the instant this
 * process received it.
 *
 * This is the fourth carried-forward obligation's measuring instrument — the captain's
 * Accessibility decision closes with *"Post-grant event rate and latency are
 * unmeasured. Validate during the build."*
 *
 * The sink is in memory rather than `ProjectStoreEventSink`: a verification run has no
 * recording to write into, and the point is to observe arrival timing, not to keep the
 * events. Everything above the sink — the helper, the tap, the batching — is the
 * shipped path, so what is measured is what a recording would get.
 *
 * Two clocks come back because they answer different questions. `tSec` is the
 * sampler's own timestamp for the event, and it is the one inter-arrival is measured
 * from. `receivedMs` is when *this process* saw the line, which §2.5's 100 ms flush
 * cadence quantises — one batch, one stamp, however many clicks are in it — so it is
 * evidence about batching and must never be read as timing. Neither is an
 * input-to-app latency: that needs the helper's clock compared against a synthesised
 * event, which is `packages/sampler/test/rate-control.ts`'s territory, not this
 * harness's.
 */
async function observeClicks(durationMs: number): Promise<{ tSec: number; receivedMs: number }[]> {
  const { InputSampler } = await import('@loom/sampler');
  const clicks: { tSec: number; receivedMs: number }[] = [];

  const sampler = new InputSampler({
    sink: {
      create: () => Promise.resolve(),
      append: (log, ndjson) => {
        if (log !== 'clicks') return Promise.resolve();
        const at = performance.now();
        for (const line of ndjson.split('\n')) {
          if (line === '') continue;
          try {
            clicks.push({ tSec: (JSON.parse(line) as { t: number }).t, receivedMs: at });
          } catch {
            // A line this process cannot parse is a sampler bug, and the sampler's own
            // tests are where it belongs. Here it must not abort the measurement.
          }
        }
        return Promise.resolve();
      },
      sync: () => Promise.resolve(),
      writeCursorImage: () => Promise.resolve(),
      writeCursorIndex: () => Promise.resolve(),
    },
    // No recording, so no `recording.json` clock to share an origin with. `t` is
    // therefore seconds since the sampler started, which is all this needs — the rate
    // comes from the length of the observation window, and inter-arrival from these
    // timestamps.
    t0Us: 0,
    clicks: true,
    helperPath: helperPathFor(distRoot),
  });

  await sampler.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  } finally {
    // Stop the producer before anything else, per the ordering contract: the sampler
    // writes from its own timers, and a stop that has not resolved is a stop that is
    // still appending.
    await sampler.stop();
  }
  return clicks;
}

/**
 * Run the phase 2 gate and quit.
 *
 * Crash recovery is skipped and no window is shown by the normal path: the harness
 * opens exactly the windows it needs.
 *
 * The report is **printed, not written**. `apps/main` has no filesystem — `node:fs`
 * is import-restricted to `ProjectStore` (§0, rule 1) — and a verification harness is
 * not a good enough reason to punch the first hole in that. So the JSON goes to
 * stdout between markers and `scripts/verify-permissions.mjs` saves it, which also
 * makes the report readable when nobody asked for a file.
 *
 * The exit code is the verdict, so a shell or CI can act on it without parsing
 * anything: `1` for a real failure, `2` for a run that could not establish what it
 * set out to (a missing grant, a dev binary), `0` only for a genuine, trustworthy
 * pass.
 */
async function runVerifyMode(permissions: PermissionManager): Promise<void> {
  const { runVerification, formatReport } = await import('./verify/permissions-harness.ts');
  let code = 1;
  try {
    const report = await runVerification({
      permissions,
      windows,
      appVersion: app.getVersion(),
      clickStream: observeClicks,
      // The shipping recorder and store, so the §7.3 revocation check drives a real
      // recording rather than a stand-in. It only runs when a person opted in, for
      // the reason `checkMicrophoneRevocation` states: a TCC grant cannot be revoked
      // programmatically, so the check waits for somebody to do it.
      recorderDrive: { recorder, store },
      micRevocation: process.argv.includes('--mic-revocation'),
    });
    console.log(formatReport(report));
    console.log(VERIFY_JSON_BEGIN);
    console.log(JSON.stringify(report));
    console.log(VERIFY_JSON_END);
    code = report.outcome === 'verified' ? 0 : report.outcome === 'failed' ? 1 : 2;
  } catch (error) {
    console.error('[verify] the harness itself failed:', error);
  } finally {
    windows.closeAll();
    console.log(`${VERIFY_SCRATCH_MARK}${verifyScratch}`);
    app.exit(code);
  }
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
