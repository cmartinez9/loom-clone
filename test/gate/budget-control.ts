/**
 * Holding the phase-6 gate's frame budget to the compositor, and not to the host.
 *
 * §8 specifies *"no frame over 16 ms at a 1440p viewport"*, and the gate asserts it on
 * the single worst frame with no allowance: `overBudget === 0`, `maxMs <= 16.67`.
 * Those bounds are the compositor's to meet — **they are not relaxed here, and
 * `FRAME_BUDGET_MS` is not touched.**
 *
 * What they cannot survive on their own is a host that will not give *any* program a
 * whole frame's worth of uninterrupted CPU. On this machine the compositor measures a
 * 0.30 ms worst frame, two orders of magnitude under budget. On GitHub's macos-14
 * runners — an Apple Paravirtual GPU on a shared host — the same code has measured
 * worst frames of 82.1 ms and 140.6 ms beside p99s of 2.2 ms and 5.3 ms, and, on the
 * run that turned `main` red, 17.60 ms beside a p99 of 5.50 ms: one frame of 360,
 * under a millisecond the wrong side of a hard line, with every other frame a third of
 * the budget. That is host jitter, not a renderer. A bound asserted blind there fails
 * for a reason that has nothing to do with the code under test — and a bound merely
 * loosened to accommodate it would stop failing when the compositor really did
 * regress.
 *
 * So this follows `packages/sampler/test/rate-control.ts`, which follows
 * `packages/format/test/kill-mid-write.test.ts`, and ships a control: {@link burn},
 * a fixed span of pure arithmetic with none of the compositor's, the decoder's or
 * WebGL's code in it. It runs **in the same frames of the same windows** as the
 * measurement it is a control for — never before or after them, because two figures a
 * second apart are not two readings of one machine, and a host that stalls is not
 * stalling a moment later. Then:
 *
 * - **The control holds the budget** → this host can do this, so the bound is the
 *   compositor's and §8 is asserted exactly as it stands.
 * - **The control does not** — it stretched half a frame of arithmetic past a whole
 *   frame → the shortfall is *reported*, with the measured figure, rather than failed
 *   on.
 *
 * The second branch is deliberately not an escape hatch. The compositor is never
 * excused from compositing: it must still hold the ceiling the control just measured
 * ({@link expectTracksControl}), so a compositor that has actually got slow fails here
 * on any host, fast or slow. Only §8's *absolute* number is ever deferred, and only on
 * the evidence of a measurement taken in the same frames. `test/phase6-gate.test.ts`
 * runs a deliberately-slowed compositor through the same instrument in the same run and
 * requires it to miss §8's number whichever branch this host took, and to miss the
 * tracking ceiling as well wherever that phase's own control cleared the budget — the
 * one place the ceiling is guaranteed to sit below {@link SLOW_COMPOSITE_MS}, since a
 * stalled control can earn one above it. `test/budget-control.test.ts` proves the policy
 * itself, that boundary included.
 *
 * ## Why a spin, and why half a budget of it
 *
 * The control has to be *exposed* to whatever the host does. Exposure is occupancy: a
 * stall lands inside a window in proportion to how much of the frame that window
 * occupies, so a control that costs nothing would sit beside every stall it is meant
 * to catch and report a healthy machine forever. {@link CONTROL_TARGET_MS} is half of
 * one 60 Hz refresh, taken once per {@link CONTROL_PERIOD_MS} — a quarter of the wall
 * clock, against the ~30% of each frame an honest CPU-backed 4K upload occupies on the
 * paravirtual runner. Comparable exposure, and the claim it supports is a plain one:
 * *this host stretched half a frame of arithmetic past a whole frame.* Nothing that
 * does that can promise a 16.67 ms frame to anybody.
 *
 * It costs a quarter of the renderer's main thread for the length of the measured
 * phases. That is the price of a control that shares the window rather than guessing
 * at it, and {@link CONTROL_PERIOD_MS} is where the bill was negotiated down from a
 * version that broke the run it was measuring.
 */

