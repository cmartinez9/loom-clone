/**
 * A lost WebGL context must never be laundered into plausible-looking pixels.
 *
 * This is the durable form of a defect the phase 6 gate found the hard way. On a
 * GitHub macOS runner the renderer's context was lost mid-run; `gl.readPixels`
 * became a silent no-op, so `Compositor.readPixels` returned the caller's scratch
 * buffer still holding the *previous* frame's pixels, and then ran its in-place
 * vertical flip over them. The gate read those bytes back as frame numbers and
 * reported a compositor defect. A hardware event had been turned into data.
 *
 * It matters well beyond that gate, which is why the test lives here and not in
 * `test/gate/`. Phase 8's exporter reads every frame back through **one** scratch
 * buffer (§5.3), so a silent stale return would encode fabricated output that looks
 * exactly like real output — and §4.5's golden-frame test, which compares the
 * preview path against the export path, could end up comparing two copies of the
 * same stale buffer and passing.
 *
 * The rule: **fail loudly, never return bytes you did not read.**
 */

import { describe, expect, it } from 'vitest';
import { Compositor } from '../src/compositor.ts';
import { GlError } from '../src/gl-util.ts';
import { fakeGl } from './helpers/fake-gl.ts';

const SIZE: [number, number] = [8, 4];

describe('Compositor.readPixels and a lost context', () => {
  it('reads real pixels while the context is live', () => {
    const fake = fakeGl();
    const compositor = new Compositor(fake.gl, SIZE);
    const pixels = compositor.readPixels();
    expect(pixels.byteLength).toBe(SIZE[0] * SIZE[1] * 4);
    expect([...new Set(pixels)]).toEqual([0x40]);
  });

  it('throws instead of returning the previous frame’s pixels once the context is lost', () => {
    const fake = fakeGl();
    const compositor = new Compositor(fake.gl, SIZE);

    // One real readback into a reused scratch buffer — the exporter's pattern.
    const scratch = new Uint8Array(SIZE[0] * SIZE[1] * 4);
    compositor.readPixels(scratch);
    expect([...new Set(scratch)]).toEqual([0x40]);

    fake.loseContext();
    const callsBefore = fake.readPixelCalls;

    expect(() => compositor.readPixels(scratch)).toThrow(GlError);
    // It did not even reach `gl.readPixels`, so nothing could have been laundered.
    expect(fake.readPixelCalls).toBe(callsBefore);
    // And the stale bytes are still stale rather than being handed back as a result.
    expect([...new Set(scratch)]).toEqual([0x40]);
  });

  it('CONTROL: without the guard, a lost context returns stale bytes silently', () => {
    // The bug this test exists to prevent, reproduced against the same fake: a
    // caller that reads the framebuffer itself, the way `readPixels` did before the
    // guard, gets its own previous contents back and no error at all. If this ever
    // stops holding, the fake has stopped modelling a lost context and the
    // assertions above prove nothing.
    const fake = fakeGl();
    const scratch = new Uint8Array(SIZE[0] * SIZE[1] * 4);
    const gl = fake.gl;

    gl.readPixels(0, 0, SIZE[0], SIZE[1], gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    expect([...new Set(scratch)]).toEqual([0x40]);

    fake.loseContext();
    gl.readPixels(0, 0, SIZE[0], SIZE[1], gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    // No throw, no signal, and the caller cannot tell this from a real reading.
    expect([...new Set(scratch)]).toEqual([0x40]);
  });

  it('reports the loss through `contextLost`, so callers can stop before measuring', () => {
    const fake = fakeGl();
    const compositor = new Compositor(fake.gl, SIZE);
    expect(compositor.contextLost).toBe(false);
    fake.loseContext();
    expect(compositor.contextLost).toBe(true);
  });
});
