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
 * ## The other half of the question: is this host running the product's workload?
 *
 * The control above is pure arithmetic, and that is what makes it a control — but it
 * also makes it structurally blind to the one path where a virtualised runner's cost
 * actually lives. It answers *"will this host give a thread a whole frame?"* and it
 * cannot answer *"is a frame here the same piece of work a frame is on the machines
 * this ships to?"* On GitHub's macos-14 runners it has answered the first with a
 * confident yes — 10.10 ms worst spin, 8.47 ms mean, nothing over budget — while §8
 * failed on a 17.20 ms frame beside a 5.00 ms p99. Nothing in that control could have
 * seen the cost that produced it.
 *
 * What produced it is structural. loom-clone ships on macOS 14+ Macs, every one of
 * which has a hardware H.264 decoder, and ANGLE-Metal binds a hardware-decoded frame's
 * IOSurface rather than copying it (§12.4 measured that upload at 0.000 ms). A host
 * with no hardware decoder hands the compositor CPU-backed frames instead, and the same
 * `texImage2D` converts and uploads ~30 MB per frame. That is not a slower version of
 * the product's frame; it is a frame with a 30 MB copy in it that the product's frame
 * does not contain, and no user of this app will ever run it. Measuring how often it
 * trips a 16.67 ms budget says nothing about the compositor.
 *
 * So {@link hostRepresentsTarget} is the second half of the branch condition, and
 * {@link assertsAbsoluteBudget} is the pair. Where the host runs the product's workload
 * §8 is asserted exactly as it stands, whatever it measures; where it structurally
 * cannot, the absolute per-frame number is deferred and the figures are reported.
 *
 * ## What the deferred branch asks, and which door asked it
 *
 * Two doors reach {@link expectTracksControl} and they do not carry the same bound,
 * because the ceiling is only *relief* on one of them. A control that failed
 * {@link environmentSustainsBudget} read past 16.67 ms, so {@link TRACKS_CONTROL}× it is
 * past 25 ms — looser than §8, which is what a bound you fall *to* has to be. A host that
 * merely is not this product's machine had a *healthy* control beside it, where the same
 * multiple is 12.60 ms — tighter than §8, on the one branch whose purpose is not failing a
 * host for being a different machine. So the ceiling is asked only of the first door.
 *
 * What both doors keep is {@link overBudgetRate}: the compositor must miss the budget no
 * oftener than the host missed it in the same frames, a plain `>` with no factor, floored
 * at {@link spinResolution} so a share the control could not have resolved is reported
 * inconclusive rather than failed. On the representativeness door that share is the only
 * per-frame judgement left, which is why `test/phase6-gate.test.ts` runs a
 * deliberately-slowed compositor through the same instrument in the same run and requires
 * it to miss §8's number on every host **and** to be caught by the deferred branch's own
 * bound — the share, overwhelmingly, since a path burning four budgets on every frame
 * misses the budget on all of them. `test/budget-control.test.ts` proves the policy
 * itself, both doors included.
 *
 * ## Why a spin, and why half a budget of it
 *
 * The control has to be *exposed* to whatever the host does. Exposure is occupancy: a
 * stall lands inside a window in proportion to how much of the frame that window
 * occupies, so a control that costs nothing would sit beside every stall it is meant
 * to catch and report a healthy machine forever. {@link CONTROL_TARGET_MS} is half of
 * one 60 Hz refresh, and {@link CONTROL_PERIOD_MS} of wall clock has to pass after each
 * spin ends before the next may start — a fifth of the clock on a host doing what it
 * was asked, against the ~30% of each frame an honest CPU-backed 4K upload occupies on
 * the paravirtual runner. The same order of exposure, and the claim it supports is a
 * plain one: *this host stretched half a frame of arithmetic past a whole frame.*
 * Nothing that does that can promise a 16.67 ms frame to anybody.
 *
 * It costs a fifth of the renderer's main thread for the length of the measured
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
 * How much wall clock has to pass **after a spin ends** before the next may start —
 * and **not** once per frame.
 *
 * Once per frame is what this was first written as, and it is wrong for a reason worth
 * keeping: the display's refresh rate is not the gate's to choose. On a 120 Hz panel
 * "half a budget per frame" is a whole second of arithmetic per second — the renderer's
 * main thread, entire — and the run that proved it starved the decoder so thoroughly
 * that every one of twelve scrub targets timed out at four seconds, decode delivered 85
 * frames instead of 197, and playback went from no misses to 507. A control that
 * changes what it is measuring is not a control.
 *
 * Pacing by wall clock instead makes the cost the same on any panel: on a host doing
 * what it was asked, 8.33 ms of arithmetic per 41.67 ms of clock — a fifth of the
 * thread, the same order as the ~30% of each frame an honest CPU-backed 4K upload
 * occupies on the paravirtual runner, and the same number on any panel.
 *
 * **From the end of the last spin, not from its start**, and that is the whole of it.
 * Measured from the start, the interval between spins is `spinDuration + frameGap`
 * rather than a period, so a spin whose own elapsed time reaches this number satisfies
 * the gate on the very next frame — and every frame after it. Past a 3× dilation of
 * {@link CONTROL_TARGET_MS} the wall-clock pacing therefore collapses into exactly the
 * per-frame pacing above, by a positive feedback loop: the slower the host, the harder
 * the control loads it, on precisely the saturated hosts the control exists to
 * characterise, and the run reddens on timed-out scrub targets rather than deferring.
 * Measured from the end, the host gets a whole period of the clock back after every
 * spin however long that spin took, so the arithmetic the control demands per second
 * *falls* as the host dilates instead of rising.
 */