import { FRAME_BUDGET_MS, FrameMetrics } from '../../apps/renderer/src/preview/frame-metrics.ts';

/**
 * What each spin is asked to cost. Half of one 60 Hz refresh — see above.
 *
 * Fixed, and deliberately independent of anything the compositor does: a target
 * derived from the measured frame would rise with a compositor that got slower, and
 * the control would excuse exactly the regression it exists to catch.
 */
export const CONTROL_TARGET_MS = FRAME_BUDGET_MS / 2;

/**
 * How often a spin is allowed, in wall clock — **not** once per frame.
 *
 * Once per frame is what this was first written as, and it is wrong for a reason worth
 * keeping: the display's refresh rate is not the gate's to choose. On a 120 Hz panel
 * "half a budget per frame" is a whole second of arithmetic per second — the renderer's
 * main thread, entire — and the run that proved it starved the decoder so thoroughly
 * that every one of twelve scrub targets timed out at four seconds, decode delivered 85
 * frames instead of 197, and playback went from no misses to 507. A control that
 * changes what it is measuring is not a control.
 *
 * Pacing by wall clock instead makes the cost the same on any panel: one spin per two
 * refreshes, a 25% duty cycle, against the ~30% of each frame an honest CPU-backed 4K
 * upload occupies on the paravirtual runner. Comparable exposure to a host stall, a
 * quarter of the thread, and the same number either way.
 */
export const CONTROL_PERIOD_MS = FRAME_BUDGET_MS * 2;

/**
 * How far under the budget the control has to land before the budget is the
 * compositor's to meet.
 *
 * **One.** The only thing that defers §8's number is a host that has *actually
 * exceeded* it — that stretched half a frame of arithmetic past a whole frame, and so
 * cannot promise 16.67 ms to anybody. Anything short of that has not demonstrated it
 * cannot hold the budget, and does not get to speak for the compositor.
 *
 * This was 0.8 for a margin's sake — the control and the frame are two workloads
 * sampled in the same frames rather than two readings of one quantity, so a control
 * clearing the budget by a hair is not the same as a host holding it — and the margin
 * cost more than it bought. It let a control reading 14.50 ms, 2.17 ms *under* §8's
 * number, route a phase to the deferred branch, where a real 20.20 ms frame from a
 * regression patched into `Compositor.render` was judged against 21.75 ms and excused.
 * On this machine, where the compositor composites in 0.20 ms, every phase of every
 * clean run deferred: the six controls read 17.30 to 34.40 ms against a 13.33 ms bar,
 * so the absolute pair the gate exists to assert never ran. At 1 those same readings
 * still defer, honestly, because they are over the budget itself.
 *
 * The margin is not lost, only moved to where it cannot excuse a frame: on the
 * deferred branch {@link TRACKS_CONTROL} is what allows for the two workloads being
 * sampled separately.
 *
 * This is not a relaxation of the bound. It decides *whose* bound it is, and on the
 * clearing side — now every host that holds the budget at all — the bound is asserted
 * exactly as written.
 */
export const CLEARS_BUDGET = 1;

/**
 * How closely the compositor must track a ceiling the host has just shown it cannot
 * exceed.
 *
 * Above 1 because the control and the frame are sampled separately within each frame:
 * a stall lands in one or the other, so the worst frame may legitimately land above
 * the worst spin. Its job is to catch a compositor that is far worse than the host it
 * is running on, which is the compositor's fault however slow that host is — the
 * 66.67 ms deliberately-slowed path in the harness clears this by more than 2.5×, on
 * any control reading that could have excused it.
 */
export const TRACKS_CONTROL = 1.5;

