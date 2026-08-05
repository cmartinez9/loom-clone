/**
 * Electron main for the phase-11 golden gate.
 *
 * Its whole job is to give the harness the runtime the app itself has: a `loom://`
 * origin, a sandboxed context-isolated renderer with no filesystem, and the app's
 * own privilege table. `registerLoomScheme()` is imported from `apps/main` rather
 * than reimplemented, for the reason the phase-6 gate gives — reimplementing it is
 * how a gate ends up testing the harness.
 *
 * This gate does not touch `test/gate/`. That harness belongs to phase 6's frame
 * budget and is explicitly off limits; the two measure different things and share
 * nothing but a shape.
 */

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { LOOM_SCHEME } from '@loom/ipc';
import { registerLoomScheme } from '../../apps/main/src/protocol.ts';
import { serveFile } from '../../apps/main/src/media-reader.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { OUTPUT_SIZE, SOURCE_SIZE } from './fixture.ts';
import type { GoldenReport } from './report.ts';

interface Args {
  harnessDir: string;
  out: string;
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
    out: resolve(get('out')),
    timeoutMs: Number.parseInt(get('timeout', '180000'), 10),
  };
}

const args = parseArgs(process.argv.slice(1));
const logs: string[] = [];
let finished = false;

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
    contextLost: false,
    environment: {
      glRenderer: 'unknown',
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
    },
    outputSize: [OUTPUT_SIZE[0], OUTPUT_SIZE[1]],
    sourceSize: [SOURCE_SIZE[0], SOURCE_SIZE[1]],
    timestamps: [],
    controls: [],
    privacyFallbacks: 0,
    textTruncations: 0,
    atlasGlyphs: 0,
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
// The same four switches `test/gate/main.ts` runs with, and for the same reason one
// layer along: this gate does not judge time, but a renderer the OS has
// deprioritised or a GPU process the watchdog has killed produces a *lost context*,
// and a lost context reads as data — every GL call becomes a no-op and `readPixels`
// leaves the caller's buffer untouched. Two frames read out of the same untouched
// buffer compare equal, which is a golden test passing on nothing at all.
// `Compositor.readPixels` throws on a lost context and the report carries
// `contextLost`, but not spending the run in the first place is better than both.
app.commandLine.appendSwitch('disable-gpu-watchdog');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

void app.whenReady().then(async () => {
  protocol.handle(LOOM_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'golden') return new Response('not found', { status: 404 });
    const path = confine(args.harnessDir, url.pathname);
    if (path === null) return new Response('forbidden', { status: 403 });
    try {
      return await serveFile(path, request.headers.get('Range'));
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  ipcMain.handle('golden:finish', async (_event, report: GoldenReport) => {
    note(
      report.ok ? 'harness reported success' : `harness reported failure: ${report.error ?? ''}`,
    );
    await finish(
      {
        ...report,
        environment: { ...report.environment, electron: process.versions.electron ?? '' },
      },
      report.ok ? 0 : 1,
    );
  });

  ipcMain.on('golden:log', (_event, message: string) => {
    note(message);
  });

  const window = new BrowserWindow({
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

  await window.loadURL(`${LOOM_SCHEME}://golden/harness.html`);
});

app.on('window-all-closed', () => {
  void finish(failureReport('the gate window closed before the harness reported'), 1);
});

app.on('child-process-gone', (_event, details) => {
  note(`${details.type} process gone: ${details.reason} (exit ${String(details.exitCode)})`);
});

process.on('uncaughtException', (error: Error) => {
  void finish(failureReport(`uncaught in main: ${error.message}`), 1);
});
