/**
 * The phase 12 gate. Architecture report §8: *"Strokes appear live, are **absent**
 * from the raw capture, and are deletable in the editor."*
 *
 * Two of those three are claims about pixels and are made here, in a real Electron
 * renderer in front of a real window server. The third is arithmetic over an
 * `EditDocument` and is made in `packages/edl/test/drawing.test.ts`, through the
 * ordinary §2.7 op vocabulary — what this file adds to it is the *other* end of the
 * same pipe: the log the importer reads is the log a real pen wrote through real
 * IPC into a real bundle, not a fixture that agrees with itself.
 *
 * ## The middle sentence is the one that matters, and how it is proved
 *
 * The overlay is `setContentProtection(true)` — `NSWindowSharingNone` — because the
 * strokes are re-composited at edit time from `events/drawing.ndjson` and must not
 * *also* be burned into the captured pixels. An assertion that the flag was **set**
 * is a different and much weaker claim, and it is the assertion that would still
 * pass on the day macOS stopped honouring it.
 *
 * So this measures the same way phase 2 measured the HUD's, with the same
 * instrument (`apps/main/src/verify/marker.ts`, shared rather than reimplemented)
 * and the same discipline:
 *
 * > The control is the whole design. "The marker is not in the protected window's
 * > rectangle" passes just as well when the capture is black, when the rectangle is
 * > computed wrong, or when the window never painted.
 *
 * A second window — the shipping role's own constructor options, the same page, the
 * same paint, `setContentProtection` *not* called — is placed beside it and must
 * show the marker first. Phase 2 measured **99.3% against 0.0%**; this asserts the
 * same shape of result, against the same thresholds, with no allowance added.
 *
 * ## What a machine that cannot look reports
 *
 * `desktopCapturer` needs the Screen Recording grant, and a host without it produces
 * a black rectangle rather than an error. That is *"we could not look"*, and the
 * codebase's rule — `apps/main/src/verify/checks.ts` — is that it must never be
 * reported as *"we looked and it was fine"*. The gate therefore reports
 * `captureUnavailable` and a `screenAccess` read taken **independently** of the
 * measurement, and this file fails with the grant named rather than passing quietly.
 * The threshold is not relaxed on any host.
 */

import { describe, expect, it } from 'vitest';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDrawingLog, parseDrawingLog, readStrokePoints } from '@loom/edl';
import type { InkProbe, OverlayReport } from './overlay/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const GATE_TIMEOUT_MS = 240_000;
const PROBE_TIMEOUT_MS = 120_000;

/**
 * The thresholds, from phase 2's own reading and not softened.
 *
 * The control cleared 99.3% and the protected HUD 0.0%. `CONTROL_MIN` is the same
 * 50% phase 2's harness uses to decide the instrument works at all; `PROTECTED_MAX`
 * is its same 1%, which is a hundredth of the rectangle and is there because a
 * capture is resampled to DIP size and an edge pixel is a blend of two windows.
 */
const CONTROL_MIN = 0.5;
const PROTECTED_MAX = 0.01;

/**
 * How much of a marker window placed **under** the overlay must come back through
 * it, and where the number comes from.
 *
 * Not a tuned threshold. The capture is resampled to the display's DIP size, so the
 * backdrop's own border pixels blend with the desktop outside it: the rectangle is
 * 520x320 = 166,400 px with a perimeter of 1,680, so a full one-pixel border is
 * **1.01%** of it and is lost to resampling no matter what the window under test
 * does. 99% is exactly that bound. Measured on this machine: 99.852%, so the real
 * loss is a seventh of one border pixel and the margin is about 7x.
 */
const BACKDROP_MIN = 0.99;

interface Built {
  rendererRoot: string;
  preloadPath: string;
  mainPath: string;
}

/**
 * Build what the overlay is made of, from source, into a scratch directory.
 *
 * The renderer goes through the project's own vite config, so the page under the pen
 * is the page the app ships — same CSP, same `loom://` asset paths, same self-hosted
 * fonts, same `overlay.html` entry.
 */
