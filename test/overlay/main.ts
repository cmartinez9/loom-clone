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
 * ## Two passes, and a control for each
 *
 * **Live ink.** Real `sendInputEvent` mouse gestures into the real page, then the
 * canvas read back through `getImageData`. The control is the same gestures with the
 * pen *up*: the page must ink nothing, which is what makes "there were pixels" a
 * reading rather than a formality. What this cannot exercise is
 * `setIgnoreMouseEvents` — `sendInputEvent` injects below the window server, which
 * is precisely why it is reliable here — so the click-through policy is asserted
 * where it is decided, in `apps/main/test/overlay.test.ts`, against the calls main
 * actually makes.
 *
 * **Absent from the capture.** Phase 2's instrument, unchanged and shared:
 * `apps/main/src/verify/marker.ts` paints a window an unmistakable magenta, captures
 * the display through the same `desktopCapturer` path a recording uses, and counts.
 * The control is a second window — same page, same options, same paint, with
 * `setContentProtection` *not* called — and it has to show the marker first. Without
 * it, an absence in the protected window's rectangle would prove nothing: a black
 * capture, wrong coordinates and a window that never painted all produce the same
 * zero.
 */

import { app, BrowserWindow, screen, systemPreferences, type NativeImage } from 'electron';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BUNDLE, type RecordingId } from '@loom/format';
import { OverlayController } from '../../apps/main/src/overlay.ts';
import { ProjectStore } from '../../apps/main/src/project-store.ts';
import { installLoomProtocol, registerLoomScheme } from '../../apps/main/src/protocol.ts';
import {
  captureDisplay,
  isMarker,
  markerFraction,
  paintMarker,
} from '../../apps/main/src/verify/marker.ts';
import { WINDOW_ROLES, WindowRegistry } from '../../apps/main/src/windows.ts';
import type { InkProbe, MarkerReading, OverlayReport } from './report.ts';

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

/** The gate's window rect: small enough that the control fits beside it on any display. */
const OVERLAY_RECT = { x: 120, y: 140, width: 520, height: 320 } as const;
const CONTROL_RECT = { x: 120, y: 500, width: 520, height: 320 } as const;

/**
 * A patch of bare desktop, the same size, well clear of both windows.
 *
 * `null` on a display too narrow to hold one — the reading is context, not the gate,
 * and inventing a rectangle that overlapped a window would make it worse than absent.
 */
function desktopRect(
  display: Electron.Display,
): { x: number; y: number; width: number; height: number } | null {
  const x = display.bounds.width - OVERLAY_RECT.width - 60;
  if (x < CONTROL_RECT.x + CONTROL_RECT.width + 40) return null;
  return { x, y: OVERLAY_RECT.y, width: OVERLAY_RECT.width, height: OVERLAY_RECT.height };
}

/** The gesture: a horizontal drag across the middle of the window, in CSS pixels. */
const DRAG = { fromX: 80, toX: 440, y: 160, steps: 24 } as const;

const EMPTY_MARKER: MarkerReading = { fraction: 0, mean: [0, 0, 0], sampled: 0 };

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
  contentProtection: {
    captureUnavailable: true,
    screenAccess: 'unknown',
    control: EMPTY_MARKER,
    protectedOverlay: EMPTY_MARKER,
    desktop: EMPTY_MARKER,
    protectedWithOverlayGone: EMPTY_MARKER,
    backdropThroughOverlay: EMPTY_MARKER,
    frameMarkerPixels: 0,
    frameMarkerBox: null,
    controlBounds: { ...CONTROL_RECT },
    protectedBounds: { ...OVERLAY_RECT },
    desktopBounds: null,
    captureSize: [0, 0],
  },
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

/**
 * Paint a window a flat colour, without changing which window it is.
 *
 * The same `insertCSS` trick `paintMarker` uses, with the colour open: the occlusion
 * pass needs the overlay painted something that is emphatically **not** the marker,
 * so that a leak of it would *remove* marker pixels rather than add them.
 */
async function paintFlat(window: BrowserWindow, hex: string): Promise<void> {
  await window.webContents.insertCSS(
    `html, body { background: ${hex} !important; } body * { visibility: hidden !important; }`,
  );
}

