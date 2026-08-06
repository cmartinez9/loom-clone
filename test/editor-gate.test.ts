/**
 * The phase 14 gate: a person can open a recording, watch it play, scrub it, trim
 * it, and find the trim still there afterwards.
 *
 * `test/editor/main.ts` runs it — a real Electron process, a real `.loomrec` built
 * from the committed H.264 fixture through the shipping writer, the real library
 * window, the real editor window, the real preview loop. This half only reads what
 * it measured.
 *
 * ## The one assertion that is worth the whole gate
 *
 * *Trim two seconds off the front; the picture at timeline 0 must be **byte-for-byte
 * the picture that was at source 2.0 s before the trim**.*
 *
 * The fixture is `testsrc2`, so every frame differs from every other. That makes a
 * pixel hash a fingerprint of a source instant, and it makes the equality above
 * unsatisfiable by anything except decoding the right frame: a preview that primed
 * its source at the wrong instant holds one stale picture (§4.3), a preview that
 * moved only its playhead shows the same picture as before, and both fail. The
 * **control** is beside it: the picture at source 0 must *differ* from the picture
 * at source 2.0, or the equality would pass on any recording of a still screen.
 *
 * ## What it does not assert
 *
 * The frame budget. §8's 16.67 ms belongs to `test/phase6-gate.test.ts`, along with
 * the whole argument about which hosts can be judged on it. Timing the same loop
 * here, on a different workload, would be a second and weaker opinion about one
 * number.
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
import { fixturePath } from '../packages/mux/test/helpers/fixture.ts';
import type { EditorReport, Reading } from './editor/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const GATE_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 180_000;

/** The fixture is ten seconds of `testsrc2` at 30 fps. */
const RECORDING_SEC = 10;

