/**
 * **The environment control's own control.**
 *
 * `test/gate/budget-control.ts` lets the phase-6 gate defer §8's absolute number on a
 * host whose own measured ceiling cannot reach it. That deferral is only honest while
 * it stays unreachable by a compositor that has actually got slow — otherwise the
 * deferred branch is a way to pass by compositing badly on a busy machine, and the
 * gate's bound proves nothing on any virtualised runner.
 *
 * So the policy is exercised here directly, in Node, against the figures this project
 * has actually measured: 0.30 ms on this machine, 14.90 ms on a runner that passed,
 * 17.60 ms on the one that turned `main` red, and 82.10 ms and 140.60 ms on hosts that
 * stalled outright. The gate itself proves the same thing the expensive way — a real
 * `PreviewLoop` over a deliberately-slowed compositor, measured by the same instrument
 * in the same run — the way `packages/format/test/kill-mid-write.test.ts` proves its
 * tearing control and `packages/sampler/test/rate-control.ts` proves its own.
 *
 * The four rows below carry the compositor-side figures from that history. The
 * control-side figures beside them are the shapes the policy has to route — a healthy
 * host lands within a fraction of a millisecond of the target, a stalled one does not
 * — and are marked as such rather than dressed up as measurements nobody has taken.
 */

import { describe, expect, it } from 'vitest';
import {
  assertsAbsoluteBudget,
  CLEARS_BUDGET,
  CONTROL_PERIOD_MS,
  CONTROL_TARGET_MS,
  deferredBoundsOutcome,
  EnvironmentControl,
  environmentSustainsBudget,
  expectTracksControl,
  framesPerSpin,
  GpuCostProbe,
  gpuProfile,
  hostRepresentsTarget,
  instrumentOutOfCalibration,
  withheldJudgement,
  NO_CONTROL,
  NO_GPU_PROFILE,
  overBudgetRate,
  REPRESENTATIVE_GPU_MS,
  REPRESENTATIVE_GPU_SHARE,
  scaledFrameEnvelope,
  SLOW_COMPOSITE_MS,
  spinResolution,
  TRACKS_CONTROL,
  UNKNOWN_HOST,
  type BudgetEvidence,
  type ControlPhase,
  type HostProfile,
} from './gate/budget-control.ts';

const FRAME_BUDGET_MS = 1000 / 60;
/**
 * What the harness's deliberately-slowed compositor burns inside `render` — the
 * declaration itself, not a copy of the number, because the boundary this file pins is
 * between that burn and the two policy constants beside it.
 */
const SLOWED_MS = SLOW_COMPOSITE_MS;

function control(overrides: Partial<ControlPhase> = {}): ControlPhase {
  return { ...NO_CONTROL, count: 360, maxMs: 8.4, maxAt: 100, meanMs: 8.36, ...overrides };
}

/** A host doing exactly what it was asked: half a budget of arithmetic, in half a budget. */
const HEALTHY = control();
/** A host that stalled: the same arithmetic, stretched past a whole frame. */
const STALLED = control({ maxMs: 74.2, overBudget: 2 });
/** A host that only just missed the budget — this machine's smallest real reading. */
const JUST_OVER = control({ maxMs: 17.3, overBudget: 1 });

/**
 * The machines this ships to: a hardware H.264 decoder, and a composite whose GPU cost
 * is a rounding error inside §8's frame because ANGLE-Metal binds the decoded frame's
 * IOSurface rather than uploading it. Measured, on an M5 Pro.
 */
const TARGET_HOST: HostProfile = {
  hardwareDecode: 'yes',
  gpu: { count: 310, medianMs: 0.312, maxMs: 0.51 },
};

/**
 * GitHub's macos-14 runner: an Apple Paravirtual device with no hardware video decoder
 * at all, so every composite carries a ~30 MB CPU-backed `texImage2D`. Measured, on the
 * run that turned `main` red.
 */
const RUNNER_HOST: HostProfile = {
  hardwareDecode: 'no',
  gpu: { count: 290, medianMs: 3.309, maxMs: 7.4 },
};

function evidence(
  measured: Partial<BudgetEvidence['measured']>,
  c: ControlPhase,
  host: HostProfile = TARGET_HOST,
): BudgetEvidence {
  return {
    what: 'play',
    budgetMs: FRAME_BUDGET_MS,
    measured: { count: 360, maxMs: 0.3, maxAt: 71, overBudget: 0, ...measured },
    control: c,
    host,
  };
}

