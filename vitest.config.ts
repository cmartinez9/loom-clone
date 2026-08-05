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
    // Tests that spawn processes and write to temp directories must not race each
    // other for the same fixtures; each file gets its own temp root, so files may
    // still run in parallel.
    fileParallelism: true,
    reporters: process.env['CI'] === undefined ? ['default'] : ['default', 'junit'],
    outputFile: { junit: 'coverage/junit.xml' },
  },
});
