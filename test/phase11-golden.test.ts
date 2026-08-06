/**
 * **Phase 11's gate: the golden-frame test, extended to annotations.**
 *
 * Architecture report §8, row 11: *"Golden-frame test extended to annotations."*
 * §4.5 is what that test *is*:
 *
 * > `packages/compositor/test/golden.spec.ts` renders a fixture project at 24 fixed
 * > timestamps through both the preview path and the export path at the same output
 * > size and asserts a per-pixel max delta of 0.
 *
 * It lives here rather than under `packages/compositor/test/` because it needs a
 * real WebGL2 context, a real `VideoFrame` and the shipping `PreviewLoop` at once —
 * `test/` is where this repo keeps gates that span more than one package, in a real
 * Electron renderer. `test/golden/harness.ts` is what runs inside; this file builds
 * it, launches it and judges the report.
 *
 * ## What is real here
 *
 * The preview path is `apps/renderer`'s `PreviewLoop`, unmodified. The export path
 * is `resolve` → `Compositor.render` → `Compositor.readPixels` at a fixed timestamp —
 * the loop phase 8 owns, written out in two lines rather than imported, **because
 * phase 8 is being built concurrently and owns that pipeline**. Nothing in this gate
 * or its harness touches it. When it lands, those two lines become a call into it and
 * every assertion below stays exactly where it is.
 *
 * ## Why "max delta 0" is asserted and is not the gate
 *
 * A preview and an export that both draw **no annotation whatsoever** agree
 * perfectly. Equality is necessary and nowhere near sufficient, so this file also
 * requires, at every timestamp, that the annotations changed the picture, that every
 * changed pixel is inside the box the fixture computes for it *with its own
 * arithmetic*, that each of the seven kinds changed pixels in its own box, that the
 * mask's centre is exactly the mask's colour and that the blur destroyed the
 * variance it was placed over.
 *
 * And each of those is backed by a control the harness runs on purpose — a perturbed
 * annotation the comparator must see, a blur with no region that must refuse the
 * frame, an unproducible blur that must be redacted solid, a fixture that must have
 * detail for a blur to destroy. The `verify:mutation` entries
 * `annotation-*` go one level further and break the production source on disk.
 *
 * **Do not add a tolerance to anything below.** §4.5's number is zero, and every
 * other threshold here is a *presence* check (something changed, something is
 * exactly one colour) rather than a measurement of this machine.
 */

import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOXES, REVEAL_POINT_COUNT, TIMESTAMP_COUNT } from './golden/fixture.ts';
import type { GoldenReport } from './golden/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const GOLDEN = join(here, 'golden');

/** Building the harness, encoding nothing, and 24 composites is well under this. */
const TIMEOUT_MS = 180_000;