export const CONTROL_PERIOD_MS = FRAME_BUDGET_MS * 2;

/**
 * How many scheduled frames one spin covers on a panel refreshing at `refreshHz`.
 *
 * Everything the gate asserts about the control's sample count is a reading of this
 * function rather than a number written out beside it, because the two are the same
 * fact: `tick()` is called once a frame and tests eligibility there, so a spin lands on
 * **the first frame boundary strictly after `CONTROL_TARGET_MS + CONTROL_PERIOD_MS` of
 * clock has passed** — 41.67 ms — and never on the boundary that merely reaches it,
 * since the spin starts after the frame's own body rather than at the boundary itself.
 * Hence `floor` plus one rather than `ceil`:
 *
 * - 60 Hz → 3 frames (50 ms between spins, a 16.7% duty)
 * - 120 Hz → 6 (50 ms, 16.7%; measured at 5.6 on the 120 Hz machine this was written
 *   on, which is what an upper bound should look like beside a real reading)
 * - 240 Hz → 11 (45.83 ms, 18.2%)
 *
 * Two consequences the panel decides and the gate must not assume: the duty is *at
 * most* the fifth {@link CONTROL_PERIOD_MS} argues for, quantisation only ever lowering
 * it; and how many frames a control sample speaks for grows with the refresh rate, so
 * **both** the ratio guard and the spin floors are read off the fastest panel the gate
 * expects to meet — that is where one sample stands for the most frames and a phase
 * therefore yields the fewest spins, which is the only side either can be derived from.
 * `test/phase6-gate.test.ts` is where they are.
 */
export function framesPerSpin(refreshHz: number): number {
  return Math.floor((CONTROL_TARGET_MS + CONTROL_PERIOD_MS) / (1000 / refreshHz)) + 1;
}

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
 * exceed — asked **only of the door this branch has always had**, a control that
 * actually exceeded the budget.
 *
 * Above 1 because the control and the frame are sampled separately within each frame:
 * a stall lands in one or the other, so the worst frame may legitimately land above
 * the worst spin. Its job is to catch a compositor that is far worse than the host it
 * is running on, which is the compositor's fault however slow that host is — the
 * 66.67 ms deliberately-slowed path in the harness clears this by more than 2.5×, on
 * any control reading that could have excused it.
 *
 * ## Why it is confined to that door
 *
 * The ceiling is only ever *relief* while the control that earned it had already missed
 * the budget: `CLEARS_BUDGET` is 1, so a control on that door read past 16.67 ms and the
 * ceiling it earns is past 25 ms — looser than §8, which is the whole point of a bound
 * you fall to. {@link hostRepresentsTarget} opened a second door, and behind it sits a
 * control that was *healthy*: a runner spin of 8.40 ms earns 12.60 ms, **below** §8's own
 * number. Applied there the ceiling would turn a fixed 16.67 ms bar into a moving
 * 12.60–15.15 ms one, on the branch whose entire purpose is not to fail a host for being
 * a different machine. So a phase deferred for representativeness alone is held to no
 * per-frame number at all, and {@link overBudgetRate} carries it instead.
 *
 * ## Why this ceiling cannot be the only thing asked of the deferred branch
 *
 * It is a multiple of a number measured on the same main thread the compositor runs on,
 * so a regression that saturates that thread inflates the very ceiling it is judged
 * against. Measured, not hypothesised: the same regression patched into
 * `Compositor.render` — 20 ms on one frame in thirty — was caught on one run by 2.4 ms
 * (a 39.00 ms frame against a 36.60 ms ceiling) and missed on three others by 7 to
 * 67 ms, because the play control read 36.50, 40.60 and 75.30 ms beside it and earned
 * ceilings of 54.75, 60.90 and 112.95 ms. Twenty-seven to twenty-nine frames per run
 * sat at three times §8's budget and the gate passed. Detection in that band was luck.
 *
 * So {@link expectTracksControl} discriminates on *how often* as well as on *how badly*
 * — see {@link overBudgetRate}.
 */
