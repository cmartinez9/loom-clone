/**
 * **Phase 6's gate.**
 *
 * Architecture report §8: *"Scrub and play a 4K fixture with **no frame over
 * 16 ms** at 1440p viewport; live `VideoFrame` count never exceeds the ring cap."*
 *
 * Both halves are asserted here, against a real Electron renderer: a real
 * `VideoDecoder`, a real WebGL2 context, a real 4K H.264 stream encoded on the
 * machine running the test, served over `loom://` with byte ranges by main's own
 * `serveFile`. `test/gate/harness.ts` is what runs inside; this file builds it,
 * launches it and judges the report.
 *
 * The second half is not decoration. §10.2 names leaked `VideoFrame` lifetimes as
 * one of the three things most likely to sink this project, and describes exactly
 * what a leak looks like from outside: *"it does not throw, it just stops producing
 * frames. Preview freezes or an export hangs at 40%, with no error anywhere."*
 *
 * ## Why this is a real pass and not a fast blank screen
 *
 * A preview that draws nothing meets a timing budget trivially. So the gate also
 * requires, and this file asserts:
 *
 *  - every scrub target composited the **frame the index says belongs there**, read
 *    back out of the framebuffer and decoded from the fixture's frame-number band;
 *  - playback found a decoded frame for the overwhelming majority of its frames;
 *  - the composite never fell back to the background *while* a scrub was settling,
 *    which is the window made entirely of misses — with a control proving the check
 *    can see a background composite when there is one;
 *  - the fixture really is variable-frame-rate, with holds of half a second;
 *  - the run measured a meaningful number of frames rather than two.
 */

import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateReport } from './gate/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const GATE = join(here, 'gate');

/** One 60 Hz refresh. §8's "no frame over 16 ms". */
const FRAME_BUDGET_MS = 1000 / 60;
const GATE_TIMEOUT_MS = 300_000;

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

interface RunResult {
  report: GateReport;
  exitCode: number | null;
  output: string;
}

