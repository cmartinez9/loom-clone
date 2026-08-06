/**
 * Electron main for the phase-12 gate.
 *
 * It opens the **real** drawing overlay: the shipping `WindowRegistry` role
 * (transparent, frameless, non-activating, content-protected), the shipping preload,
 * the shipping `loom://app/overlay.html`, the shipping `OverlayController`, and a
 * real `ProjectStore` writing into a scratch bundle. Nothing about the window or the
 * pen is reimplemented here, because a gate that builds its own overlay measures its
 * own overlay.
 *
 * What it fakes is only the recording: a `RecordingClock` whose answer is a number
 * this file sets, in place of a live capture. That is the one thing a gate cannot
 * have and does not need — where a stroke lands on the recording clock is arithmetic,
 * and `apps/main/test/overlay.test.ts` drives that clock through every case.
 *
 * ## Live ink, and its control
 *
 * Real `sendInputEvent` mouse gestures into the real page, then the canvas read back
 * through `getImageData`. The control is the same gestures with the pen *up*: the
 * page must ink nothing, which is what makes "there were pixels" a reading rather
 * than a formality. What this cannot exercise is `setIgnoreMouseEvents` —
 * `sendInputEvent` injects below the window server, which is precisely why it is
 * reliable here — so the click-through policy is asserted where it is decided, in
 * `apps/main/test/overlay.test.ts`, against the calls main actually makes.
 *
 * ## What is deliberately not here
 *
 * **Absent from the capture** is measured in `apps/main/src/verify/permissions-harness.ts`,
 * as `overlay-content-protection`, with phase 2's shared instrument and phase 2's own
 * thresholds. Capturing the screen needs the Screen Recording grant; that harness is
 * where this codebase keeps a measurement which cannot be taken without one, and its
 * contract is that a check that cannot run reports `blocked` and says why. Nothing in
 * `npm test` may depend on a grant, and nothing here may skip because one is missing.
 */

import { app, type BrowserWindow, screen } from 'electron';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BUNDLE, type RecordingId } from '@loom/format';
import { OverlayController } from '../../apps/main/src/overlay.ts';
import { ProjectStore } from '../../apps/main/src/project-store.ts';
import { installLoomProtocol, registerLoomScheme } from '../../apps/main/src/protocol.ts';
import { WindowRegistry } from '../../apps/main/src/windows.ts';
import type { InkProbe, OverlayReport } from './report.ts';

interface Args {
  rendererRoot: string;
  preloadPath: string;
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
    rendererRoot: resolve(get('renderer')),
    preloadPath: resolve(get('preload')),
    out: resolve(get('out')),
    timeoutMs: Number.parseInt(get('timeout', '120000'), 10),
  };
}

const args = parseArgs(process.argv.slice(1));
const logs: string[] = [];
const probes: InkProbe[] = [];
let finished = false;

/**
 * The gate's window rect.
 *
 * Small, and on a fixed corner of the display: {@link DRAG}'s coordinates are CSS
 * pixels inside it, so the assertion about *where* the ink landed is an assertion
 * about this rectangle.
 */
const OVERLAY_RECT = { x: 120, y: 140, width: 520, height: 320 } as const;

/** The gesture: a horizontal drag across the middle of the window, in CSS pixels. */
const DRAG = { fromX: 80, toX: 440, y: 160, steps: 24 } as const;

function note(message: string): void {
  logs.push(message);
  console.log(`[phase12] ${message}`);
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => {
    setTimeout(r, ms);
  });
}

let report: OverlayReport = {
  ok: false,
  error: '',
  environment: { electron: '', chrome: '', scaleFactor: 1 },
  windowSize: [OVERLAY_RECT.width, OVERLAY_RECT.height],
  probes,
  drawingLog: '',
  drawingSummary: null,
  overlayClosedByFinish: false,
  logs,
};

async function finish(ok: boolean, error: string): Promise<void> {
  if (finished) return;
  finished = true;
  report = { ...report, ok, error, probes, logs };
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2));
  app.exit(ok ? 0 : 1);
}

/**
 * Read the overlay's own canvas.
 *
 * `getImageData` over the backing store, plus the inked bounding box converted back
 * to CSS pixels — so the gate can say *where* the ink landed rather than only that
 * some arrived. A stroke drawn in the wrong place is a defect a pixel count cannot
 * see.
 */
const INK_PROBE = `(() => {
  const probe = window.__loomOverlayProbe;
  const canvas = probe.canvas();
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const dpr = canvas.width / window.innerWidth;
  let inked = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] === 0) continue;
      inked++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return {
    armed: probe.armed(),
    strokeCount: probe.strokeCount(),
    inkedPixels: inked,
    canvasPixels: canvas.width * canvas.height,
    bounds: inked === 0 ? null : { x0: x0 / dpr, y0: y0 / dpr, x1: x1 / dpr, y1: y1 / dpr },
  };
})()`;

async function probeInk(window: BrowserWindow, label: string): Promise<InkProbe> {
  const measured = (await window.webContents.executeJavaScript(INK_PROBE)) as Omit<
    InkProbe,
    'label'
  >;
  const reading: InkProbe = { label, ...measured };
  probes.push(reading);
  note(
    `${label}: armed=${String(reading.armed)} strokes=${String(reading.strokeCount)} ` +
      `inked=${String(reading.inkedPixels)}/${String(reading.canvasPixels)}` +
      (reading.bounds === null
        ? ''
        : ` box=[${reading.bounds.x0.toFixed(0)},${reading.bounds.y0.toFixed(0)} → ` +
          `${reading.bounds.x1.toFixed(0)},${reading.bounds.y1.toFixed(0)}]`),
  );
  return reading;
}

