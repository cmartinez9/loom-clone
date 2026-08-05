/**
 * Electron main for the phase-6 gate.
 *
 * Its whole job is to give the harness the runtime the app itself has: a `loom://`
 * origin, byte-range media served by main, a sandboxed context-isolated renderer,
 * and no filesystem in the renderer. The gate is only worth running if what it
 * measures is the shipping arrangement.
 *
 * Two pieces are imported from `apps/main` rather than reimplemented, because
 * reimplementing them is how a gate ends up testing the harness:
 *
 *  - `registerLoomScheme()` — the privilege table, which must be declared before
 *    `app.whenReady()` or it silently does nothing.
 *  - `serveFile()` — the same `Range`-aware reader the editor gets its media
 *    through (§1.4, §2.4).
 *
 * The renderer *writes* nothing: the fixture goes over a named IPC channel and main
 * puts it on disk. §0, rule 2 — main is the only writer — holds even in a test.
 */

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { LOOM_SCHEME } from '@loom/ipc';
import { registerLoomScheme } from '../../apps/main/src/protocol.ts';
import { serveFile } from '../../apps/main/src/media-reader.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { NO_CONTROL } from './budget-control.ts';
import type { GateReport } from './report.ts';

interface Args {
  harnessDir: string;
  fixtureDir: string;
  out: string;
  frameCount: number;
  gopSize: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string => {
    const index = argv.indexOf(`--${name}`);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`missing --${name}`);
    }
    return value;
  };
  return {
    harnessDir: resolve(get('harness')),
    fixtureDir: resolve(get('fixture')),
    out: resolve(get('out')),
    frameCount: Number.parseInt(get('frames', '130'), 10),
    gopSize: Number.parseInt(get('gop', '30'), 10),
    timeoutMs: Number.parseInt(get('timeout', '300000'), 10),
  };
}

const args = parseArgs(process.argv.slice(1));
const logs: string[] = [];
let finished = false;

function note(message: string): void {
  logs.push(message);
  console.log(`[gate] ${message}`);
}

async function finish(report: GateReport, code: number): Promise<void> {
  if (finished) return;
  finished = true;
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(
    args.out,
    JSON.stringify({ ...report, logs: [...report.logs, ...logs] }, null, 2),
  );
  app.exit(code);
}

/** A report for a failure that happened before the harness could produce one. */
function failureReport(error: string): GateReport {
  const empty = { count: 0, maxMs: 0, maxAt: -1, meanMs: 0, p50Ms: 0, p99Ms: 0, overBudget: 0 };
  return {
    ok: false,
    error,
    contextLost: false,
    environment: {
      glRenderer: 'unknown',
      scheduler: 'raf',
      hardwareEncode: 'unknown',
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
    },
    fixture: {
      width: 0,
      height: 0,
      frameCount: 0,
      durationSec: 0,
      byteLength: 0,
      codec: '',
      observedFps: 0,
      longestHoldSec: 0,
      encodeMs: 0,
    },
    viewport: [0, 0],
    ringCapacity: 0,
    peakLiveFrames: 0,
    liveFramesAtEnd: 0,
    warmup: empty,
    scrub: empty,
    play: empty,
    control: { scrub: NO_CONTROL, play: NO_CONTROL },
    slowCompositor: { injectedMs: 0, frames: empty, control: NO_CONTROL },
    scrubChecks: [],
    settleSamples: 0,
    settleBlackFrames: 0,
    controlDetectsBlack: false,
    playSamples: [],
    playHits: 0,
    playMisses: 0,
    decodedFrames: 0,
    seeks: 0,
    bytesRead: 0,
    gpuCompositeMs: null,
    logs,
  };
}

/** Resolve a request path inside a root, refusing anything that climbs out. */
function confine(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = normalize(decoded.replace(/^\/+/, ''));
  if (relative.startsWith('..') || relative.startsWith(sep) || relative.includes('\0')) return null;
  const full = join(root, relative);
  return full === root || full.startsWith(root + sep) ? full : null;
}