export const TRACKS_CONTROL = 1.5;

/**
 * The control for this control: how far past the budget the harness pushes a
 * deliberately-slowed compositor, burned inside `render` on every frame of that phase.
 *
 * Four budgets, not one over. The point is not that a slowed compositor scrapes past the
 * line but that it fails whichever branch of the judgement above the host puts it on —
 * §8's absolute number on any host at all, and additionally the deferred branch's own
 * bound. On the door where the control stalled that is {@link TRACKS_CONTROL}'s ceiling,
 * which this clears by more than two and a half times whenever the ceiling applies at
 * all; on the door where it did not, it is {@link overBudgetRate}, and a path that burns
 * four budgets on **every** frame of the phase misses the budget on 100% of them against
 * a host that missed it on none — two orders above anything that control could resolve.
 * That is why the slow-compositor control is the one absolute check that survives on a
 * non-representative host.
 *
 * It lives here, beside the two constants it has to stay in that relation to, rather
 * than in the harness that burns it: the relation is what `test/phase6-gate.test.ts`'s
 * slow-compositor branch turns on, and `test/budget-control.test.ts` pins it from this
 * declaration rather than from a copy of the number.
 */
export const SLOW_COMPOSITE_MS = FRAME_BUDGET_MS * 4;

/**
 * How much of §8's whole frame a host may spend on the GPU and still be running the
 * product's workload.
 *
 * **A tenth**, and the tenth is the derivation rather than a threshold placed between
 * two readings. §8 gives the whole frame 16.67 ms. On the hardware this ships to the
 * composite's GPU cost is a rounding error inside that — 0.312 ms measured, 1/53rd of
 * the frame — because there is nothing to upload: the frame arrives hardware-decoded
 * and ANGLE-Metal binds its IOSurface (§12.4, 0.000 ms). On a host with no hardware
 * decoder the same composite carries a ~30 MB CPU-backed `texImage2D` and measures
 * 3.309 ms, a fifth of the entire budget. Those two are an order of magnitude apart
 * (10.6×) and they are not two speeds of one workload — the second contains a copy the
 * first never performs.
 *
 * The line between them is therefore stated against §8's own number and not against
 * either measurement: **a host whose unregressed composite already spends a tenth of
 * the whole frame budget on the GPU is not the workload §8 is about.** One tenth is the
 * order of magnitude, expressed against the only figure in this gate that was not taken
 * on somebody's particular machine. The two measured profiles then land either side of
 * it with room — target hardware 5.3× under, the paravirtual runner 2.0× over — which
 * is a *check* on the derivation, not the source of it.
 */
export const REPRESENTATIVE_GPU_SHARE = 1 / 10;
export const REPRESENTATIVE_GPU_MS = FRAME_BUDGET_MS * REPRESENTATIVE_GPU_SHARE;

/**
 * Whether a hardware-backed decoder for the fixture exists on this host.
 *
 * `'unknown'` when the probe itself could not answer — and, like a control that
 * produced nothing, it counts as *representative*: absence of evidence never buys the
 * compositor a weaker bound.
 */
export type HardwareDecode = 'yes' | 'no' | 'unknown';

