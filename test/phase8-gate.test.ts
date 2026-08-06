/**
 * **Phase 8's gate.**
 *
 * Architecture report §8: *"Golden-frame test: preview and export pixel-identical at
 * 24 timestamps."* §4.5 sets the bar: *"a per-pixel max delta of 0"*, and §10.3
 * explains what it is protecting — *"Preview and export drifting apart … it is the
 * default outcome. It takes three separate disciplines to prevent — one decoder, one
 * compositor, and frame-rate-independent animation — and each is individually
 * tempting to violate."*
 *
 * `test/export-golden/harness.ts` runs both shipping loops inside a real Electron
 * renderer; this file builds it, launches it and judges the report.
 *
 * ## Its relationship to phase 11's golden gate
 *
 * Phase 11 ships `test/golden/`, which checks the other half of §4.5 over a
 * *synthetic* source frame: that annotations actually change the picture, in the right
 * places, and that the mask and the blur are effects on pixels rather than draw calls.
 * It drives {@link ExportRenderLoop.renderAt} exactly as this gate does — its
 * `exportFrame` was a two-line stand-in only while phase 8 was being built, and that
 * fold has happened with every one of its assertions left where it was. Neither gate
 * subsumes the other and they must not be merged into one:
 *
 * | | `test/golden/` (phase 11) | this file (phase 8) |
 * |---|---|---|
 * | source | one painted `VideoFrame` | a real decoded H.264 stream, VFR |
 * | export path | the shipping `ExportRenderLoop` | the shipping `ExportRenderLoop` |
 * | contexts | one `Compositor`, both paths | two contexts, two readers, two rings |
 * | also proves | annotations are not vacuous | the encoded file carries the pixels |
 *
 * So what separates them is no longer the export path but everything around it: this
 * gate is the only one with a real decoded VFR source, two GL contexts and two frame
 * rings, and the only one that demuxes and decodes the finished MP4 back out again.
 *
 * ## What makes this a pass rather than a coincidence
 *
 * A comparison of two identical mistakes is also zero, so the run carries its own
 * controls and every one of them is asserted here:
 *
 *  - **the identity control** — the export path composited twice, which must be 0.
 *    Without it, a comparator stuck at "different" would be invisible;
 *  - **two divergence controls** — the real `ExportRenderLoop`, run once with its
 *    timeline shifted by a single output frame and once over a reader whose frame
 *    selection is one source frame late. Those are exactly §4.5's two "must be
 *    identical" properties, perturbed one at a time, and **each must make the same
 *    comparison non-zero**. This is the requirement that the test be shown to catch
 *    a divergence, and it is the pattern
 *    `packages/format/test/kill-mid-write.test.ts` established: a control that must
 *    fail, run through the real apparatus;
 *  - **a moving spring-driven zoom**, so the state under comparison is a different
 *    non-trivial value at each timestamp rather than the identity — a golden test
 *    over `zoom.amount === 1` would pass on a compositor that ignored the state
 *    entirely;
 *  - **the finished file**, verified by §7.5's five checks and then decoded back so
 *    the frame numbers painted into the fixture can be read out of it. The golden
 *    comparison reads the render target; the user gets the file.
 *
 * ## What `delta 0` here is *not* evidence about
 *
 * §4.5's *"must be identical"* list has four rows and this gate exercises two of them
 * — frame selection and the zoom state — each with a control that must go non-zero.
 * The other two, **the webcam bubble and the cursor**, have no compositor pass on
 * `main`: `Compositor.render` throws when handed a `webcam` or a `cursor` frame, and
 * `ExportRenderLoop`'s `CompositorFrames` is `{ screen: null }`, so neither path draws
 * anything for them and a per-pixel delta of 0 between two blanks says nothing.
 * Building those passes is separate scheduled work.
 *
 * So the report carries `coverage` — printed on every run, passing or not — and a
 * **tripwire**: the harness hands the real compositor a `webcam` frame and a `cursor`
 * frame and requires it to refuse both. The assertions below fail if either refusal
 * stops, which is the day the coverage list becomes wrong and the day this gate could
 * start covering those rows. A comment would have rotted; this cannot.
 *
 * ## The one thing that is not a comparison
 *
 * A lost WebGL context is not a reading — Chromium exits the GPU process when one is
 * lost and takes every context in it, so what a harness would report afterwards is
 * whatever it was holding when the lights went out. That earns exactly one relaunch,
 * through {@link shouldRelaunchGolden}, and nothing else does.
 *
 * When **every** launch is taken away, this gate has no verdict to give and says so:
 * the run reports **skipped**, under a NOT JUDGED banner carrying Chromium's own
 * account of what died, rather than printing a pixel-identity failure over a report
 * that reads `samples n=0`. {@link instrumentOutOfCalibration} is that condition, the
 * hazard it would be unsound without, and the guard that makes it safe to take before
 * every assertion here; `test/golden-verdict.test.ts` is its counter-cases. A run whose
 * context survived is judged exactly as it was, and `report.contextLost` is still
 * asserted below — so a run that lost it once, relaunched, and then compared 24
 * timestamps fails here if anything about them is wrong.
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
import { shouldRelaunchGolden } from './export-golden/relaunch.ts';
import {
  instrumentOutOfCalibration,
  notJudgedBanner,
  withheldJudgement,
} from './export-golden/verdict.ts';
import type { GoldenReport } from './export-golden/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const GATE = join(here, 'export-golden');

/**
 * Room for {@link GATE_ATTEMPTS} launches, and nothing else.
 *
 * Deliberately not a tighter number that a slow host could trip: a virtualised runner
 * has no hardware decoder, so every composite there carries a CPU-backed upload and
 * the run is a different workload from the four seconds it costs on target hardware.
 * Judging *that* is what the assertions below are for; this only has to be larger
 * than two of {@link ATTEMPT_TIMEOUT_MS}.
 */
