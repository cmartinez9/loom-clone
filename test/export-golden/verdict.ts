/**
 * Whether the phase 8 gate has a verdict to give at all.
 *
 * `test/gate/budget-control.ts` asks the same question of the phase 6 gate and this
 * borrows its vocabulary deliberately — {@link instrumentOutOfCalibration}, a withheld
 * judgement, a **NOT JUDGED** banner, a test that reports *skipped* rather than passed.
 * One idea, one set of words. It is a separate, differently-typed function for the
 * reason `relaunch.ts` states about the two gates' relaunch predicates: phase 6's is
 * typed to phase 6's report, and a predicate two gates share is a predicate a widening
 * in one gate silently applies to the other. Sharing the *code* is a later change and
 * belongs to whoever owns both files at once.
 *
 * ## What "out of calibration" means here
 *
 * Phase 6's instrument is a stopwatch and it comes back wrong. This gate's instrument
 * is the pair of WebGL2 contexts the two paths composite into, and it comes back
 * **absent**: Chromium exits the GPU process when a context is lost and takes every
 * context living in it, so after that every GL call is a no-op, `readPixels` refuses,
 * and there is nothing to compare. Measured on CI run 31094399329, and it is the same
 * five lines every time:
 *
 * ```
 * export writer open at …/Golden.mp4
 * ERROR:gpu/command_buffer/service/dawn_context_provider.cc:120] Failed to allocate texture.
 * ERROR:components/viz/service/gl/exit_code.cc:13] Restarting GPU process due to
 *     unrecoverable error. Context was lost.
 * GPU process gone: abnormal-exit (exit 8704)
 * renderer: WebGL: CONTEXT_LOST_WEBGL
 * ```
 *
 * The gate already earns one relaunch for exactly that, through `shouldRelaunchGolden`,
 * and that predicate is `report.contextLost` and nothing else — correct, and untouched
 * here. What was missing is the other end: when **every** launch is taken away, the
 * gate used to fail on `expect(report.contextLost).toBe(false)` and print a
 * pixel-identity verdict for a run whose own report says `samples n=0`,
 * `identity max delta=-1`, `export did not run`. §4.5's per-pixel zero was neither met
 * nor missed on that run. It was not measured.
 *
 * ## The hazard this would be unsound without, and what rules it out
 *
 * Withholding is only honest while **a defect in the export path cannot itself provoke
 * the context loss**. If it could, a real regression would starve the GPU process,
 * reach this branch and convert its own failure into "inconclusive" — which is worse
 * than the red builds it fixes, because phase 9 deletes a user's only copy of the raw
 * sources on the strength of an export this gate is supposed to be judging.
 *
 * It cannot, and the argument is structural rather than statistical. **The export path
 * has no per-frame GPU allocation to leak, and the one thing it does allocate per frame
 * is freed in a `finally` in the same statement:**
 *
 *  - `Compositor` allocates in its constructor and nowhere else — one screen texture,
 *    one render target, deleted only in `dispose()`. `#draw` re-specifies that same
 *    texture with `texImage2D`; it never creates one. `GpuTimer` creates exactly one
 *    query, lazily, and reuses it (`this.#query ??= gl.createQuery()`). So the
 *    compositor's GPU residency at output frame 168 is what it was at frame 1, whatever
 *    the code does with the pixels in between.
 *  - `ExportRenderLoop.renderAt` allocates nothing at all: it resolves state, borrows a
 *    frame the ring owns, composites, presents, and drops the reference. Its own
 *    docblock says so — *"No path out of this function keeps a frame alive (§10.2)"*.
 *  - `VideoExportEncoder.encode` is the one per-frame GPU object in the pass —
 *    `new VideoFrame(canvas, …)` — and it is closed in a `finally` in the same
 *    synchronous statement that encodes it, so it cannot outlive the call whatever the
 *    encoder does with it. Queue depth is bounded by `MAX_QUEUE` in `drain()`.
 *  - The decode side's leak — §10.2's named failure, *"forget one `close()` in an error
 *    path and the decoder's output pool exhausts"* — is bounded **in JavaScript, ahead
 *    of any allocation**: `FrameLedger.acquire` throws `FrameLeakError` on the *first*
 *    frame past the ring cap of 20. That defect therefore arrives as a thrown error
 *    with `contextLost: false`, on the branch below that judges rather than the one that
 *    withholds.
 *
 * So there is no defect *of omission* available in the code under test that grows GPU
 * residency: every bound is either a fixed allocation made once, a `finally`, or a JS
 * counter that trips first.
 *
 * **Three readings agree with the argument**, and are worth more than it alone:
 *
 *  1. *The allocation that fails is Chromium's own, in the GPU process.*
 *     `dawn_context_provider.cc:120` is the browser's device-side allocator failing to
 *     serve an ordinary texture request; the size of that request is fixed by
 *     `FIXTURE_SIZE` and `OUTPUT_SIZE`, which the **harness** chooses and the product
 *     never sees.
 *  2. *Only harness-side resource knobs have ever moved it.* `harness.ts`'s
 *     `disposePath` and `OUTPUT_SIZE` record the two reductions — four contexts to two,
 *     1920x1080 to 1280x720 to 1024x576 with a 768x432 output — and **not one assertion
 *     changed with either**. A crash the export path was provoking would not answer to
 *     the fixture's resolution.
 *  3. *It does not walk.* A leak crosses a fixed limit at a reproducible frame count.
 *     This has fired at output frame 15 (run 31094399329) and at 112 of 168 on an
 *     earlier run of the same code — no progression, which is a host that sometimes
 *     cannot serve an allocation rather than a curve reaching a threshold. And run
 *     31080229527 ran the *same* export path on `main` to `samples n=24 worst delta=0`
 *     with the file verified.
 *
 * **Scoped rather than overstated**, in the same division phase 6's makes: this is an
 * argument about *defects in the existing code*, where every GPU bound is structural. A
 * change that **adds** an unbounded GPU allocation — a texture per frame, a `VideoFrame`
 * held across a turn, a second context — is new code rather than a regression in
 * existing code, and it would re-open the question. If you add one, the thing to check
 * is not this file: it is whether the new allocation has a bound of the same kind as the
 * four above.
 *
 * ## The one guard that makes the branch safe where phase 6's ordering cannot
 *
 * Phase 6 puts its `skip()` **last**, so everything else has already been asserted and a
 * withheld verdict cannot suppress a real one. This gate cannot do that: a lost context
 * empties the report, so every assertion below would fail and the branch has to come
 * first. The safety therefore has to live in the predicate, and it does —
 * {@link readingsTaken} enumerates **every** reading *of the subject* a `GoldenReport`
 * can carry, field by field, and one of them is enough to refuse to withhold. That is
 * `mayDeleteSources`'s discipline applied here: refuse on what the record *says*, field
 * by field rather than by `error === undefined`, because a record claiming some of it is
 * one to refuse whatever else it says. What that list leaves out — the fixture that was
 * fed in and the host it ran on, neither of which is a reading of the subject — is a
 * deliberate exclusion argued at {@link readingsTaken} itself, not a gap to close.
 *
 * **Honest about its reach:** today the harness's catch-all builds an empty report on
 * any throw, so a run that lost the context has nothing in those fields and the guard
 * is a property of this predicate rather than a case CI currently produces. Keeping
 * partial readings from a run whose GPU process died was considered and rejected — this
 * gate's whole stance is that such a run is not a reading (`readPixels` refuses,
 * `contextWasLost` asks the contexts themselves) — so judging half of one would adopt
 * the opposite stance in the one place it matters most. The guard stays because the
 * report shape is not frozen and the branch below runs before every assertion in the
 * gate.
 */

