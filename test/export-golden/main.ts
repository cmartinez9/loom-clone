/**
 * Electron main for the golden-frame gate.
 *
 * It gives the harness the runtime the app itself has — a `loom://` origin,
 * byte-range media served by main's own `serveFile`, a sandboxed context-isolated
 * renderer with no filesystem — and it runs the **shipping** write and verify path
 * for the end-to-end half: `ExportMp4Writer` through `ProjectStore`, and
 * `verifyExport` from `apps/main/src/export/verify.ts`.
 *
 * Reimplementing either would be testing the harness. The one thing that is
 * different from the app is where the file goes: a temp directory rather than the
 * user's Exports folder.
 */

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { LOOM_SCHEME } from '@loom/ipc';
import { registerLoomScheme } from '../../apps/main/src/protocol.ts';
import { serveFile } from '../../apps/main/src/media-reader.ts';
import { ProjectStore } from '../../apps/main/src/project-store.ts';
import { verifyExport } from '../../apps/main/src/export/verify.ts';
import type { GoldenReport } from './report.ts';

interface Args {
  harnessDir: string;
  fixtureDir: string;
  outDir: string;
  out: string;
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
  return {
    harnessDir: resolve(get('harness')),
    fixtureDir: resolve(get('fixture')),
    outDir: resolve(get('outdir')),
    out: resolve(get('out')),
    timeoutMs: Number.parseInt(get('timeout', '600000'), 10),
  };
}

const args = parseArgs(process.argv.slice(1));
const logs: string[] = [];
let finished = false;
/**
 * Set when Chromium's GPU process dies, which takes every WebGL context with it.
 *
 * The harness notices that for itself and says so, and its answer is the one that
 * counts. This flag is for the failures the harness cannot report — the watchdog
 * firing, the renderer going — where the honest classification of a run that lost its
 * GPU is *no reading*, not *phase 8 is broken*. Never true on a healthy run.
 */
let gpuGone = false;

function note(message: string): void {
  logs.push(message);
  console.log(`[golden] ${message}`);
}

async function finish(report: GoldenReport, code: number): Promise<void> {
  if (finished) return;
  finished = true;
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(
    args.out,
    JSON.stringify({ ...report, logs: [...report.logs, ...logs] }, null, 2),
  );
  app.exit(code);
}

function failureReport(error: string): GoldenReport {
  return {
    ok: false,
    error,
    contextLost: gpuGone,
    environment: { glRenderer: '', electron: '', chrome: '', hardwareEncode: '' },
    fixture: { width: 0, height: 0, frameCount: 0, durationSec: 0, longestHoldSec: 0 },
    outputSize: [0, 0],
    fps: 0,
    samples: [],
    identityMaxDelta: -1,
    controls: [],
    liveFramesAtEnd: -1,
    exported: null,
    cancelLeftBehind: null,
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
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '2048');
// Same reasons as the phase-6 gate: this run composites 4K-class frames and must not
// have the GPU process taken away from it, or be descheduled mid-encode, on a shared
// host. Nothing here is timed — but a lost context makes every pixel comparison a
// fiction, which is worse than a slow one.
app.commandLine.appendSwitch('disable-gpu-watchdog');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

/** The store, pointed at the temp tree. The real class, doing the real writes. */
const store = new ProjectStore({
  recordingsRoot: join(args.outDir, 'recordings'),
  settingsPath: join(args.outDir, 'settings.json'),
  appVersion: '0.0.0-golden',
  trash: () => Promise.resolve(),
});

const JOB = 'golden';
let exportPath = '';
let window: BrowserWindow | null = null;
/** Set once the fixture bundle exists; the `loom://fixture` host serves out of it. */
let fixtureDir = args.fixtureDir;

/** Carry a verification decode request to the renderer and bring back its answer. */
function decodeInRenderer(request: unknown): Promise<{ ok: boolean; error?: string }> {
  const target = window;
  if (target === null || target.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'the gate window is gone' });
  }
  return new Promise((done) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener('golden:verified', listener);
      done({ ok: false, error: 'the renderer did not answer the decode check' });
    }, 60_000);
    const listener = (_event: unknown, outcome: { ok: boolean; error?: string }): void => {
      clearTimeout(timer);
      ipcMain.removeListener('golden:verified', listener);
      done(outcome);
    };
    ipcMain.once('golden:verified', listener);
    target.webContents.send('golden:verify', request);
  });
}