describe('the frame budget is enforced against a measured environment', () => {
  it('asks the host for a fifth of the clock, so the control is exposed like a frame is', () => {
    // Occupancy is exposure: a stall lands inside a window in proportion to how much
    // of the clock that window takes. A control costing nothing would sit beside every
    // stall it exists to catch, and one costing a whole thread would break the run it
    // is measuring — which the first version of it did. A fifth is the same order as
    // the ~30% of a frame an honest CPU-backed 4K upload occupies on the runner.
    expect(CONTROL_TARGET_MS).toBeCloseTo(FRAME_BUDGET_MS / 2, 10);
    expect(CONTROL_TARGET_MS / CONTROL_PERIOD_MS).toBeCloseTo(0.25, 10);
    // The period runs from the end of one spin to the start of the next, so what a
    // host doing what it was asked is *asked* for is target/(target + period) — and
    // that is a ceiling rather than a figure, because a spin can only start on a frame
    // boundary and the boundary always lands past the deadline, never on it. A 60 Hz
    // and a 120 Hz panel both quantise the fifth to a sixth; 240 Hz gets closest at
    // 18.2%. Quantisation only ever lowers it, which is the safe direction: the control
    // can under-occupy the thread and still be a control, where over-occupying it
    // breaks the run it is measuring.
    expect(CONTROL_TARGET_MS / (CONTROL_TARGET_MS + CONTROL_PERIOD_MS)).toBeCloseTo(0.2, 10);
    for (const hz of [60, 120, 240]) {
      const duty = CONTROL_TARGET_MS / (framesPerSpin(hz) * (1000 / hz));
      expect(duty).toBeLessThanOrEqual(CONTROL_TARGET_MS / (CONTROL_TARGET_MS + CONTROL_PERIOD_MS));
    }
    // Paced by the wall clock, never by the display: a 120 Hz panel must not double
    // what the control costs, and a 60 Hz one must not halve what it measures.
    expect(CONTROL_PERIOD_MS).toBeGreaterThan(FRAME_BUDGET_MS);
  });

  /**
   * The one reading every sample-count guard in `test/phase6-gate.test.ts` is taken
   * from, checked against a scheduler rather than against itself.
   *
   * Those guards catch a control that died or was truncated; they say nothing about §8.
   * But they are counts, counts come from the pacing, and the pacing has now moved
   * twice — so the arithmetic that turns one into the other is asserted here against a
   * simulated fixed-refresh scheduler, at each of the three panels the gate may meet.
   * The guards themselves are all read off the fastest of them.
   *
   * The `+ 1` in {@link framesPerSpin} is the whole subtlety: a spin runs *after* the
   * frame body, so at 120 and 240 Hz, where `target + period` is an exact multiple of
   * the refresh, the boundary that reaches the deadline has already been spent and the
   * spin waits for the next one. Reading it off `ceil` alone gives 5 at 120 Hz against
   * the 5.6 this project actually measures there, and a ratio guard built on 5 would
   * fail a healthy run for the panel's arithmetic.
   */
  it('derives frames-per-spin from the pacing, and a scheduler agrees', () => {
    expect(framesPerSpin(60)).toBe(3);
    expect(framesPerSpin(120)).toBe(6);
    expect(framesPerSpin(240)).toBe(11);

    /** Frames on a fixed grid that slips only when a callback overruns its slot. */
    const spinsOverFrames = (refreshHz: number, bodyMs: number, frames: number): number => {
      const refreshMs = 1000 / refreshHz;
      let now = 0;
      const control = new EnvironmentControl(CONTROL_TARGET_MS, CONTROL_PERIOD_MS, {
        now: () => now,
        spin: () => {
          now += CONTROL_TARGET_MS;
          return CONTROL_TARGET_MS;
        },
      });
      control.arm();
      for (let frame = 0; frame < frames; frame++) {
        now = Math.max(now, frame * refreshMs) + bodyMs;
        control.tick();
      }
      return control.snapshot().count;
    };

    const frames = 600;
    for (const hz of [60, 120, 240]) {
      // An upper bound whatever the frame body costs, so the ratio guard cannot
      // false-fail: a body that overruns its own slot slips the grid, which only ever
      // means fewer frames to a spin.
      for (const bodyMs of [0.01, 0.3, 4]) {
        const spins = spinsOverFrames(hz, bodyMs, frames);
        expect(spins).toBeGreaterThan(0);
        expect(frames / spins).toBeLessThanOrEqual(framesPerSpin(hz));
      }
      // And a tight one where this gate actually lives — frame bodies of two to five
      // tenths of a millisecond — so a control that stopped a third of the way in
      // cannot hide under a bound that was slack to begin with.
      expect(frames / spinsOverFrames(hz, 0.3, frames)).toBeGreaterThan(framesPerSpin(hz) - 2);
    }
  });

  /**
   * The pacing, and the one thing it must not do to a host that is already struggling.
   *
   * Measured from the *start* of a spin, the interval between spins is
   * `spinDuration + frameGap` rather than a period: a spin the host stretches past
   * {@link CONTROL_PERIOD_MS} satisfies the gate on the very next frame, and on every
   * frame after it, so the wall-clock pacing collapses into the once-per-frame pacing
   * that starved decode until all twelve scrub targets timed out at four seconds. That
   * is a positive feedback loop — the slower the host, the harder the control loads it
   * — and it arrives on exactly the saturated hosts the control exists to characterise,
   * where the run would redden on missing scrub frames rather than deferring §8.
   *
   * Measured from the end, the host gets a whole period back after every spin however
   * long that spin took, so the arithmetic the control demands per second *falls* as
   * the host dilates. The clock and the spin are injected here because the property is
   * about how much of a *host's* clock the control takes, and asking a real one for a
   * real 6× stall is not something a test can do twice the same way.
   */
  it('CONTROL: a stretched spin buys back a period, never the next frame', () => {
    /** A 120 Hz panel — the worst case for anything paced per frame. */
    const frameMs = 1000 / 120;
    const spanMs = 1000;
    /** One second of that panel, on a host that takes `dilationMs` to do a spin. */
    const second = (dilationMs: number): { spins: number; frames: number } => {
      let now = 0;
      let frames = 0;
      const control = new EnvironmentControl(CONTROL_TARGET_MS, CONTROL_PERIOD_MS, {
        now: () => now,
        spin: () => {
          now += dilationMs;
          return dilationMs;
        },
      });
      control.arm();
      while (now < spanMs) {
        now += frameMs;
        frames += 1;
        control.tick();
      }
      return { spins: control.snapshot().count, frames };
    };

    // A host doing what it was asked: a fifth of its clock, and nothing like the
    // 120 spins a second the panel would have handed a per-frame control.
    const healthy = second(CONTROL_TARGET_MS);
    expect((healthy.spins * CONTROL_TARGET_MS) / spanMs).toBeCloseTo(0.2, 1);

    // And under dilation the demand falls rather than rises — in spins a second,
    // bounded by one per `dilation + period`, and in the share of frames that carry
    // one, which is the figure that collapsed. Timed from the start of a spin, a
    // dilation past the period puts a spin on *every* frame, whatever the panel: the
    // once-per-frame pacing, arrived at exactly when the host can least afford it.
    let previousSpins = Infinity;
    for (const dilationMs of [CONTROL_TARGET_MS, 16.67, CONTROL_PERIOD_MS, 50, 100]) {
      const { spins, frames } = second(dilationMs);
      expect(spins).toBeLessThanOrEqual(Math.ceil(spanMs / (dilationMs + CONTROL_PERIOD_MS)) + 1);
      expect((spins * CONTROL_TARGET_MS) / spanMs).toBeLessThanOrEqual(0.25);
      expect(spins / frames).toBeLessThanOrEqual(0.25);
      expect(spins).toBeLessThan(previousSpins);
      previousSpins = spins;
    }
    // The floor of that range is still a control: a host stalled sixfold is sampled
    // often enough for `maxMs` and the share to mean something.
    expect(second(100).spins).toBeGreaterThan(5);
  });

  it.each([
    ['this machine', 0.3, 0],
    ['the runner that passed', 14.9, 0],
  ])('routes %s to the strict branch', (_label, maxMs, overBudget) => {
    const { control: c, measured } = evidence({ maxMs, overBudget }, HEALTHY);
    expect(environmentSustainsBudget(c, FRAME_BUDGET_MS)).toBe(true);
    // What the gate then asserts, unchanged: no frame over one 60 Hz refresh.
    expect(measured.overBudget).toBe(0);
    expect(measured.maxMs).toBeLessThanOrEqual(FRAME_BUDGET_MS);
  });

  it('defers only on a host that actually exceeded the budget', () => {
    // The line is §8's own number and nothing short of it. A host that kept half a
    // budget of arithmetic inside a whole budget — even by a hair, even at 15.9 ms —
    // has not demonstrated it cannot hold the budget, so the bound stays the
    // compositor's; one that stretched the same arithmetic to 17.3 ms has.
    expect(CLEARS_BUDGET).toBe(1);
    expect(environmentSustainsBudget(control({ maxMs: 15.9 }), FRAME_BUDGET_MS)).toBe(true);
    expect(environmentSustainsBudget(control({ maxMs: FRAME_BUDGET_MS }), FRAME_BUDGET_MS)).toBe(
      true,
    );
    expect(JUST_OVER.maxMs).toBeGreaterThan(FRAME_BUDGET_MS);
    expect(environmentSustainsBudget(JUST_OVER, FRAME_BUDGET_MS)).toBe(false);
  });

  it.each([
    ['the host that stalled to 82.10 ms', 82.1, 1],
    ['the host that stalled twice to 140.60 ms', 140.6, 2],
  ])('reports rather than fails %s', (_label, maxMs, overBudget) => {
    const shortfall = expectTracksControl(
      evidence({ maxMs, overBudget }, control({ maxMs: maxMs * 0.9, overBudget })),
    );
    expect(shortfall).toContain('this environment cannot sustain');
    // Reported, not silently passed: the measured figures are in the line.
    expect(shortfall).toContain(`${maxMs.toFixed(2)} ms`);
    expect(shortfall).toContain(`${overBudget} of 360 frames over budget`);
  });

  it('reports the 17.60 ms frame that turned main red, given a host that stalled with it', () => {
    const shortfall = expectTracksControl(
      evidence({ maxMs: 17.6, maxAt: 71, overBudget: 1 }, STALLED),
    );
    expect(shortfall).toContain('this environment cannot sustain');
    expect(shortfall).toContain('74.20');
  });

  /**
   * The half that keeps the branch above from being an escape hatch: a compositor
   * that cannot hold the ceiling this host just demonstrated fails, however slow the
   * host is.
   *
   * The figures are the gate's own deliberately-slowed path — {@link SLOWED_MS}, four
   * budgets — under each of the control readings that could have routed it here. Both
   * numbers absorb the host, because that is what "measured in the same frames" means:
   * a stall that stretched the control's arithmetic stretched the frame beside it too,
   * and the slow frame is the one carrying 66.67 ms of its own on top.
   */
  it('CONTROL: a slow compositor fails, stalled host or not', () => {
    // A host that holds the budget never reaches this branch at all — §8's own number
    // is what gets asserted, and the gate asserts it directly.
    expect(environmentSustainsBudget(HEALTHY, FRAME_BUDGET_MS)).toBe(true);

    // And a host that does not still holds the compositor to the ceiling it earned.
    for (const host of [JUST_OVER, STALLED, control({ maxMs: 40, overBudget: 4 })]) {
      const stallMs = host.maxMs - host.targetMs;
      expect(() =>
        expectTracksControl(evidence({ maxMs: SLOWED_MS + stallMs, overBudget: 24 }, host)),
      ).toThrow(/cannot hold this machine's own ceiling/);
    }

    // The ceiling is the control's worst spin, scaled — stated here so widening it
    // has to break this line, and so the one number this branch turns on is visible.
    expect(TRACKS_CONTROL).toBe(1.5);
    expect(() =>
      expectTracksControl(evidence({ maxMs: 40 * TRACKS_CONTROL + 0.1 }, control({ maxMs: 40 }))),
    ).toThrow(/cannot hold this machine's own ceiling/);
    expect(
      expectTracksControl(evidence({ maxMs: 40 * TRACKS_CONTROL - 0.1 }, control({ maxMs: 40 }))),
    ).toContain('this environment cannot sustain');
  });

  /**
   * The limit of that half, and why the gate does not demand it of a host whose own
   * control was stalled.
   *
   * The case above has both numbers absorbing the same stall, which is the ordinary
   * shape — the spin runs immediately after the frame body, so a host that stretched one
   * stretched the other. It is not the only shape, and {@link TRACKS_CONTROL} exists
   * precisely because a stall can land in one and not the other. Past
   * `SLOWED_MS / TRACKS_CONTROL` a stall in the control *alone* lifts the ceiling above
   * everything the slowed path burns — so the ceiling on its own would report there, and
   * a gate that required the throw would fail for the host's stall, which is the one
   * thing this file exists to stop.
   *
   * The share is what still catches it there, and it takes a great deal more than a
   * stall to lift: a host that missed the budget on as large a fraction of its own spins
   * as the slowed compositor missed it on of its frames. Both have to go before the
   * slowed path is merely reported, which is why `test/phase6-gate.test.ts` keeps the
   * required throw to the branch where the phase's own control cleared the budget, and
   * asserts §8's absolute number against the slowed path on both.
   */
  it('CONTROL: only a host stalled in both statistics lifts the slowed path clear', () => {
    const beyond = control({ maxMs: SLOWED_MS / TRACKS_CONTROL + 1, overBudget: 6 });
    expect(environmentSustainsBudget(beyond, FRAME_BUDGET_MS)).toBe(false);
    // The ceiling has nothing left to say about it: 66.67 ms of burn under a ceiling
    // this host's own stall earned.
    expect(SLOWED_MS).toBeLessThan(beyond.maxMs * TRACKS_CONTROL);
    // The share does. 24 frames of 360 against the host's own 6 of 360.
    expect(() =>
      expectTracksControl(evidence({ maxMs: SLOWED_MS, overBudget: 24 }, beyond)),
    ).toThrow(/a larger share than this host missed it on of its own spins/);
    // And only a host that stalled as often as the slowed path missed reports instead.
    const asOften = control({ maxMs: SLOWED_MS / TRACKS_CONTROL + 1, overBudget: 24 });
    expect(expectTracksControl(evidence({ maxMs: SLOWED_MS, overBudget: 24 }, asOften))).toContain(
      'this environment cannot sustain',
    );
    // Which is why the absolute pair is what the gate asserts against the slowed path
    // on every host: four budgets burned inside `render` miss §8's number regardless of
    // what the machine was doing beside them.
    expect(SLOWED_MS).toBeGreaterThan(FRAME_BUDGET_MS);

    // And on the branch where the throw *is* required — the slow phase's own control
    // cleared the budget, so the ceiling is not this branch's bound there at all — the
    // share is what catches it, and overwhelmingly: every frame of the phase against a
    // host that missed none of its own spins.
    const clearing = control({ count: 24, maxMs: FRAME_BUDGET_MS * CLEARS_BUDGET });
    expect(environmentSustainsBudget(clearing, FRAME_BUDGET_MS)).toBe(true);
    expect(() =>
      expectTracksControl(evidence({ count: 24, maxMs: SLOWED_MS, overBudget: 24 }, clearing)),
    ).toThrow(/a larger share than this host missed it on of its own spins/);
  });

  /**
   * The same required throw, on the host the gate actually meets in CI — the combination
   * no test covered, and the one that reached CI red.
   *
   * The slowed path is run beside a healthy control on a machine with no hardware
   * decoder, so it reaches the representativeness door and the *envelope* answers first,
   * not the share. `test/phase6-gate.test.ts` therefore picks which message it requires
   * from the same two measurements rather than assuming one; both outcomes below are a
   * specific bound firing, and neither is "something threw".
   */
  it('CONTROL: catches the slowed path on a non-representative host too', () => {
    const clearing = control({ count: 24, maxMs: FRAME_BUDGET_MS * CLEARS_BUDGET });
    const slowed = { count: 24, maxMs: SLOWED_MS, overBudget: 24 };

    // The runner: 10 x 3.309 = 33.09 ms of envelope against 66.67 ms of burn, so the
    // envelope reaches it before the share does.
    expect(scaledFrameEnvelope(RUNNER_HOST, FRAME_BUDGET_MS) ?? 0).toBeLessThan(SLOWED_MS);
    expect(() => expectTracksControl(evidence(slowed, clearing, RUNNER_HOST))).toThrow(
      /this host's own workload earns/,
    );

    // And a host so far outside the envelope that it cannot reach the burn — swiftshader
    // earns 427 ms — falls through to the share, which still has it at 24 of 24.
    const swiftshader: HostProfile = {
      hardwareDecode: 'no',
      gpu: { count: 120, medianMs: 42.749, maxMs: 61 },
    };
    expect(scaledFrameEnvelope(swiftshader, FRAME_BUDGET_MS) ?? 0).toBeGreaterThan(SLOWED_MS);
    expect(() => expectTracksControl(evidence(slowed, clearing, swiftshader))).toThrow(
      /a larger share than this host missed it on of its own spins/,
    );
  });

  /**
   * **The two doors into the deferred branch, and why only one of them carries a ceiling.**
   *
   * The ceiling is relief only while the control that earned it had itself missed the
   * budget: `CLEARS_BUDGET` is 1, so such a control read past 16.67 ms and 1.5x of it is
   * past 25 ms — looser than §8, which is what a bound you fall *to* has to be.
   * {@link hostRepresentsTarget} opened a second door and put a *healthy* control behind
   * it, where 1.5 x 8.40 ms is 12.60 ms — below §8's own number. Asking that of a runner
   * would turn a fixed 16.67 ms bar into a moving 12.60–15.15 ms one on the one branch
   * whose whole purpose is not to fail a host for being a different machine.
   */
  it('asks the tracking ceiling only of a control that missed the budget itself', () => {
    // The original door: relief, always, because the control was over the budget.
    for (const c of [JUST_OVER, STALLED]) {
      expect(environmentSustainsBudget(c, FRAME_BUDGET_MS)).toBe(false);
      expect(c.maxMs * TRACKS_CONTROL).toBeGreaterThan(FRAME_BUDGET_MS);
      expect(() =>
        expectTracksControl(evidence({ maxMs: c.maxMs * TRACKS_CONTROL + 0.1 }, c)),
      ).toThrow(/cannot hold this machine's own ceiling/);
    }

    // The representativeness door, with a healthy control: the ceiling it would have
    // earned sits *below* §8, so it is not asked. A 14 ms frame — inside §8, over
    // 1.5 x 8.40 ms — is reported rather than failed.
    const tighter = HEALTHY.maxMs * TRACKS_CONTROL;
    expect(tighter).toBeLessThan(FRAME_BUDGET_MS);
    const inside = evidence({ maxMs: 14, overBudget: 0 }, HEALTHY, RUNNER_HOST);
    expect(assertsAbsoluteBudget(inside)).toBe(false);
    expect(inside.measured.maxMs).toBeGreaterThan(tighter);
    expect(expectTracksControl(inside)).toContain('cannot run the workload §8 is about');
  });

  /**
   * **The resolution floor: a property of the sample size, never a tolerance.**
   *
   * A control of N spins reports its own share in steps of `1/N`, so it cannot tell "this
   * host misses the budget on fewer than one window in N" from "never" — both come back
   * as zero. A frame share finer than that, compared against such a zero, is quantisation
   * rather than evidence, so the phase is inconclusive and reported.
   *
   * The figures are a check on it and not its source. CI run 31039796990: 1 frame of 380
   * (0.263%) beside a 154-spin control resolving 0.649% — under it, inconclusive. The
   * 20 ms-on-one-composite-in-thirty regression: ~3.3%, five times that floor, still
   * failed. Move the spin count and the floor moves with it, which is the whole point.
   */
  it('computes the share’s floor from the control’s own spin count', () => {
    expect(spinResolution(154)).toBeCloseTo(1 / 154, 12);
    expect(spinResolution(1000)).toBeCloseTo(1 / 1000, 12);
    // Halve the sample and the floor doubles; nothing here is pinned to a number.
    expect(spinResolution(77)).toBeCloseTo(spinResolution(154) * 2, 12);
    // A control that took no spins resolves nothing, so nothing clears it.
    expect(spinResolution(0)).toBe(Infinity);

    // The run this whole round was built for: one frame of 380 against a 154-spin
    // control. Under the floor, so it comes back as a line rather than a failure.
    const ciControl = control({ count: 154, maxMs: 10.1, maxAt: 96, meanMs: 8.47 });
    const ciRun = evidence(
      { count: 380, maxMs: 17.2, maxAt: 186, overBudget: 1 },
      ciControl,
      RUNNER_HOST,
    );
    expect(assertsAbsoluteBudget(ciRun)).toBe(false);
    expect(1 / 380).toBeLessThan(spinResolution(ciControl.count));
    const reported = expectTracksControl(ciRun);
    expect(reported).toContain('INCONCLUSIVE');
    expect(reported).toContain('154-spin control can resolve');

    // And the regression, on the same host and the same control: five times the floor,
    // so it is signal and it fails.
    expect(30 / 900).toBeGreaterThan(spinResolution(ciControl.count) * 4);
    expect(() =>
      expectTracksControl(
        evidence({ count: 900, maxMs: 20.3, maxAt: 256, overBudget: 30 }, ciControl, RUNNER_HOST),
      ),
    ).toThrow(/a larger share than this host missed it on of its own spins/);
  });

  /**
   * **The single-frame bound on the representativeness door.**
   *
   * The rate check above cannot see one catastrophic frame: a share under `1/spins` is
   * quantisation, so on the runner's own figures up to two frames of *any* magnitude
   * would be reported inconclusive with nothing else to say about them. The ceiling
   * belongs to the other door. So the frame is held to §8's own number scaled by how much
   * more per-frame work this host was measured doing — dimensional scaling by a measured
   * quantity, not a multiplier picked to clear a run, and strictly more checking than the
   * nothing that was there before it.
   */
  it('bounds a single frame by §8’s frame scaled to the host’s own workload', () => {
    // 16.67 x (3.309 / 1.667) = 33.1 ms on the runner, and never tighter than §8 itself:
    // a host under the representative line never reaches this door at all.
    const envelope = scaledFrameEnvelope(RUNNER_HOST, FRAME_BUDGET_MS);
    expect(envelope).not.toBeNull();
    expect(envelope).toBeCloseTo(
      FRAME_BUDGET_MS * ((RUNNER_HOST.gpu.medianMs ?? 0) / REPRESENTATIVE_GPU_MS),
      10,
    );
    expect(envelope ?? 0).toBeCloseTo(33.09, 1);
    expect(envelope ?? 0).toBeGreaterThan(FRAME_BUDGET_MS);

    // Computed from the measurement, never pinned: twice the per-frame work, twice the
    // frame time.
    const heavier: HostProfile = {
      hardwareDecode: 'no',
      gpu: { count: 290, medianMs: 6.618, maxMs: 12 },
    };
    expect(scaledFrameEnvelope(heavier, FRAME_BUDGET_MS) ?? 0).toBeCloseTo((envelope ?? 0) * 2, 10);

    // The frame the rate check cannot see, on the runner's own figures: 1 of 380 against
    // a 154-spin control is under the floor, so only this bound stands between a 123.6 ms
    // frame — a magnitude that runner has actually produced — and a pass.
    const ciControl = control({ count: 154, maxMs: 10.1, maxAt: 96, meanMs: 8.47 });
    const catastrophic = evidence(
      { count: 380, maxMs: 123.6, maxAt: 186, overBudget: 1 },
      ciControl,
      RUNNER_HOST,
    );
    expect(overBudgetRate(1, 380)).toBeLessThan(spinResolution(ciControl.count));
    expect(() => expectTracksControl(catastrophic)).toThrow(
      /over the 33.09 ms this host's own workload earns/,
    );
    // And 500 ms, the same way.
    expect(() =>
      expectTracksControl(
        evidence({ count: 380, maxMs: 500, maxAt: 186, overBudget: 1 }, ciControl, RUNNER_HOST),
      ),
    ).toThrow(/this host's own workload earns/);

    // While the run this round was built for clears it and says so.
    const ciRun = expectTracksControl(
      evidence({ count: 380, maxMs: 17.2, maxAt: 186, overBudget: 1 }, ciControl, RUNNER_HOST),
    );
    expect(ciRun).toContain("inside the 33.09 ms this host's own per-frame workload earns");
    expect(ciRun).toContain('INCONCLUSIVE');
  });

  /**
   * Where the scaled envelope stops meaning anything, stated so it is not later read as
   * a bug: the ratio is unbounded above, so a wildly non-representative host earns an
   * envelope with no practical single-frame effect. That is a graceful floor — such a
   * host was never going to say anything about §8 — and capping it with a constant would
   * be exactly the arbitrary multiplier this shape avoids.
   */
  it('CONTROL: degrades gracefully on a host nothing could represent', () => {
    // `use-angle swiftshader`, measured: 42.7 ms of GPU per composite.
    const swiftshader: HostProfile = {
      hardwareDecode: 'no',
      gpu: { count: 120, medianMs: 42.749, maxMs: 61 },
    };
    expect(scaledFrameEnvelope(swiftshader, FRAME_BUDGET_MS) ?? 0).toBeGreaterThan(400);
    expect(
      expectTracksControl(evidence({ maxMs: 120, overBudget: 0 }, HEALTHY, swiftshader)),
    ).toContain('cannot run the workload §8 is about');

    // And it is the ceiling's door, not this one, that judges a stalled host — the two
    // bounds never both apply, so the envelope can never loosen the ceiling.
    expect(() =>
      expectTracksControl(evidence({ maxMs: 200, overBudget: 1 }, STALLED, swiftshader)),
    ).toThrow(/cannot hold this machine's own ceiling/);

    // A driver with no timer query has nothing to scale by — and never reaches here,
    // because an unmeasured host reads as representative.
    expect(scaledFrameEnvelope(UNKNOWN_HOST, FRAME_BUDGET_MS)).toBeNull();
    expect(hostRepresentsTarget({ hardwareDecode: 'no', gpu: NO_GPU_PROFILE })).toBe(true);
  });

  /**
   * The floor cannot loosen the door the ceiling guards, and that is structural rather
   * than lucky.
   *
   * A control that failed {@link environmentSustainsBudget} read past the budget, so at
   * least one of its spins was over it and `spinShare >= 1/count` — which is the floor.
   * Any frame share big enough to beat `spinShare` has therefore already cleared it, so
   * the floor can only ever change a verdict where the control was healthy and its share
   * is a quantised zero.
   */
  it('CONTROL: the floor is inert wherever the control itself missed the budget', () => {
    for (const c of [JUST_OVER, STALLED, control({ count: 194, maxMs: 62.5, overBudget: 43 })]) {
      expect(environmentSustainsBudget(c, FRAME_BUDGET_MS)).toBe(false);
      // maxMs past the budget means at least one spin was counted over it.
      expect(c.overBudget).toBeGreaterThanOrEqual(1);
      expect(overBudgetRate(c.overBudget, c.count)).toBeGreaterThanOrEqual(spinResolution(c.count));
    }
  });

  /**
   * The case that set {@link CLEARS_BUDGET} to 1.
   *
   * Measured, not hypothesised: a regression patched into the real `Compositor.render`
   * — 20 ms on one frame in thirty — put a 20.20 ms frame in the scrub phase beside a
   * control that had done its 8.33 ms of arithmetic in 14.50 ms at worst. That is a
   * host inside the budget and a compositor outside it, which is the one shape this
   * whole file exists to fail on, and at 0.8 it was excused: the phase routed to the
   * deferred branch on a control 2.17 ms *under* §8's number, and the frame was judged
   * against 14.50 × 1.5 = 21.75 ms instead. Only the play phase caught the mutation.
   *
   * A host that keeps half a budget of arithmetic inside a whole budget has not
   * demonstrated it cannot hold the budget, so it does not get to speak for the
   * compositor.
   */
  it('CONTROL: a host inside the budget does not excuse a frame outside it', () => {
    const host = control({ count: 27, maxMs: 14.5, maxAt: 21, meanMs: 9.11 });
    const { measured } = evidence({ count: 117, maxMs: 20.2, maxAt: 86, overBudget: 1 }, host);

    expect(host.maxMs).toBeLessThanOrEqual(FRAME_BUDGET_MS);
    expect(environmentSustainsBudget(host, FRAME_BUDGET_MS)).toBe(true);
    // So the gate asserts §8's pair — and these are the two assertions it makes there,
    // verbatim. Both must fail on that frame; the tracking ceiling never gets a say.
    expect(() => {
      expect(measured.overBudget).toBe(0);
    }).toThrow();
    expect(() => {
      expect(measured.maxMs).toBeLessThanOrEqual(FRAME_BUDGET_MS);
    }).toThrow();
    // What excused it before: the ceiling the deferred branch would have earned sat
    // above the offending frame, so that branch had nothing to say about it either.
    expect(measured.maxMs).toBeLessThan(host.maxMs * TRACKS_CONTROL);
  });

  /**
   * The case that put a share beside the ceiling, and the honest edge of what it buys.
   *
   * Measured, from the same regression as the case above — 20 ms on one frame in thirty,
   * patched into the real `Compositor.render` — run seven times against this gate. The
   * ceiling on its own is `TRACKS_CONTROL` × a number taken on the main thread the
   * regression is saturating, so it rises with the thing it is judging: three runs put
   * 27–29 play frames at three times §8's budget and passed, the play control having read
   * 36.50, 40.60 and 75.30 ms and earned ceilings of 54.75, 60.90 and 112.95 ms.
   *
   * How *often* is the statistic the compositor cannot inflate — the spin runs after the
   * frame body, so none of the regression's own burn lands in it — and on a quiet host it
   * separates cleanly: 30 of 900 play frames, 3.33%, against 2 of 204 spins, 0.98%.
   *
   * It is not sufficient, and the second half of this test says where it stops. Under
   * sustained load the control's 8.33 ms window needs only another 8.33 ms of stall to
   * miss the budget where a 0.20 ms composite needs sixteen, so the host's own share runs
   * *ahead* of the regression's — 43 of 194 spins, 22.16%, beside 27 of 720 frames,
   * 3.75%, on a box with 20 spinners on it. That reading is exactly why there is no
   * factor here to make it separate: a share a stalling host inflates would be the
   * ceiling's own circularity one level up, and tuning one until a known mutation failed
   * would be fitting the instrument to the defect it is meant to find.
   *
   * It was re-measured once the control stopped timing its period from the *start* of a
   * spin — a control that spun harder the slower the host got could have manufactured
   * this whole band, see the pacing test above — and the band survived: three runs of
   * three under the same 20 spinners put the host at 9.09%, 14.10%/14.74% and 28.06% of
   * its own spins against 0.78–3.33% of the regression's frames, and the mutation
   * passed all three. Quiet, that same mutation now fails four runs of four, three of
   * them on §8's own number with the control never reaching this branch.
   */
  it('CONTROL: a regression missing the budget oftener than the host fails on the share', () => {
    // Quiet host, measured: the ceiling excuses it and the share does not.
    const host = control({ count: 204, maxMs: 23.7, maxAt: 114, meanMs: 8.54, overBudget: 2 });
    const regressed = evidence({ count: 900, maxMs: 20.3, maxAt: 256, overBudget: 30 }, host);
    expect(environmentSustainsBudget(host, FRAME_BUDGET_MS)).toBe(false);
    expect(regressed.measured.maxMs).toBeLessThan(host.maxMs * TRACKS_CONTROL);
    expect(() => expectTracksControl(regressed)).toThrow(/30 of 900 frames over/);

    // And the edge, measured on the same commit under load: a host missing the budget on
    // 22% of its own spins says nothing about a compositor missing it on 4% of frames,
    // so both this branch's bounds are lifted and the deferral is reported as one.
    const stalling = control({ count: 194, maxMs: 62.5, maxAt: 41, meanMs: 14.37, overBudget: 43 });
    const underLoad = evidence({ count: 720, maxMs: 60.9, maxAt: 256, overBudget: 27 }, stalling);
    expect(expectTracksControl(underLoad)).toContain('this environment cannot sustain');
    // Reported with both shares in it, so the deferral CI reads names what it excused.
    expect(expectTracksControl(underLoad)).toContain('3.75%');
    expect(expectTracksControl(underLoad)).toContain("host's own 22.16%");
  });

  it('CONTROL: the share can only ever fire on a phase that already missed §8', () => {
    // The one property that makes this safe to add to an acceptance gate: it is not a
    // new way to fail a good run. With no frame over budget the share is zero and
    // nothing under it, however healthy or wretched the host beside it was.
    for (const host of [JUST_OVER, STALLED, control({ maxMs: 62.5, overBudget: 43, count: 194 })]) {
      expect(overBudgetRate(0, 900)).toBe(0);
      expect(expectTracksControl(evidence({ maxMs: host.maxMs, overBudget: 0 }, host))).toContain(
        'this environment cannot sustain',
      );
    }
  });

  it('CONTROL: a control that measured nothing enforces the bound rather than lifting it', () => {
    // "Shown nothing about the host" must never read as "the host is the problem".
    // The gate additionally asserts the control's sample count against the phase's,
    // so a control that silently stopped fails loudly there instead of here.
    expect(environmentSustainsBudget(NO_CONTROL, FRAME_BUDGET_MS)).toBe(true);
    expect(environmentSustainsBudget(control({ count: 0, maxMs: 0 }), FRAME_BUDGET_MS)).toBe(true);
  });
});

/**
 * **An instrument out of calibration yields no verdict.**
 *
 * The control is a fixed span of arithmetic with none of the compositor's code in it,
 * given {@link CONTROL_PERIOD_MS} of free clock after every spin. When that cannot finish
 * {@link CONTROL_TARGET_MS} of work inside one 60 Hz refresh, the host was not scheduling
 * the process, and a frame time sampled from the same windows is scheduler noise carrying
 * a number. There is nothing left to judge it against — the ceiling the deferred branch
 * used to fall to is a multiple of the stalled number itself, and the share beside it is
 * counted over the very windows the stall landed in — so the phase reports **no verdict**.
 *
 * Measured, on `main` and on the branch behind it. Five of the last fifteen CI runs on
 * `main` went red, every one of them on this gate and on nothing else. Run 31074994194
 * (`main`): the play control was pre-empted to 22.60 ms doing 8.33 ms of arithmetic, one
 * spin of 158 over the budget, and the phase failed on a 52.90 ms frame against the
 * 33.90 ms ceiling that same stalled number earned. Run 31075861127
 * (`fm/loom-p14-editor-shell`) rules out the obvious confounder — the repository's other
 * macOS job was *skipped* on that run and only started after `verify` had finished, so
 * nothing of ours shared the host — and the control was still pre-empted to 26.00 ms with
 * two spins of 136 over budget, failing the phase on a 40.10 ms frame against a 39.00 ms
 * ceiling, 1.03× it.
 *
 * The tests that matter here are the second, the third and the fourth. The second
 * constructs the case this must never stop failing — a clean control beside a frame over
 * budget — from those same two runs, substituting the control's *health* and nothing
 * else: each run keeps its own spin count, its own worst-spin index, its own frames and
 * its own host. §8's strict pair fails both runs there, and that is the half a
 * withholding must never be able to touch.
 *
 * The deferred branch's answer is **not** uniform across the two, and is asserted as what
 * it is rather than made to look uniform. The scaled envelope catches run 31074994194's
 * 52.90 ms frame whatever the spin count; run 31075861127's *single* over-budget frame in
 * 310 is 0.32%, finer than the 0.74% its own 136-spin control can resolve, so that phase
 * comes back INCONCLUSIVE. That is a real finding about the instrument's resolution — a
 * phase that short cannot tell one frame apart from the host's own quantised zero — and
 * it is recorded rather than dressed up as a throw. So the share door is proved by the
 * third test instead, at a shape a real run produced and against a regression a real
 * compositor could make. The fourth pins that the withholding keys on the control's own
 * overrun and on nothing else at all.
 */
interface RedRun {
  control: ControlPhase;
  measured: BudgetEvidence['measured'];
  host: HostProfile;
  /**
   * What the deferred branch makes of this phase once only the control's *health* is
   * substituted and the run's own spin count is kept — a throw, and which bound, or the
   * line it reports instead.
   */
  cleanControl: { throws: boolean; matches: RegExp };
}

describe('a control that missed its own budget yields no verdict', () => {
  /** `budget-control.ts`'s own `fmt`, so these assertions read the line it really writes. */
  const figure = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(2);

  /**
   * The play phase of CI run 31074994194: `main`, red on this gate at the time of writing.
   *
   * `cleanControl` is what door two — a healthy control on a host that is not the
   * product's machine — makes of this same phase once only the control's health is
   * substituted. The scaled envelope catches it here: 16.67 × 2.878 / 1.667 = 28.78 ms
   * against a 52.90 ms frame, which it clears by 24 ms whatever the spin count beside it.
   */
  const RED_MAIN = {
    control: control({ count: 158, maxMs: 22.6, maxAt: 149, meanMs: 8.5, overBudget: 1 }),
    measured: { count: 470, maxMs: 52.9, maxAt: 330, overBudget: 1 },
    host: { hardwareDecode: 'no', gpu: { count: 238, medianMs: 2.878, maxMs: 27.062 } },
    cleanControl: { throws: true, matches: /this host's own workload earns/ },
  } satisfies RedRun;
  /**
   * The play phase of CI run 31075861127, measured with no concurrent macOS job of ours.
   *
   * At this phase's **own** 136 spins neither remaining door reaches it once the control
   * is healthy: this host's deeper GPU cost earns an envelope of 16.67 × 4.509 / 1.667 =
   * 45.09 ms against a 40.10 ms frame, and one over-budget frame in 310 is 0.32% against
   * the 0.74% a 136-spin control can resolve. So it reports INCONCLUSIVE, which is the
   * honest reading of a phase too short to separate one frame from the host's quantised
   * zero. §8's own strict pair still fails it; the share door is proved below instead.
   */
  const RED_ALONE = {
    control: control({ count: 136, maxMs: 26, maxAt: 132, meanMs: 8.71, overBudget: 2 }),
    measured: { count: 310, maxMs: 40.1, maxAt: 28, overBudget: 1 },
    host: { hardwareDecode: 'no', gpu: { count: 121, medianMs: 4.509, maxMs: 17.917 } },
    cleanControl: { throws: false, matches: /INCONCLUSIVE rather than passed/ },
  } satisfies RedRun;

  it('reports the two runs that turned this gate red as not judged, naming the overrun', () => {
    for (const run of [RED_MAIN, RED_ALONE]) {
      const stalled = evidence(run.measured, run.control, run.host);
      // What used to happen, and what still happens to everything else on this door:
      // the ceiling is `TRACKS_CONTROL` × the stalled number, and the frame is over it.
      expect(run.measured.maxMs).toBeGreaterThan(run.control.maxMs * TRACKS_CONTROL);
      expect(() => expectTracksControl(stalled)).toThrow(/ceiling this host earned/);

      // And what happens now: the instrument is judged first, and it failed.
      expect(instrumentOutOfCalibration(stalled)).toBe(true);
      const line = withheldJudgement(stalled);
      expect(line).toContain('NOT JUDGED');
      expect(line).toContain('this is not a pass');
      // The control's own measured overrun, in the line, because that is what this
      // verdict keys on and a reader must not have to take it on trust.
      expect(line).toContain(`took up to ${figure(run.control.maxMs)} ms`);
      expect(line).toContain(`${String(run.control.overBudget)} over the 16.67 ms budget`);
      // The frames are named too — as unjudged, so nothing here can be read as either
      // the compositor holding the budget or the compositor missing it.
      expect(line).toContain(`worst frame ${run.measured.maxMs.toFixed(2)} ms`);
      // And what the withheld bounds would have said is still printed, so a compositor
      // that really was slow on a stalled host leaves its evidence in the log.
      expect(line).toContain('ceiling this host earned');
      // The last thing read says the same as the first. That borrowed line ends in the
      // deferred branch's vocabulary, and where those bounds happen to clear it ends in
      // something that reads like a verdict — so the withheld line closes on its own
      // terms rather than on theirs.
      expect(line.endsWith('this run is not a pass on it.')).toBe(true);
    }
    // Including the shape where the borrowed bounds cleared, which is the one a reader
    // could otherwise skim to the end of and come away reassured by.
    const cleared = withheldJudgement(evidence({ maxMs: 0.3, overBudget: 0 }, STALLED));
    expect(cleared).toContain('missed the budget no oftener than this host missed it');
    expect(cleared.endsWith('this run is not a pass on it.')).toBe(true);
  });

  /**
   * **The one that proves this is not a way out.**
   *
   * Constructed deliberately, and from the failing runs above rather than from a
   * convenient fiction: the same frames, the same hosts, the same spin counts — with the
   * control's *health* replaced and nothing else. §8's own strict pair must still fail
   * both runs, and it does; that half is untouched by anything the control measured.
   *
   * The deferred branch's own answer differs between them and each run asserts its own,
   * because substituting a healthy control at a spin count neither phase measured is what
   * made it look uniform: `HEALTHY`'s own 360 spins bought run 31075861127 a resolution it
   * never had, turning its one over-budget frame into a throw. A check exercised at
   * conditions that cannot occur proves nothing about the conditions that can, so the
   * share door is proved separately, at a reachable shape, in the test below.
   *
   * ## What a phase can carry: one invariant, and one argument that is only an argument
   *
   * **Structural, and asserted on the fixtures below: spins ≤ frames.** Not a reading of
   * the pacing — an identity of the dispatch loop, which is why it can never reject a
   * real measurement. `counting()` in `test/gate/harness.ts` runs
   * `callback(nowMs); afterFrame(); frames += 1;`, so `afterFrame` fires exactly once per
   * scheduler dispatch, unconditionally and after the callback. The gate's one
   * `EnvironmentControl` is constructed in that same file and its only `afterFrame` is
   * `gpuCost.sample(); control.tick();`; nothing else in the gate calls `tick()`, and
   * `EnvironmentControl.tick()` holds a single `#metrics.record(#spin(targetMs))` with no
   * loop, so it records **at most one** spin per call. On the other side,
   * `PreviewLoop.#schedule()` requests
   * `(nowMs) => { this.#handle = null; this.#frame(nowMs); this.#schedule(); }`, so one
   * dispatch runs exactly one `#frame`, and `#frame` closes with an unconditional
   * `this.metrics.record(elapsed)` — a render that threw is caught inside the frame body,
   * so even a refused frame is counted. `stop()` cancels the in-flight handle and every
   * snapshot/reset pair in the harness is one synchronous block, so no dispatch straddles
   * a phase boundary. Dispatches therefore equal measured frames and spins never exceed
   * them; a callback that threw would yield *fewer* spins, which is the safe direction.
   *
   * That settles run 31075861127 outright: `HEALTHY`'s 360 spins is more than that phase
   * had frames at all, so it is not a healthier host but a control the phase could not
   * have produced. It does **not** settle run 31074994194, where 360 is under 470, and
   * the only thing claimed there is the plain one — 360 is not the number that phase
   * measured, and the counter-case uses its own 158 either way. The arithmetic suggests a
   * cap near 235 for it (360 spins need at least 15.0 s of phase, over which 470 frames
   * average 31.9 ms, so only every second frame clears the 41.67 ms gate), and **nothing
   * here checks that**.
   *
   * **`framesPerSpin` is not the bound to reach for, and this is why.** It caps
   * frames-per-spin only where frames really are delivered at the panel's rate. On a
   * stalled host — which is exactly what both of these runs are — they arrive further
   * apart, so `CONTROL_TARGET_MS + CONTROL_PERIOD_MS` elapses in fewer of them and the
   * control spins on a *larger* fraction. Both runs measured under three frames to a
   * spin: 470 / 158 = 2.97 and 310 / 136 = 2.28. Nothing about that weakens its use in
   * `test/phase6-gate.test.ts`, whose ratio cap and spin floors bound the other direction.
   *
   * If this test can be made to pass by a change to the withholding, the withholding has
   * become a tolerance and the gate has stopped being a gate.
   */
  it('CONTROL: a clean control beside a frame over budget still fails §8 on both runs', () => {
    for (const run of [RED_MAIN, RED_ALONE]) {
      // Only the instrument's *health* is substituted. This phase's own spin count and
      // its own worst-spin index stay, so the resolution the share is judged at is the
      // one this phase really had — pinned here so a future edit cannot re-inflate it.
      const healthy = control({ ...HEALTHY, count: run.control.count, maxAt: run.control.maxAt });
      expect(healthy.count).toBe(run.control.count);
      expect(healthy.maxAt).toBe(run.control.maxAt);
      expect(healthy.maxMs).toBe(HEALTHY.maxMs);
      expect(healthy.overBudget).toBe(0);
      // And the fixture itself is held to the dispatch loop's own identity: one spin per
      // dispatch at most, one measured frame per dispatch exactly, so a recorded phase
      // claiming more spins than frames is impossible rather than merely unlikely. That
      // is what `HEALTHY`'s 360 was beside run 31075861127's 310 frames.
      expect(run.control.count).toBeLessThanOrEqual(run.measured.count);

      // The host held the budget in these frames — the same 8.4 ms spin the quiet
      // runners measure — so nothing is withheld and the phase is judged.
      expect(instrumentOutOfCalibration(evidence(run.measured, healthy, TARGET_HOST))).toBe(false);

      // Door one: a host that runs the product's own workload. §8's number applies
      // exactly as written, these are the gate's two assertions verbatim, and both fail
      // on both runs whatever the spin count beside them.
      const strict = evidence(run.measured, healthy, TARGET_HOST);
      expect(assertsAbsoluteBudget(strict)).toBe(true);
      expect(() => {
        expect(strict.measured.overBudget).toBe(0);
      }).toThrow();
      expect(() => {
        expect(strict.measured.maxMs).toBeLessThanOrEqual(FRAME_BUDGET_MS);
      }).toThrow();

      // Door two: a host that is a different machine, judged by the deferred branch. Each
      // run asserts what that branch genuinely does with it, by name — the scaled
      // envelope on the first, and on the second the INCONCLUSIVE verdict a 136-spin
      // control earns a single frame of 310. Never a matcher that would accept any throw,
      // and never a throw manufactured out of a spin count the phase did not have.
      const deferred = evidence(run.measured, healthy, run.host);
      expect(assertsAbsoluteBudget(deferred)).toBe(false);
      expect(instrumentOutOfCalibration(deferred)).toBe(false);
      if (run.cleanControl.throws) {
        expect(() => expectTracksControl(deferred)).toThrow(run.cleanControl.matches);
      } else {
        expect(expectTracksControl(deferred)).toMatch(run.cleanControl.matches);
      }
    }
  });

  /**
   * **The share door, proved against a regression a real compositor could make.**
   *
   * The counter-case above establishes the envelope and cannot establish the share: both
   * red runs are a *single* over-budget frame, and one frame of 470 or of 310 is finer
   * than either phase's own control could resolve. Inflating the substituted control's
   * spin count until it did resolve would be proving the door at a condition the gate
   * cannot meet, which is no proof at all.
   *
   * So it is proved at a shape a real run produced — run 31074994194's own 470 frames and
   * its own 158-spin control, made healthy — carrying the regression this project has
   * already measured against this gate: 20 ms burned on one composite in thirty, worst
   * frame 20.30 ms. That is 15 frames of 470, 3.19%, against the 0.63% a 158-spin control
   * resolves and a host that missed none of its own spins.
   *
   * `verify:mutation`'s `the-over-budget-share-is-never-compared` deletes that comparison
   * from `test/gate/budget-control.ts` on disk and requires this file to notice.
   */
  it('CONTROL: the share catches a reachable regression at a shape a real run produced', () => {
    const spins = RED_MAIN.control.count;
    const frames = RED_MAIN.measured.count;
    const healthy = control({ ...HEALTHY, count: spins, maxAt: RED_MAIN.control.maxAt });
    // One composite in thirty, over this run's own frame count.
    const regressed = {
      count: frames,
      maxMs: 20.3,
      maxAt: 256,
      overBudget: Math.floor(frames / 30),
    };

    // Not the envelope: this host's own per-frame workload earns 28.78 ms and the
    // regression's worst frame is 20.30 ms, so what fires below is the share alone.
    expect(scaledFrameEnvelope(RED_MAIN.host, FRAME_BUDGET_MS) ?? 0).toBeGreaterThan(
      regressed.maxMs,
    );
    expect(overBudgetRate(regressed.overBudget, frames)).toBeGreaterThan(spinResolution(spins));
    expect(() => expectTracksControl(evidence(regressed, healthy, RED_MAIN.host))).toThrow(
      /a larger share than this host missed it on of its own spins/,
    );

    // CONTROL: the same evidence with the regression taken back out — this run's own
    // single over-budget frame, everything else identical — must not throw, so the throw
    // above is the regression's doing rather than the fixture's. One frame of 470 is
    // 0.21% against the 0.63% a 158-spin control can resolve.
    const unregressed = { ...regressed, overBudget: RED_MAIN.measured.overBudget };
    expect(overBudgetRate(unregressed.overBudget, frames)).toBeLessThan(spinResolution(spins));
    const reported = expectTracksControl(evidence(unregressed, healthy, RED_MAIN.host));
    expect(reported).toContain('INCONCLUSIVE rather than passed');
    expect(reported).toContain(`${String(spins)}-spin control can resolve`);
  });

  it('CONTROL: keys on the control’s own overrun and on nothing else', () => {
    // Nothing about the frames can withhold a verdict. A phase 100× over budget, on
    // every host profile this gate knows, beside a control that held: judged, every time.
    for (const host of [TARGET_HOST, RUNNER_HOST, UNKNOWN_HOST]) {
      for (const measured of [
        { count: 470, maxMs: 0.3, overBudget: 0 },
        { count: 470, maxMs: 1667, maxAt: 12, overBudget: 470 },
      ]) {
        expect(instrumentOutOfCalibration(evidence(measured, HEALTHY, host))).toBe(false);
      }
    }

    // And the verdict flips exactly at the budget, because `CLEARS_BUDGET` is 1: a
    // control that reached the budget held it, and one that passed it did not. No
    // margin, no tolerance, and no percentile — the same boundary
    // `environmentSustainsBudget` already draws, which is the point of defining this
    // from it rather than beside it.
    const atBudget = control({ maxMs: FRAME_BUDGET_MS });
    const justPast = control({ maxMs: FRAME_BUDGET_MS * (1 + Number.EPSILON), overBudget: 1 });
    expect(instrumentOutOfCalibration(evidence({}, atBudget))).toBe(false);
    expect(instrumentOutOfCalibration(evidence({}, justPast))).toBe(true);
    expect(CLEARS_BUDGET).toBe(1);
    for (const c of [HEALTHY, STALLED, JUST_OVER, atBudget, justPast, NO_CONTROL]) {
      expect(instrumentOutOfCalibration(evidence({}, c))).toBe(
        !environmentSustainsBudget(c, FRAME_BUDGET_MS),
      );
    }
  });

  /**
   * `verify:mutation`'s `a-dead-control-withholds-the-verdict` keys the withholding on
   * something other than the control's own measured overrun — a control that produced
   * nothing — in `test/gate/budget-control.ts` on disk, and requires this file to notice.
   */
  it('CONTROL: a control that measured nothing is judged, never withheld', () => {
    // The one shape that must not reach this branch. A dead instrument has shown
    // nothing, and "shown nothing" must never buy a compositor a withheld verdict —
    // otherwise "the control stopped running" and "the gate has no opinion" become the
    // same event, silently, forever. The gate asserts the spin count separately, so an
    // empty control fails there with its own number in the message.
    expect(instrumentOutOfCalibration(evidence({}, NO_CONTROL))).toBe(false);
    expect(instrumentOutOfCalibration(evidence({}, control({ count: 0, maxMs: 0 })))).toBe(false);
    expect(assertsAbsoluteBudget(evidence({ maxMs: 20.2, overBudget: 1 }, NO_CONTROL))).toBe(true);
  });

  it('reports what the withheld bounds would have said, without acting on it', () => {
    // A line either way, never a throw: this is the log's record of a judgement that
    // was not made, and the gate prints it beside the withheld verdict.
    const caught = deferredBoundsOutcome(
      evidence(RED_MAIN.measured, RED_MAIN.control, RED_MAIN.host),
    );
    expect(caught).toContain('they caught it anyway');
    expect(caught).toContain('ceiling this host earned');
    const cleared = deferredBoundsOutcome(evidence({ maxMs: 0.3, overBudget: 0 }, STALLED));
    expect(cleared).toContain('those bounds did not reach it');
    expect(cleared).toContain('this environment cannot sustain');
  });
});

/**
 * **The other half of the branch condition: is a frame here the frame §8 is about?**
 *
 * The control above is pure arithmetic, and that is what makes it a control — and what
 * makes it blind to the one path a virtualised runner's cost actually lives on. CI run
 * 31039796990 is the whole case: the control found the host healthy (10.10 ms worst spin,
 * 8.47 ms mean, nothing over budget), the strict branch applied, and §8 failed on a
 * 17.20 ms frame beside a 5.00 ms p99 — a cost the spin could not have seen, because it
 * was a ~30 MB CPU-backed `texImage2D` that exists only where there is no hardware
 * decoder to hand the compositor an IOSurface.
 *
 * So {@link hostRepresentsTarget} asks the two structural questions, and this file pins
 * both that it separates the two measured profiles and — the part that matters — that a
 * real compositor regression still fails on *both* sides of it.
 */
describe('the frame budget is enforced against a host that runs the product', () => {
  it('draws the line at a tenth of §8’s own frame, not between two machines', () => {
    // The derivation, and it is the derivation rather than a threshold placed to clear a
    // run: §8 gives the whole frame 16.67 ms, and a host whose *unregressed* composite
    // already spends a tenth of that on the GPU is not running the product's workload.
    // One tenth is the order of magnitude, expressed against the only number in this
    // gate that was not measured on somebody's particular machine.
    expect(REPRESENTATIVE_GPU_SHARE).toBe(1 / 10);
    expect(REPRESENTATIVE_GPU_MS).toBeCloseTo(FRAME_BUDGET_MS / 10, 10);

    // And the check on it, which is not the same thing as the derivation: the two
    // profiles this project has measured land either side with room, an order of
    // magnitude apart. Neither is within a factor of two of deciding it.
    const target = TARGET_HOST.gpu.medianMs ?? 0;
    const runner = RUNNER_HOST.gpu.medianMs ?? 0;
    expect(runner / target).toBeGreaterThan(10);
    expect(REPRESENTATIVE_GPU_MS / target).toBeGreaterThan(5);
    expect(runner / REPRESENTATIVE_GPU_MS).toBeGreaterThan(1.9);
  });

  it('separates the machines this ships to from the runner', () => {
    expect(hostRepresentsTarget(TARGET_HOST)).toBe(true);
    expect(hostRepresentsTarget(RUNNER_HOST)).toBe(false);
  });

  it('takes both facts, so the compositor cannot buy its own way out of §8', () => {
    // The GPU reading is the one number here the thing under test can move, and the
    // conjunction is what stops it being a lever: `hardwareDecode` is a property of the
    // platform, probed before a frame is composited. On the hardware this ships to it is
    // `'yes'`, the GPU reading is never consulted, and a compositor that got slow on the
    // GPU is held to §8 exactly as written however much it spends there.
    expect(
      hostRepresentsTarget({ hardwareDecode: 'yes', gpu: { count: 90, medianMs: 40, maxMs: 61 } }),
    ).toBe(true);
    // And a missing decoder alone is not enough either: without the upload actually
    // landing in the frame there is nothing to say this host's frame is a different
    // piece of work.
    expect(
      hostRepresentsTarget({
        hardwareDecode: 'no',
        gpu: { count: 300, medianMs: 0.4, maxMs: 0.9 },
      }),
    ).toBe(true);
  });

  it('CONTROL: anything unmeasured tightens this gate rather than loosening it', () => {
    // The same rule `environmentSustainsBudget` follows for an empty control. A probe
    // that could not answer, and a driver with no timer query, have shown nothing about
    // the host — and "shown nothing" must never buy the compositor a weaker bound.
    expect(hostRepresentsTarget(UNKNOWN_HOST)).toBe(true);
    expect(hostRepresentsTarget({ hardwareDecode: 'unknown', gpu: RUNNER_HOST.gpu })).toBe(true);
    expect(hostRepresentsTarget({ hardwareDecode: 'no', gpu: NO_GPU_PROFILE })).toBe(true);
    expect(gpuProfile([])).toEqual(NO_GPU_PROFILE);
  });

  /**
   * **The proof, and the thing this round turns on.**
   *
   * The documented regression — 20 ms burned on one composite in thirty, patched into
   * the shipping `Compositor.render` — must go red on a representative host *and* on a
   * host the gate has just declared cannot represent the product. If it can pass on
   * either, the representativeness branch is a hole rather than a discrimination.
   *
   * The figures are this project's own: 30 of 900 play frames over budget at 20.30 ms
   * worst, beside a control that did its 8.33 ms of arithmetic in 8.40 ms and never
   * missed a window.
   */
  it('CONTROL: a real compositor regression fails on both branches', () => {
    const regressed = { count: 900, maxMs: 20.3, maxAt: 256, overBudget: 30 };

    // Representative host: the strict branch, and these are the two assertions the gate
    // makes there, verbatim. Both fail.
    const strict = evidence(regressed, HEALTHY, TARGET_HOST);
    expect(assertsAbsoluteBudget(strict)).toBe(true);
    expect(() => {
      expect(strict.measured.overBudget).toBe(0);
    }).toThrow();
    expect(() => {
      expect(strict.measured.maxMs).toBeLessThanOrEqual(FRAME_BUDGET_MS);
    }).toThrow();

    // Non-representative host, on each of the two control readings a runner has actually
    // produced beside a healthy spin. No per-frame number is asserted there — and the
    // share catches the regression anyway: 3.33% of frames against a host that missed
    // none of its own spins, five times over what those controls can resolve.
    for (const c of [HEALTHY, control({ count: 154, maxMs: 10.1, maxAt: 96, meanMs: 8.47 })]) {
      const deferred = evidence(regressed, c, RUNNER_HOST);
      expect(assertsAbsoluteBudget(deferred)).toBe(false);
      expect(environmentSustainsBudget(c, FRAME_BUDGET_MS)).toBe(true);
      expect(overBudgetRate(regressed.overBudget, regressed.count)).toBeGreaterThan(
        spinResolution(c.count) * 4,
      );
      expect(() => expectTracksControl(deferred)).toThrow(
        /a larger share than this host missed it on of its own spins/,
      );
    }

    // And where a host stall opens the ceiling's door but lifts it over the regression,
    // the share still has it: the spin runs after the frame body, so none of the
    // regression's own burn lands in it.
    const stalled = control({ count: 204, maxMs: 23.7, maxAt: 114, meanMs: 8.54, overBudget: 2 });
    const underStall = evidence(regressed, stalled, RUNNER_HOST);
    expect(environmentSustainsBudget(stalled, FRAME_BUDGET_MS)).toBe(false);
    expect(regressed.maxMs).toBeLessThan(stalled.maxMs * TRACKS_CONTROL);
    expect(() => expectTracksControl(underStall)).toThrow(/30 of 900 frames over/);
  });

  it('reports which half deferred the phase, with the figures for both', () => {
    const shortfall = expectTracksControl(
      evidence({ maxMs: 12, overBudget: 0 }, HEALTHY, RUNNER_HOST),
    );
    expect(shortfall).toContain('cannot run the workload §8 is about');
    expect(shortfall).toContain('hardware-backed decode: no');
    expect(shortfall).toContain('3.31 ms median GPU composite');
    // And both halves, when both are why.
    const both = expectTracksControl(evidence({ maxMs: 12, overBudget: 0 }, STALLED, RUNNER_HOST));
    expect(both).toContain('this environment cannot sustain');
    expect(both).toContain('cannot run the workload §8 is about');
  });

  /**
   * The probe, which has to be a reading of the driver's queries rather than of the
   * gate's frames.
   *
   * `GpuTimer.lastMs` holds the most recent *completed* query, so it repeats across the
   * frames between results; recording every frame would weight the median by how long a
   * value happened to sit there rather than by how often the GPU produced it.
   */
  it('samples the timer query’s own cadence, not the frame rate', () => {
    const source = { lastMs: null as number | null };
    const probe = new GpuCostProbe(source);
    const feed = (values: (number | null)[]): void => {
      for (const value of values) {
        source.lastMs = value;
        probe.sample();
      }
    };

    // Disarmed, nothing is recorded however many frames go by.
    feed([1, 2, 3]);
    expect(probe.snapshot()).toEqual(NO_GPU_PROFILE);

    // And arming does not adopt the query standing at that moment — on the real harness
    // that is a warmup composite, specifically the first 4K `texImage2D` the warmup
    // phase exists to hold, and it would land in the median this test reads.
    const warm = { lastMs: 24.5 as number | null };
    const armed = new GpuCostProbe(warm);
    armed.arm();
    armed.sample();
    expect(armed.snapshot()).toEqual(NO_GPU_PROFILE);
    warm.lastMs = 0.31;
    armed.sample();
    expect(armed.snapshot()).toEqual({ count: 1, medianMs: 0.31, maxMs: 0.31 });

    probe.arm();
    // Three completed queries held across nine frames are three samples, and the median
    // is the middle query rather than the value that sat there longest.
    feed([0.3, 0.3, 0.3, 5, 5, 5, 5, 0.4, 0.4]);
    expect(probe.snapshot()).toEqual({ count: 3, medianMs: 0.4, maxMs: 5 });

    // A driver with no timer query answers null forever, and that is not a zero.
    const blind = new GpuCostProbe({ lastMs: null });
    blind.arm();
    blind.sample();
    expect(blind.snapshot().medianMs).toBeNull();

    // Reset clears the phase, not the last value seen: the next phase must not re-record
    // the reading the previous one ended on.
    probe.reset();
    expect(probe.snapshot()).toEqual(NO_GPU_PROFILE);
    feed([0.4, 0.4, 0.9]);
    expect(probe.snapshot()).toEqual({ count: 1, medianMs: 0.9, maxMs: 0.9 });
  });
});