import type { GoldenReport } from './report.ts';
import { COVERAGE_PROBE_NOT_REACHED } from './report.ts';

/**
 * Launches that must have been taken away before a verdict may be withheld.
 *
 * Two, and it is deliberately **not** written as `=== GATE_ATTEMPTS`. Stated as a floor
 * of its own, lowering the gate's attempt count can only ever make this stricter — it
 * cannot quietly turn a single lost context into a withheld verdict. One loss is a
 * shared host having a moment and is what the relaunch exists to absorb; withholding
 * §4.5's verdict is a heavier thing than launching again, and it wants more than one
 * observation behind it.
 */
export const MIN_LOST_LAUNCHES = 2;

/**
 * Every reading this report carries, named. Empty means there is nothing to judge.
 *
 * Field by field, and the fields are `GoldenReport`'s own: `-1` and `null` are what the
 * two failure paths (`harness.ts`'s catch-all and `main.ts`'s `failureReport`) write
 * where a number or an object would go, so "was this measured?" is answerable without
 * trusting `ok` or `error`. A single entry here is enough to refuse to withhold: the
 * gate then judges the run and fails on it, which is the right way round.
 *
 * ## What is deliberately not on this list
 *
 * `report.fixture` and `report.environment` are **excluded on purpose**. This is not an
 * incomplete enumeration, and it is not an oversight: do not finish it.
 *
 * This function answers exactly one question — *was the subject measured*, i.e. was a
 * single pixel of the export ever compared. `fixture` describes the **input** that was
 * fed in (its size, its frame count, its longest hold); `environment` describes the
 * **host** it ran on (the renderer string, the Electron and Chrome versions). Neither is
 * a reading of the subject. A run that built a fixture, read a renderer string and then
 * lost the GPU before comparing anything measured **nothing**, and withholding is the
 * correct outcome for it.
 *
 * Counting those fields would make that run judge-and-fail instead — which is precisely
 * the flakiness this branch exists to remove, reintroduced in exactly the future the
 * guard was written for: a partial-report writer that stops emitting an empty report on
 * a throw and keeps the two cheapest fields to preserve. Widening the list is
 * directionally conservative, and conservative in the **wrong dimension**: being more
 * willing to fail is a virtue only where the extra failures are real, and these would be
 * failures on runs where nothing was measured.
 */
