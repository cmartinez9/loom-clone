/**
 * The one condition under which the phase 8 gate is allowed to launch again.
 *
 * This is `test/gate/relaunch.ts`'s predicate for the golden-frame gate, and it is a
 * separate file rather than a shared one on purpose: phase 6's is typed to phase 6's
 * report, and a predicate two gates share is a predicate a widening in one gate
 * silently applies to the other. The rule it states is the same, and so is the reason.
 *
 * **A lost WebGL context is not a comparison.** Chromium's GPU process exits when a
 * context is lost, and every context living in it goes too — on this harness, all
 * four at once. After that every GL call is a no-op, `readPixels` throws rather than
 * hand back whatever the scratch buffer last held, and `new VideoFrame(canvas)` would
 * encode a drawing buffer nobody drew. Relaunching there is not retrying a failure;
 * it is retrying a run that never produced a reading. Observed on a GitHub macOS
 * runner: `GPU process gone: abnormal-exit`, followed by four `CONTEXT_LOST_WEBGL`.
 *
 * Everything else is a reading and is reported exactly once: a non-zero delta, a
 * control that could not see a divergence, a leaked frame, a file that failed §7.5, a
 * cancelled export that left something behind, or a run that failed outright.
 * `test/relaunch-policy.test.ts` enumerates those and requires that none of them
 * earns a second launch.
 */

import type { GoldenReport } from './report.ts';

export function shouldRelaunchGolden(report: GoldenReport): boolean {
  // Deliberately the whole condition. A second clause here — `|| !report.ok` is the
  // tempting one — turns §4.5's per-pixel zero into a coin flipped twice.
  return report.contextLost;
}
