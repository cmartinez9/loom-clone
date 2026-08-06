/**
 * The stroke pass's shape, which the golden gate cannot see.
 *
 * Phase 12 draws a hand-drawn polyline as a chain of round-capped capsules. They
 * **must** overlap — that is what makes a joint round rather than notched — so
 * compositing them one after another into the frame draws the ink over itself at
 * every joint. At `alpha = 1` that is invisible; at the 0.35 a highlighter draws
 * with, or anywhere inside a `blendMs` crossfade, the line grows a string of dark
 * beads along it.
 *
 * The fix is that coverage is accumulated into a scratch target where overlap is
 * **idempotent** — `blendEquation(MAX)` — and the stroke is composited exactly once
 * from it, at exactly its own alpha.
 *
 * `test/phase11-golden.test.ts` renders the real thing on a real ANGLE context and
 * proves the ink lands in the right box, reveals by arc length, and is identical in
 * preview and export. What it cannot show is *this*: a single opaque stroke looks
 * the same whether or not the scratch exists, and the fixture's strokes have to be
 * opaque because the per-kind probe needs them to draw at every timestamp. So the
 * property is asserted here, as an ordering, on the stub — with a control that fails
 * when the ordering is broken, in the shape `packages/format/test/kill-mid-write.ts`
 * uses for the crash gate.
 */

import { describe, expect, it } from 'vitest';
import { identityState, type ResolvedAnnotation } from '@loom/edl';
import { Compositor } from '../src/compositor.ts';
import { fakeGl } from './helpers/fake-gl.ts';

const SIZE: [number, number] = [64, 32];

function fakeScreen(): VideoFrame {
  return { displayWidth: SIZE[0], displayHeight: SIZE[1] } as unknown as VideoFrame;
}

/** A four-segment zig-zag: real joints, so the overlap this file is about exists. */
function stroke(alpha = 1): ResolvedAnnotation {
  return {
    id: 'a-stroke',
    type: 'stroke',
    style: {
      stroke: [1, 0, 0, alpha],
      strokeWidth: 0.02,
      points: [-0.9, 0.6, -0.45, -0.6, 0, 0.6, 0.45, -0.6, 0.9, 0.6],
    },
    values: new Map([
      ['opacity', Float64Array.of(1)],
      ['center', Float64Array.of(0.5, 0.5)],
      ['size', Float64Array.of(0.6, 0.3)],
    ]),
    weight: 1,
  };
}

function render(annotation: ResolvedAnnotation | null): readonly string[] {
  const fake = fakeGl({ width: SIZE[0], height: SIZE[1], traceCalls: true });
  const compositor = new Compositor(fake.gl, SIZE);
  const state = identityState(0);
  if (annotation !== null) state.annotations = [annotation];
  // Only the annotation pass's calls matter, so the trace is taken from the point
  // the screen pass has finished.
  const before = fake.calls.length;
  compositor.render({ screen: fakeScreen() }, state);
  return fake.calls.slice(before);
}

/** The index of the first call matching `pattern`, or `-1`. */
function firstAt(calls: readonly string[], pattern: RegExp): number {
  return calls.findIndex((call) => pattern.test(call));
}

describe('one stroke is composited once, from a scratch', () => {
  it('accumulates coverage with MAX, so overlapping capsules do not double-blend', () => {
    const calls = render(stroke());
    const max = firstAt(calls, /^blendEquation\(32776\)$/); // GL_MAX
    expect(max, `no blendEquation(MAX):\n${calls.join('\n')}`).toBeGreaterThanOrEqual(0);

    // And the ordinary equation is put back before anything else draws — the pass
    // runs inside `render`'s blend setup and every other annotation kind depends on
    // it.
    const restored = calls.findIndex(
      (call, at) => at > max && /^blendEquation\(32774\)$/.test(call),
    ); // GL_FUNC_ADD
    expect(restored, `MAX was never undone:\n${calls.join('\n')}`).toBeGreaterThan(max);
    expect(
      calls.findIndex((call, at) => at > max && call.startsWith('blendFuncSeparate(')),
      'the separate-alpha blend the annotation pass runs under was not restored',
    ).toBeGreaterThan(max);
  });

  it('clears only the stroke’s own rectangle, rather than the whole scratch', () => {
    // A page of annotations would otherwise cost a full-target clear per span. The
    // scissor is also what keeps one stroke's coverage out of the next one's.
    const calls = render(stroke());
    const enabled = firstAt(calls, /^enable\(3089\)$/); // GL_SCISSOR_TEST
    const scissor = firstAt(calls, /^scissor\(/);
    const cleared = calls.findIndex((call, at) => at > enabled && call.startsWith('clear('));
    const disabled = firstAt(calls, /^disable\(3089\)$/);
    expect(enabled, `the scratch clear was not scissored:\n${calls.join('\n')}`).toBeGreaterThan(
      -1,
    );
    expect(scissor).toBeGreaterThan(enabled);
    expect(cleared).toBeGreaterThan(scissor);
    expect(disabled, 'the scissor test was left on for whatever draws next').toBeGreaterThan(
      cleared,
    );
  });

  it('draws the capsules before the one composite, and composites once', () => {
    const calls = render(stroke());
    // Counted from the scissor, not from the first `clear`: `render` clears the
    // frame before the screen pass, so a count from there would include the screen's
    // own draw.
    const scissored = firstAt(calls, /^enable\(3089\)$/);
    const draws = calls
      .map((call, at) => (call.startsWith('drawArrays(') ? at : -1))
      .filter((at) => at > scissored);
    // The capsule batch, then the composite. Two draws for a stroke whose segments
    // fit one batch: any more composites would be the double-blend this pass exists
    // to avoid.
    expect(draws.length, `expected coverage + composite:\n${calls.join('\n')}`).toBe(2);
    const restored = firstAt(calls, /^blendEquation\(32774\)$/);
    expect(draws[0], 'the coverage draw ran outside the MAX window').toBeLessThan(restored);
    expect(draws[1], 'the composite ran inside the MAX window').toBeGreaterThan(restored);
  });

  it('is the same shape for a translucent stroke, which is the case that needs it', () => {
    // The reason the scratch exists at all. A highlighter is 0.35, and 0.35 over
    // 0.35 is 0.58 — visibly darker, at every joint of every stroke.
    const calls = render(stroke(0.35));
    const scissored = firstAt(calls, /^enable\(3089\)$/);
    expect(
      calls.filter((call, at) => at > scissored && call.startsWith('drawArrays(')),
    ).toHaveLength(2);
  });

  it('CONTROL: a frame with no stroke runs no scratch clear and no MAX', () => {
    // Without this, every assertion above would pass against a trace that happened
    // to contain those calls for some other reason.
    const calls = render(null);
    expect(firstAt(calls, /^blendEquation\(32776\)$/)).toBe(-1);
    expect(firstAt(calls, /^enable\(3089\)$/)).toBe(-1);
  });

  it('CONTROL: a stroke with no points draws nothing rather than throwing', () => {
    // Ink is a decoration: the lenient half of `annotations.ts`'s rule. A stroke is
    // not `blur` and must never refuse a frame.
    const empty: ResolvedAnnotation = { ...stroke(), style: { stroke: [1, 0, 0, 1] } };
    const calls = render(empty);
    expect(firstAt(calls, /^blendEquation\(32776\)$/)).toBe(-1);
  });
});
