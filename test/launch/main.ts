/**
 * Electron main for the launch gate.
 *
 * This harness opens **no window of its own** and builds no registry, no store and
 * no IPC: it `require`s the shipping `dist/main/index.cjs` and watches. That is the
 * whole point. `main()`'s startup path had never been exercised by any test, which
 * is how twenty-four merged commits and every phase gate went green over an app that
 * would not open for the first person who ran it.
 *
 * ## What it can and cannot fake
 *
 * Nothing. The app under it resolves its own preload and renderer roots from
 * `__dirname`, takes the single-instance lock, installs the `loom://` protocol,
 * registers every channel, runs crash recovery and shows a window — and it does all
 * of that here exactly as it does on a desktop. The **only** thing this harness
 * arranges is where the app's data lives: `HOME` and `--user-data-dir` are set by
 * the caller, which is what puts `store.recordingsRoot` and `settings.json` in a
 * scratch directory rather than in the user's library. There is no test flag in
 * production for this and there must not be one.
 *
 * ## The three readings
 *
 * 1. **A window a person could see.** `BrowserWindow.isVisible()` — a role is
 *    created `show: false` and revealed on `ready-to-show`, so that is what a
 *    `ready-to-show` which never fires, or a `reveal()` that is not reached, fails
 *    on. The control is a window this harness creates `show: false` on the same
 *    page: it must read `false`, or `true` is not a measurement. The renderer's own
 *    `document.visibilityState` was reached for first and that same control retired
 *    it — see `WindowReading.visibilityState` in `./report.ts`.
 * 2. **IPC that answers, from inside the page.** Every call the library makes at
 *    load, made through the real preload bridge. `library.delete` with a nonsense id
 *    is beside them and must **reject**, so a row of `ok: true` is evidence rather
 *    than a probe that cannot report bad news.
 * 3. **What the quit leaves standing.** Registered after the app's own `before-quit`
 *    listener, so it reads the state that listener left synchronously.
 */

import { BrowserWindow, app, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { CHANNEL } from '@loom/ipc';
import type { IpcReading, LaunchReport, QuitReading, WindowReading } from './report.ts';

interface Args {
  /** The built app to run: the directory holding `main/index.cjs`. */
  dist: string;
  out: string;
  scenario: 'setup' | 'library';
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string => {
    const index = argv.indexOf(`--${name}`);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (value === undefined) {
      if (fallback === undefined) throw new Error(`missing --${name}`);
      return fallback;
    }
    return value;
  };
  const scenario = get('scenario');
  if (scenario !== 'setup' && scenario !== 'library') throw new Error('--scenario');
  return {
    dist: resolve(get('dist')),
    out: resolve(get('out')),
    scenario,
    timeoutMs: Number.parseInt(get('timeout', '120000'), 10),
  };
}

const args = parseArgs(process.argv.slice(1));
const logs: string[] = [];
let finished = false;

function note(message: string): void {
  logs.push(message);
  console.log(`[launch] ${message}`);
}

const state: {
  windowsBeforeLaunch: number;
  windows: WindowReading[];
  hiddenControl: WindowReading | null;
  ipc: IpcReading[];
  quit: QuitReading | null;
} = {
  windowsBeforeLaunch: -1,
  windows: [],
  hiddenControl: null,
  ipc: [],
  quit: null,
};

function reportOf(ok: boolean, error: string): LaunchReport {
  return { ok, error, scenario: args.scenario, ...state, logs };
}

async function finish(ok: boolean, error: string): Promise<void> {
  if (finished) return;
  finished = true;
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(reportOf(ok, error), null, 2));
  app.exit(ok ? 0 : 1);
}

/**
 * The same write, synchronously, for the one reading that has to be taken inside a
 * `before-quit` listener.
 *
 * There is no awaiting anything there: the app's own listener has already run and
 * the process is on its way out, so the report is written with the blocking call and
 * the harness exits rather than handing control back to a shutdown it is measuring.
 */
function finishSync(ok: boolean, error: string): void {
  if (finished) return;
  finished = true;
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(reportOf(ok, error), null, 2));
  app.exit(ok ? 0 : 1);
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => {
    setTimeout(r, ms);
  });
}