const GATE_TIMEOUT_MS = 1_020_000;
/**
 * The backstop on one launch, not a budget.
 *
 * Every wait inside the run is bounded on its own — the decode by
 * `ExportRenderLoop`'s `STALL_TIMEOUT_MS`, the encode by `ENCODE_STALL_TIMEOUT_MS`,
 * both of which name what stopped — so this fires only for a hang nothing else has a
 * name for. Left where it was: shrinking it would trade a hang nobody has seen for a
 * slow host nobody has measured.
 */
const ATTEMPT_TIMEOUT_MS = 480_000;
/** One relaunch, for {@link shouldRelaunchGolden}'s single reason. */
const GATE_ATTEMPTS = 2;

/** §4.5's number. */
const TIMESTAMP_COUNT = 24;

async function buildHarness(outDir: string): Promise<void> {
  const common = { bundle: true, sourcemap: 'inline' as const, logLevel: 'warning' as const };
  await Promise.all([
    build({
      ...common,
      entryPoints: [join(GATE, 'main.ts')],
      outfile: join(outDir, 'main.cjs'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
    }),
    build({
      ...common,
      entryPoints: [join(GATE, 'preload.ts')],
      outfile: join(outDir, 'preload.cjs'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
    }),
    build({
      ...common,
      entryPoints: [join(GATE, 'harness.ts')],
      outfile: join(outDir, 'harness.js'),
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
    }),
  ]);
  await copyFile(join(GATE, 'harness.html'), join(outDir, 'harness.html'));
}

/** See the same function in `test/phase6-gate.test.ts`: refuse to *fetch* Electron here. */
function electronBinary(): string {
  const require = createRequire(import.meta.url);
  const moduleDir = dirname(require.resolve('electron'));
  if (!existsSync(join(moduleDir, 'path.txt')) || !existsSync(join(moduleDir, 'dist'))) {
    throw new Error(
      'the Electron runtime is not on disk. Run `node scripts/install-electron-runtime.mjs` ' +
        '(npm ci runs it) first.',
    );
  }
  return require('electron') as string;
}

/**
 * How much of Electron's own output a failing run prints.
 *
 * Chromium says why it took the GPU process down — the harness only ever sees the
 * lights going out — so a run that reports `contextLost` with nothing about what died
 * is a round trip wasted. Printed on a bad run only, for the reason
 * `test/phase6-gate.test.ts` prints its log on one.
 */
const ELECTRON_TAIL_CHARS = 4000;

async function runGate(): Promise<{
  report: GoldenReport;
  exitCode: number | null;
  output: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-golden-'));
  try {
    const harnessDir = join(dir, 'harness');
    const fixtureDir = join(dir, 'fixture.loomrec');
    const outDir = join(dir, 'out');
    const out = join(dir, 'report.json');
    await mkdir(harnessDir, { recursive: true });
    await mkdir(join(fixtureDir, 'media'), { recursive: true });
    await mkdir(outDir, { recursive: true });
    await buildHarness(harnessDir);

    const child = spawn(
      electronBinary(),
      [
        join(harnessDir, 'main.cjs'),
        '--harness',
        harnessDir,
        '--fixture',
        fixtureDir,
        '--outdir',
        outDir,
        '--out',
        out,
        '--timeout',
        String(ATTEMPT_TIMEOUT_MS),
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

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });

    try {
      return { report: JSON.parse(await readFile(out, 'utf8')) as GoldenReport, exitCode, output };
    } catch {
      throw new Error(
        `the golden gate produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-ELECTRON_TAIL_CHARS)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Launch until the gate produces a comparison, or run out of attempts.
 *
 * The retry condition is {@link shouldRelaunchGolden} — a named predicate with a test
 * of its own — and not a clause in this loop, for the reason phase 6's gate states:
 * a retry around an acceptance gate is how a real defect gets to look like weather,
 * and this one stays defensible only while it stays this narrow. The last report is
 * judged either way, so the assertions below judge a real run.
 *
 * **Every** attempt comes back, not just the last, because
 * {@link instrumentOutOfCalibration} is a question about all of them: a verdict is
 * withheld only where no launch produced a reading, and a launch whose report is
 * discarded here is a launch whose reading could not be consulted there.
 */
async function runGateUntilCompared(): Promise<{
  attempts: GoldenReport[];
  exitCode: number | null;
  output: string;
}> {
  let result = await runGate();
  const attempts = [result.report];
  for (
    let attempt = 2;
    attempt <= GATE_ATTEMPTS && shouldRelaunchGolden(result.report);
    attempt++
  ) {
    console.log(
      `the gate's WebGL context was lost (${result.report.error ?? 'no detail'}); ` +
        `launch ${String(attempt)} of ${String(GATE_ATTEMPTS)}`,
    );
    result = await runGate();
    attempts.push(result.report);
  }
  return { attempts, exitCode: result.exitCode, output: result.output };
}

function describeRun(report: GoldenReport): string {
  const worst = report.samples.reduce(
    (max, sample) => (sample.maxDelta > max.maxDelta ? sample : max),
    report.samples[0] ?? { maxDelta: 0, atSec: 0, index: -1, differingBytes: 0 },
  );
  return [
    '',
    ...(report.error === undefined || report.error === '' ? [] : [`error       ${report.error}`]),
    `renderer    ${report.environment.glRenderer}`,
    `encode      ${report.environment.hardwareEncode}`,
    `fixture     ${report.fixture.width}x${report.fixture.height} ` +
      `${report.fixture.frameCount} frames / ${report.fixture.durationSec.toFixed(2)}s ` +
      `(longest hold ${report.fixture.longestHoldSec.toFixed(2)}s)`,
    `output      ${report.outputSize.join('x')} @ ${report.fps} fps`,
    `samples     n=${report.samples.length} worst delta=${worst.maxDelta} ` +
      `@${worst.atSec.toFixed(3)}s (${worst.differingBytes} bytes differ)`,
    `zoom        ${report.samples.map((s) => s.zoomAmount.toFixed(2)).join(' ')}`,
    `identity    max delta=${report.identityMaxDelta}`,
    ...report.controls.map(
      (c) =>
        `control     ${c.name}: max delta=${c.maxDelta} over ${c.differingSamples}/${report.samples.length} samples — ${c.what}`,
    ),
    `frames      live at end=${report.liveFramesAtEnd}`,
    // Printed on a passing run too: the headline `delta 0` is only evidence about the
    // rows listed here, and a reader who cannot see the boundary will assume there
    // isn't one.
    ...report.coverage.exercised.map((row) => `§4.5 ok      ${row}`),
    ...report.coverage.notExercised.map((row) => `§4.5 NOT     ${row.row} — ${row.why}`),
    `tripwire    webcam pass absent=${report.coverage.tripwire.webcamPassStillAbsent} ` +
      `cursor pass absent=${report.coverage.tripwire.cursorPassStillAbsent} ` +
      `(${report.coverage.tripwire.detail})`,
    report.exported === null
      ? 'export      did not run'
      : `export      ${report.exported.bytes} bytes, ` +
        `${report.exported.durationSec.toFixed(3)}s (expected ` +
        `${report.exported.expectedDurationSec.toFixed(3)}s), ` +
        `${report.exported.videoSampleCount} video samples, verification ` +
        (report.exported.verificationFailure ?? 'passed'),
    report.exported === null
      ? ''
      : `decoded     ${report.exported.decodedFrames
          .map((f) => `${f.atSec.toFixed(2)}s→${f.expectedFrame}/${f.observedFrame}`)
          .join(' ')}`,
    `cancel      left behind: ${JSON.stringify(report.cancelLeftBehind)}`,
    ...(report.ok ? [] : ['gate log', ...report.logs.map((line) => `  ${line}`)]),
    '',
  ].join('\n');
}

describe('phase 8 gate: preview and export are pixel-identical', () => {
  it(
    'agrees at 24 timestamps, and can see it when they disagree',
    async ({ skip }) => {
      const { attempts, exitCode, output } = await runGateUntilCompared();
      const report = attempts[attempts.length - 1]!;
      const detail =
        describeRun(report) +
        (report.ok ? '' : `electron output\n${output.slice(-ELECTRON_TAIL_CHARS)}\n`);
      // Printed unconditionally: a gate whose numbers appear only on a failure tells
      // you nothing about the margin you had while it passed.
      console.log(detail);

      // ---- the third outcome, and it has to come first ----------------------
      // Where **every** launch had its GPU context taken away and not one of them read
      // anything, there is no verdict to give on §4.5 — good or bad — and this run says
      // so rather than failing. `expect(report.contextLost).toBe(false)` below would
      // otherwise print a pixel-identity failure over a report whose own numbers are
      // `samples n=0`, `identity max delta=-1`, `export did not run`.
      //
      // **First rather than last, which is the opposite of phase 6's ordering and needs
      // its own safety.** Phase 6 can put its `skip()` after every assertion, so a
      // withheld verdict is structurally unable to suppress a real one. Here a lost
      // context empties the report, so everything below would fail on the absence rather
      // than on a finding, and the branch has to precede them. The safety therefore
      // lives in the predicate: `instrumentOutOfCalibration` refuses to withhold a run
      // that carries **any** reading — one timestamp, one control, one file, field by
      // field — so a run with something to judge is judged. `test/golden-verdict.test.ts`
      // is where that is required, counter-case by counter-case, including a healthy run
      // whose pixels disagree and a lost-context run that compared 24 timestamps anyway.
      //
      // Nothing about the *relaunch* moves: `shouldRelaunchGolden` is still
      // `report.contextLost` alone, and {@link GATE_ATTEMPTS} is still two.
      if (instrumentOutOfCalibration(attempts)) {
        console.log(notJudgedBanner(withheldJudgement(attempts)));
        skip(
          `§4.5's per-pixel zero was NOT JUDGED and this is not a pass: the WebGL ` +
            `contexts both paths composite into were taken away on all ` +
            `${String(attempts.length)} launches this gate is given, so no pixel was ever ` +
            `compared (${report.gpuProcessGone ?? 'no GPU-process exit reached main'}). A ` +
            `run whose context survives is judged exactly as before; see the output above.`,
        );
      }

      // First, because it makes every number below a fiction rather than a reading.
      expect(report.contextLost, detail).toBe(false);
      expect(report.error ?? '', detail).toBe('');
      expect(report.ok, detail).toBe(true);
      expect(exitCode, detail).toBe(0);

      // ---- the fixture is what it claims to be ----------------------------
      expect(report.fixture.frameCount, detail).toBeGreaterThanOrEqual(60);
      // Genuinely variable-frame-rate, so hold-last-frame is exercised on both paths
      // rather than assumed (§4.2).
      expect(report.fixture.longestHoldSec, detail).toBeGreaterThanOrEqual(0.4);

      // ---- §4.5's requirement, at §8's 24 timestamps ------------------------
      expect(report.samples.length, detail).toBe(TIMESTAMP_COUNT);
      for (const sample of report.samples) {
        expect(
          sample.maxDelta,
          `${detail}\npreview and export differ at ${sample.atSec.toFixed(3)}s ` +
            `(output frame ${sample.index}): ${sample.differingBytes} bytes differ, ` +
            `worst by ${sample.maxDelta} at byte ${sample.atByte}`,
        ).toBe(0);
      }
      // And every one of them composited a real decoded frame rather than agreeing
      // about a held background.
      for (const sample of report.samples) {
        expect(sample.drawn, `${detail}\nno source frame at ${sample.atSec.toFixed(3)}s`).toBe(
          true,
        );
      }
      // The state under comparison actually moved. A golden test taken entirely at
      // `zoom.amount === 1` would pass on a compositor that ignored `ResolvedState`.
      const zooms = report.samples.map((s) => s.zoomAmount);
      expect(Math.max(...zooms) - Math.min(...zooms), detail).toBeGreaterThan(0.5);
      expect(new Set(zooms.map((z) => z.toFixed(4))).size, detail).toBeGreaterThanOrEqual(12);

      // ---- CONTROL 1: the comparator can report zero ------------------------
      expect(report.identityMaxDelta, detail).toBe(0);

      // ---- CONTROL 2 and 3: it can report non-zero --------------------------
      // Each perturbs one of §4.5's "must be identical" properties, inside the real
      // export loop, and is judged by the same comparison. A gate that could not see
      // these would be reporting zero for a reason unrelated to what it claims.
      expect(report.controls.map((c) => c.name).sort(), detail).toEqual([
        'clock-skew',
        'frame-selection',
      ]);
      for (const control of report.controls) {
        expect(
          control.maxDelta,
          `${detail}\nthe ${control.name} control did not move a single pixel, so the ` +
            `golden comparison above proves nothing: ${control.what}`,
        ).toBeGreaterThan(0);
        expect(
          control.differingSamples,
          `${detail}\nthe ${control.name} control changed too few of the ${TIMESTAMP_COUNT} timestamps`,
        ).toBeGreaterThanOrEqual(4);
      }

      // ---- §10.2: every VideoFrame closed -----------------------------------
      expect(report.liveFramesAtEnd, detail).toBe(0);

      // ---- what the 24 zeroes above are, and are not, evidence about ---------
      // The two rows this gate perturbs, named in the report rather than inferred
      // from the control names.
      expect(report.coverage.exercised.length, detail).toBe(2);
      expect(report.coverage.notExercised.map((row) => row.row).join(' '), detail).toMatch(
        /webcam bubble[\s\S]*cursor/,
      );
      // THE TRIPWIRE. While `Compositor.render` refuses a `webcam` frame and a
      // `cursor` frame, neither path can draw either, and the coverage list above is
      // accurate. The first time one of those passes is built the refusal stops and
      // this fails — which is the point: the change that makes the list wrong is the
      // change that has to update it, and is also the change that lets this gate start
      // perturbing those rows the way it perturbs the other two.
      expect(
        report.coverage.tripwire.webcamPassStillAbsent,
        `${detail}\nCompositor.render no longer refuses a webcam frame, so the webcam bubble ` +
          'is now drawable — extend this gate to perturb §4.5’s bubble row (centre, size, ' +
          'aspect, corner radius, opacity, mirror) and move it into `coverage.exercised`.',
      ).toBe(true);
      expect(
        report.coverage.tripwire.cursorPassStillAbsent,
        `${detail}\nCompositor.render no longer refuses a cursor frame, so the cursor is now ` +
          'drawable — extend this gate to perturb §4.5’s cursor row (position after ' +
          'smoothing, image, scale) and move it into `coverage.exercised`.',
      ).toBe(true);

      // ---- the file the user actually gets ----------------------------------
      const exported = report.exported;
      expect(exported, detail).not.toBeNull();
      if (exported === null) return;
      expect(exported.verificationFailure, detail).toBeNull();
      // §7.5's five, individually, so a failure names which one.
      expect(exported.verified.exists, detail).toBe(true);
      expect(exported.verified.bytes, detail).toBeGreaterThan(0);
      expect(exported.verified.lastFrameDecodable, detail).toBe(true);
      expect(exported.verified.sha256, detail).toMatch(/^[0-9a-f]{64}$/);
      expect(
        Math.abs(exported.verified.durationSec - exported.expectedDurationSec),
        detail,
      ).toBeLessThanOrEqual(0.1);
      expect(exported.videoSampleCount, detail).toBeGreaterThanOrEqual(60);

      // The pictures in the file are the pictures the timeline selected. This is the
      // half the render-target comparison cannot see: canvas → encoder → muxer → disk.
      expect(exported.decodedFrames.length, detail).toBeGreaterThanOrEqual(3);
      for (const frame of exported.decodedFrames) {
        expect(
          frame.observedFrame,
          `${detail}\nthe exported file shows fixture frame ${frame.observedFrame} at ` +
            `${frame.atSec.toFixed(3)}s, where the timeline selects ${frame.expectedFrame}`,
        ).toBe(frame.expectedFrame);
      }

      // ---- and a cancelled export leaves nothing behind ----------------------
      // §7.5, obligation 1, read the other way round: phase 9 deletes sources on the
      // strength of a finished export, so a cancelled one must not be able to look
      // like one. Asserted against the directory listing rather than the writer's
      // own account of itself.
      expect(report.cancelLeftBehind, detail).toEqual([]);
    },
    GATE_TIMEOUT_MS,
  );
});
