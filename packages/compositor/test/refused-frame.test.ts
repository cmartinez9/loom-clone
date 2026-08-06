/**
 * A refused frame, from the compositor's side.
 *
 * `blur` and `mask` fail closed: a redaction whose region cannot be read throws out
 * of `Compositor.render` rather than being composited without it, and the throw keeps
 * going so that phase 8's exporter fails the export instead of encoding an unredacted
 * frame. That much the phase-11 gate's `a-blur-with-no-region-refuses-the-frame`
 * control already watches.
 *
 * What it does not watch, and what this file exists for, is the *state the refusal
 * leaves behind* — the two invariants that decide whether failing closed actually
 * closed anything:
 *
 *  - **The render target must not still hold the screen picture with the redaction
 *    missing.** The screen pass has already drawn by the time the annotation pass
 *    refuses, so a caller that catches the throw and still calls `present()` — or
 *    reads the framebuffer — would publish exactly the pixels the user hid. This is
 *    not §4.3's "hold the previous frame": holding is for a *`null`* frame, and a
 *    refusal is not a miss.
 *  - **The GPU timer query must stay balanced.** An unended query leaves `GpuTimer`
 *    open and in flight for good, so `lastMs` freezes at its last reading and reports
 *    it forever — a measurement that is silently a lie, on the one instrument a
 *    future effect's cost would be judged by.
 *
 * Both are headless properties of one `render` call, and the real gate cannot see
 * either: it asserts that the call threw and then throws the frame away. The fake
 * context here is not a renderer — it models the framebuffer just far enough to ask
 * *"what would a `present()` publish right now"*.
 */

import { describe, expect, it } from 'vitest';
import { AnnotationError, identityState, type ResolvedAnnotation } from '@loom/edl';
import { Compositor } from '../src/compositor.ts';
import { DRAWN, fakeGl } from './helpers/fake-gl.ts';

const SIZE: [number, number] = [8, 4];

/** A frame, as far as `render` is concerned: two numbers and an upload it ignores. */
function fakeScreen(): VideoFrame {
  return { displayWidth: SIZE[0], displayHeight: SIZE[1] } as unknown as VideoFrame;
}

/**
 * A `blur` whose region the document does not carry.
 *
 * `values` has no `center`, which is what `readAnnotationGeometry` refuses: the
 * region is unknown, the compositor has nowhere defensible to put the redaction, and
 * there is nothing safe to draw.
 */
function unplaceableBlur(): ResolvedAnnotation {
  return {
    id: 'a-blur',
    type: 'blur',
    style: { blurPx: 18 },
    values: new Map([['opacity', Float64Array.of(1)]]),
    weight: 1,
  };
}

/** The same span with a region, so the control below composites normally. */
function placeableBlur(): ResolvedAnnotation {
  return {
    id: 'a-blur',
    type: 'blur',
    style: { blurPx: 18 },
    values: new Map([
      ['opacity', Float64Array.of(1)],
      ['center', Float64Array.of(0.5, 0.5)],
      ['size', Float64Array.of(0.2, 0.2)],
    ]),
    weight: 1,
  };
}

function stateWith(annotation: ResolvedAnnotation) {
  const state = identityState(0);
  state.annotations = [annotation];
  return state;
}

describe('Compositor.render refuses an unplaceable redaction', () => {
  it('lets the throw out, so an export fails rather than encoding an unredacted frame', () => {
    const fake = fakeGl();
    const compositor = new Compositor(fake.gl, SIZE);
    expect(() => {
      compositor.render({ screen: fakeScreen() }, stateWith(unplaceableBlur()));
    }).toThrow(AnnotationError);
  });

  it('leaves nothing unredacted in the render target for a caller to publish', () => {
    const fake = fakeGl({ trackPixels: true });
    const compositor = new Compositor(fake.gl, SIZE, { background: [0, 0, 0] });

    // The control first: a placeable redaction composites, and what the target then
    // holds is the drawn picture. Without this the assertion below would pass just as
    // well against a compositor that never draws anything at all.
    compositor.render({ screen: fakeScreen() }, stateWith(placeableBlur()));
    expect([...new Set(compositor.readPixels())]).toEqual([DRAWN]);

    expect(() => {
      compositor.render({ screen: fakeScreen() }, stateWith(unplaceableBlur()));
    }).toThrow(AnnotationError);

    // The screen pass drew before the annotation pass refused, so this is the whole
    // question: the target holds the letterbox background and not those pixels.
    const published = compositor.readPixels();
    expect([...new Set(published)]).not.toContain(DRAWN);
    expect([...published.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it('does not count a refused frame as a composited one', () => {
    const fake = fakeGl({ trackPixels: true });
    const compositor = new Compositor(fake.gl, SIZE);
    compositor.render({ screen: fakeScreen() }, stateWith(placeableBlur()));
    expect(compositor.frameCount).toBe(1);
    expect(() => {
      compositor.render({ screen: fakeScreen() }, stateWith(unplaceableBlur()));
    }).toThrow(AnnotationError);
    expect(compositor.frameCount).toBe(1);
  });

  it('keeps the GPU timer query balanced across the throw', () => {
    const fake = fakeGl({ timerQuery: true });
    const compositor = new Compositor(fake.gl, SIZE);

    expect(() => {
      compositor.render({ screen: fakeScreen() }, stateWith(unplaceableBlur()));
    }).toThrow(AnnotationError);

    // One `beginQuery` and one `endQuery`. An unbalanced pair leaves `GpuTimer` open
    // and in flight forever: every later `begin()` returns early, `poll()` never sees
    // a result for a query that was never ended, and `lastMs` reports its last
    // reading for the life of the compositor.
    expect(fake.queryBegins).toBeGreaterThan(0);
    expect(fake.queryEnds).toBe(fake.queryBegins);
  });
});