/** One drag, as the sequence of real mouse events a hand produces. */
async function drag(window: BrowserWindow): Promise<void> {
  const contents = window.webContents;
  contents.sendInputEvent({
    type: 'mouseDown',
    x: DRAG.fromX,
    y: DRAG.y,
    button: 'left',
    clickCount: 1,
  });
  for (let step = 1; step <= DRAG.steps; step++) {
    const x = DRAG.fromX + ((DRAG.toX - DRAG.fromX) * step) / DRAG.steps;
    contents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: DRAG.y, button: 'left' });
    // A move per frame: the page's own minimum-spacing filter is what turns these
    // into points, and firing them all in one turn would let it coalesce them.
    await wait(16);
  }
  contents.sendInputEvent({
    type: 'mouseUp',
    x: DRAG.toX,
    y: DRAG.y,
    button: 'left',
    clickCount: 1,
  });
  await wait(120);
}

registerLoomScheme();

void app.whenReady().then(async () => {
  try {
    const scratch = await mkdtemp(join(tmpdir(), 'loom-p12-'));
    const store = new ProjectStore({
      recordingsRoot: join(scratch, 'recordings'),
      settingsPath: join(scratch, 'settings.json'),
      appVersion: '0.0.0-phase12-gate',
      trash: () => Promise.resolve(),
    });
    installLoomProtocol({ store, rendererRoot: args.rendererRoot });

    const display = screen.getPrimaryDisplay();
    report.environment = {
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      scaleFactor: display.scaleFactor,
    };

    setTimeout(() => {
      void finish(false, `the gate did not finish within ${String(args.timeoutMs)}ms`);
    }, args.timeoutMs).unref?.();

    const windows = new WindowRegistry({ preloadPath: args.preloadPath });

    // A driven clock in place of a live capture. Everything downstream of it — the
    // subtraction, the clamp, the refusal when there is no recording — is
    // `apps/main/test/overlay.test.ts`'s.
    let nowSec = 30;
    let recordingId: RecordingId | null = null;
    const overlay = new OverlayController({
      store,
      windows,
      recorder: { sourceTimeNowSec: () => (recordingId === null ? null : nowSec) },
    });
    overlay.install();

    const created = await store.create('phase 12 gate');
    await store.openProject(created.id);
    recordingId = created.id;
    overlay.begin(created.id);

    // The shipping open path: bounds, always-on-top level, click-through,
    // `showInactive`. Resized afterwards so the gestures below land in a window
    // whose CSS pixels {@link DRAG} knows the size of.
    overlay.setOpen(true);
    const window = windows.get('drawing-overlay');
    if (window === undefined) throw new Error('the overlay window was never created');
    window.setBounds({ ...OVERLAY_RECT });

    window.webContents.on('console-message', (_event, _level, message) => {
      note(`renderer: ${message}`);
    });
    window.webContents.on('preload-error', (_event, path, error) => {
      void finish(false, `preload ${path} failed: ${error.message}`);
    });

    await new Promise<void>((resolveLoad, rejectLoad) => {
      if (!window.webContents.isLoadingMainFrame()) {
        resolveLoad();
        return;
      }
      window.webContents.once('did-finish-load', () => {
        resolveLoad();
      });
      window.webContents.once('did-fail-load', (_event, code, description) => {
        rejectLoad(new Error(`overlay.html failed to load: ${description} (${String(code)})`));
      });
    });
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await window.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
    );

    // ---- 1. the control: the same gestures with the pen up -------------------
    // First, so it cannot be mistaken for a reading taken after the canvas was
    // cleared: nothing has ever been drawn at this point.
    await drag(window);
    await probeInk(window, 'pen up');

    // ---- 2. live ink ----------------------------------------------------------
    await window.webContents.executeJavaScript('window.__loomOverlayProbe.selectPen("pen"), true');
    nowSec = 30;
    await drag(window);
    const inked = await probeInk(window, 'pen down');
    if (inked.inkedPixels > 0) note('the pen drew, live, on the overlay’s own canvas');

    // ---- 3. the recording ends, which closes the overlay -----------------------
    // `finish()` drains the write chain and then dismisses the window through the
    // same `setOpen(false)` the palette's Done button and the HUD's Draw toggle use.
    // Read back afterwards, because the log is what a real pen wrote through real
    // IPC and the summary is what `recording.json` would carry.
    report.drawingSummary = await overlay.finish();
    report.overlayClosedByFinish = windows.get('drawing-overlay') === undefined;
    if (!report.overlayClosedByFinish) {
      note('the overlay outlived the recording — it should have been dismissed by finish()');
    }
    const bundle = (await store.list()).find((s) => s.id === created.id);
    if (bundle !== undefined) {
      report.drawingLog = await readFile(join(bundle.path, BUNDLE.drawingLog), 'utf8').catch(
        () => '',
      );
    }
    await store.close(created.id);
    recordingId = null;

    await finish(true, '');
  } catch (error) {
    await finish(false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
});

app.on('window-all-closed', () => {
  // The gate decides when it is over, not the window count.
});