async function runGate(): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-gate-'));
  try {
    const harnessDir = join(dir, 'harness');
    const fixtureDir = join(dir, 'fixture.loomrec');
    const out = join(dir, 'report.json');
    await mkdir(harnessDir, { recursive: true });
    await mkdir(join(fixtureDir, 'media'), { recursive: true });
    await buildHarness(harnessDir);

    const require = createRequire(import.meta.url);
    const electron = require('electron') as unknown as string;

    const child = spawn(
      electron,
      [
        join(harnessDir, 'main.cjs'),
        '--harness',
        harnessDir,
        '--fixture',
        fixtureDir,
        '--out',
        out,
        '--timeout',
        String(GATE_TIMEOUT_MS - 30_000),
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

    let report: GateReport;
    try {
      report = JSON.parse(await readFile(out, 'utf8')) as GateReport;
    } catch {
      throw new Error(
        `the gate produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-4000)}`,
      );
    }
    return { report, exitCode, output };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function describeRun(report: GateReport): string {
  return [
    '',
    `renderer     ${report.environment.glRenderer}`,
    `scheduler    ${report.environment.scheduler}   encode: ${report.environment.hardwareEncode}`,
    `fixture      ${String(report.fixture.width)}x${String(report.fixture.height)} ` +
      `${String(report.fixture.frameCount)} frames / ${report.fixture.durationSec.toFixed(2)}s ` +
      `(${report.fixture.observedFps.toFixed(1)} fps observed, longest hold ` +
      `${report.fixture.longestHoldSec.toFixed(2)}s, ${String(report.fixture.byteLength)} bytes)`,
    `viewport     ${report.viewport.join('x')}`,
    `warmup       n=${String(report.warmup.count)} max=${report.warmup.maxMs.toFixed(2)}ms`,
    `scrub        n=${String(report.scrub.count)} max=${report.scrub.maxMs.toFixed(2)}ms ` +
      `p99=${report.scrub.p99Ms.toFixed(2)}ms over-budget=${String(report.scrub.overBudget)}`,
    `play         n=${String(report.play.count)} max=${report.play.maxMs.toFixed(2)}ms ` +
      `p99=${report.play.p99Ms.toFixed(2)}ms over-budget=${String(report.play.overBudget)}`,
    `frames       peak-live=${String(report.peakLiveFrames)}/${String(report.ringCapacity)} ` +
      `at-end=${String(report.liveFramesAtEnd)} decoded=${String(report.decodedFrames)} seeks=${String(report.seeks)}`,
    `playback     hits=${String(report.playHits)} misses=${String(report.playMisses)}`,
    `settle       samples=${String(report.settleSamples)} black=${String(report.settleBlackFrames)} ` +
      `control-sees-black=${String(report.controlDetectsBlack)}`,
    `gpu          ${report.gpuCompositeMs === null ? 'no timer query' : `${report.gpuCompositeMs.toFixed(3)}ms`}`,
    `play samples ${report.playSamples
      .map((s) => `${s.atSec.toFixed(2)}s→${String(s.expectedFrame)}/${String(s.observedFrame)}`)
      .join(' ')}`,
    `scrub checks ${report.scrubChecks
      .map(
        (c) => `${c.targetSec.toFixed(2)}s→${String(c.expectedFrame)}/${String(c.observedFrame)}`,
      )
      .join(' ')}`,
    '',
  ].join('\n');
}

describe('phase 6 gate: 4K scrub and play', () => {
  it(
    'holds the 16 ms frame budget at 1440p and never exceeds the ring cap',
    async () => {
      const { report, exitCode } = await runGate();
      const detail = describeRun(report);
      // Printed unconditionally: a gate whose numbers are only visible when it
      // fails tells you nothing about the headroom you had while it passed.
      console.log(detail);

      expect(report.error ?? '', detail).toBe('');
      expect(report.ok, detail).toBe(true);
      expect(exitCode, detail).toBe(0);

      // ---- the fixture is what it claims to be -----------------------------
      expect(report.fixture.width, detail).toBe(3456);
      expect(report.fixture.height, detail).toBe(2234);
      expect(report.fixture.frameCount, detail).toBeGreaterThanOrEqual(100);
      expect(report.viewport, detail).toEqual([2560, 1440]);
      // Genuinely variable-frame-rate, not 30 fps wearing a VFR label (§2.3).
      expect(report.fixture.longestHoldSec, detail).toBeGreaterThanOrEqual(0.4);
      expect(report.fixture.observedFps, detail).toBeLessThan(30);

      // ---- half one: no frame over 16 ms -----------------------------------
      expect(report.scrub.count, detail).toBeGreaterThanOrEqual(30);
      expect(report.play.count, detail).toBeGreaterThanOrEqual(60);
      expect(report.scrub.overBudget, detail).toBe(0);
      expect(report.play.overBudget, detail).toBe(0);
      expect(report.scrub.maxMs, detail).toBeLessThanOrEqual(FRAME_BUDGET_MS);
      expect(report.play.maxMs, detail).toBeLessThanOrEqual(FRAME_BUDGET_MS);

      // ---- half two: the live VideoFrame count never exceeds the ring cap ---
      expect(report.ringCapacity, detail).toBe(20);
      expect(report.peakLiveFrames, detail).toBeGreaterThan(0);
      expect(report.peakLiveFrames, detail).toBeLessThanOrEqual(report.ringCapacity);
      // And everything is closed at the end: no acquire without a release, on any
      // path, including the seeks and the cancellations the scrub phase provokes.
      expect(report.liveFramesAtEnd, detail).toBe(0);

      // ---- and the pass is not a blank screen ------------------------------
      expect(report.scrubChecks.length, detail).toBeGreaterThanOrEqual(12);
      for (const check of report.scrubChecks) {
        expect(check.observedFrame, `${detail}\nscrub to ${check.targetSec.toFixed(3)}s`).toBe(
          check.expectedFrame,
        );
      }
      expect(report.decodedFrames, detail).toBeGreaterThan(50);
      expect(report.seeks, detail).toBeGreaterThan(1);

      // ---- and a miss holds the previous picture rather than flashing black ----
      // §4.3. A backward scrub clears the ring, so every frame composited until the
      // new decode lands is a miss; checking only the settled frame would have let a
      // preview that went black between every scrub target through unremarked.
      expect(report.settleSamples, detail).toBeGreaterThanOrEqual(6);
      expect(report.settleBlackFrames, detail).toBe(0);
      // CONTROL: the same detector, shown the behaviour the hold replaced. Without
      // this, a detector that could not see black would report zero just as happily.
      expect(report.controlDetectsBlack, detail).toBe(true);
      // Playback advanced through the fixture rather than holding one frame: the
      // picture on screen matched the index, sample after sample, and moved forward.
      expect(report.playSamples.length, detail).toBeGreaterThanOrEqual(4);
      let previous = -1;
      for (const sample of report.playSamples) {
        expect(
          Math.abs(sample.observedFrame - sample.expectedFrame),
          `${detail}\nplayback at ${sample.atSec.toFixed(3)}s`,
        ).toBeLessThanOrEqual(2);
        expect(sample.observedFrame, detail).toBeGreaterThan(previous);
        previous = sample.observedFrame;
      }

      const total = report.playHits + report.playMisses;
      expect(total, detail).toBeGreaterThan(0);
      expect(report.playHits / total, detail).toBeGreaterThan(0.9);
    },
    GATE_TIMEOUT_MS,
  );
});