async function buildWindow(dir: string): Promise<Built> {
  const rendererRoot = join(dir, 'renderer');
  const preloadPath = join(dir, 'preload.cjs');
  const mainPath = join(dir, 'main.cjs');
  const common = {
    bundle: true,
    platform: 'node' as const,
    format: 'cjs' as const,
    target: 'node20',
    external: ['electron'],
    sourcemap: 'inline' as const,
    logLevel: 'warning' as const,
  };
  await Promise.all([
    esbuild({
      ...common,
      entryPoints: [join(root, 'apps/main/src/preload.ts')],
      outfile: preloadPath,
    }),
    esbuild({ ...common, entryPoints: [join(here, 'overlay/main.ts')], outfile: mainPath }),
    viteBuild({
      configFile: resolve(root, 'apps/renderer/vite.config.ts'),
      logLevel: 'warn',
      build: { outDir: rendererRoot, emptyOutDir: true, sourcemap: false },
    }),
  ]);
  return { rendererRoot, preloadPath, mainPath };
}

async function runGate(): Promise<OverlayReport> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-p12-gate-'));
  try {
    const built = await buildWindow(dir);
    const out = join(dir, 'report.json');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as unknown as string;

    const child = spawn(
      electron,
      [
        built.mainPath,
        '--renderer',
        built.rendererRoot,
        '--preload',
        built.preloadPath,
        '--out',
        out,
        '--timeout',
        String(PROBE_TIMEOUT_MS),
      ],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      },
    );

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exitCode = await new Promise<number | null>((r) => {
      child.once('exit', (code) => {
        r(code);
      });
    });

    try {
      return JSON.parse(await readFile(out, 'utf8')) as OverlayReport;
    } catch {
      throw new Error(
        `the phase 12 gate produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-4000)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One launch, shared by every assertion below. */
let run: Promise<OverlayReport> | null = null;
function gate(): Promise<OverlayReport> {
  run ??= runGate();
  return run;
}

function describeRun(report: OverlayReport): string {
  const cp = report.contentProtection;
  return [
    '',
    `electron ${report.environment.electron}  chrome ${report.environment.chrome}  ` +
      `scale ${String(report.environment.scaleFactor)}`,
    ...(report.error === '' ? [] : [`error    ${report.error}`]),
    ...report.probes.map(
      (p) =>
        `  ${p.label.padEnd(10)} armed=${String(p.armed).padEnd(5)} ` +
        `strokes=${String(p.strokeCount)} inked=${String(p.inkedPixels).padStart(7)}` +
        (p.bounds === null
          ? ''
          : `  box=[${p.bounds.x0.toFixed(0)},${p.bounds.y0.toFixed(0)} → ` +
            `${p.bounds.x1.toFixed(0)},${p.bounds.y1.toFixed(0)}]`),
    ),
    `  capture  ${cp.captureUnavailable ? 'UNAVAILABLE' : cp.captureSize.join('x')}  ` +
      `screen grant ${cp.screenAccess}`,
    `  control  ${(cp.control.fraction * 100).toFixed(1)}% marker, mean rgb ` +
      cp.control.mean.join(', '),
    `  overlay  ${(cp.protectedOverlay.fraction * 100).toFixed(3)}% marker, mean rgb ` +
      cp.protectedOverlay.mean.join(', '),
    `  gone     ${(cp.protectedWithOverlayGone.fraction * 100).toFixed(3)}% marker — the same ` +
      `rectangle, overlay destroyed, mean rgb ${cp.protectedWithOverlayGone.mean.join(', ')}`,
    `  desktop  ${(cp.desktop.fraction * 100).toFixed(3)}% marker (baseline), mean rgb ` +
      cp.desktop.mean.join(', '),
    `  backdrop ${(cp.backdropThroughOverlay.fraction * 100).toFixed(3)}% marker — an ` +
      'unprotected marker window UNDER the overlay, seen through it, mean rgb ' +
      cp.backdropThroughOverlay.mean.join(', '),
    `  frame    ${String(cp.frameMarkerPixels)} marker px in the WHOLE capture` +
      (cp.frameMarkerBox === null
        ? ''
        : `, box=[${String(cp.frameMarkerBox.x0)},${String(cp.frameMarkerBox.y0)} → ` +
          `${String(cp.frameMarkerBox.x1)},${String(cp.frameMarkerBox.y1)}]`),
    `  log      ${String(report.drawingLog.trim().split('\n').filter(Boolean).length)} line(s)`,
    '',
  ].join('\n');
}

function probeAt(report: OverlayReport, label: string): InkProbe {
  const found = report.probes.find((p) => p.label === label);
  if (found === undefined) throw new Error(`the gate never reported "${label}"`);
  return found;
}

describe('phase 12 gate: the live drawing overlay', () => {
  it(
    'runs, in a real Electron renderer with the shipping overlay window',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      console.log(detail);
      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);
    },
    GATE_TIMEOUT_MS,
  );

  // ---- 1. strokes appear live ------------------------------------------------

  it(
    'inks the overlay’s own canvas while the pen is down',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const down = probeAt(report, 'pen down');

      expect(down.armed, detail).toBe(true);
      expect(down.strokeCount, `${detail}\nthe page recorded no stroke`).toBe(1);
      expect(down.inkedPixels, `${detail}\nthe pen drew nothing`).toBeGreaterThan(200);
      // Ink everywhere would pass a bare count just as well as ink where the hand
      // went, so the box is checked too.
      expect(down.bounds, detail).not.toBeNull();
      expect(
        down.inkedPixels / down.canvasPixels,
        `${detail}\nthe whole canvas was inked, which is not a stroke`,
      ).toBeLessThan(0.2);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'draws where the hand went, and not somewhere else',
    async () => {
      // The gesture is a horizontal drag from x=80 to x=440 at y=160, in CSS pixels
      // of a 520x320 window. The pen is 0.004 of the window width — about 2 px — and
      // the canvas is antialiased, so the ink is allowed a few pixels either side of
      // that line and nothing more.
      const report = await gate();
      const detail = describeRun(report);
      const bounds = probeAt(report, 'pen down').bounds;
      expect(bounds, detail).not.toBeNull();
      if (bounds === null) return;
      const slack = 8;
      expect(bounds.x0, `${detail}\nink started left of the gesture`).toBeGreaterThan(80 - slack);
      expect(bounds.x1, `${detail}\nink ran past the gesture`).toBeLessThan(440 + slack);
      expect(bounds.y0, `${detail}\nink above the gesture`).toBeGreaterThan(160 - slack);
      expect(bounds.y1, `${detail}\nink below the gesture`).toBeLessThan(160 + slack);
      // And it really did travel: a dot at the start would satisfy every bound above.
      expect(bounds.x1 - bounds.x0, `${detail}\nthe stroke did not travel`).toBeGreaterThan(300);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'CONTROL: the same gestures with the pen up ink nothing',
    async () => {
      // Without this, "there were inked pixels" would pass on a page that inked on
      // every pointer event whether or not the user had picked up a pen — which is
      // the same page that would swallow a click the user meant for the app below.
      const report = await gate();
      const detail = describeRun(report);
      const up = probeAt(report, 'pen up');
      expect(up.armed, detail).toBe(false);
      expect(up.strokeCount, detail).toBe(0);
      expect(up.inkedPixels, `${detail}\nthe overlay drew with no pen selected`).toBe(0);
    },
    GATE_TIMEOUT_MS,
  );

  // ---- 2. absent from the raw capture ----------------------------------------

  it(
    'is absent from a real screen capture, with a control that proves the check can see',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const cp = report.contentProtection;

      // "We could not look" is not "we looked and it was fine". Named, with the
      // grant to give, rather than skipped — the threshold below is not relaxed on
      // any host, and a host that cannot capture cannot run this gate.
      expect(
        cp.captureUnavailable,
        `${detail}\ndesktopCapturer produced no picture (screen grant: ${cp.screenAccess}). ` +
          'This gate needs the Screen Recording permission; grant it to the app running the ' +
          'suite and re-run.',
      ).toBe(false);

      // The control first, always. If the instrument cannot see a window it is
      // *supposed* to see, its opinion about a window it should not see is worthless.
      expect(
        cp.control.fraction,
        `${detail}\nthe control window — same page, same options, content protection OFF — ` +
          'did not show the marker, so an absence in the protected window proves nothing',
      ).toBeGreaterThan(CONTROL_MIN);

      expect(
        cp.protectedOverlay.fraction,
        `${detail}\nthe drawing overlay appeared in the captured pixels: ` +
          `${(cp.protectedOverlay.fraction * 100).toFixed(1)}% of its rectangle. ` +
          'setContentProtection(true) is not keeping the ink out of the recording.',
      ).toBeLessThan(PROTECTED_MAX);

      // And the control's reading is a *signal*, not the ambient magenta of whatever
      // is on this machine's desktop. `isMarker` matches a shape of colour rather
      // than a triple — a capture comes back in the display's own colour space, and
      // phase 2's first run found 0% inside its control by being stricter than that
      // — so a bare patch of desktop is measured as the baseline the other two
      // readings are read against. This tightens the claim; it does not relax it.
      expect(
        cp.control.fraction - cp.desktop.fraction,
        `${detail}\nthe control's marker is indistinguishable from the desktop behind it`,
      ).toBeGreaterThan(CONTROL_MIN);

      // And the claim does not rest on this file's arithmetic about *where* the
      // overlay is. Every reading above is taken inside a rectangle computed here,
      // and a rectangle computed wrong reports an absence that is really a miss —
      // which is exactly the shape of the near-miss this gate had. Scanning the
      // whole frame removes the coordinates from the claim: the only marker in the
      // capture is the control's own rectangle, so the marker-painted overlay is
      // nowhere in it. `1.5x` leaves room for the control's antialiased border and
      // nothing like a second window.
      const controlArea = cp.controlBounds.width * cp.controlBounds.height;
      expect(
        cp.frameMarkerPixels,
        `${detail}\nthere is more marker in the capture than the control can account ` +
          'for, so something else painted with it — the overlay — reached the frame',
      ).toBeLessThan(controlArea * 1.5);
      expect(cp.frameMarkerPixels, detail).toBeGreaterThan(controlArea * 0.5);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'shows the desktop behind it in full, which is what "absent" actually means',
    async () => {
      // An absence is only as strong as the thing that would have been there, and an
      // empty desktop is a weak thing: "under 1% marker" also passes when the
      // capture is dim, the rectangle is slightly wrong, or nothing was on screen.
      //
      // So a marker-painted **unprotected** window is placed exactly under the
      // overlay and the overlay is repainted a colour that is not the marker. Every
      // pixel of the overlay that reached the capture would cover a marker pixel, so
      // this reading falls by exactly the size of any leak — and it does not depend
      // on what happens to be on the user's screen, which is what the first
      // reading's small non-zero residue turned out to be.
      const report = await gate();
      const detail = describeRun(report);
      const cp = report.contentProtection;
      expect(cp.captureUnavailable, detail).toBe(false);
      expect(
        cp.backdropThroughOverlay.fraction,
        `${detail}\nonly ${(cp.backdropThroughOverlay.fraction * 100).toFixed(2)}% of a marker ` +
          'window placed under the overlay came back through it — the missing part is the ' +
          'overlay, in the capture, covering it',
      ).toBeGreaterThan(BACKDROP_MIN);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'reads the same with the overlay hidden, so any residue is the desktop and not ours',
    async () => {
      // The question this answers: the protected rectangle does not always read
      // exactly 0.0%, and on one run of this machine it read 0.1%. Either that is
      // whatever is on the desktop behind an invisible window — in which case
      // hiding the window changes nothing — or some of it is the overlay, in which
      // case hiding the window lowers it. Two readings of one rectangle, 700 ms
      // apart, settle it with no interpretation in between.
      //
      // Judged against `PROTECTED_MAX` rather than against a new number: the same
      // hundredth of a rectangle the primary check allows, now applied to the
      // *difference* the overlay makes rather than to the total.
      const report = await gate();
      const detail = describeRun(report);
      const cp = report.contentProtection;
      expect(cp.captureUnavailable, detail).toBe(false);
      expect(
        Math.abs(cp.protectedOverlay.fraction - cp.protectedWithOverlayGone.fraction),
        `${detail}\nhiding the overlay changed its own rectangle by ` +
          `${((cp.protectedOverlay.fraction - cp.protectedWithOverlayGone.fraction) * 100).toFixed(3)}%` +
          ' — that difference is the overlay reaching the capture',
      ).toBeLessThan(PROTECTED_MAX);
    },
    GATE_TIMEOUT_MS,
  );

  // ---- 3. the log a real pen wrote, and the track it becomes -------------------

  it(
    'writes the stroke through main into events/drawing.ndjson',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const events = parseDrawingLog(report.drawingLog);
      expect(events, `${detail}\nnothing reached the log`).toHaveLength(1);
      const stroke = events[0];
      if (stroke?.e !== 'stroke') throw new Error('the log line was not a stroke');

      // The gesture is a straight horizontal drag, so every point sits on one line
      // across the middle of the window — and the log is normalized 0–1 against the
      // display, which is §2.5's convention for `cursor.ndjson`.
      const pairs = stroke.p.length >> 1;
      expect(pairs, `${detail}\nthe pen wrote a stroke with no points`).toBeGreaterThan(1);
      for (let i = 0; i < pairs; i++) {
        expect(stroke.p[i * 2], detail).toBeGreaterThanOrEqual(0);
        expect(stroke.p[i * 2], detail).toBeLessThanOrEqual(1);
        expect(stroke.p[i * 2 + 1], detail).toBeCloseTo(160 / 320, 1);
      }
      // A stroke is written when the pen comes up, and takes a real interval.
      expect(stroke.t1, detail).toBeGreaterThan(stroke.t);
      expect(report.drawingSummary, detail).toEqual({
        file: 'events/drawing.ndjson',
        strokeCount: 1,
      });
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'is dismissed when the recording ends, which is the fourth constraint’s other half',
    async () => {
      // "Must be dismissible" is not only about the Done button. A full-screen,
      // always-on-top, non-activating window that outlived the recording would keep
      // taking every click on the display with nothing recording — and the harness
      // reads the registry after `finish()` rather than a call log, because the
      // question is whether the window is still there.
      const report = await gate();
      const detail = describeRun(report);
      expect(
        report.overlayClosedByFinish,
        `${detail}\nthe overlay survived the recording it belonged to`,
      ).toBe(true);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'imports that log as a generated annotation track the editor can delete',
    async () => {
      // The other end of `packages/edl/test/drawing.test.ts`: the same importer, over
      // a log a real pen actually produced rather than a fixture written to suit it.
      const report = await gate();
      const detail = describeRun(report);
      const track = importDrawingLog(report.drawingLog, {
        durationSec: 60,
        generatedAt: '2026-08-05T00:00:00.000Z',
      });
      expect(track, `${detail}\nthe real log imported to nothing`).not.toBeNull();
      if (track === null) return;
      expect(track.origin).toBe('generated');
      expect(track.generator?.type).toBe('live-drawing');
      expect(track.spans).toHaveLength(1);
      const points = readStrokePoints(track.spans?.[0]?.style ?? null);
      expect(points, detail).not.toBeNull();
      expect((points?.length ?? 0) / 2, detail).toBeGreaterThan(1);
    },
    GATE_TIMEOUT_MS,
  );
});
