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
  environmentSustainsBudget,
  expectTracksControl,
  NO_CONTROL,
  TRACKS_CONTROL,
  type BudgetEvidence,
  type ControlPhase,
} from './gate/budget-control.ts';

const FRAME_BUDGET_MS = 1000 / 60;
/** What the harness's deliberately-slowed compositor burns inside `render`. */
const SLOWED_MS = FRAME_BUDGET_MS * 4;

function control(overrides: Partial<ControlPhase> = {}): ControlPhase {
  return { ...NO_CONTROL, count: 360, maxMs: 8.4, maxAt: 100, meanMs: 8.36, ...overrides };
}

/** A host doing exactly what it was asked: half a budget of arithmetic, in half a budget. */
const HEALTHY = control();
/** A host that stalled: the same arithmetic, stretched past a whole frame. */
const STALLED = control({ maxMs: 74.2, overBudget: 2 });
/** A host that only just clears the budget — which is not the same as holding it. */
const MARGINAL = control({ maxMs: 15.9 });

function evidence(measured: Partial<BudgetEvidence['measured']>, c: ControlPhase): BudgetEvidence {
  return {
    what: 'play',
    budgetMs: FRAME_BUDGET_MS,
    measured: { count: 360, maxMs: 0.3, maxAt: 71, overBudget: 0, ...measured },
    control: c,
  };
}

describe('the frame budget is enforced against a measured environment', () => {
  it('asks the host for a quarter of the clock, so the control is exposed like a frame is', () => {
    // Occupancy is exposure: a stall lands inside a window in proportion to how much
    // of the clock that window takes. A control costing nothing would sit beside every
    // stall it exists to catch, and one costing a whole thread would break the run it
    // is measuring — which the first version of it did. A quarter is the same order as
    // the ~30% of a frame an honest CPU-backed 4K upload occupies on the runner.
    expect(CONTROL_TARGET_MS).toBeCloseTo(FRAME_BUDGET_MS / 2, 10);
    expect(CONTROL_TARGET_MS / CONTROL_PERIOD_MS).toBeCloseTo(0.25, 10);
    // Paced by the wall clock, never by the display: a 120 Hz panel must not double
    // what the control costs, and a 60 Hz one must not halve what it measures.
    expect(CONTROL_PERIOD_MS).toBeGreaterThan(FRAME_BUDGET_MS);
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

  it('does not treat a control that barely clears the budget as holding it', () => {
    // Two different workloads sampled in the same frames are not two readings of one
    // quantity. A host already inflating 8.33 ms of arithmetic to 15.9 ms has not
    // shown it can promise 16.67 ms to a frame.
    expect(MARGINAL.maxMs).toBeLessThan(FRAME_BUDGET_MS);
    expect(environmentSustainsBudget(MARGINAL, FRAME_BUDGET_MS)).toBe(false);
    expect(MARGINAL.maxMs).toBeGreaterThan(FRAME_BUDGET_MS * CLEARS_BUDGET);
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
    for (const host of [MARGINAL, STALLED, control({ maxMs: 40, overBudget: 4 })]) {
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

  it('CONTROL: a control that measured nothing enforces the bound rather than lifting it', () => {
    // "Shown nothing about the host" must never read as "the host is the problem".
    // The gate additionally asserts the control's sample count against the phase's,
    // so a control that silently stopped fails loudly there instead of here.
    expect(environmentSustainsBudget(NO_CONTROL, FRAME_BUDGET_MS)).toBe(true);
    expect(environmentSustainsBudget(control({ count: 0, maxMs: 0 }), FRAME_BUDGET_MS)).toBe(true);
  });
});