async function buildHarness(outDir: string): Promise<void> {
  const common = { bundle: true, sourcemap: 'inline' as const, logLevel: 'warning' as const };
  await Promise.all([
    build({
      ...common,
      entryPoints: [join(GOLDEN, 'main.ts')],
      outfile: join(outDir, 'main.cjs'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
    }),
    build({
      ...common,
      entryPoints: [join(GOLDEN, 'preload.ts')],
      outfile: join(outDir, 'preload.cjs'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
    }),
    build({
      ...common,
      entryPoints: [join(GOLDEN, 'harness.ts')],
      outfile: join(outDir, 'harness.js'),
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
    }),
  ]);
  await copyFile(join(GOLDEN, 'harness.html'), join(outDir, 'harness.html'));
  // The Pressroom UI face, served over `loom://` exactly as the app serves it.
  await copyFile(
    join(root, 'packages/design/fonts/mona-sans-normal.woff2'),
    join(outDir, 'mona-sans-normal.woff2'),
  );
}

/**
 * The Electron executable — refusing to *fetch* it here, for the reason the phase-6
 * gate gives: a ~300 MB download inside a test is not what this measures.
 */
function electronBinary(): string {
  const require = createRequire(import.meta.url);
  const moduleDir = dirname(require.resolve('electron'));
  const installed = existsSync(join(moduleDir, 'path.txt')) && existsSync(join(moduleDir, 'dist'));
  if (!installed) {
    throw new Error(
      'the Electron runtime is not on disk. Run `node scripts/install-electron-runtime.mjs` ' +
        '(npm ci runs it) first.',
    );
  }
  return require('electron') as string;
}

async function runGate(): Promise<{
  report: GoldenReport;
  output: string;
  exitCode: number | null;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-golden-'));
  try {
    const harnessDir = join(dir, 'harness');
    const out = join(dir, 'report.json');
    await mkdir(harnessDir, { recursive: true });
    await buildHarness(harnessDir);

    const child = spawn(
      electronBinary(),
      [
        join(harnessDir, 'main.cjs'),
        '--harness',
        harnessDir,
        '--out',
        out,
        '--timeout',
        String(TIMEOUT_MS - 20_000),
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
    const exitCode = await new Promise<number | null>((done) => {
      child.once('exit', (code) => {
        done(code);
      });
    });

    let report: GoldenReport;
    try {
      report = JSON.parse(await readFile(out, 'utf8')) as GoldenReport;
    } catch {
      throw new Error(
        `the golden gate produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-4000)}`,
      );
    }
    return { report, output, exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let cached: Promise<{ report: GoldenReport; output: string; exitCode: number | null }> | null =
  null;
function gate(): Promise<{ report: GoldenReport; output: string; exitCode: number | null }> {
  cached ??= runGate();
  return cached;
}

/**
 * The 24 frames, or a loud failure.
 *
 * Every assertion below is a loop over these, and a loop over an empty array passes.
 * That is exactly how a gate whose harness died early reports green, so the length
 * is checked once, here, on the way in.
 */
function frames(report: GoldenReport): GoldenReport['timestamps'] {
  if (report.timestamps.length !== TIMESTAMP_COUNT) {
    throw new Error(
      `the harness produced ${String(report.timestamps.length)} timestamps, not ` +
        `${String(TIMESTAMP_COUNT)}: ${report.error ?? 'no error reported'}`,
    );
  }
  return report.timestamps;
}

function control(report: GoldenReport, name: string) {
  const found = report.controls.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(
      `the harness did not run the control ${JSON.stringify(name)}; it ran ` +
        `[${report.controls.map((c) => c.name).join(', ')}]`,
    );
  }
  return found;
}

describe('phase 11 gate: preview and export are pixel-identical with annotations', () => {
  it(
    'runs, in a real Electron renderer with a real WebGL2 context',
    async () => {
      const { report, output } = await gate();
      expect(report.error, `gate failed: ${report.error ?? ''}\n${output.slice(-4000)}`).toBeNull();
      expect(report.ok).toBe(true);
      // A lost context makes every GL call a no-op and leaves `readPixels`' buffer
      // untouched, so two frames read from one buffer would compare equal. That is a
      // golden test passing on nothing; it is refused rather than retried.
      expect(report.contextLost).toBe(false);
      console.log(
        `[phase 11] ${report.environment.glRenderer} — ${String(report.timestamps.length)} timestamps, ` +
          `${String(report.atlasGlyphs)} glyphs, ${String(report.privacyFallbacks)} privacy fallback(s)`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'composites §4.5’s 24 fixed timestamps',
    async () => {
      const { report } = await gate();
      expect(report.timestamps).toHaveLength(TIMESTAMP_COUNT);
    },
    TIMEOUT_MS,
  );

  it(
    'agrees to the byte at every one of them',
    async () => {
      const { report } = await gate();
      for (const frame of frames(report)) {
        expect(
          frame.maxDelta,
          `preview and export disagree at t=${frame.t.toFixed(3)}s by ${String(frame.maxDelta)}`,
        ).toBe(0);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'CONTROL: the comparator sees a perturbed annotation, so delta 0 is not vacuous',
    async () => {
      const { report } = await gate();
      const check = control(report, 'comparator-sees-a-perturbed-annotation');
      expect(check.detected, check.detail).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe('the annotations are actually in the picture', () => {
  it(
    'changes pixels at every timestamp',
    async () => {
      const { report } = await gate();
      for (const frame of frames(report)) {
        expect(frame.changedPixels, `nothing drew at t=${frame.t.toFixed(3)}s`).toBeGreaterThan(
          1000,
        );
      }
    },
    TIMEOUT_MS,
  );

  it(
    'changes nothing outside the boxes the fixture computes for itself',
    async () => {
      const { report } = await gate();
      for (const frame of frames(report)) {
        expect(
          frame.outsideExpected,
          `${String(frame.outsideExpected)} changed pixels outside every annotation's box at ` +
            `t=${frame.t.toFixed(3)}s (zoom ${frame.zoomAmount.toFixed(3)})`,
        ).toBe(0);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'draws every kind, in its own box',
    async () => {
      const { report } = await gate();
      const kinds = Object.keys(BOXES).filter(
        // `parked` and `fading` are windowed and `revealing` is authored to draw
        // nothing at t=0; each carries its own check below instead.
        (name) => name !== 'parked' && name !== 'fading' && name !== 'revealing',
      );
      // Judged at the unzoomed timestamps. Zoomed in, some of the fixture's boxes
      // are genuinely off the visible region and drawing nothing there is the
      // *correct* answer — the zoomed frames are covered by `outsideExpected` and by
      // the mask and blur probes, which stay on screen throughout.
      const flat = frames(report).filter((frame) => frame.zoomAmount <= 1.0001);
      expect(flat.length, 'the fixture was zoomed at every timestamp').toBeGreaterThan(12);
      for (const frame of flat) {
        for (const kind of kinds) {
          const probe = frame.probes[kind];
          expect(probe, `no probe for ${kind} at t=${frame.t.toFixed(3)}s`).toBeDefined();
          expect(
            probe?.changed ?? 0,
            `${kind} drew nothing at t=${frame.t.toFixed(3)}s`,
          ).toBeGreaterThan(20);
        }
      }
    },
    TIMEOUT_MS,
  );

  it(
    'follows the zoom, which is what makes a source-anchored redaction correct',
    async () => {
      const { report } = await gate();
      const zoomed = frames(report).filter((frame) => frame.zoomAmount > 1.05);
      expect(zoomed.length, 'the fixture never zoomed').toBeGreaterThan(2);
      // The boxes are computed by `expectedBoxPx` from the resolved zoom, so
      // `outsideExpected === 0` at a zoomed timestamp *is* the statement that the
      // annotation moved with the content. Asserted again here so a fixture that
      // stopped zooming cannot make the check above pass by never exercising it.
      for (const frame of zoomed) {
        expect(frame.outsideExpected).toBe(0);
        expect(frame.changedPixels).toBeGreaterThan(1000);
      }
    },
    TIMEOUT_MS,
  );
});

describe('the two privacy features are checked as effects on pixels', () => {
  it(
    'the mask’s centre is exactly the mask’s colour',
    async () => {
      const { report } = await gate();
      for (const frame of frames(report)) {
        expect(
          frame.maskCentre.slice(0, 3),
          `the mask did not cover its own centre at t=${frame.t.toFixed(3)}s`,
        ).toEqual([0x11, 0x22, 0xdd]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'CONTROL: that pixel is not the mask’s colour when the annotations are off',
    async () => {
      const { report } = await gate();
      const check = control(report, 'the-mask-probe-is-not-reading-the-masks-colour-by-accident');
      expect(check.detected, check.detail).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'the blur destroys the detail it was placed over',
    async () => {
      const { report } = await gate();
      for (const frame of frames(report)) {
        expect(
          frame.blurVarianceRatio,
          `the blur left ${((frame.blurVarianceRatio || 1) * 100).toFixed(1)}% of the region's ` +
            `variance at t=${frame.t.toFixed(3)}s`,
        ).toBeLessThan(0.1);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'CONTROL: the fixture has detail for a blur to destroy',
    async () => {
      const { report } = await gate();
      const check = control(report, 'the-fixture-has-detail-for-a-blur-to-destroy');
      expect(check.detected, check.detail).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'CONTROL: a blur whose region cannot be read refuses the frame',
    async () => {
      const { report } = await gate();
      const check = control(report, 'a-blur-with-no-region-refuses-the-frame');
      expect(check.detected, check.detail).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'CONTROL: a blur too large to produce is redacted solid, not weakly blurred',
    async () => {
      const { report } = await gate();
      const check = control(report, 'an-unproducible-blur-is-redacted-solid');
      expect(check.detected, check.detail).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'no ordinary frame needed the solid fallback',
    async () => {
      const { report } = await gate();
      // The controls run after the 24 timestamps and deliberately trip it once, so
      // the fallback count over the whole run is exactly the control's.
      expect(report.privacyFallbacks).toBe(1);
    },
    TIMEOUT_MS,
  );
});

describe('text', () => {
  it(
    'CONTROL: a text span with no atlas degrades — the rest of the frame still draws, and it is counted',
    async () => {
      // Refusing a frame is `blur` and `mask`'s alone. Text failing to render is
      // cosmetic and *visible*; a redaction failing is invisible and publishes a
      // secret. The control requires all three halves of the narrower rule: the
      // frame is not refused, the other annotations still composite, and the skip is
      // observable — which is what `PreviewLoop` turns into a single `onError`.
      const { report } = await gate();
      const check = control(report, 'a-text-span-with-no-atlas-degrades-and-is-reported');
      expect(check.detected, check.detail).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'no ordinary frame was missing its atlas',
    async () => {
      const { report } = await gate();
      // The control above trips it exactly once, after the 24 timestamps, so the
      // count over the whole run is the control's and nothing else's.
      expect(report.textSpansWithoutAtlas).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    'no stroke was lost to a scratch target the compositor could not allocate',
    async () => {
      // The stroke pass's counterpart to the count above, and the other condition
      // the annotation surface degrades through rather than refusing. Nothing in
      // this run deliberately trips it, so any reading at all is ink that silently
      // did not draw on a frame the gate then compared byte for byte.
      const { report } = await gate();
      expect(report.strokesWithoutScratch).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'CONTROL: the atlas rasterised real ink from the shipped face',
    async () => {
      const { report } = await gate();
      const check = control(report, 'the-text-atlas-has-ink');
      expect(check.detected, check.detail).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'drew every glyph it was given',
    async () => {
      const { report } = await gate();
      expect(report.textTruncations).toBe(0);
    },
    TIMEOUT_MS,
  );
});

describe('the track window gates an annotation, in pixels', () => {
  it(
    'a parked track draws nothing once its activeRanges end',
    async () => {
      const { report } = await gate();
      const after = frames(report).filter((frame) => !frame.parkedActive);
      expect(after.length, 'the fixture never left the parked track’s window').toBeGreaterThan(4);
      for (const frame of after) {
        expect(
          frame.parkedChanged,
          `the parked track still drew ${String(frame.parkedChanged)} pixels at ` +
            `t=${frame.t.toFixed(3)}s`,
        ).toBe(0);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'blendMs crossfades it, and the weight is readable out of the pixels',
    async () => {
      // The span is opaque white over the fixture's pattern, so the mean difference
      // inside its box is exactly `weight × mean|255 − background|`. Taking the
      // plateau frames as the unit, every other frame must land on its own expected
      // weight — which catches a window that is ignored, a crossfade that is a cut,
      // and a weight that never reaches the annotation's opacity.
      const { report } = await gate();
      // Unzoomed frames only, for the reason the per-kind probe gives: a mean over a
      // box that is partly off the visible region is not a reading of the weight.
      // The fixture's zoom starts after this track's window ends, so this drops
      // nothing that carries a crossfade.
      const all = frames(report).filter((frame) => frame.zoomAmount <= 1.0001);
      const plateau = all.filter((frame) => frame.fadingWeight >= 1);
      expect(plateau.length, 'the fixture never reached full weight').toBeGreaterThan(2);
      const unit = plateau.reduce((sum, frame) => sum + frame.fadingMeanDiff, 0) / plateau.length;
      expect(unit, 'the fading track drew nothing even at full weight').toBeGreaterThan(20);

      for (const frame of all) {
        const expected = unit * frame.fadingWeight;
        if (frame.fadingWeight === 0) {
          expect(
            frame.fadingMeanDiff,
            `the fading track still drew outside its window at t=${frame.t.toFixed(3)}s`,
          ).toBe(0);
        } else {
          // Linear in the weight: the tolerance is 8% of one plateau, which is far
          // tighter than the 50% steps the fixture's crossfade actually takes and is
          // a property of the blend rather than of this machine.
          expect(
            Math.abs(frame.fadingMeanDiff - expected),
            `t=${frame.t.toFixed(3)}s: weight ${frame.fadingWeight.toFixed(3)} should give ` +
              `${expected.toFixed(2)}, measured ${frame.fadingMeanDiff.toFixed(2)}`,
          ).toBeLessThan(unit * 0.08);
        }
      }
    },
    TIMEOUT_MS,
  );

  it(
    'reveals a stroke by arc length, as it was drawn',
    async () => {
      // Phase 12. `progress` is an ordinary curve channel and the compositor
      // truncates the polyline by **arc length**, which is invisible to a "did it
      // draw" check — the same gap `blendMs` had, and the same shape of answer.
      //
      // Growth rather than an absolute count: how many pixels a fraction of a
      // zig-zag covers depends on the stroke width, the joins and the coverage
      // ramp, and predicting it here would be a second implementation of the thing
      // being judged. What is asserted is what a truncation by point index, or no
      // truncation at all, both fail.
      const { report } = await gate();
      const flat = frames(report).filter((frame) => frame.zoomAmount <= 1.0001);
      const zero = flat.filter((frame) => frame.revealProgress <= 0);
      expect(zero.length, 'the fixture never sampled progress 0').toBeGreaterThan(0);
      for (const frame of zero) {
        expect(
          frame.probes['revealing']?.changed ?? 0,
          `the revealing stroke drew at t=${frame.t.toFixed(3)}s, where progress is 0`,
        ).toBe(0);
      }

      const growing = flat
        .filter((frame) => frame.revealProgress > 0)
        .sort((a, b) => a.revealProgress - b.revealProgress);
      expect(growing.length, 'the fixture never revealed the stroke').toBeGreaterThan(6);
      let previous = -1;
      for (const frame of growing) {
        const changed = frame.probes['revealing']?.changed ?? 0;
        expect(
          changed,
          `the revealing stroke shrank at t=${frame.t.toFixed(3)}s ` +
            `(progress ${frame.revealProgress.toFixed(3)})`,
        ).toBeGreaterThanOrEqual(previous);
        previous = changed;
      }

      // And it really is a reveal rather than a stroke that appears whole: the last
      // sampled progress must cover materially more than the first.
      const first = growing[0]?.probes['revealing']?.changed ?? 0;
      const last = growing[growing.length - 1]?.probes['revealing']?.changed ?? 0;
      expect(first, 'the reveal drew nothing at its first non-zero progress').toBeGreaterThan(20);
      expect(
        last,
        `the reveal did not grow: ${String(first)} pixels at the start, ${String(last)} at the end`,
      ).toBeGreaterThan(first * 1.5);

      // The part that says **arc length** rather than "some monotonic thing". A
      // truncation by point index reaches a new point at most `REVEAL_POINT_COUNT`
      // times however finely progress is sampled, so it can produce at most that
      // many distinct pictures — and it passes every assertion above. Shortening the
      // last segment as well produces a new one at every sample.
      const distinct = new Set(growing.map((frame) => frame.probes['revealing']?.changed ?? 0));
      expect(
        distinct.size,
        `the reveal took only ${String(distinct.size)} distinct values across ` +
          `${String(growing.length)} sampled progresses, which is what a truncation by ` +
          'point index looks like rather than one by arc length',
      ).toBeGreaterThan(REVEAL_POINT_COUNT);
    },
    TIMEOUT_MS,
  );

  it(
    'CONTROL: it does draw while its window covers the instant',
    async () => {
      const { report } = await gate();
      const during = frames(report).filter((frame) => frame.parkedActive);
      expect(during.length).toBeGreaterThan(4);
      for (const frame of during) {
        expect(frame.probes['parked']?.changed ?? 0).toBeGreaterThan(20);
      }
    },
    TIMEOUT_MS,
  );
});