/**
 * The reading taken inside the page.
 *
 * The heading is the load-bearing one: a window that is on screen and painted
 * nothing is a window whose renderer bundle did not load over `loom://`, which is
 * the failure a "the window exists" assertion cannot see. Both pages carry an
 * `<h1>`, so one script serves the setup window and the library. `visibilityState`
 * rides along recorded rather than asserted — `WindowReading.visibilityState` in
 * `./report.ts` says why it is not an instrument.
 */
const PAGE_SCRIPT = `(() => {
  const heading = document.querySelector('h1');
  const view = window.innerHeight;
  let visiblePx = 0;
  let text = '';
  if (heading !== null) {
    text = (heading.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const r = heading.getBoundingClientRect();
    if (r.width > 0) visiblePx = Math.max(0, Math.min(r.bottom, view) - Math.max(r.top, 0));
  }
  return { visibilityState: document.visibilityState, headingText: text, headingVisiblePx: visiblePx };
})()`;

interface PageReading {
  visibilityState: string;
  headingText: string;
  headingVisiblePx: number;
}

/**
 * How many distinct colours the window composited.
 *
 * `capturePage` reads the window's own compositor output, so it needs no Screen
 * Recording grant and cannot be fooled by something on top. One colour is the ground
 * the registry paints every window at construction with nothing drawn over it —
 * which is what a window that opened and never rendered its page looks like.
 */
async function countCapturedColours(
  window: BrowserWindow,
): Promise<{ colours: number; size: [number, number] }> {
  const image = await window.webContents.capturePage();
  const { width, height } = image.getSize();
  if (width === 0 || height === 0) return { colours: 0, size: [width, height] };
  const pixels = image.toBitmap();
  const seen = new Set<number>();
  // Every 64th pixel: enough to tell a flat rectangle from a rendered page, cheap
  // enough not to walk eight megabytes for it.
  for (let index = 0; index + 3 < pixels.length && seen.size < 64; index += 4 * 64) {
    seen.add(
      ((pixels[index] ?? 0) << 16) | ((pixels[index + 1] ?? 0) << 8) | (pixels[index + 2] ?? 0),
    );
  }
  return { colours: seen.size, size: [width, height] };
}

async function readWindow(window: BrowserWindow): Promise<WindowReading> {
  const page = (await window.webContents.executeJavaScript(PAGE_SCRIPT, true)) as PageReading;
  const [width = 0, height = 0] = window.getContentSize();
  const captured = await countCapturedColours(window);
  return {
    url: window.webContents.getURL(),
    title: window.getTitle(),
    isVisible: window.isVisible(),
    contentSize: [width, height],
    capturedColours: captured.colours,
    capturedSize: captured.size,
    ...page,
  };
}

/**
 * One call through the real preload bridge, made from inside the page.
 *
 * `window.loom` is what the sandboxed renderer actually has — the preload exposes
 * named channels only and never a generic `invoke` — so this reaches the handler the
 * same way the library's own code does. A rejection is recorded rather than thrown,
 * because a probe that stops at the first bad answer cannot say which of the others
 * were fine.
 */
async function probeIpc(window: BrowserWindow, call: string, argument?: string): Promise<void> {
  const path = call.split('.');
  const arg = argument === undefined ? '' : JSON.stringify(argument);
  const script = `(async () => {
    try {
      const value = await window.loom.${path.join('.')}(${arg});
      return { ok: true, error: '', value: JSON.stringify(value ?? null).slice(0, 200) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error), value: '' };
    }
  })()`;
  const result = (await window.webContents.executeJavaScript(script, true)) as Omit<
    IpcReading,
    'call'
  >;
  state.ipc.push({ call, ...result });
  note(`ipc ${call} -> ${result.ok ? result.value : `REJECTED ${result.error}`}`);
}

/** Wait for the app to put a visible window on screen, or give up saying so. */
async function awaitFirstWindow(deadlineMs: number): Promise<BrowserWindow> {
  const started = Date.now();
  for (;;) {
    const candidate = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible() && !window.webContents.isLoading(),
    );
    if (candidate !== undefined) return candidate;
    if (Date.now() - started > deadlineMs) {
      const seen = BrowserWindow.getAllWindows().map(
        (window) =>
          `${window.webContents.getURL()} visible=${String(window.isVisible())} ` +
          `loading=${String(window.webContents.isLoading())}`,
      );
      throw new Error(
        `the app opened no visible window within ${String(deadlineMs)} ms ` +
          `(windows: ${seen.length === 0 ? 'none' : seen.join('; ')})`,
      );
    }
    await wait(100);
  }
}

