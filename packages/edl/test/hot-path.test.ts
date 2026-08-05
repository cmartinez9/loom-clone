/**
 * `resolve` is on the frame budget — §3.6's *"Hot path. No allocation, no locking,
 * no simulation. Called once per rendered frame."*
 *
 * Measured here at **0.08 µs for an identity timeline and ~0.3 µs for a
 * thirty-minute, 3000-key document**, against §8's 16.67 ms frame — with later
 * phases still to add passes. The phase-6 gate's CI readings are not the headroom
 * this fits inside: that gate certifies the budget on target hardware, where a
 * composite costs 0.20–0.30 ms, and its CI frame is a different workload no user
 * runs. The brief's instruction is unambiguous: if something pushes a frame over
 * budget, make the frame faster; do not move the line. So the two properties worth
 * pinning are the ones that would quietly cost a frame:
 *
 * 1. **Nothing allocates.** Not the state, not its nested objects, not the
 *    annotation array. Asserted by object identity across calls rather than by a
 *    heap measurement, because identity is exact and a heap measurement is weather.
 * 2. **Nothing scales with the length of the recording.** A thirty-minute channel
 *    with thousands of keys must cost what a thirty-second one with a handful does.
 *    That is what §3.6's `curveIndex` and the fixed-grid spring table are *for*, and
 *    it is the regression an innocent-looking `keys.find(...)` would introduce.
 *
 * The second is a timing comparison, so it follows `packages/sampler/test/rate-control.ts`'s
 * rule: the long document and the short one are measured **in the same window**,
 * interleaved, and compared against each other. An absolute millisecond figure from
 * one machine would say nothing about another; a ratio taken across one window says
 * the same thing on every machine, which is the only kind of timing claim worth
 * asserting here.
 */

import { describe, expect, it } from 'vitest';
import type { EditDocument, Keyframe, Track } from '@loom/format';
import {
  compile,
  DEFAULT_SPRING,
  identityTimeline,
  manualZoomTrack,
  resolve,
} from '../src/index.ts';

/** A zoom track with `keyCount` keys spread over `spanSec`, half curve, half spring. */
function zoomTrack(id: string, keyCount: number, spanSec: number, spring: boolean): Track {
  const amount: Keyframe[] = Array.from({ length: keyCount }, (_, i) => ({
    t: (i * spanSec) / keyCount,
    v: 1 + (i % 7) / 4,
    ease: spring ? { kind: 'spring' } : i % 3 === 0 ? { kind: 'hold' } : { kind: 'linear' },
  }));
  const center: Keyframe[] = Array.from({ length: keyCount }, (_, i) => ({
    t: (i * spanSec) / keyCount,
    v: [0.5 + 0.4 * Math.sin(i), 0.5 + 0.4 * Math.cos(i)],
    ease: spring ? { kind: 'spring' } : { kind: 'cubic', p1: [0.32, 0], p2: [0, 1] },
  }));
  return manualZoomTrack({
    id,
    activeRanges: [[0, spanSec]],
    amount,
    center,
    ...(spring ? { spring: DEFAULT_SPRING } : {}),
  });
}

function document(spanSec: number, keyCount: number): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 1,
    output: { size: [1920, 1240], fps: 30, background: { kind: 'none' } },
    clips: [{ id: 'c1', sourceStart: 0, sourceEnd: spanSec, speed: 1 }],
    tracks: [
      zoomTrack('t-generated', keyCount, spanSec, true),
      zoomTrack('t-manual', keyCount, spanSec, false),
    ],
  };
}

