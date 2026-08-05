/**
 * `DemuxIndex` — frame selection, seek points and byte ranges.
 *
 * Frame selection is on §4.5's **"must be identical"** list (*"which source frame is
 * selected for a given time"*), so these are correctness tests for a contract
 * between phase 6 and phase 8, not unit tests for a search.
 */

import { describe, expect, it } from 'vitest';
import { currentSchemaId } from '@loom/format';
import { DemuxIndex, NO_FRAME } from '../src/frame-index.ts';
import { syntheticPart } from './helpers/synthetic.ts';

describe('DemuxIndex.frameAtTime', () => {
  it('holds the last frame — §4.2, because that is what the screen looked like', () => {
    const { index } = syntheticPart({ frameCount: 40, gopSize: 10 });

    for (let i = 0; i < 40; i++) {
      const t = index.ptsSec(i);
      // Exactly on the PTS picks that frame.
      expect(index.frameAtTime(t)).toBe(i);
      // A hair after it still picks it, all the way to the next frame.
      expect(index.frameAtTime(t + 1e-4)).toBe(i);
      if (i + 1 < 40) {
        const next = index.ptsSec(i + 1);
        expect(index.frameAtTime(next - 1e-6)).toBe(i);
      }
    }
  });

  it('holds across a long VFR gap rather than going blank', () => {
    // Frame 17 in the default pattern follows a half-second hold.
    const { index } = syntheticPart({ frameCount: 40 });
    const before = index.ptsSec(16);
    const after = index.ptsSec(17);
    expect(after - before).toBeGreaterThan(0.4);
    for (let step = 0; step < 10; step++) {
      const t = before + (after - before) * (step / 10);
      expect(index.frameAtTime(t)).toBe(16);
    }
  });

  it('reports no frame before the first PTS, and clamps past the last', () => {
    const { index } = syntheticPart({ frameCount: 10, gapBefore: (i) => (i === 0 ? 1.5 : 1 / 30) });
    expect(index.frameAtTime(0)).toBe(NO_FRAME);
    expect(index.frameAtTime(1.4999)).toBe(NO_FRAME);
    expect(index.frameAtTime(1.5)).toBe(0);
    expect(index.frameAtTime(9_999)).toBe(9);
  });

  it('is right when PTS is not in decode order', () => {
    // A legal index whose presentation order differs from decode order. A plain
    // binary search over `pts` returns the wrong frame here; the presentation
    // permutation is what makes it right.
    const index = new DemuxIndex({
      timescale: 1000,
      keyframes: [0],
      pts: [0, 300, 100, 200, 600, 400, 500],
      sizes: [10, 10, 10, 10, 10, 10, 10],
      offsets: [0, 10, 20, 30, 40, 50, 60],
    });
    expect(index.frameAtTime(0)).toBe(0);
    expect(index.frameAtTime(0.1)).toBe(2);
    expect(index.frameAtTime(0.2)).toBe(3);
    expect(index.frameAtTime(0.3)).toBe(1);
    expect(index.frameAtTime(0.45)).toBe(5);
    expect(index.frameAtTime(0.55)).toBe(6);
    expect(index.frameAtTime(9)).toBe(4);
  });

  it('answers on an empty index instead of throwing', () => {
    const index = new DemuxIndex({
      timescale: 1000,
      keyframes: [],
      pts: [],
      sizes: [],
      offsets: [],
    });
    expect(index.frameCount).toBe(0);
    expect(index.frameAtTime(0)).toBe(NO_FRAME);
    expect(index.keyframeAtOrBefore(0)).toBe(NO_FRAME);
  });
});