/** What the driver's timer query made of one phase's composites. */
export interface GpuProfile {
  /** Completed timer-query results seen in this phase's frames. */
  count: number;
  /**
   * The median completed reading, or `null` when the driver offered no timer query.
   *
   * The median rather than the worst: this figure decides what *kind of machine* this
   * is, and one preempted query says nothing about that. A disjoint reading is already
   * dropped by `GpuTimer` for the same reason.
   */
  medianMs: number | null;
  maxMs: number | null;
}

/** A control that never ran, for a phase whose GPU cost was never sampled. */
export const NO_GPU_PROFILE: GpuProfile = { count: 0, medianMs: null, maxMs: null };

/**
 * The two structural facts that decide whether §8's absolute number is this host's to
 * meet — as opposed to {@link ControlPhase}, which decides whether it is this *moment's*.
 */
export interface HostProfile {
  hardwareDecode: HardwareDecode;
  /** Measured in the same phase's frames as everything else here. */
  gpu: GpuProfile;
}

/** For the report shapes that exist before a run does. */
export const UNKNOWN_HOST: HostProfile = { hardwareDecode: 'unknown', gpu: NO_GPU_PROFILE };

/**
 * Whether this host runs the workload §8 describes.
 *
 * **Both facts, and neither alone.** A host is only refused the absolute bound when it
 * has no hardware decoder *and* its per-frame GPU composite is above
 * {@link REPRESENTATIVE_GPU_MS} — the missing decoder is what makes the frames
 * CPU-backed, and the GPU cost is what shows that upload actually landing in the frame.
 *
 * The conjunction is also what keeps this from being a lever the thing under test can
 * pull. `hardwareDecode` is a property of the platform, probed before a single frame is
 * composited, and no compositor can change it — so on the hardware this ships to the
 * answer is `'yes'`, the GPU reading is never consulted, and a compositor that got slow
 * on the GPU cannot spend its way out of §8 by inflating the very number that would
 * excuse it. That circularity is real; it is the one the ceiling in
 * {@link expectTracksControl} already has, and it is closed here rather than repeated.
 *
 * Anything unmeasured — an `'unknown'` probe, a driver with no timer query — reads as
 * representative, so a broken instrument tightens the gate rather than loosening it.
 */
export function hostRepresentsTarget(host: HostProfile): boolean {
  if (host.hardwareDecode !== 'no') return true;
  const gpuMs = host.gpu.medianMs;
  if (gpuMs === null) return true;
  return gpuMs <= REPRESENTATIVE_GPU_MS;
}

/**
 * §8's frame, scaled by how much more per-frame work this host was measured doing —
 * the single-frame bound on the representativeness door, and `null` where the driver
 * offered no reading to scale by.
 *
 * `budgetMs × (median GPU composite / {@link REPRESENTATIVE_GPU_MS})`, both terms
 * measured or already declared, computed at judgement time. Nothing new is introduced
 * and nothing is pinned: move the host and the bound moves with it.
 *
 * ## Why this is not the widened bound this project has rejected three times
 *
 * It looks superficially like one, and the next reader must not mistake it. What was
 * rejected each time was an **arbitrary multiplier or tolerance** — a 3× stall ceiling,
 * a one-in-a-hundred over-budget allowance, a p99 standing in for the max — and every
 * one of them let a **worse product pass on the same hardware**. This is **dimensional
 * scaling by a measured quantity**: a host measured doing twice the per-frame work is
 * given twice the frame time. Decisively, the door this applies to has **no single-frame
 * bound at all** without it — the tracking ceiling belongs to the stalled control's door
 * and is not asked here — so this is strictly *more* checking than not having it, which
 * is the opposite of a weakening.
 *
 * ## The class it cannot catch, and what does
 *
 * The divisor is fixed, but **the numerator is measured on the compositor under test**,
 * and since {@link REPRESENTATIVE_GPU_MS} is a tenth of the budget this envelope is
 * exactly `10 × medianMs`. A **GPU-side** regression that lifts the median by *d* therefore
 * lifts the envelope by *10d* while lifting the frame it judges by about *d*: the bound
 * grows ten times faster than the cost it bounds, and cannot catch that class on this
 * door. What catches it is {@link overBudgetRate} beside it — a regression that lifts the
 * median is a shift in the whole distribution, which is exactly what a rate sees and what
 * no single-frame bound can. **So do not drop the rate check on the strength of this one**;
 * they carry different halves. A CPU-side regression — the 20 ms-on-one-composite-in-thirty
 * burn this gate is judged on — leaves the GPU median where it was and is caught by both.
 *
 * ## Where it stops meaning anything, said out loud
 *
 * The ratio is unbounded above, so a wildly non-representative host — `use-angle
 * swiftshader` measured 42.7 ms of GPU per composite — earns an envelope so large
 * (427 ms) that it has no practical effect on any single frame. That is a **graceful
 * floor, not a wrong answer**: such a host was never going to say anything about §8, and
 * the rate check beside this one is what carries regression detection there. Do not read
 * it later as a bug and do not cap it with a constant; a cap would be exactly the
 * arbitrary multiplier this avoids.
 *
 * Checked against figures rather than derived from them: the paravirtual runner's
 * 3.309 ms median gives 16.67 × (3.309 / 1.667) = 33.1 ms, so CI run 31039796990's
 * 17.20 ms frame clears it, the 123.6 ms frame that same runner has produced does not,
 * and neither does a 500 ms one. The ratio is always above 1 here by construction —
 * a host under {@link REPRESENTATIVE_GPU_MS} is representative and never reaches this
 * door — so the envelope can never be tighter than §8's own number.
 */
