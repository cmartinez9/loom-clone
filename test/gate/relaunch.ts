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
