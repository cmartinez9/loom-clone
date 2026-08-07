/**
 * **The phase 15 gate: the editor's controls, and what they leave behind.**
 *
 * `test/editor-controls/main.ts` runs it — a real Electron process, a real `.loomrec`
 * with real H.264 in `media/` and real §2.5 logs in `events/`, the real library
 * window, its real Open button, the real editor, the real generators, and two real
 * exports through the real `ExportSession`. This half only reads what it measured.
 *
 * ## The assertion worth the whole gate
 *
 * *A person takes manual control of a zoom the generator produced, changes it, and the
 * change survives a round trip through the stored document and appears in an exported
 * file — everywhere they said, and nowhere else.*
 *
 * It is measured three ways at once, because each alone is satisfiable by a defect:
 *
 * - **`resolve`** reports the user's magnification inside the window and the
 *   generator's outside it. A document alone could say that and draw nothing.
 * - **the composited picture** differs inside and matches outside. Pixels alone could
 *   move for any reason.
 * - **two finished MP4s**, decoded back out of their own sample tables, differ inside
 *   the window and agree outside it. That is the half nothing else in this repo can
 *   claim: preview and export share one `TrackReader` and one `Compositor`, and this
 *   is the check that the thing on disk is the thing that was approved.
 *
 * The **outside** reading is the control throughout, and it is what a whole class of
 * plausible defects fails: a manual track written with `ALWAYS` for its `activeRanges`
 * (§3.5's window ignored), a clip list disturbed by the edit, a wrong frame selected
 * for a given time — every one of those changes the picture *everywhere*, and every
 * one of them is caught by requiring the outside frames to agree.
 *
 * ## What it does not measure, deliberately
 *
 * The frame budget — `test/phase6-gate.test.ts` owns §8's 16.67 ms and the whole
 * argument about which hosts may be judged on it. §4.5's per-pixel preview/export
 * identity — `test/phase8-gate.test.ts` owns that, over two GL contexts and two
 * readers, and phase 11's golden gate owns the annotation axis. A second and weaker
 * opinion about either number would make both harder to trust.
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
import { ANNOTATION_TOOLS } from '../apps/renderer/src/editor/annotate.ts';
import type { ControlsReport, OnDisk, Reading } from './editor-controls/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const GATE_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 480_000;

/**
 * The instant the user takes control of, in source seconds.
 *
 * The harness names it too (`test/editor-controls/main.ts`), and the two constants are
 * deliberately not shared: this half's job is to read what was measured, and importing
 * the number the harness aimed at would make an assertion about *where* the reading
 * was taken circular. The `outside` instant is never named here at all — it is only
 * ever compared against itself, before and after.
 */
const INSIDE_SEC = 5.0;

/** §6.5's `amountRange` tops out here, so anything above it is unmistakably the user's. */
const GENERATOR_MAX_AMOUNT = 2.5;

async function runProbe(): Promise<ControlsReport> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-p15-gate-'));
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
      esbuild({
        ...common,
        entryPoints: [join(here, 'editor-controls/main.ts')],
        outfile: mainPath,
      }),
      // The project's own vite config, so the pages under the probe are the pages the
      // app ships: same CSP, same `loom://` asset paths, same self-hosted fonts —
      // which the export window now needs as well, because a `text` annotation's
      // glyphs are rasterised there.
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
        '--fixture',
        fixturePath(),
        '--out',
        out,
        '--timeout',
        String(PROBE_TIMEOUT_MS),
        // Chromium's own stderr, which is where a GPU process that restarted or ran out
        // of host memory says so. Off by default on macOS, and the output is only ever
        // *printed* when the run failed, so a passing gate is as quiet as it was.
        '--enable-logging',
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

    let report: ControlsReport;
    try {
      report = JSON.parse(await readFile(out, 'utf8')) as ControlsReport;
    } catch {
      throw new Error(
        `the phase-15 gate produced no report (electron exited ${String(exitCode)}).\n` +
          `--- electron output ---\n${output.slice(-8000)}`,
      );
    }
    // A report that says the run failed is exactly when the *unreported* half is worth
    // having, and until now it was discarded on this path: the electron output carries
    // every `note()` in order, Chromium's own stderr, and the `child process gone` line
    // above. The first CI failure of this gate was diagnosed without any of it, from an
    // encoder stall and a bare "Script failed to execute" — so it is printed rather than
    // thrown, which keeps the assertions' own messages the thing that fails the test.
    if (!report.ok) {
      console.log(`--- electron output ---\n${output.slice(-16000)}`);
    }
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let run: Promise<ControlsReport> | null = null;
function gate(): Promise<ControlsReport> {
  run ??= runProbe();
  return run;
}