export function scaledFrameEnvelope(host: HostProfile, budgetMs: number): number | null {
  const gpuMs = host.gpu.medianMs;
  if (gpuMs === null) return null;
  return budgetMs * (gpuMs / REPRESENTATIVE_GPU_MS);
}

/** The median of a phase's completed timer-query results, and its worst. */
export function gpuProfile(samplesMs: readonly number[]): GpuProfile {
  if (samplesMs.length === 0) return NO_GPU_PROFILE;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: sorted[sorted.length >> 1] ?? null,
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}

/** Whatever a phase's GPU timer is read from. Narrow so this file stays dependency-free. */
export interface GpuCostSource {
  readonly lastMs: number | null;
}

/**
 * One phase's GPU composite cost, sampled where the environment control is sampled.
 *
 * `GpuTimer.lastMs` is the most recent *completed* query rather than this frame's, so
 * this reads it once per scheduled frame and keeps the value only when it has changed —
 * which is the query's own cadence, one result every frame or two. Sampling is a
 * property read and a compare, taken outside the measured frame body and before the
 * control's spin, so it costs neither of the two things it sits between.
 */
export class GpuCostProbe {
  readonly #source: GpuCostSource;
  #samples: number[] = [];
  #lastSeen: number | null = null;
  #armed = false;

  constructor(source: GpuCostSource) {
    this.#source = source;
  }

  /**
   * The same invariant {@link reset} keeps, at the other end of a phase: the query
   * standing at arm time belongs to the phase before this one.
   *
   * Without this the scrub profile's first sample is a *warmup* composite — and
   * specifically the first 4K `texImage2D`, the one-time cost the warmup phase exists to
   * hold — landing in the median the representativeness test reads.
   */
  arm(): void {
    this.#lastSeen = this.#source.lastMs;
    this.#armed = true;
  }

  disarm(): void {
    this.#armed = false;
  }

