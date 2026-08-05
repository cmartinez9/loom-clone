/**
 * Test runner.
 *
 * Node environment throughout: phase 0's tests are about the format, the store and
 * the boundaries, none of which need a DOM. A window-level test arrives with the
 * phase that has something to render into one.
 */

import { defineConfig } from 'vitest/config';

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
    // frame budget on the single worst frame with no allowance, and phase 3's
    // twenty-minute A/V sync gate saturates the box for the better part of a minute
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
    reporters: process.env['CI'] === undefined ? ['default'] : ['default', 'junit'],
    outputFile: { junit: 'coverage/junit.xml' },
  },
});