/**
 * The control for the visibility instrument.
 *
 * Same page, same preload, same protocol — created `show: false` and never revealed,
 * which is the state a window whose `ready-to-show` never fired is left in. Its
 * `isVisible` has to read `false`, or the subject's `true` above is a constant rather
 * than a measurement — while its `visibilityState` reads `visible` anyway, which is
 * the measurement that retired that second instrument.
 */
async function readHiddenControl(subject: BrowserWindow): Promise<WindowReading> {
  const control = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      // The app's own preload, out of the same build the subject window loaded —
      // a control on a different bridge would be a different window.
      preload: join(args.dist, 'preload', 'index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await control.loadURL(subject.webContents.getURL());
    return await readWindow(control);
  } finally {
    control.destroy();
  }
}

async function run(): Promise<void> {
  // Before the app is required, so "the app opened a window" is a statement about
  // the app rather than about whatever was already on screen.
  state.windowsBeforeLaunch = BrowserWindow.getAllWindows().length;

  // **Required before `whenReady`, synchronously, and that is the app's own rule
  // rather than a harness convenience.** `apps/main/src/index.ts` calls
  // `registerLoomScheme()` at module scope because Electron reads the privileged
  // scheme table when the first renderer starts and registering later silently does
  // nothing — it throws outright once the app is ready. A harness that awaited
  // readiness first would be running a different program.
  const entry = join(args.dist, 'main', 'index.cjs');
  note(`requiring the shipping main from ${entry}`);
  // `createRequire` rather than a bare `require`, so this resolves against a real
  // path at runtime instead of being rewritten into the harness's own bundle: the
  // subject is the app built into a scratch `dist/`, not a second copy of it
  // compiled in here. Seeded from `entry` itself, because this harness is bundled to
  // CJS and `import.meta.url` is empty there.
  createRequire(entry)(entry);

  await app.whenReady();
  const window = await awaitFirstWindow(Math.min(args.timeoutMs / 2, 60_000));
  // The library asks main three things as it loads and then paints; a beat here
  // means the reading is of a settled window rather than of one mid-render.
  await wait(750);

  for (const open of BrowserWindow.getAllWindows()) {
    if (open.isDestroyed()) continue;
    state.windows.push(await readWindow(open));
  }
  note(`windows: ${state.windows.map((w) => `${w.url} (${w.visibilityState})`).join(', ')}`);

  state.hiddenControl = await readHiddenControl(window);
  note(`hidden control: ${state.hiddenControl.visibilityState}`);

  // Every call the library makes at load, plus one that must fail.
  await probeIpc(window, 'app.info');
  await probeIpc(window, 'library.list');
  await probeIpc(window, 'library.recovery');
  await probeIpc(window, 'recorder.preflight');
  await probeIpc(window, 'library.delete', 'not-a-recording-id');

  // ---- what the quit leaves standing -------------------------------------------
  //
  // Registered now, so it runs *after* the app's own `before-quit` listener — which
  // was installed at module scope when the entry above was required — and therefore
  // reads what that listener left behind synchronously.
  app.on('before-quit', () => {
    let libraryListHandled = true;
    try {
      // There is no public "is this handled" API. Registering a second handler for a
      // channel that has one throws; on a channel whose handler has been removed it
      // succeeds, so this answers the question and then puts the surface back.
      ipcMain.handle(CHANNEL.libraryList, () => []);
      libraryListHandled = false;
      ipcMain.removeHandler(CHANNEL.libraryList);
    } catch {
      libraryListHandled = true;
    }
    const quit: QuitReading = {
      windowsAlive: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
      libraryListHandled,
      captureEndedListeners: ipcMain.listenerCount(CHANNEL.captureEnded),
    };
    state.quit = quit;
    note(
      `quit: windows=${String(quit.windowsAlive)} library.list=${String(quit.libraryListHandled)} ` +
        `capture.ended listeners=${String(quit.captureEndedListeners)}`,
    );
    finishSync(true, '');
  });

  app.quit();
}

setTimeout(() => {
  void finish(false, `the launch probe did not finish within ${String(args.timeoutMs)} ms`);
}, args.timeoutMs).unref();

run().catch((error: unknown) => {
  void finish(false, error instanceof Error ? error.message : String(error));
});