function describeRun(report: ControlsReport): string {
  return [
    '',
    `recording   ${report.recording.id} ${report.recording.durationSec.toFixed(3)}s ` +
      `${String(report.recording.frameCount)} frames ${report.recording.size.join('x')}`,
    `logs        ${String(report.logs.cursorSamples)} cursor samples, ` +
      `${String(report.logs.clickDowns)} clicks`,
    `lanes       ${report.lanes.join(' | ')}`,
    `tools       ${report.tools.join(' ')}`,
    ...(report.error === '' ? [] : [`error       ${report.error}`]),
    ...report.readings.map(
      (r) =>
        `  ${r.label.padEnd(30)} t=${r.timelineSec.toFixed(2)} zoom=${r.zoom.amount.toFixed(3)} ` +
        `pic=${r.picture.hash} mask(mean=${r.picture.boxes[0]?.mean.map((v) => v.toFixed(0)).join('/') ?? '-'} ` +
        `var=${(r.picture.boxes[0]?.variance ?? 0).toFixed(1)}) ` +
        `panel(${r.panel.atPlayhead} @ ${r.panel.centre} yours=${r.panel.yours}` +
        `${offersManualControl(r) ? ' +take-control' : ''}) ` +
        `tracks=${r.tracks.map((t) => `${t.id}${t.generated ? '*' : ''}${t.baked ? '^' : ''}`).join(',')}` +
        (r.trouble === '' ? '' : ` TROUBLE "${r.trouble}"`),
    ),
    ...report.disk.map(
      (d) => `  disk ${d.label.padEnd(36)} rev=${String(d.revision)} ${d.trackIds.join(' > ')}`,
    ),
    ...report.exports.map(
      (e) =>
        `  export ${e.label.padEnd(12)} ${e.ok ? 'done' : `FAILED ${e.error}`} ` +
        `${e.durationSec.toFixed(3)}s ${String(e.bytes)}B verified=${String(e.verified)} ` +
        `frames=${e.frames.map((f) => `${f.label}:${f.hash}`).join(',')}`,
    ),
    ...report.deltas.map((d) => `  delta ${d.label.padEnd(10)} ${d.meanAbs.toFixed(3)} / 255`),
    ...(report.slider === null
      ? ['  slider      never driven']
      : [
          `  slider      ${String(report.slider.moves)} moves survived=${String(
            report.slider.survivedTheDrag,
          )} revisions=${String(report.slider.revisions)} ` +
            `(one step costs ${String(report.slider.controlRevisions)}) ` +
            `asked=${report.slider.asked.toFixed(2)} amount=${report.slider.amount.toFixed(3)}`,
        ]),
    ...(report.settled === null
      ? ['  return trip never driven']
      : [
          `  return trip showing=${report.settled.shownAmount.toFixed(3)} ` +
            `committed=${report.settled.committedAmount.toFixed(3)} ` +
            `revisions=${String(report.settled.revisions)}`,
        ]),
    '',
  ].join('\n');
}

/**
 * Is the captain's own row of the capability table on offer at this reading?
 *
 * By the button's visible text, because that is the claim: a person looking at this
 * panel can either take manual control from it or they cannot.
 */
function offersManualControl(reading: Reading): boolean {
  return reading.panel.buttons.some((label) => label.includes('Take manual control'));
}

function readingAt(report: ControlsReport, label: string): Reading {
  const found = report.readings.find((r) => r.label === label);
  if (found === undefined) throw new Error(`the gate never took a reading called "${label}"`);
  return found;
}

