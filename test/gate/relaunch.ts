/**
 * The one condition under which the phase 6 gate is allowed to launch again.
 *
 * A retry around an acceptance gate is how a real defect gets to look like weather,
 * so this is a named predicate with a test rather than a condition inside a loop
 * that a later edit could widen to `|| !report.ok` without anyone noticing.
 *
 * **A lost WebGL context is not a measurement.** The driver takes the program, the
 * textures and the render target away mid-run; every GL call after it is a no-op and
 * every query answers `null`, so what the harness would report is whatever it was
 * holding when the lights went out — which is why `Compositor.readPixels` now throws
 * rather than handing those bytes back (`packages/compositor/test/context-loss.test.ts`).
 * Relaunching after that is not retrying a failure; it is retrying a run that never
 * produced a reading.
 *
 * Everything else is a reading and is reported exactly once: over budget, short of
 * frames, holding a leaked frame, showing the wrong frame, or failing outright.
 */

import type { GateReport } from './report.ts';

export function shouldRelaunch(report: GateReport): boolean {
  // Deliberately the whole condition. Adding a second clause here needs the same
  // scrutiny as changing the budget itself — see the test beside this file.
  return report.contextLost;
}

/**
 * Launches allowed before a lost context is called a failure. **Three, and three is
 * derived from a measurement rather than chosen.**
 *
 * It lives here, beside {@link shouldRelaunch}, because the predicate and the count are
 * one policy and only one of them is a dial. It used to sit in `phase6-gate.test.ts` as
 * a bare `const`, where raising it was a one-character edit in a file nobody reviews for
 * retry policy. `test/relaunch-policy.test.ts` now pins this value, so a nudge fails a
 * test and lands whoever made it in the fence file, next to the rule below.
 *
 * ## The rule, and it is the load-bearing half
 *
 * **What may trigger a relaunch is fixed; only the count answers to evidence.**
 * {@link shouldRelaunch} is `report.contextLost` and nothing else, and no reading ever
 * earns a second launch — over budget, short of frames, holding a leaked frame, showing
 * the wrong frame or failing outright are all reported exactly once, on the first
 * launch. That is what makes a count above one defensible at all, and it does not move.
 *
 * **This number may only be raised by producing the same kind of evidence that raised it
 * to three.** Not by a run that felt flaky, not to make a red branch green: a measured
 * demonstration that every launch the gate currently gets can fail to yield a reading
 * for one shared cause. Anything else is a dial being turned, and a dial that turns
 * without evidence is how a retry around an acceptance gate becomes a coin flipped until
 * it lands.
 *
 * ## Why three, measured
 *
 * Two was reasoned from *"a second loss in a row is no longer a shared host having a
 * moment"*, which assumes the second launch is an independent reading. On **CI run
 * 31084636446** it was not. Both launches lost the context at the same place — the first
 * scrub readback, 18 s and 16 s in — on one runner inside 35 s, and `child-process-gone`
 * named the mechanism the previous occurrence could only guess at: `GPU process gone:
 * abnormal-exit (exit 8704)`. Not the GPU watchdog, which `test/gate/main.ts` already
 * disables, but Chromium's GPU process *exiting* on a context loss and taking the
 * harness's one context with it — the same way it takes all four of phase 8's. A launch
 * starting seconds after that exit, on that runner, against the GPU process restarted in
 * its place, is a second reading of one host in one state. Three is the smallest number
 * that leaves the gate a launch which is not that.
 *
 * Three consecutive losses still fail the gate, on `phase6-gate.test.ts`'s
 * `report.contextLost` assertion.
 */
export const GATE_ATTEMPTS = 3;

/**
 * How long **one launch** may take, so a hung run leaves room for the attempts after it.
 *
 * Passed to the harness as `--timeout` and armed inside `app.whenReady()`, so it bounds
 * the page load, the 4K fixture encode and every phase — everything the harness's own
 * clock can see. What it does not bound is either end of a launch: {@link
 * LAUNCH_OVERHEAD_MS} is that, and {@link GATE_TIMEOUT_MS} is what makes this docblock's
 * first sentence true rather than merely intended.
 */
export const ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * What one launch costs **outside** {@link ATTEMPT_TIMEOUT_MS}: the `mkdtemp`, the three
 * esbuild bundles, the Electron spawn up to `app.whenReady()` — the harness's own timer
 * is armed inside that callback, so none of it is on its clock — and, after the child
 * exits, reading the report and removing the temp tree.
 *
 * **Sized above the observed figures rather than fitted to them.** Measured on this
 * machine: the three-bundle esbuild build is 261 ms cold and 10–14 ms warm, and a quiet
 * local run of the whole gate is about 14 s end to end, of which under 2 s is outside the
 * harness's clock. 30 s is therefore more than the entire quiet run, let alone the slice
 * this term covers. Deliberately: a 3-vCPU runner is slower at every one of those four,
 * and this gate is where the `verify` job first `exec`s a freshly written `Electron.app`,
 * which macOS signature-scans on that first launch — `.github/workflows/ci.yml` says why
 * the binary is fetched in a step of its own for the same reason. A term fitted to the
 * 2 s measured here would be a bound on CI rather than the slack it is meant to be.
 */
export const LAUNCH_OVERHEAD_MS = 30_000;

/**
 * Vitest's limit on the **whole** gate — every launch, not one — and therefore a
 * consequence of {@link GATE_ATTEMPTS} rather than a number of its own.
 *
 * It is derived because it was once written down, and then the count moved without it:
 * `GATE_ATTEMPTS` went from two to three and this stayed at the 300 s that fitted two,
 * against the 360 s three launches may legitimately take. `test/relaunch-policy.test.ts`
 * holds the rest of that story, the failure it produces, and the assertion that keeps
 * this number inside the bound which encloses it.
 */
export const GATE_TIMEOUT_MS = GATE_ATTEMPTS * (ATTEMPT_TIMEOUT_MS + LAUNCH_OVERHEAD_MS);