describe('resolve allocates nothing', () => {
  it('hands back the same objects every call', () => {
    const ct = compile(document(60, 40));
    const first = resolve(ct, 1);
    const zoom = first.zoom;
    const center = first.zoom.center;
    const bubbleCenter = first.bubble.center;
    const annotations = first.annotations;
    const audio = first.audio;

    for (let i = 0; i < 500; i++) {
      const state = resolve(ct, (i * 60) / 500);
      expect(state).toBe(first);
      expect(state.zoom).toBe(zoom);
      expect(state.zoom.center).toBe(center);
      expect(state.bubble.center).toBe(bubbleCenter);
      expect(state.annotations).toBe(annotations);
      expect(state.audio).toBe(audio);
    }
  });

  it('reuses the cursor object across calls rather than making one per frame', () => {
    // A `cursor` that is sometimes `null` is the one field with a shape change in
    // it, and the obvious implementation allocates a fresh object each time it is
    // not null.
    const ct = compile(
      {
        ...document(60, 8),
        tracks: [
          {
            id: 't-cursor',
            kind: 'transform',
            target: 'cursor',
            domain: 'source',
            origin: 'manual',
            blend: 'replace',
            blendMs: 0,
            activeRanges: [[0, 60]],
            enabled: true,
            channels: { scale: { keys: [{ t: 0, v: 1, ease: { kind: 'hold' } }] } },
          },
        ],
      },
      {
        cursor: {
          count: 2,
          indexAt: (t) => (t < 0 ? -1 : t < 30 ? 0 : 1),
          tAt: (i) => i * 30,
          xAt: (i) => i / 2,
          yAt: (i) => i / 4,
          imageIdAt: () => 'arrow',
        },
        clicks: null,
        recording: null,
      },
    );
    const first = resolve(ct, 1).cursor;
    expect(first).not.toBeNull();
    for (let i = 0; i < 100; i++) expect(resolve(ct, i / 2).cursor).toBe(first);
  });
});

describe('resolve does not scale with the length of the recording', () => {
  it('costs the same on a thirty-minute channel as on a thirty-second one', () => {
    // 1800 s with a key every 0.6 s — a generated cursor-follow track's density —
    // against 30 s with the same shape and a hundredth of the keys.
    const long = compile(document(1800, 3000));
    const short = compile(document(30, 50));

    const ROUNDS = 6;
    const CALLS = 20_000;
    let longMs = 0;
    let shortMs = 0;

    // Interleaved, so both figures come from the same window of the same machine.
    // Measured separately — before, or after — the same code has reported
    // wildly different rates on this project's CI (see `rate-control.ts`).
    for (let round = 0; round < ROUNDS; round++) {
      const longStart = performance.now();
      for (let i = 0; i < CALLS; i++) resolve(long, (i * 1800) / CALLS);
      longMs += performance.now() - longStart;

      const shortStart = performance.now();
      for (let i = 0; i < CALLS; i++) resolve(short, (i * 30) / CALLS);
      shortMs += performance.now() - shortStart;
    }

    const longUs = (longMs * 1000) / (ROUNDS * CALLS);
    const shortUs = (shortMs * 1000) / (ROUNDS * CALLS);
    console.log(
      `resolve: 1800 s / 3000 keys = ${longUs.toFixed(3)} µs, ` +
        `30 s / 50 keys = ${shortUs.toFixed(3)} µs, ratio ${(longUs / shortUs).toFixed(2)}`,
    );

    // A `keys.find(...)` on the hot path would make this ratio 60×. The bound is
    // deliberately loose about *constants* — a longer table has worse cache
    // behaviour and that is fine — and tight about *growth*.
    expect(longUs / shortUs).toBeLessThan(4);
  });

  it('an identity timeline resolves to essentially nothing', () => {
    // What the phase-6 gate's fixture actually costs: the preview loop calls this
    // every frame whether the project has edits or not, so the no-edit case has to
    // be free.
    const ct = identityTimeline(1800);
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) resolve(ct, (i * 1800) / 200_000);
    const perCallUs = ((performance.now() - started) * 1000) / 200_000;
    console.log(`resolve: identity timeline = ${perCallUs.toFixed(3)} µs`);
    // 16.67 ms is the whole frame. A hundredth of a millisecond is 0.06% of it, and
    // this rules out a regression in kind rather than measuring the machine.
    expect(perCallUs).toBeLessThan(10);
  });
});