export function readingsTaken(report: GoldenReport): string[] {
  const readings: string[] = [];
  if (report.ok) readings.push('the harness reported the run as successful');
  if (report.samples.length > 0) {
    const worst = report.samples.reduce((max, s) => Math.max(max, s.maxDelta), 0);
    readings.push(
      `${String(report.samples.length)} of §4.5's timestamps were compared (worst delta ${String(worst)})`,
    );
  }
  if (report.identityMaxDelta >= 0) {
    readings.push(`the identity control read ${String(report.identityMaxDelta)}`);
  }
  if (report.controls.length > 0) {
    readings.push(
      `${String(report.controls.length)} divergence control(s) reported: ` +
        report.controls.map((c) => `${c.name}=${String(c.maxDelta)}`).join(', '),
    );
  }
  if (report.liveFramesAtEnd >= 0) {
    readings.push(`the live frame count was taken (${String(report.liveFramesAtEnd)})`);
  }
  if (report.exported !== null) readings.push('the end-to-end export produced a file');
  if (report.cancelLeftBehind !== null) {
    readings.push('the cancellation probe listed the output directory');
  }
  if (report.coverage.tripwire.detail !== COVERAGE_PROBE_NOT_REACHED) {
    readings.push(`the §4.5 coverage tripwire ran: ${report.coverage.tripwire.detail}`);
  }
  return readings;
}

/**
 * Was the instrument out of calibration on **every** launch this run was given?
 *
 * Two measured facts and nothing else — not CI, not an environment variable, not the
 * renderer string, not `report.ok`, not `report.error`, and not
 * {@link GoldenReport.gpuProcessGone}, which is printed as evidence and never consulted
 * (a context can be lost without the process exiting, and a run that produced no
 * reading produced no reading either way):
 *
 *  1. **every** attempt reported `contextLost`, and there were at least
 *     {@link MIN_LOST_LAUNCHES} of them;
 *  2. **no** attempt carries a reading — {@link readingsTaken} is empty for all of them.
 *
 * The second is the load-bearing half and the reason the branch is safe to run before
 * the gate's assertions rather than after them. See this file's header.
 */
export function instrumentOutOfCalibration(attempts: readonly GoldenReport[]): boolean {
  if (attempts.length < MIN_LOST_LAUNCHES) return false;
  return attempts.every((report) => report.contextLost && readingsTaken(report).length === 0);
}

/** One line per launch: what was taken away, on whose word, and what was not read. */
export function withheldJudgement(attempts: readonly GoldenReport[]): string[] {
  return attempts.map((report, i) => {
    const chromium = report.gpuProcessGone ?? 'no GPU-process exit was reported to main';
    const harness = report.error === undefined || report.error === '' ? 'no detail' : report.error;
    return (
      `launch ${String(i + 1)} of ${String(attempts.length)}: NOT JUDGED — the WebGL ` +
      `context was taken away before anything was compared. Chromium: ${chromium}. ` +
      `The harness: ${harness}. Nothing was read: samples n=` +
      `${String(report.samples.length)}, identity max delta=` +
      `${String(report.identityMaxDelta)}, ${String(report.controls.length)} divergence ` +
      `control(s), export ${report.exported === null ? 'did not run' : 'ran'}.`
    );
  });
}

/**
 * The withheld verdict, printed where nobody can skim past it.
 *
 * A vitest line reading `✓ agrees at 24 timestamps` is a claim, and on a run that
 * compared nothing it is a claim nothing established. So a run that gets here says so
 * in a block of its own, and the test is then marked **skipped** rather than passed —
 * see the call site. The two together are the requirement that this must never read as
 * a pass.
 */
export function notJudgedBanner(withheld: readonly string[]): string {
  const rule = '='.repeat(78);
  return [
    '',
    rule,
    '  PHASE 8 GATE — NO VERDICT. §4.5’s per-pixel zero was NOT JUDGED on this run.',
    '  This is not a pass. Nothing here says preview and export agree, and nothing',
    '  here says they disagree: the WebGL contexts both paths composite into were',
    '  taken away on every launch this gate is given, so no pixel was ever compared.',
    '  The report says so in its own numbers — n=0 samples, an identity control of',
    '  -1, no export. What each launch lost, and on whose word, is below: a line',
    '  naming a GPU-process exit is Chromium’s account; one saying none reached main',
    '  is the contexts themselves answering `isContextLost()`.',
    '',
    '  A run whose context survived is judged exactly as before, and fails on a',
    '  single differing pixel. A run that compared anything at all — one timestamp,',
    '  one control, one file — is judged rather than withheld; see `readingsTaken`',
    '  in test/export-golden/verdict.ts.',
    rule,
    ...withheld.map((line) => `  ${line}`),
    rule,
    '',
  ].join('\n');
}
