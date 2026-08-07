/**
 * Test runner.
 *
 * Node environment throughout: phase 0's tests are about the format, the store and
 * the boundaries, none of which need a DOM. A window-level test arrives with the
 * phase that has something to render into one.
 */

import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * The one file that is handed the machine before this suite has done anything to it.
 *
 * `fileParallelism: false` keeps two test *files* off each other; it does not keep a
 * file off what the file before it started. Those are different claims, and the gap
 * between them is a process — `/usr/bin/avconvert`, an Electron launch, a SIGKILL
 * round — plus the writeback of whatever that file put on disk, both of which outlive
 * the `it()` that began them and land on whoever runs next.
 *
 * Which matters to exactly one file. This gate judges its **single worst frame with
 * no allowance**, so one pre-empted 33 ms frame in 450 fails it while its p99 stays at
 * 4.20 ms, and its own host control — 154 spins against 450 frames — samples too
 * coarsely to have been holding the thread at that instant and withhold the verdict.
 * The rest of the suite compares against something measured in its own window
 * (`packages/sampler/test/rate-control.ts`) or has minutes of budget
 * (`apps/main/test/av-sync.test.ts`), and neither notices.
 *
 * Measured on CI run 31195372445: `apps/main/test/recorder-session.test.ts` — 5.4 s
 * of real fragment writing with two `/usr/bin/avconvert` playability transcodes in it
 * — finished **100 ms** before this gate launched its Electron, purely because vitest
 * sorts by file size and those two files land next to each other. The gate came back
 * with one 33.10 ms play frame against a 27.93 ms envelope, and with the host stalling
 * its own pure-arithmetic spin to 25.40 ms in the slow-compositor phase against 8.40 ms
 * on each of the four runs before it. `.github/workflows/ci.yml` already records the
 * same pairing across jobs — the phase-6 gate measured beside `mutation`'s `avconvert`
 * transcodes — and answered it there with `needs: verify`; this is that answer inside
 * the run, where the pairing was decided by a byte count.
 *
 * So the gate goes first, on a box that has started nothing. Only this one: hoisting
 * all three stopwatch gates would make them each other's noise, which is the thing
 * `fileParallelism: false` exists to prevent.
 */
const QUIETEST_BOX_FIRST = 'test/phase6-gate.test.ts';

class StopwatchGateFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Composed with the default order rather than replacing it: vitest sorts by
    // cached duration where it has one and by file size otherwise, and neither of
    // those is a judgement this override has any opinion about.
    const sorted = await super.sort(files);
    const at = sorted.findIndex((file) =>
      file.moduleId.replaceAll('\\', '/').endsWith(QUIETEST_BOX_FIRST),
    );
    const gate = at < 0 ? undefined : sorted[at];
    // Absent (a filtered run, `-t`) or already first: leave the order alone.
    if (at <= 0 || gate === undefined) return sorted;
    return [gate, ...sorted.slice(0, at), ...sorted.slice(at + 1)];
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    // `test/` at the root is for gates that span more than one package: phase 6's
    // needs `decode`, `compositor`, the renderer's preview loop and main's byte-range
    // server at once, in a real Electron renderer.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    // The kill test spawns and SIGKILLs child processes across many rounds; the
    // phase 6 gate encodes a 4K fixture and plays it, and sets its own longer limit.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // One file at a time. Isolation is not the reason — every file already gets its
    // own temp root — measurement is: three of these gates time the machine they are
    // running on. The phase-5 sampler asserts §6.1's 120 Hz, phase 6 judges a 16 ms
    // frame budget on the single worst frame — and measures the host beside it, so a
    // box busy enough to push that control past the whole budget withholds the verdict
    // instead of failing on it, while a control merely stretched inside the budget
    // leaves the frame judged exactly as §8 writes it — and phase 3's twenty-minute
    // A/V sync gate saturates the box for the better part of a minute
    // encoding AAC and H.264. Two of those on a 3-vCPU CI runner measure each other,
    // and neither can tell that apart from the thing it exists to catch: CI failed the
    // sampler at 53 samples in a window it needed 60 in, on a commit that changed
    // nothing in the sampler.
    //
    // `packages/sampler/test/rate-control.ts` holds the other half — a rate is only
    // ever compared against a no-op control measured across the *same* window — but
    // that keeps the comparison honest, not the machine free. A sampler doing two
    // window-server round trips per tick loses more to a saturated box than an empty
    // timer handler does, so a rate gate still cannot share one with a gate that
    // saturates it. About a minute of wall clock is what that costs; nothing here
    // depended on the parallelism.
    fileParallelism: false,
    // ...and the other half of that rule, which `fileParallelism` alone does not
    // reach: what the *previous* file left running. See {@link StopwatchGateFirst}.
    sequence: { sequencer: StopwatchGateFirst },
    reporters: process.env['CI'] === undefined ? ['default'] : ['default', 'junit'],
    outputFile: { junit: 'coverage/junit.xml' },
  },
});