/**
 * The control for this control: how far past the budget the harness pushes a
 * deliberately-slowed compositor, burned inside `render` on every frame of that phase.
 *
 * Four budgets, not one over. The point is not that a slowed compositor scrapes past the
 * line but that it fails whichever branch of the judgement above the host puts it on —
 * §8's absolute number on any host at all, and additionally {@link TRACKS_CONTROL}'s
 * ceiling wherever the phase's own control cleared the budget, since the most such a
 * control can earn is `FRAME_BUDGET_MS * CLEARS_BUDGET * TRACKS_CONTROL` — 25 ms — and
 * this clears that by more than two and a half times.
 *
 * It lives here, beside the two constants it has to stay in that relation to, rather
 * than in the harness that burns it: the relation is what `test/phase6-gate.test.ts`'s
 * slow-compositor branch turns on, and `test/budget-control.test.ts` pins it from this
 * declaration rather than from a copy of the number.
 */
export const SLOW_COMPOSITE_MS = FRAME_BUDGET_MS * 4;

/** One phase's worth of control samples, measured beside that phase's frames. */
export interface ControlPhase {
  /** What each spin was asked to cost: {@link CONTROL_TARGET_MS}. */
  targetMs: number;
  /** How often one was allowed: {@link CONTROL_PERIOD_MS}, in wall clock. */
  periodMs: number;
  /** Spins measured. Zero means the control did not run — see {@link environmentSustainsBudget}. */
  count: number;
  /** The worst spin: what this host did to a fixed span of arithmetic. */
  maxMs: number;
  /** Which spin of the phase {@link maxMs} was, so a stall can be placed in the run. */
  maxAt: number;
  meanMs: number;
  /** Spins that came back over one 60 Hz refresh. */
  overBudget: number;
}

export interface BudgetEvidence {
  /** Named for the failure message and the report: `'scrub'`, `'play'`. */
  what: string;
  /** §8's number, passed in rather than redeclared, so there is one of it. */
  budgetMs: number;
  /** The phase's frames, as `PreviewLoop` measured them. */
  measured: { count: number; maxMs: number; maxAt: number; overBudget: number };
  /** The control, measured in those same frames. */
  control: ControlPhase;
}

/** Kept out of the optimiser's reach, and printed at the end of the run. */
let sink = 0;

/**
 * Burn `targetMs` of wall clock on arithmetic and report what it actually took.
 *
 * No GL, no decode, no allocation, no clock-reading loop pretending to be work: a
 * fixed block of floating-point between clock reads, so what is measured is the host's
 * willingness to run a thread rather than the cost of asking it the time. The result
 * accumulates into a module-level `sink` that {@link controlSink} reads, because a
 * loop whose result is never used is a loop an optimiser is entitled to delete.
 */
export function burn(targetMs: number): number {
  const started = performance.now();
  let local = sink;
  let elapsed = 0;
  do {
    for (let i = 1; i <= 4096; i++) local = (local + Math.sqrt(i)) % 1_000_003;
    elapsed = performance.now() - started;
  } while (elapsed < targetMs);
  sink = local;
  return elapsed;
}

/** The accumulated result of every {@link burn}. Logged so the spin cannot be elided. */
export function controlSink(): number {
  return sink;
}

/**
 * The environment control, armed for one phase at a time.
 *
 * `tick()` belongs immediately after the frame callback the gate is measuring, inside
 * the same scheduler dispatch — that is what "in the same frames" means here, and it
 * is the whole reason this is worth anything. `FrameMetrics` is reused rather than
 * reimplemented so the control's `overBudget` is counted against exactly the number
 * the frames' is.
 */
export class EnvironmentControl {
  readonly targetMs: number;
  readonly periodMs: number;
  readonly #metrics: FrameMetrics;
  #armed = false;
  #lastSpinAtMs = -Infinity;

  constructor(targetMs: number = CONTROL_TARGET_MS, periodMs: number = CONTROL_PERIOD_MS) {
    this.targetMs = targetMs;
    this.periodMs = periodMs;
    this.#metrics = new FrameMetrics(4096, FRAME_BUDGET_MS);
  }

  arm(): void {
    this.#armed = true;
  }

  disarm(): void {
    this.#armed = false;
  }