void app.whenReady().then(async () => {
  await mkdir(args.outDir, { recursive: true });
  await store.loadSettings();

  protocol.handle(LOOM_SCHEME, async (request) => {
    const url = new URL(request.url);
    const root =
      url.hostname === 'gate'
        ? args.harnessDir
        : url.hostname === 'fixture'
          ? fixtureDir
          : url.hostname === 'out'
            ? args.outDir
            : null;
    if (root === null) return new Response('not found', { status: 404 });
    const path = confine(root, url.pathname);
    if (path === null) return new Response('forbidden', { status: 403 });
    try {
      return await serveFile(path, request.headers.get('Range'));
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  ipcMain.handle('golden:options', () => ({ outDir: args.outDir }));

  /**
   * Write the fixture as a **real capture part**, through the real writer.
   *
   * Not as the elementary stream phase 6's gate uses. An export reads a `.loomrec`,
   * and the very first thing it does is read the codec description out of the part's
   * own initialisation segment — which `source-reader.ts` calls *"the one thing an
   * adapter has to decide"*. A fixture with no `moov` would route the gate around
   * that decision instead of exercising it, and would leave the `avcC` coming from
   * the harness's memory rather than off the disk.
   *
   * So the frames go through `ProjectStore.beginMediaPart` → `appendMediaChunk` →
   * `finalizeMediaPart`: the capture spine's own path, producing the fragmented MP4
   * and the `loom.index/1` sidecar the exporter will actually be handed.
   */
  ipcMain.handle(
    'golden:writeFixture',
    async (
      _event,
      request: {
        width: number;
        height: number;
        fps: number;
        avcC: Uint8Array;
        bytes: Uint8Array;
        frames: { offset: number; byteLength: number; timestampUs: number; isKey: boolean }[];
        endTimestampUs: number;
      },
    ) => {
      const created = await store.create('Golden fixture');
      await store.openProject(created.id);
      const opened = await store.beginMediaPart(created.id, {
        track: 'screen',
        part: 0,
        width: request.width,
        height: request.height,
        avcC: new Uint8Array(request.avcC),
        nominalFps: request.fps,
        colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
      });
      const source = new Uint8Array(request.bytes);
      for (const frame of request.frames) {
        await store.appendMediaChunk(created.id, 'screen', {
          data: source.subarray(frame.offset, frame.offset + frame.byteLength),
          isKey: frame.isKey,
          timestampUs: frame.timestampUs,
          durationUs: null,
        });
      }
      const part = await store.finalizeMediaPart(created.id, 'screen', request.endTimestampUs);
      await store.close(created.id);
      fixtureDir = created.paths.dir;
      note(
        `wrote a real capture part: ${String(part.frameCount)} frames, ` +
          `${part.durationSec.toFixed(3)}s, ${String(part.byteLength)} bytes in ${fixtureDir}`,
      );
      return {
        mediaUrl: `${LOOM_SCHEME}://fixture/${opened.file}`,
        indexUrl: `${LOOM_SCHEME}://fixture/${opened.index}`,
        durationSec: part.durationSec,
        frameCount: part.frameCount,
      };
    },
  );

  ipcMain.handle(
    'golden:beginExport',
    async (
      _event,
      request: { name: string; width: number; height: number; timescale: number; avcC: Uint8Array },
    ) => {
      exportPath = join(args.outDir, `${request.name}.mp4`);
      await store.beginExport(JOB, {
        outputPath: exportPath,
        video: {
          width: request.width,
          height: request.height,
          timescale: request.timescale,
          avcC: new Uint8Array(request.avcC),
          colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
        },
      });
      note(`export writer open at ${exportPath}`);
    },
  );

  ipcMain.handle(
    'golden:appendExport',
    async (
      _event,
      sample: { data: Uint8Array; durationUnits: number; isKey: boolean; timestampUs: number },
    ) => {
      await store.appendExportSample(JOB, 'video', {
        data: new Uint8Array(sample.data),
        durationUnits: sample.durationUnits,
        isKey: sample.isKey,
        timestampUs: sample.timestampUs,
      });
    },
  );

  ipcMain.handle('golden:finalizeExport', async (_event, expectedDurationSec: number) => {
    const finishedExport = await store.finalizeExport(JOB);
    const outcome = await verifyExport(finishedExport.path, finishedExport.durationSec, {
      size: (path) => store.fileSize(path),
      readHead: (path, byteLength) => store.readFileHead(path, byteLength),
      readRanges: (path, ranges) => store.readFileRanges(path, ranges),
      hash: (path) => store.hashFile(path),
      decode: (request) => decodeInRenderer(request),
    });
    note(
      `finalized ${finishedExport.byteLength} bytes, ${finishedExport.durationSec.toFixed(3)}s ` +
        `(expected ${expectedDurationSec.toFixed(3)}s); verification ` +
        (outcome.failure ?? 'passed'),
    );
    return {
      path: finishedExport.path,
      url: `${LOOM_SCHEME}://out/Golden.mp4`,
      bytes: finishedExport.byteLength,
      durationSec: finishedExport.durationSec,
      videoSampleCount: finishedExport.videoSampleCount,
      audioSampleCount: finishedExport.audioSampleCount,
      verified: outcome.verified,
      verificationFailure: outcome.failure,
    };
  });

  /**
   * Write a few samples into a second export and cancel it.
   *
   * §7.5's obligation 1 read the other way round: a cancelled export must leave
   * nothing a later pass could mistake for a finished one. What comes back is the
   * directory listing, so the assertion is about what is on disk rather than about
   * what the writer claims it did.
   */
  ipcMain.handle('golden:cancelProbe', async () => {
    const dir = join(args.outDir, 'cancel-probe');
    await mkdir(dir, { recursive: true });
    await store.beginExport('cancelled', {
      outputPath: join(dir, 'Cancelled.mp4'),
      video: {
        width: 640,
        height: 360,
        timescale: 30_000,
        avcC: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68]),
      },
    });
    for (let i = 0; i < 4; i++) {
      await store.appendExportSample('cancelled', 'video', {
        data: new Uint8Array(1024).fill(i + 1),
        durationUnits: 1000,
        isKey: i === 0,
        timestampUs: i * 33_333,
      });
    }
    await store.cancelExport('cancelled');
    return readdir(dir);
  });

  ipcMain.handle('golden:finish', async (_event, report: GoldenReport) => {
    note(
      report.ok ? 'harness reported success' : `harness reported failure: ${report.error ?? ''}`,
    );
    await store.cancelExport(JOB).catch(() => undefined);
    await finish(report, report.ok ? 0 : 1);
  });

  ipcMain.on('golden:log', (_event, message: string) => {
    note(message);
  });

  window = new BrowserWindow({
    width: 900,
    height: 600,
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
    void finish(failureReport(`the gate did not finish within ${String(args.timeoutMs)}ms`), 1);
  }, args.timeoutMs).unref?.();

  await window.loadURL(`${LOOM_SCHEME}://gate/harness.html`);
});

app.on('window-all-closed', () => {
  void finish(failureReport('the gate window closed before the harness reported'), 1);
});

app.on('child-process-gone', (_event, details) => {
  note(`${details.type} process gone: ${details.reason} (exit ${String(details.exitCode)})`);
  // Chromium exits the GPU process on a context loss, so this is the loss itself
  // arriving by another route — and unlike `webglcontextlost`, it names what died.
  if (details.type === 'GPU') gpuGone = true;
});

process.on('uncaughtException', (error: Error) => {
  void finish(failureReport(`uncaught in main: ${error.message}`), 1);
});