function diskAt(report: ControlsReport, label: string): OnDisk {
  const found = report.disk.find((d) => d.label === label);
  if (found === undefined) throw new Error(`the gate never read the disk at "${label}"`);
  return found;
}

function deltaAt(report: ControlsReport, label: string): number {
  const found = report.deltas.find((d) => d.label === label);
  if (found === undefined) throw new Error(`the gate never measured a delta called "${label}"`);
  return found.meanAbs;
}

describe('the editor’s controls', () => {
  it(
    'opens with every tool the compositor can render, and the two effect lanes',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      console.log(detail);

      expect(report.error, detail).toBe('');
      expect(report.ok, detail).toBe(true);
      expect(report.openedFromLibrary, detail).toBe(true);
      expect(report.lanes, detail).toEqual(['Screen', 'Zoom', 'Notes']);

      // Every annotation kind the rail claims, present as a real button. Bound to
      // `ANNOTATION_TOOLS` rather than to a copy of it, so a kind added to
      // `ANNOTATION_KINDS` and given a tool is covered here without an edit — and one
      // added and *not* given a tool fails `annotate.ts`'s own `satisfies` instead,
      // which is a compile error rather than a silently unreachable feature.
      expect(report.tools, detail).toEqual(['select', 'zoom', ...ANNOTATION_TOOLS]);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'runs a generator from its own button, over the recording’s real click log',
    async () => {
      const report = await gate();
      const detail = describeRun(report);

      expect(report.logs.clickDowns, detail).toBeGreaterThan(0);
      const after = diskAt(report, 'after generating');
      const generated = after.tracks.find((t) => t.generated);
      expect(generated, detail).toBeDefined();
      expect(generated?.origin, detail).toBe('generated');
      // §6.5's step 1 with `clusterGapSec = preRollSec + postRollSec + mergeGapSec`
      // puts the harness's four clicks in two clusters, and step 4 does not merge
      // them — so the track's `activeRanges` **is** the segment list, and there are
      // two of them. A single segment spanning the recording is the exact defect
      // `auto-zoom.ts` records having found on the ten real logs.
      expect(generated?.activeRanges, detail).toHaveLength(2);
      expect(generated?.keyTimes['amount']?.length, detail).toBeGreaterThan(4);

      // And it did something to the picture, which a document alone cannot claim.
      const before = readingAt(report, 'before any zoom, inside');
      const zoomed = readingAt(report, 'generated, inside');
      expect(before.zoom.amount, detail).toBeCloseTo(1, 3);
      expect(zoomed.zoom.amount, detail).toBeGreaterThan(1.2);
      expect(zoomed.picture.hash, detail).not.toBe(before.picture.hash);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'takes manual control: the user’s zoom wins INSIDE its window',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const generated = readingAt(report, 'generated, inside');
      const manual = readingAt(report, 'manual, inside');

      // §6.5's `amountRange` tops out at 2.5, so a resolved magnification above it at
      // this instant can only have come from the track the person made.
      expect(generated.zoom.amount, detail).toBeLessThanOrEqual(GENERATOR_MAX_AMOUNT + 0.01);
      expect(manual.zoom.amount, detail).toBeGreaterThan(GENERATOR_MAX_AMOUNT + 0.5);
      // And the picture followed it.
      expect(manual.picture.hash, detail).not.toBe(generated.picture.hash);
      expect(manual.picture.distinct, detail).toBeGreaterThan(64);
      expect(manual.trouble, detail).toBe('');

      // The region the editor is showing is the one the button was pressed inside.
      expect(manual.regions, detail).toHaveLength(1);
      expect(manual.regions[0]?.startSec, detail).toBeLessThanOrEqual(INSIDE_SEC);
      expect(manual.regions[0]?.endSec, detail).toBeGreaterThanOrEqual(INSIDE_SEC);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'drags the Amount slider: the element survives its own drag, and it is ONE undo step',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const slider = report.slider;
      expect(slider, detail).not.toBeNull();
      if (slider === null) return;

      // Non-vacuous first: a single synthetic `input` is not a drag, and it is
      // precisely what a slider destroyed by its own first event still survives.
      expect(slider.moves, detail).toBeGreaterThan(3);

      // This is the control on the one capability the captain named himself, so it has
      // to be usable — and "usable" here is a mechanical claim rather than a matter of
      // taste: the `<input type="range">` the gesture is holding is still
      // the one in the document when the gesture ends. Committing on `input` rebuilt
      // the panel over it, so the thumb stopped after one step — an interaction that
      // fails on first contact while every cheaper check still reports the right
      // number, because the *last* value it was given did land.
      expect(slider.survivedTheDrag, detail).toBe(true);

      // And one gesture is one edit — measured against one step of the same control on
      // the same document rather than against a number written here. `input` is
      // provisional and never sent, `change` commits once, so a six-step drag costs
      // exactly what a single change costs. A commit per step would leave the drag
      // needing as many undos as the pointer moved, which makes undo useless for the
      // one control this phase exists for.
      //
      // The control has to have cost something first: a step that committed nothing
      // would satisfy the equality with a slider that does not work at either length.
      expect(slider.controlRevisions, detail).toBeGreaterThan(0);
      expect(slider.revisions, detail).toBe(slider.controlRevisions);

      // The drag actually landed on what it asked for last, rather than on some
      // intermediate value a dropped `change` would have left behind.
      expect(slider.amount, detail).toBeCloseTo(slider.asked, 2);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'and a gesture that ends where it started leaves nothing provisional behind',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const settled = report.settled;
      expect(settled, detail).not.toBeNull();
      if (settled === null) return;

      // The branch no other gesture in this gate reaches: the last `input` and the
      // `change` both ask for a document that is already committed, so both produce no
      // ops. Returning early there would leave the moves on the way out showing — a
      // magnification that is in no `edit.json`, in the preview and in the panel, until
      // some later commit or undo happened by. Both numbers are measured: the second is
      // what the previous gesture actually committed, not a value written here.
      expect(settled.shownAmount, detail).toBeCloseTo(settled.committedAmount, 6);

      // And it is not an edit, because it changed nothing.
      expect(settled.revisions, detail).toBe(0);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'and DEFERS outside it — the control that makes the whole gate mean something',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const before = readingAt(report, 'generated, outside');
      const after = readingAt(report, 'manual, outside');

      // Same instant, before and after somebody took control of a *different* stretch.
      // Everything must be identical: the generator is still driving here, so this is
      // §3.5's `activeRanges` window doing its job. A manual track written with
      // `ALWAYS` would pass every other assertion in this file and fail this one.
      expect(after.zoom.amount, detail).toBeCloseTo(before.zoom.amount, 6);
      expect(after.zoom.center[0], detail).toBeCloseTo(before.zoom.center[0], 6);
      expect(after.picture.hash, detail).toBe(before.picture.hash);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'and the panel follows the playhead across the boundary — the numbers AND the button',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      // The same two readings the two tests above judge, either side of the manual
      // region's window: the second is reached from the first by an ordinary scrub,
      // which is the crossing and the path a person actually takes.
      const inside = readingAt(report, 'manual, inside');
      const outside = readingAt(report, 'manual, outside');

      // What a person can **see**, against what the model computed at that instant.
      // Read off the DOM and compared against the probe, because the defect this
      // covers lived exactly in the gap: the picture was right, `resolve` was right,
      // and the panel beside them was describing the moment of the last edit.
      for (const reading of [inside, outside]) {
        expect(reading.panel.atPlayhead, detail).toBe(`${reading.zoom.amount.toFixed(2)}×`);
        expect(reading.panel.centre, detail).toBe(
          `${reading.zoom.center[0].toFixed(3)}, ${reading.zoom.center[1].toFixed(3)}`,
        );
      }

      // Non-vacuous, and it has to be said: the two instants resolve to different
      // magnifications, so a panel frozen on either one fails the pair above. Without
      // this the agreement is satisfiable by a recording where both happen to match.
      expect(inside.panel.atPlayhead, detail).not.toBe(outside.panel.atPlayhead);

      // And the *shape* follows, in both directions — a panel that never offered the
      // button would otherwise pass half of this. Inside the user's own window there
      // is nothing left to take control of; outside it the generator is driving, which
      // is precisely when the captain's *"Manual option too."* means something, and it
      // is the instant a scrub arrives at.
      expect(inside.panel.yours, detail).toBe('yes');
      expect(offersManualControl(inside), detail).toBe(false);
      expect(outside.panel.yours, detail).toBe('no');
      expect(offersManualControl(outside), detail).toBe(true);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'leaves the generated track byte-for-byte alone, above it in the stack',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const before = diskAt(report, 'after generating');
      const after = diskAt(report, 'after taking manual control');

      // §3.5: *"Regeneration rewrites only the generated track. User edits survive by
      // construction, because they were never in that track."* The other half of that
      // sentence is this one: taking control must not touch the generated track.
      const generatedBefore = before.tracks.find((t) => t.generated);
      const generatedAfter = after.tracks.find((t) => t.generated);
      expect(generatedAfter, detail).toEqual(generatedBefore);

      // Track order is stacking order and `resolve` folds in it, so the manual track
      // has to be **after** the generated one in the array. A manual zoom written
      // first would leave a valid document and a wrong picture.
      expect(after.trackIds.length, detail).toBe(2);
      const generatedAt = after.trackIds.indexOf(generatedAfter?.id ?? '');
      const manualAt = after.trackIds.findIndex((id) => id === 't-zoom-manual');
      expect(manualAt, detail).toBeGreaterThan(generatedAt);
      expect(after.revision, detail).toBeGreaterThan(before.revision);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'REACHES THE EXPORTED FILE: two finished MP4s differ inside the window and agree outside it',
    async () => {
      const report = await gate();
      const detail = describeRun(report);

      // Both exports ran to completion and passed §7.5's five checks. A gate whose
      // exports failed would report a delta of zero for a reason that has nothing to
      // do with the editor.
      expect(report.exports, detail).toHaveLength(2);
      for (const finished of report.exports) {
        expect(finished.ok, detail).toBe(true);
        expect(finished.verified, detail).toBe(true);
        expect(finished.bytes, detail).toBeGreaterThan(0);
        // `keepSources`, so the recording is still editable for everything after this.
        expect(finished.sourcesDeleted, detail).toBe(false);
        expect(finished.frames.length, detail).toBe(2);
      }

      const inside = deltaAt(report, 'inside');
      const outside = deltaAt(report, 'outside');

      // Inside the user's window the two files show different pictures — the manual
      // zoom is in the second one. The bound is on the *mean absolute difference per
      // channel* over the whole frame, and it is generous on purpose: what is being
      // asserted is that the picture is materially different, not how different.
      expect(inside, detail).toBeGreaterThan(8);

      // Outside it they agree. Not bit-for-bit — the two files were encoded
      // separately and H.264 is lossy — but far closer than the difference above, and
      // by a margin no re-encode accounts for. This is the assertion that a defect
      // changing the picture *everywhere* fails.
      expect(outside, detail).toBeLessThan(3);
      expect(inside, detail).toBeGreaterThan(outside * 4);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'edits a keyframe with a drag on the lane, and undoes it',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const before = diskAt(report, 'after taking manual control');
      const dragged = diskAt(report, 'after dragging a keyframe');
      const undone = diskAt(report, 'after undoing the keyframe drag');

      // Every channel of the manual track, because the pointer went down on whichever
      // diamond the lane drew first at that instant and `amount` and `center` both
      // carry a key there. Which one moved is a fact about a pointer; *that one moved
      // and the document is still ordered* is the property.
      const keysOf = (entry: OnDisk): Record<string, number[]> =>
        entry.tracks.find((t) => t.id === 't-zoom-manual')?.keyTimes ?? {};

      const start = keysOf(before);
      const moved = keysOf(dragged);
      expect(Object.keys(start).sort(), detail).toEqual(['amount', 'center']);
      expect(start['amount']?.length, detail).toBe(4);
      expect(Object.keys(moved).sort(), detail).toEqual(Object.keys(start).sort());
      // A real pointer landed somewhere a pointer lands, so the assertion is that
      // *a* key moved and every channel is still strictly increasing — never that it
      // moved to a number the gate chose.
      expect(moved, detail).not.toEqual(start);
      for (const times of Object.values(moved)) {
        for (let i = 1; i < times.length; i++) {
          expect(times[i], detail).toBeGreaterThan(times[i - 1] ?? 0);
        }
      }
      expect(dragged.revision, detail).toBeGreaterThan(before.revision);

      // And the undo put it back — through the journal, at a *higher* revision,
      // because §2.7 makes an undo an edit rather than a rewind.
      expect(keysOf(undone), detail).toEqual(start);
      expect(undone.revision, detail).toBeGreaterThan(dragged.revision);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'places a mask with a drag on the picture: flat where it was drawn, untouched beside it',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const before = readingAt(report, 'manual, inside');
      const masked = readingAt(report, 'masked, inside');

      const box = (reading: Reading, label: string): { mean: number[]; variance: number } => {
        const found = reading.picture.boxes.find((b) => b.label === label);
        if (found === undefined) throw new Error(`no box called "${label}"`);
        return found;
      };

      // A mask is black and opaque, because *"make this unreadable" has one answer*
      // and a translucent one is not an answer. So inside the box the mean goes to
      // black and the variance collapses — a much stronger claim than "the picture
      // changed", and one a half-applied redaction fails.
      const inside = box(masked, 'mask');
      expect(inside.variance, detail).toBeLessThan(5);
      expect(Math.max(...inside.mean), detail).toBeLessThan(12);
      // Non-vacuous: the region was not already black. A gate that masked a black
      // patch would report success for a mask that never drew.
      expect(Math.max(...box(before, 'mask').mean), detail).toBeGreaterThan(60);

      // And the control: a patch of the frame the drag never went near is unchanged,
      // so the mask covered a *region* rather than the picture. Both halves are
      // needed — "unchanged" alone is satisfied by a corner that was already black,
      // so it is also required to be something other than what a mask leaves behind.
      const cornerBefore = box(before, 'corner');
      const cornerAfter = box(masked, 'corner');
      for (let channel = 0; channel < 3; channel++) {
        expect(cornerAfter.mean[channel] ?? 0, detail).toBeCloseTo(
          cornerBefore.mean[channel] ?? 0,
          0,
        );
      }
      expect(Math.max(...cornerAfter.mean), detail).toBeGreaterThan(60);

      // On disk, as a span on an annotation track — no new primitive.
      const disk = diskAt(report, 'after masking');
      const notes = disk.tracks.find((t) => t.id === 't-annotations');
      expect(notes?.spanIds, detail).toHaveLength(1);
      expect(
        masked.annotations.map((a) => a.kind),
        detail,
      ).toEqual(['mask']);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'bakes the generated track: manual, with the spec kept and the block removed',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const before = diskAt(report, 'after masking');
      const after = diskAt(report, 'after baking');

      const id = before.tracks.find((t) => t.generated)?.id;
      expect(id, detail).toBeDefined();
      const baked = after.tracks.find((t) => t.id === id);
      expect(baked?.origin, detail).toBe('manual');
      // `generated` is "carries a live `generator` block", and `baked` is
      // "`origin: manual` with a `generatedFrom`". §3.5 has no third state, and the
      // difference between these two fields is the whole of it.
      expect(baked?.generated, detail).toBe(false);
      expect(baked?.baked, detail).toBe(true);
      // The keys are untouched: a bake detaches a track from regeneration, it does
      // not recompute it.
      expect(baked?.keyTimes, detail).toEqual(before.tracks.find((t) => t.id === id)?.keyTimes);
      expect(after.trackIds, detail).toEqual(before.trackIds);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'keeps all of it when the window closes, through the journal and the snapshot',
    async () => {
      const report = await gate();
      const detail = describeRun(report);
      const live = diskAt(report, 'after baking');
      const closed = diskAt(report, 'after the editor window closed');

      // The round trip a person makes: edit, close, come back — read through a store
      // that has never seen the bundle before, after `EditorWindows` released it and
      // the final `edit.json` was written.
      expect(closed.trackIds, detail).toEqual(live.trackIds);
      expect(closed.tracks, detail).toEqual(live.tracks);
      expect(closed.revision, detail).toBe(live.revision);
    },
    GATE_TIMEOUT_MS,
  );
});
