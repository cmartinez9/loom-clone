/**
 * The phase 12 gate. Architecture report §8: *"Strokes appear live, are **absent**
 * from the raw capture, and are deletable in the editor."*
 *
 * The **first** is a claim about pixels and is made here, in a real Electron renderer
 * in front of a real window server. The **third** is arithmetic over an
 * `EditDocument` and is made in `packages/edl/test/drawing.test.ts`, through the
 * ordinary §2.7 op vocabulary — what this file adds to it is the *other* end of the
 * same pipe: the log the importer reads is the log a real pen wrote through real
 * IPC into a real bundle, not a fixture that agrees with itself.
 *
 * ## The middle sentence is the one that matters, and it is measured elsewhere
 *
 * The overlay is `setContentProtection(true)` — `NSWindowSharingNone` — because the
 * strokes are re-composited at edit time from `events/drawing.ndjson` and must not
 * *also* be burned into the captured pixels. An assertion that the flag was **set**
 * is a different and much weaker claim, and it is the assertion that would still
 * pass on the day macOS stopped honouring it. So it is measured in captured pixels,
 * against a control — and that measurement lives in
 * `apps/main/src/verify/permissions-harness.ts` as `overlay-content-protection`,
 * beside phase 2's identical measurement of the recorder HUD.
 *
 * **It is there because of what it needs to look through, not because it is weaker.**
 * `desktopCapturer` needs the Screen Recording grant, and a host without it produces
 * a black rectangle rather than an error. That is *"we could not look"*, and the
 * codebase's rule — `apps/main/src/verify/checks.ts` — is that it must never be
 * reported as *"we looked and it was fine"*. The harness is where a check that cannot
 * run reports `blocked` and says why; `npm test` is where checks that need nothing
 * from macOS live. All five readings and all three thresholds moved across unchanged.
 * Nothing in this file may grow a skip-on-missing-grant branch to bring it back.
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

  // ---- 2. the log a real pen wrote, and the track it becomes -------------------

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
