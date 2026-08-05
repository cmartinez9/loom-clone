/**
 * Finding the helper.
 *
 * The asar case is the one that cannot be caught anywhere else: it is correct in
 * development, correct in every test, and wrong only in a packaged build — where the
 * symptom is "The input sampler is missing from this build" about a binary that
 * shipped, and the fix is a release away.
 */

import { sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HELPER_PATH_ENV, defaultHelperPath, unpackedHelperPath } from '../src/native.ts';

describe('helper path', () => {
  it('names the unpacked helper, because spawn is not asar-aware', () => {
    const packaged = ['', 'Applications', 'Loom Clone.app', 'Contents', 'Resources'].join(sep);
    const inside = [packaged, 'app.asar', 'dist', 'native', 'loom-input-sampler'].join(sep);

    // Electron's `fs` shim would read straight through `app.asar`; `child_process`
    // hands the literal string to `uv_spawn`, which has never heard of it.
    expect(unpackedHelperPath(inside)).toBe(
      [packaged, 'app.asar.unpacked', 'dist', 'native', 'loom-input-sampler'].join(sep),
    );
  });

  it('leaves an unpackaged path alone', () => {
    const dev = ['', 'src', 'loom-clone', 'dist', 'native', 'loom-input-sampler'].join(sep);
    expect(unpackedHelperPath(dev)).toBe(dev);
  });

  it('honours the override verbatim', () => {
    vi.stubEnv(HELPER_PATH_ENV, '/tmp/loom-input-sampler');
    try {
      expect(defaultHelperPath()).toBe('/tmp/loom-input-sampler');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