/**
 * A colour `isMarker` does not match, and nothing in the Pressroom palette is
 * either. If the overlay leaks, this is what covers the backdrop.
 */
const NOT_MARKER = '#00FF66';

/**
 * Marker pixels anywhere in the whole capture, and the box they occupy.
 *
 * Every other reading in this gate is taken inside a rectangle this file computed,
 * and a rectangle computed wrong reports an absence that is really a miss. This
 * removes the coordinates from the claim entirely: if the overlay reached the
 * capture at *any* position, the count here exceeds what the control alone can
 * account for.
 *
 * `isMarker` is not reimplemented — the shared instrument's own predicate is applied
 * to every pixel, so the frame and the rectangles agree on what a marker is.
 */
function scanFrameForMarker(image: NativeImage): {
  count: number;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
} {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const at = (y * size.width + x) * 4;
      if (!isMarker(bitmap[at + 2] ?? 0, bitmap[at + 1] ?? 0, bitmap[at] ?? 0)) continue;
      count += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { count, box: count === 0 ? null : { x0, y0, x1, y1 } };
}

/**
 * The control window for the content-protection reading.
 *
 * Built from the shipping role's **own** constructor options, with the single
 * difference being that `setContentProtection` is never called. Copying the options
 * rather than writing plausible ones is what makes this a control: a difference in
 * transparency, in shadow or in activation would be a second explanation for a
 * difference in the pixels.
 */