  /**
   * One spin, if armed and if {@link CONTROL_PERIOD_MS} has passed since the last one.
   *
   * Called from every scheduled frame, after the frame's own work; how many of those
   * calls actually spin is decided by the clock rather than by the display, for the
   * reason {@link CONTROL_PERIOD_MS} gives.
   */
  tick(): void {
    if (!this.#armed) return;
    const now = performance.now();
    if (now - this.#lastSpinAtMs < this.periodMs) return;
    this.#lastSpinAtMs = now;
    this.#metrics.record(burn(this.targetMs));
  }

  snapshot(): ControlPhase {
    return {
      targetMs: this.targetMs,
      periodMs: this.periodMs,
      count: this.#metrics.count,
      maxMs: this.#metrics.maxMs,
      maxAt: this.#metrics.maxAt,
      meanMs: this.#metrics.meanMs,
      overBudget: this.#metrics.overBudget,
    };
  }

  reset(): void {
    this.#metrics.reset();
  }
}

/** A control that never ran. For the report shapes that exist before one does. */
export const NO_CONTROL: ControlPhase = {
  targetMs: CONTROL_TARGET_MS,
  periodMs: CONTROL_PERIOD_MS,
  count: 0,
  maxMs: 0,
  maxAt: -1,
  meanMs: 0,
  overBudget: 0,
};

/**
 * Whether §8's bound is this host's to meet — and therefore asserted as written.
 *
 * **A control that produced nothing returns `true`.** A control that did not run has
 * shown nothing about the host, and "shown nothing" must never buy the compositor a
 * weaker bound; the gate asserts the control's own sample count separately, so a
 * silently dead control fails there rather than quietly disabling the gate here.
 */
export function environmentSustainsBudget(control: ControlPhase, budgetMs: number): boolean {
  if (control.count === 0) return true;
  return control.maxMs <= budgetMs * CLEARS_BUDGET;
}

/**
 * The branch where the host, not the compositor, missed §8's number.
 *
 * Returns the line the caller should report. **Throws — the gate fails — whenever the
 * compositor is the one that came up short**, which is what stops this branch from
 * being a way to pass by compositing slowly on a busy machine.
 */
export function expectTracksControl(evidence: BudgetEvidence): string {
  const { what, budgetMs, measured, control } = evidence;
  const ceiling = control.maxMs * TRACKS_CONTROL;
  if (measured.maxMs > ceiling) {
    throw new Error(
      `${what}: worst frame ${fmt(measured.maxMs)} ms at frame ${measured.maxAt}, over the ` +
        `${fmt(ceiling)} ms ceiling this host earned — ${TRACKS_CONTROL}x the ${fmt(control.maxMs)} ms ` +
        `it took to do ${fmt(control.targetMs)} ms of arithmetic in these same frames. The ` +
        `compositor cannot hold this machine's own ceiling, which is the compositor's fault ` +
        `however slow the machine is. ${figures(control, budgetMs)}`,
    );
  }
  return (
    `${what}: this environment cannot sustain the ${fmt(budgetMs)} ms frame budget §8 requires — ` +
    `${figures(control, budgetMs)}. The worst frame was ${fmt(measured.maxMs)} ms ` +
    `(${measured.overBudget} of ${measured.count} frames over budget) and is held to tracking ` +
    `that measured ceiling instead. See test/gate/budget-control.ts; §8's number is asserted ` +
    `exactly as written on any host whose control clears it.`
  );
}

function figures(control: ControlPhase, budgetMs: number): string {
  return (
    `${fmt(control.targetMs)} ms of pure arithmetic, run every ${fmt(control.periodMs)} ms in ` +
    `these same frames with none of the compositor's code, took up to ${fmt(control.maxMs)} ms ` +
    `across ${control.count} spins ` +
    `(mean ${fmt(control.meanMs)} ms, ${control.overBudget} over the ${fmt(budgetMs)} ms budget, ` +
    `worst at spin ${control.maxAt})`
  );
}

/** Readable in a failure message; never used for the comparison itself. */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