async function runProbe(): Promise<EditorReport> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-editor-gate-'));
  try {
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
      esbuild({ ...common, entryPoints: [join(here, 'editor/main.ts')], outfile: mainPath }),
      // The project's own vite config, so the page under the probe is the page the
      // app ships: same CSP, same `loom://` relative asset paths, same fonts.
      viteBuild({
        configFile: resolve(root, 'apps/renderer/vite.config.ts'),
        logLevel: 'warn',
        build: { outDir: rendererRoot, emptyOutDir: true, sourcemap: false },
      }),
    ]);

    const out = join(dir, 'report.json');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as unknown as string;

    const child = spawn(
      electron,
      [
        mainPath,
        '--renderer',
        rendererRoot,
        '--preload',
        preloadPath,
        // The fixture path is handed in: `main.cjs` is a CommonJS bundle and
        // `import.meta.url` does not survive one.
        '--fixture',
        fixturePath(),
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
      return JSON.parse(await readFile(out, 'utf8')) as EditorReport;
    } catch {
      throw new Error(
        `the editor gate produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-6000)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One Electron launch, read by every assertion below. */
let run: Promise<EditorReport> | null = null;
function gate(): Promise<EditorReport> {
  run ??= runProbe();
  return run;
}

function describeRun(report: EditorReport): string {
  return [
    '',
    `recording      ${report.recording.id} ${report.recording.durationSec.toFixed(3)}s ` +
      `${String(report.recording.frameCount)} frames ${report.recording.size.join('x')}`,
    `from library   ${String(report.openedFromLibrary)}`,
    `lanes          ${report.lanes.join(' | ')}`,
    ...(report.error === '' ? [] : [`error          ${report.error}`]),
    ...report.readings.map(
      (r) =>
        `  ${r.label.padEnd(42)} t=${r.timelineSec.toFixed(3)} src=${r.sourceSec.toFixed(3)} ` +
        `dur=${r.durationSec.toFixed(3)} trim=[${r.trim.startSec.toFixed(2)},${r.trim.endSec.toFixed(2)}] ` +
        `pic=${r.picture.hash} d=${String(r.picture.distinct)} cov=${(r.picture.coverage * 100).toFixed(1)}%` +
        (r.trouble === '' ? '' : ` TROUBLE "${r.trouble}"`),
    ),
    ...report.disk.map(
      (d) => `  disk ${d.label.padEnd(40)} rev=${String(d.revision)} ${JSON.stringify(d.clips)}`,
    ),
    '',
  ].join('\n');
}

function readingAt(report: EditorReport, label: string): Reading {
  const found = report.readings.find((r) => r.label === label);
  if (found === undefined) throw new Error(`the gate never took a reading called "${label}"`);
  return found;
}

function diskAt(report: EditorReport, label: string): EditorReport['disk'][number] {
  const found = report.disk.find((d) => d.label === label);
  if (found === undefined) throw new Error(`the gate never read the disk at "${label}"`);
  return found;
}

describe('the editor shell', () => {
  it(
    'opens from the library and shows the recording it was asked for',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      console.log(detail);

      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);

      // The whole point of seam S3: nothing used to reach this window at all.
      expect(report.openedFromLibrary, detail).toBe(true);
      // The timeline built its lanes from `recording.json`. A screen-only recording
      // gets a screen lane and no camera or audio lane — an empty lane would be a
      // false statement about what was captured.
      expect(report.lanes, detail).toEqual(['Screen', 'Zoom']);
      expect(report.recording.frameCount, detail).toBeGreaterThan(200);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'composites a real picture rather than a flat field',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const first = readingAt(report, 'playhead at 0');

      // A held stale frame, a cleared target and a letterbox all pass "the canvas
      // exists". None of them pass this: a decoded `testsrc2` frame has hundreds of
      // distinct colours in it and covers most of a 16:9 output.
      expect(first.picture.distinct, detail).toBeGreaterThan(64);
      expect(first.picture.coverage, detail).toBeGreaterThan(0.5);
      expect(first.trouble, detail).toBe('');
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'scrubs to a different frame — the CONTROL that makes the trim proof mean anything',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const zero = readingAt(report, 'playhead at 0');
      const two = readingAt(report, 'playhead at 2s');

      expect(two.timelineSec, detail).toBeCloseTo(2, 2);
      // With no trim the two domains agree, which is why the seam was invisible.
      expect(two.sourceSec, detail).toBeCloseTo(2, 2);
      // Without this, "the picture matched after the trim" would pass on a
      // recording of a motionless screen — and on a preview that never decoded
      // anything after the first frame.
      expect(two.picture.hash, detail).not.toBe(zero.picture.hash);
      expect(two.picture.distinct, detail).toBeGreaterThan(64);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'plays: the playhead advances and the picture follows it',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const two = readingAt(report, 'playhead at 2s');
      const playing = readingAt(report, 'playing');

      expect(playing.playing, detail).toBe(true);
      expect(playing.timelineSec, detail).toBeGreaterThan(two.timelineSec + 0.3);
      // The half a frame counter cannot see: the composite changed too, so frames
      // were decoded and drawn rather than a playhead sliding over a still.
      expect(playing.picture.hash, detail).not.toBe(two.picture.hash);
      expect(playing.picture.distinct, detail).toBeGreaterThan(64);
      expect(playing.trouble, detail).toBe('');
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'trims with a drag, and the trim is on disk',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const before = diskAt(report, 'before any trim');
      const dragged = readingAt(report, 'after dragging the end handle');
      const after = diskAt(report, 'after dragging the end handle');

      expect(before.clips, detail).toEqual([]);

      // The drag landed about two thirds along a ten-second recording. The exact
      // instant is a pointer's, so the bound is loose on purpose — what is being
      // asserted is that a real pointer on the real handle produced a real edit.
      expect(dragged.trim.startSec, detail).toBeCloseTo(0, 3);
      expect(dragged.trim.endSec, detail).toBeGreaterThan(5);
      expect(dragged.trim.endSec, detail).toBeLessThan(RECORDING_SEC);
      expect(dragged.durationSec, detail).toBeCloseTo(dragged.trim.endSec, 3);

      // And it is a `clips.set` in a document main wrote, at a new revision.
      expect(after.revision, detail).toBeGreaterThan(before.revision);
      expect(after.clips, detail).toHaveLength(1);
      expect(after.clips[0]?.speed, detail).toBe(1);
      expect(after.clips[0]?.sourceStart, detail).toBe(0);
      expect(after.clips[0]?.sourceEnd, detail).toBeCloseTo(dragged.trim.endSec, 6);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'maps timeline time onto source time: the trimmed picture is the SAME BYTES',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const two = readingAt(report, 'playhead at 2s');
      const trimmed = readingAt(report, 'timeline 0 after trimming 2s off the front');

      // Two seconds off the front, so the output is eight seconds long and its
      // first frame is the recording's frame at 2.0 s.
      expect(trimmed.trim.startSec, detail).toBeCloseTo(2, 6);
      expect(trimmed.durationSec, detail).toBeCloseTo(RECORDING_SEC - 2, 2);
      expect(trimmed.timelineSec, detail).toBe(0);
      expect(trimmed.sourceSec, detail).toBeCloseTo(2, 6);

      // The assertion. Same source instant, different timeline instant, identical
      // pixels — which nothing but decoding the right frame can produce.
      expect(trimmed.picture.hash, detail).toBe(two.picture.hash);
      expect(trimmed.picture.distinct, detail).toBe(two.picture.distinct);
      expect(trimmed.trouble, detail).toBe('');
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'keeps the trim when the window closes, through the journal and the snapshot',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const live = diskAt(report, 'after trimming 2s off the front');
      const closed = diskAt(report, 'after the editor window closed');

      // While the editor still held the bundle: the ops are journalled, and a
      // reader that replays the journal onto the snapshot sees them.
      expect(live.clips, detail).toEqual([
        { id: 'trim', sourceStart: 2, sourceEnd: RECORDING_SEC, speed: 1 },
      ]);

      // And after the window went: `EditorWindows` closed the project, which wrote
      // the final `edit.json` and truncated the journal. This is the round trip a
      // person makes — edit, close, come back — read through a store that has never
      // seen the bundle before.
      expect(closed.clips, detail).toEqual(live.clips);
      expect(closed.revision, detail).toBe(live.revision);
    },
    GATE_TIMEOUT_MS,
  );
});