function makeControl(): BrowserWindow {
  return new BrowserWindow({
    ...WINDOW_ROLES['drawing-overlay'].options,
    x: CONTROL_RECT.x,
    y: CONTROL_RECT.y,
    width: CONTROL_RECT.width,
    height: CONTROL_RECT.height,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
}

/** The occlusion pass's backdrop: unprotected, and exactly under the overlay. */
function makeBackdrop(): BrowserWindow {
  return new BrowserWindow({
    ...WINDOW_ROLES['drawing-overlay'].options,
    x: OVERLAY_RECT.x,
    y: OVERLAY_RECT.y,
    width: OVERLAY_RECT.width,
    height: OVERLAY_RECT.height,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
}

registerLoomScheme();

void app.whenReady().then(async () => {
  let control: BrowserWindow | null = null;
  let backdrop: BrowserWindow | null = null;
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
    // `showInactive`. Resized afterwards so the control fits beside it — the flag
    // under test is set on the role by the registry and is not a function of size.
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

    // ---- 3. absent from the raw capture ---------------------------------------
    // Before `overlay.finish()`, deliberately: the recording ending is one of the
    // three ways out of the overlay, so `finish()` closes the window. Every reading
    // below has to be taken against the **shipping** window — the one
    // `OverlayController.setOpen` created through `WindowRegistry` — and a
    // hand-built stand-in for it would be measuring this file's idea of the overlay
    // rather than the app's.
    report.contentProtection.screenAccess = systemPreferences.getMediaAccessStatus('screen');

    control = makeControl();
    await control.loadURL('loom://app/overlay.html');
    // **Every** call `OverlayController.setOpen` makes, except the one under test.
    // A control that differed in its window level, its collection behaviour or its
    // mouse policy would be a second explanation for a difference in the pixels —
    // and the whole value of a control is that there is only one.
    control.setBounds({ ...CONTROL_RECT });
    control.setAlwaysOnTop(true, 'screen-saver');
    control.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    control.setIgnoreMouseEvents(true, { forward: true });
    control.showInactive();

    await paintMarker(window);
    await paintMarker(control);
    // The window server needs a moment to composite both before anything is
    // captured; phase 2's harness waits the same 700 ms for the same reason.
    await wait(700);

    const shot = await captureDisplay(display);
    if (shot === null) {
      note('desktopCapturer produced no picture — the gate could not look at all');
    } else {
      const size = shot.getSize();
      const bare = desktopRect(display);
      const frame = scanFrameForMarker(shot);
      report.contentProtection = {
        captureUnavailable: false,
        screenAccess: report.contentProtection.screenAccess,
        control: markerFraction(shot, display, {
          x: display.bounds.x + CONTROL_RECT.x,
          y: display.bounds.y + CONTROL_RECT.y,
          width: CONTROL_RECT.width,
          height: CONTROL_RECT.height,
        }),
        protectedOverlay: markerFraction(shot, display, {
          x: display.bounds.x + OVERLAY_RECT.x,
          y: display.bounds.y + OVERLAY_RECT.y,
          width: OVERLAY_RECT.width,
          height: OVERLAY_RECT.height,
        }),
        desktop:
          bare === null
            ? EMPTY_MARKER
            : markerFraction(shot, display, {
                x: display.bounds.x + bare.x,
                y: display.bounds.y + bare.y,
                width: bare.width,
                height: bare.height,
              }),
        controlBounds: { ...CONTROL_RECT },
        protectedBounds: { ...OVERLAY_RECT },
        protectedWithOverlayGone: EMPTY_MARKER,
        backdropThroughOverlay: EMPTY_MARKER,
        frameMarkerPixels: frame.count,
        frameMarkerBox: frame.box,
        desktopBounds: bare,
        captureSize: [size.width, size.height],
      };
      const protectedRect = {
        x: display.bounds.x + OVERLAY_RECT.x,
        y: display.bounds.y + OVERLAY_RECT.y,
        width: OVERLAY_RECT.width,
        height: OVERLAY_RECT.height,
      };

      // The second capture of the **same** rectangle, with the overlay hidden. A
      // window that is genuinely absent from a capture leaves whatever is behind it,
      // so taking it away must change nothing. This is what separates "the residue
      // is the user's desktop" from "the residue is ours" without any interpretation
      // in between — a leak of one pixel makes this reading lower than the last.
      window.hide();
      await wait(700);
      const withoutOverlay = await captureDisplay(display);
      if (withoutOverlay !== null) {
        report.contentProtection.protectedWithOverlayGone = markerFraction(
          withoutOverlay,
          display,
          protectedRect,
        );
      }

      // The third: a marker-painted **unprotected** window placed exactly under the
      // overlay, with the overlay repainted a colour that is not the marker. An
      // absence is only ever as strong as the thing that would have been there, and
      // an empty desktop is a weak thing. This puts a full rectangle of marker
      // behind the overlay and requires the capture to come back holding all of it.
      backdrop = makeBackdrop();
      await backdrop.loadURL('loom://app/overlay.html');
      backdrop.showInactive();
      await paintFlat(backdrop, '#FF00FF');
      await paintFlat(window, NOT_MARKER);
      window.showInactive();
      // Raised again after the backdrop, so the overlay is unambiguously on top of
      // it: a leak has something to cover.
      window.setAlwaysOnTop(true, 'screen-saver');
      await wait(700);
      const throughOverlay = await captureDisplay(display);
      if (throughOverlay !== null) {
        report.contentProtection.backdropThroughOverlay = markerFraction(
          throughOverlay,
          display,
          protectedRect,
        );
      }

      note(
        `capture ${String(size.width)}x${String(size.height)}: control ` +
          `${(report.contentProtection.control.fraction * 100).toFixed(1)}% marker ` +
          `(mean rgb ${report.contentProtection.control.mean.join(', ')}), protected overlay ` +
          `${(report.contentProtection.protectedOverlay.fraction * 100).toFixed(1)}% ` +
          `(mean rgb ${report.contentProtection.protectedOverlay.mean.join(', ')}), the same ` +
          `rectangle with the overlay gone ` +
          `${(report.contentProtection.protectedWithOverlayGone.fraction * 100).toFixed(1)}% ` +
          `(mean rgb ${report.contentProtection.protectedWithOverlayGone.mean.join(', ')}), ` +
          `bare desktop ${(report.contentProtection.desktop.fraction * 100).toFixed(1)}%, ` +
          `marker backdrop through the overlay ` +
          `${(report.contentProtection.backdropThroughOverlay.fraction * 100).toFixed(1)}%`,
      );
    }

    // ---- 4. the recording ends, which closes the overlay -----------------------
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
  } finally {
    if (control !== null && !control.isDestroyed()) control.destroy();
    if (backdrop !== null && !backdrop.isDestroyed()) backdrop.destroy();
  }
});

app.on('window-all-closed', () => {
  // The gate decides when it is over, not the window count.
});