registerLoomScheme();
// The harness canvas is 2560x1440 and the window is small; without this the
// drawing buffer would be clamped to the window on some configurations.
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '2048');
// The GPU watchdog kills the GPU process when a call has not come back inside its
// timeout, and every context living in it goes too — silently, as a
// `webglcontextlost` event with no reason attached. In a browser that is a tab
// staying responsive. Here it is the instrument being taken away mid-run because
// the host was *slow*, which is the one thing this gate exists to measure and fail
// on: CI lost the context on both launches of one job on a runner where the same
// commit passed in another, and the runner that did pass it was already reporting a
// 24.5 ms warmup frame and a 4.1 ms composite against 4.7 ms and 1.9 ms on a quick
// one. A frame that takes too long has to arrive as a number over budget, not as a
// run that measured nothing — so the watchdog does not get to pre-empt the
// measurement. Nothing about what is measured changes; a genuinely hung GPU still
// fails, on the frame budget, with the frame named.
app.commandLine.appendSwitch('disable-gpu-watchdog');
// The same argument, one layer down, and it is the other half of that story.
//
// Chromium deprioritises a renderer it believes nobody is looking at: a hidden or
// occluded window has its process moved to background priority and its timers
// throttled. On a CI runner there is no display to be visible on, so the gate's
// window qualifies, and a renderer at background priority on a shared runner is
// pre-empted for tens of milliseconds at a time. `webPreferences.background-
// Throttling: false` does not cover this — that is Blink's own timer and rAF
// throttling, not the process priority the OS scheduler reads.
//
// A pre-emption is not a slow frame, and the instrument cannot tell them apart: it
// brackets the frame body with `performance.now()`, so whatever the scheduler takes
// away lands on whichever frame it interrupted. Measured on `fm/loom-p7`, where phase
// 7's timeline lands, with the frame body timed segment by segment: 10–20 ms readings
// inside `drawArrays`, inside `present`, and inside that branch's `resolve()` — 0.2 µs
// of work, pinned there by `packages/edl/test/hot-path.test.ts`, and on this branch the
// four state assignments `PreviewLoop` still does in its place. None of those can spend
// a millisecond doing anything. CI reported the same event on a slower host as a single
// 177 ms frame against a p99 of 7.9 ms, on the same commit whose other run passed.
//
// Over thirty runs of this gate on one machine with hardware decode disabled — so
// every frame carries CI's 30 MB CPU-backed upload — the worst frame was 2.6 ms and
// no run lost a single scheduled frame. The thirty-odd runs of the same arrangement
// without these switches produced three with a 10–20 ms pause in them, and a short
// frame count to match.
// Nothing about what is measured changes and nothing is made faster: real work still
// arrives as a number over budget, on the worst frame, with no allowance.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

void app.whenReady().then(async () => {
  protocol.handle(LOOM_SCHEME, async (request) => {
    const url = new URL(request.url);
    const range = request.headers.get('Range');
    const root =
      url.hostname === 'gate'
        ? args.harnessDir
        : url.hostname === 'fixture'
          ? args.fixtureDir
          : null;
    if (root === null) return new Response('not found', { status: 404 });
    const path = confine(root, url.pathname);
    if (path === null) return new Response('forbidden', { status: 403 });
    try {
      return await serveFile(path, range);
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  ipcMain.handle('gate:options', () => ({
    fixtureDir: args.fixtureDir,
    frameCount: args.frameCount,
    gopSize: args.gopSize,
  }));

  ipcMain.handle('gate:write', async (_event, relative: string, data: Uint8Array) => {
    const path = confine(args.fixtureDir, `/${relative}`);
    if (path === null) throw new Error(`refused to write outside the fixture dir: ${relative}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    note(`wrote ${relative} (${String(data.byteLength)} bytes)`);
  });

  ipcMain.handle('gate:finish', async (_event, report: GateReport) => {
    note(
      report.ok ? 'harness reported success' : `harness reported failure: ${report.error ?? ''}`,
    );
    await finish(report, report.ok ? 0 : 1);
  });

  ipcMain.on('gate:log', (_event, message: string) => {
    note(message);
  });

  const window = new BrowserWindow({
    width: 900,
    height: 600,
    // Shown, not hidden: an occluded renderer can stop producing compositor frames,
    // and a gate that never ticks is indistinguishable from one that hangs. The
    // harness records which scheduler actually drove it either way.
    show: true,
    webPreferences: {
      preload: join(args.harnessDir, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  window.webContents.on('console-message', (_event, _level, message) => {
    note(`renderer: ${message}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    void finish(failureReport(`renderer gone: ${details.reason}`), 1);
  });
  window.webContents.on('preload-error', (_event, path, error) => {
    void finish(failureReport(`preload ${path} failed: ${error.message}`), 1);
  });

  setTimeout(() => {
    void finish(failureReport(`gate did not finish within ${String(args.timeoutMs)}ms`), 1);
  }, args.timeoutMs).unref?.();

  await window.loadURL(`${LOOM_SCHEME}://gate/harness.html`);
});

app.on('window-all-closed', () => {
  void finish(failureReport('the gate window closed before the harness reported'), 1);
});

/**
 * A GPU process that dies takes every context in it with it, and the renderer cannot
 * see why: `webglcontextlost` arrives with no reason attached. Noted rather than
 * finished on — the harness's report is still what decides the run — so that a lost
 * context names its mechanism in the log instead of leaving the next reader to guess.
 */
app.on('child-process-gone', (_event, details) => {
  note(
    `${details.type} process gone: ${details.reason} (exit ${String(details.exitCode)})` +
      (details.name === undefined ? '' : ` [${details.name}]`),
  );
});

process.on('uncaughtException', (error: Error) => {
  void finish(failureReport(`uncaught in main: ${error.message}`), 1);
});
