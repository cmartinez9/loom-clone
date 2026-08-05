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
  CLEARS_BUDGET,
  CONTROL_PERIOD_MS,
  CONTROL_TARGET_MS,
  EnvironmentControl,
  environmentSustainsBudget,
  expectTracksControl,
  framesPerSpin,
  NO_CONTROL,
  overBudgetRate,
  SLOW_COMPOSITE_MS,
  TRACKS_CONTROL,
  type BudgetEvidence,
  type ControlPhase,
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

function evidence(measured: Partial<BudgetEvidence['measured']>, c: ControlPhase): BudgetEvidence {
  return {
    what: 'play',
    budgetMs: FRAME_BUDGET_MS,
    measured: { count: 360, maxMs: 0.3, maxAt: 71, overBudget: 0, ...measured },
    control: c,
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
   * simulated fixed-refresh scheduler, at each of the three panels the gate reads off.
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
    // cleared the budget — no reading can lift the ceiling that far: the most one can
    // earn there is 25 ms, against 66.67 ms of burn.
    const clearing = control({ maxMs: FRAME_BUDGET_MS * CLEARS_BUDGET });
    expect(environmentSustainsBudget(clearing, FRAME_BUDGET_MS)).toBe(true);
    expect(FRAME_BUDGET_MS * CLEARS_BUDGET * TRACKS_CONTROL).toBeLessThan(SLOWED_MS);
    expect(() =>
      expectTracksControl(evidence({ maxMs: SLOWED_MS, overBudget: 24 }, clearing)),
    ).toThrow(/cannot hold this machine's own ceiling/);
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