describe('DemuxIndex.keyframeAtOrBefore', () => {
  it('finds the keyframe a seek has to start from', () => {
    const { index } = syntheticPart({ frameCount: 100, gopSize: 30 });
    expect(index.keyframeAtOrBefore(0)).toBe(0);
    expect(index.keyframeAtOrBefore(29)).toBe(0);
    expect(index.keyframeAtOrBefore(30)).toBe(30);
    expect(index.keyframeAtOrBefore(59)).toBe(30);
    expect(index.keyframeAtOrBefore(99)).toBe(90);
  });

  it('says NO_FRAME when the index has no keyframe at or before a frame', () => {
    const index = new DemuxIndex({
      timescale: 1000,
      keyframes: [2],
      pts: [0, 100, 200, 300],
      sizes: [1, 1, 1, 1],
      offsets: [0, 1, 2, 3],
    });
    // Frames 0 and 1 are undecodable on their own; the reader must say so rather
    // than feed the decoder a delta chunk with no reference.
    expect(index.keyframeAtOrBefore(1)).toBe(NO_FRAME);
    expect(index.keyframeAtOrBefore(2)).toBe(2);
  });
});

describe('DemuxIndex byte ranges', () => {
  it('coalesces a keyframe run into one request — §2.4', () => {
    const { index, bytes } = syntheticPart({ frameCount: 60, gopSize: 30, frameBytes: 100 });
    const span = index.spanRange(30, 59);
    expect(span.start).toBe(index.byteRange(30).start);
    expect(span.end).toBe(index.byteRange(59).end);
    expect(index.isContiguous(30, 59)).toBe(true);
    expect(span.end).toBeLessThanOrEqual(bytes.byteLength);
  });

  it('takes the hull when frames are not stored in offset order', () => {
    const index = new DemuxIndex({
      timescale: 1000,
      keyframes: [0],
      pts: [0, 100, 200],
      sizes: [10, 10, 10],
      offsets: [200, 0, 100],
    });
    expect(index.spanRange(0, 2)).toEqual({ start: 0, end: 210 });
    expect(index.isContiguous(0, 2)).toBe(false);
  });

  it('runWithin never returns an empty run, even when one frame busts the budget', () => {
    const { index } = syntheticPart({ frameCount: 20, gopSize: 20, frameBytes: 1000 });
    expect(index.runWithin(0, 19, 1)).toBe(0);
    const to = index.runWithin(1, 19, 3500);
    expect(to).toBeGreaterThan(1);
    const span = index.spanRange(1, to);
    expect(span.end - span.start).toBeLessThanOrEqual(3500);
  });
});

describe('DemuxIndex construction', () => {
  it('validates through @loom/format, and names the file when it fails', () => {
    const bad = {
      schema: currentSchemaId('loom.index'),
      timescale: 0,
      keyframes: [],
      pts: [],
      sizes: [],
      offsets: [],
    };
    expect(() => DemuxIndex.fromDoc(bad, 'media/screen.000.index.json')).toThrow(
      /media\/screen\.000\.index\.json/,
    );
  });

  it('refuses parallel arrays of different lengths', () => {
    expect(
      () =>
        new DemuxIndex({ timescale: 1000, keyframes: [0], pts: [0, 1], sizes: [1], offsets: [0] }),
    ).toThrow(/parallel/);
  });

  it('refuses keyframes that are not strictly ascending or not frame numbers', () => {
    expect(
      () =>
        new DemuxIndex({
          timescale: 1000,
          keyframes: [1, 0],
          pts: [0, 1],
          sizes: [1, 1],
          offsets: [0, 1],
        }),
    ).toThrow(/ascending/);
    expect(
      () =>
        new DemuxIndex({
          timescale: 1000,
          keyframes: [5],
          pts: [0, 1],
          sizes: [1, 1],
          offsets: [0, 1],
        }),
    ).toThrow(/frame number/);
  });

  it('converts PTS to microseconds from any timescale', () => {
    const index = new DemuxIndex({
      timescale: 90_000,
      keyframes: [0],
      pts: [0, 3000, 6000],
      sizes: [1, 1, 1],
      offsets: [0, 1, 2],
    });
    expect(index.ptsMicros(0)).toBe(0);
    expect(index.ptsMicros(1)).toBeCloseTo(33_333, 0);
    expect(index.ptsSec(2)).toBeCloseTo(0.0667, 4);
  });
});
