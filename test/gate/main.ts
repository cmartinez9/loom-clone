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
  const empty = { count: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p99Ms: 0, overBudget: 0 };
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

process.on('uncaughtException', (error: Error) => {
  void finish(failureReport(`uncaught in main: ${error.message}`), 1);
});