  sample(): void {
    if (!this.#armed) return;
    const value = this.#source.lastMs;
    if (value === null || value === this.#lastSeen) return;
    this.#lastSeen = value;
    this.#samples.push(value);
  }

  snapshot(): GpuProfile {
    return gpuProfile(this.#samples);
  }

  /** The samples, not the last value seen: a phase must not re-record the one before it. */
  reset(): void {
    this.#samples = [];
  }
}

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
  /** What kind of machine those frames were measured on. */
  host: HostProfile;
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
 * The clock and the spin, so `test/budget-control.test.ts` can pin the pacing without
 * asking a real host for a real stall. The gate itself passes neither: what runs in the
 * measured frames is `performance.now()` and {@link burn}, and nothing else.
 */
export interface ControlHooks {
  now?: () => number;
  spin?: (targetMs: number) => number;
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
  readonly #now: () => number;
  readonly #spin: (targetMs: number) => number;
  #armed = false;
  #lastSpinEndedAtMs = -Infinity;

  constructor(
    targetMs: number = CONTROL_TARGET_MS,
    periodMs: number = CONTROL_PERIOD_MS,
    hooks: ControlHooks = {},
  ) {
    this.targetMs = targetMs;
    this.periodMs = periodMs;
    this.#metrics = new FrameMetrics(4096, FRAME_BUDGET_MS);
    this.#now = hooks.now ?? (() => performance.now());
    this.#spin = hooks.spin ?? burn;
  }

  arm(): void {
    this.#armed = true;
  }

  disarm(): void {
    this.#armed = false;
  }

  /**
   * One spin, if armed and if {@link CONTROL_PERIOD_MS} has passed since the last one
   * *ended*.
   *
   * Called from every scheduled frame, after the frame's own work; how many of those
   * calls actually spin is decided by the clock rather than by the display, and the
   * clock is read again after the spin so that a spin the host stretched cannot buy
   * itself the next frame's spin as well. Both halves are {@link CONTROL_PERIOD_MS}'s
   * to argue.
   */
  tick(): void {
    if (!this.#armed) return;
    if (this.#now() - this.#lastSpinEndedAtMs < this.periodMs) return;
    this.#metrics.record(this.#spin(this.targetMs));
    this.#lastSpinEndedAtMs = this.#now();
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
 * Whether the gate asserts §8's four absolute numbers for this phase, exactly as §8
 * writes them — the whole branch condition, in one place.
 *
 * Two questions, both of which have to answer yes, and they are different questions:
 * {@link hostRepresentsTarget} asks whether a frame *here* is the piece of work §8 is
 * about, and {@link environmentSustainsBudget} asks whether this host would give any
 * program a whole frame of it. A no from either sends the phase to
 * {@link expectTracksControl}, which is not a pass: the compositor is still held to the
 * ceiling this host just measured and to missing the budget no oftener than the host
 * missed it, in the same frames.
 */
export function assertsAbsoluteBudget(evidence: BudgetEvidence): boolean {
  return (
    hostRepresentsTarget(evidence.host) &&
    environmentSustainsBudget(evidence.control, evidence.budgetMs)
  );
}

/**
 * Over-budget samples as a share of samples taken.
 *
 * The statistic the deferred branch discriminates on, beside the worst reading. A host
 * stall is a *few* windows of a phase — this project's stalled runners missed the budget
 * on 1 and 2 frames of 360 — while a compositor that has got slow misses it on frame
 * after frame, at whatever rate the regression fires.
 *
 * The share is the one figure on this branch that the thing under test cannot inflate.
 * The spin runs immediately *after* the frame body rather than inside it, so nothing the
 * compositor does lands in a spin's window, while everything the host does lands in
 * both — and lands in the spin's more readily, since 8.33 ms of arithmetic needs only
 * another 8.33 ms of stall to miss a 60 Hz refresh, where a 0.20 ms composite needs
 * sixteen. Whatever ceiling the compositor lifts by saturating the thread, it cannot
 * lift the host's own share of missed windows above its own.
 *
 * Zero samples is zero rather than a division: a phase that measured nothing has shown
 * nothing, and the gate asserts both counts separately so an empty one fails there.
 */
export function overBudgetRate(overBudget: number, count: number): number {
  return count === 0 ? 0 : overBudget / count;
}

/**
 * The finest over-budget rate a control of `spins` samples can resolve: **`1 / spins`**.
 *
 * Not a tolerance, and it must never be allowed to become one — it is a property of the
 * sample size and it moves with the sample size. A control that took N spins reports its
 * own share in steps of `1/N`, so it cannot distinguish "this host misses the budget on
 * fewer than one window in N" from "this host never misses it": both come back as zero.
 * Comparing a frame share finer than that against such a zero is reading signal out of
 * quantisation, so a phase there is **inconclusive** and is reported rather than failed.
 *
 * Checked against the figures rather than derived from them: CI run 31039796990 measured
 * 1 frame of 380 (0.263%) beside a 154-spin control, whose resolution is 0.649% — under
 * it, so inconclusive. The 20 ms-on-one-composite-in-thirty regression measures about
 * 3.3%, five times that floor, so it is still failed. Neither number appears here; if the
 * pacing changes the spin count, this moves with it and those two figures move with it.
 *
 * Zero spins resolves nothing, so the floor is `Infinity` and every share is
 * inconclusive — the same rule the rest of this file follows for a control that showed
 * nothing. The gate asserts the spin count separately, so an empty control fails there.
 */
export function spinResolution(spins: number): number {
  return spins <= 0 ? Infinity : 1 / spins;
}

/**
 * The branch where the host, not the compositor, missed §8's number.
 *
 * Returns the line the caller should report. **Throws — the gate fails — whenever the
 * compositor is the one that came up short**, which is what stops this branch from
 * being a way to pass by compositing slowly on a busy machine. Two things are asked of
 * it — how badly, and how often — and *how badly* is a different bound on each of the
 * two doors that reach here:
 *
 * - **how badly** the worst frame missed, against {@link TRACKS_CONTROL}× the worst spin
 *   — asked only where the control itself exceeded the budget, which is the only place
 *   that ceiling is looser than the number it stands in for. See {@link TRACKS_CONTROL}.
 * - **how badly**, on the other door, against {@link scaledFrameEnvelope} — §8's own
 *   frame scaled by how much more per-frame work this host was measured doing. A phase
 *   deferred for representativeness alone would otherwise carry no single-frame bound at
 *   all, and one catastrophic frame in a phase can fall under the rate check's floor.
 * - **how often** the budget was missed at all, against how often this host missed it in
 *   the same frames ({@link overBudgetRate}) — asked on both doors.
 *
 * *How often* is a plain `>` against the control's own share, with no factor in it. A
 * factor there would be a number tuned until a known regression separated, judged
 * against a statistic a stalling host inflates — which is the circularity the ceiling
 * above already has, one level up. What does bound it is {@link spinResolution}: a share
 * finer than the control could resolve is quantisation rather than evidence.
 *
 * That floor is inert on the ceiling's own door, by construction rather than by luck. A
 * control that failed {@link environmentSustainsBudget} read past the budget, so at least
 * one of its spins was over it and `spinShare >= 1/count`, which is the floor itself — so
 * any share large enough to beat `spinShare` has already cleared it. It can only ever
 * change a verdict on the door where the control was healthy and `spinShare` is zero.
 */
export function expectTracksControl(evidence: BudgetEvidence): string {
  const { what, budgetMs, measured, control } = evidence;
  if (!environmentSustainsBudget(control, budgetMs)) {
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
  } else if (!hostRepresentsTarget(evidence.host)) {
    const envelope = scaledFrameEnvelope(evidence.host, budgetMs);
    if (envelope !== null && measured.maxMs > envelope) {
      throw new Error(
        `${what}: worst frame ${fmt(measured.maxMs)} ms at frame ${measured.maxAt}, over the ` +
          `${fmt(envelope)} ms this host's own workload earns — ${fmt(budgetMs)} ms scaled by the ` +
          `${fmt(evidence.host.gpu.medianMs ?? 0)} ms it spends per composite against the ` +
          `${fmt(REPRESENTATIVE_GPU_MS)} ms a representative one may. A machine doing that much ` +
          `more work per frame is given that much more frame; nothing here excuses a frame past ` +
          `it. ${describeHost(evidence.host)}. ${figures(control, budgetMs)}`,
      );
    }
  }
  const frameShare = overBudgetRate(measured.overBudget, measured.count);
  const spinShare = overBudgetRate(control.overBudget, control.count);
  const resolution = spinResolution(control.count);
  if (frameShare >= resolution && frameShare > spinShare) {
    throw new Error(
      `${what}: ${measured.overBudget} of ${measured.count} frames over the ${fmt(budgetMs)} ms ` +
        `budget (${pct(frameShare)}), a larger share than this host missed it on of its own ` +
        `spins — ${control.overBudget} of ${control.count} (${pct(spinShare)}), the same ` +
        `${fmt(control.targetMs)} ms of arithmetic in these same frames. A host that stalls ` +
        `stalls a window here and there and stalls the spin at least as readily as the ` +
        `frame; a compositor missing the budget this much more often than the host is doing ` +
        `it for its own reasons. Worst frame ${fmt(measured.maxMs)} ms at frame ` +
        `${measured.maxAt}. ${figures(control, budgetMs)}`,
    );
  }
  return (
    `${what}: ${whyDeferred(evidence)} — ${figures(control, budgetMs)}; ` +
    `${describeHost(evidence.host)}. The worst frame was ${fmt(measured.maxMs)} ms` +
    `${envelopeCleared(evidence)} ` +
    `(${measured.overBudget} of ${measured.count} frames over budget, ${pct(frameShare)}, against ` +
    `the host's own ${pct(spinShare)})${verdict(frameShare, resolution, control.count)}. ` +
    `See test/gate/budget-control.ts; §8's number is asserted exactly as written on any host ` +
    `that runs the product's own workload and whose control clears it.`
  );
}

/**
 * The single-frame bound this phase actually cleared, named in the line it passed on.
 *
 * Only the representativeness door carries {@link scaledFrameEnvelope}, so a report that
 * does not name it was judged by the ceiling or by nothing, and saying which is the
 * difference between a deferral a reader can check and one they have to re-derive.
 */
function envelopeCleared(evidence: BudgetEvidence): string {
  if (!environmentSustainsBudget(evidence.control, evidence.budgetMs)) return '';
  const envelope = scaledFrameEnvelope(evidence.host, evidence.budgetMs);
  if (envelope === null || hostRepresentsTarget(evidence.host)) return '';
  return `, inside the ${fmt(envelope)} ms this host's own per-frame workload earns,`;
}

/**
 * What the share had to say, once it had said it — separated out because "the compositor
 * matched the host" and "this control could not have told the difference" are different
 * findings, and only the second is a limit of the instrument.
 */
function verdict(frameShare: number, resolution: number, spins: number): string {
  if (frameShare > 0 && frameShare < resolution) {
    return (
      ` and is INCONCLUSIVE rather than passed: that share is finer than the ` +
      `${pct(resolution)} a ${spins}-spin control can resolve, so it cannot be told apart ` +
      `from the host's own quantised zero`
    );
  }
  return ` and missed the budget no oftener than this host missed it`;
}

/**
 * Which of {@link assertsAbsoluteBudget}'s two questions came back no — both, when both
 * did, because "the host stalled" and "the host is a different machine entirely" are
 * separate findings and a report that collapses them sends the next reader down the
 * wrong path.
 */
function whyDeferred(evidence: BudgetEvidence): string {
  const clauses: string[] = [];
  if (!environmentSustainsBudget(evidence.control, evidence.budgetMs)) {
    clauses.push(
      `this environment cannot sustain the ${fmt(evidence.budgetMs)} ms frame budget §8 requires`,
    );
  }
  if (!hostRepresentsTarget(evidence.host)) {
    clauses.push(
      `this host cannot run the workload §8 is about: with no hardware-backed decoder its ` +
        `frames are CPU-backed, so every composite carries a ~30 MB texImage2D that the Macs ` +
        `this ships to never perform`,
    );
  }
  return clauses.length === 0
    ? `§8's absolute number was not asserted for this phase`
    : clauses.join(', and ');
}

function describeHost(host: HostProfile): string {
  const gpu =
    host.gpu.medianMs === null
      ? 'no GPU timer query on this driver'
      : `${fmt(host.gpu.medianMs)} ms median GPU composite over ${host.gpu.count} completed ` +
        `queries (worst ${host.gpu.maxMs === null ? 'n/a' : `${fmt(host.gpu.maxMs)} ms`})`;
  return (
    `hardware-backed decode: ${host.hardwareDecode}; ${gpu}, against the ` +
    `${fmt(REPRESENTATIVE_GPU_MS)} ms a tenth of §8's whole frame allows`
  );
}

function figures(control: ControlPhase, budgetMs: number): string {
  return (
    `${fmt(control.targetMs)} ms of pure arithmetic, spun with ${fmt(control.periodMs)} ms of ` +
    `clock left free after each one, in these same frames with none of the compositor's ` +
    `code, took up to ${fmt(control.maxMs)} ms across ${control.count} spins ` +
    `(mean ${fmt(control.meanMs)} ms, ${control.overBudget} over the ${fmt(budgetMs)} ms budget, ` +
    `worst at spin ${control.maxAt})`
  );
}

/** Readable in a failure message; never used for the comparison itself. */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** A share, said out loud. Like {@link fmt}, never the comparison itself. */
function pct(share: number): string {
  return `${(share * 100).toFixed(2)}%`;
}
