/**
 * §6.1 input conditioning, one property per stage.
 *
 * The constants are §6.1's and the ports are Cap's, so these tests are about the
 * *behaviour* each one buys: shake that reverses inside 100 ms disappears, motion that
 * does not is untouched, decimation halves the work without moving anything, and a
 * cursor that flickers to I-beam for 200 ms does not change the rendered cursor.
 */

import { describe, expect, it } from 'vitest';
import { arrayCursorStream, type CursorSampleInput } from '../src/streams.ts';
import {
  conditionCursor,
  stabilizeCursorShapes,
  DEFAULT_MIN_DISTANCE_UV,
  MAX_SOURCE_TIME_SEC,
  SHAKE_THRESHOLD_UV,
  type CursorSample,
} from '../src/generators/conditioning.ts';

function stream(samples: CursorSampleInput[]): ReturnType<typeof arrayCursorStream> {
  return arrayCursorStream(samples);
}

describe('§6.1 the sanity pass', () => {
  it('drops non-finite samples and counts them', () => {
    const result = conditionCursor(
      stream([
        { t: 0, x: 0.5, y: 0.5, c: 'arrow' },
        { t: 0.01, x: Number.NaN, y: 0.5, c: 'arrow' },
        { t: 0.02, x: 0.5, y: Number.POSITIVE_INFINITY, c: 'arrow' },
        { t: Number.NaN, x: 0.5, y: 0.5, c: 'arrow' },
        { t: 1, x: 0.6, y: 0.5, c: 'arrow' },
      ]),
    );
    expect(result.rejected).toBe(3);
    expect(result.count).toBe(2);
  });

  it('drops a repeated timestamp rather than dividing by a zero interval', () => {
    const result = conditionCursor(
      stream([
        { t: 0, x: 0.2, y: 0.2, c: 'arrow' },
        { t: 0, x: 0.9, y: 0.9, c: 'arrow' },
        { t: 0.5, x: 0.3, y: 0.3, c: 'arrow' },
      ]),
    );
    expect(result.rejected).toBe(1);
    for (let i = 1; i < result.count; i++) {
      expect(result.t[i]).toBeGreaterThan(result.t[i - 1] ?? 0);
    }
  });

  it('clamps positions from another display onto this one, and counts that', () => {
    const result = conditionCursor(
      stream([
        { t: 0, x: -2.5, y: 0.5, c: 'arrow' },
        { t: 1, x: 0.5, y: 4, c: 'arrow' },
      ]),
    );
    expect(result.clamped).toBe(2);
    expect(result.x[0]).toBe(0);
    expect(result.y[1]).toBe(1);
  });

  it('refuses a log whose origin was never subtracted', () => {
    // The smoke script measured audio timestamped from 2,678,930 s — machine uptime.
    // A cursor log with that origin is not a thirty-one-day recording.
    const result = conditionCursor(
      stream([
        { t: MAX_SOURCE_TIME_SEC + 1, x: 0.5, y: 0.5, c: 'arrow' },
        { t: MAX_SOURCE_TIME_SEC + 2, x: 0.6, y: 0.5, c: 'arrow' },
      ]),
    );
    expect(result.count).toBe(0);
    expect(result.rejected).toBe(2);
  });

  it('an absent stream and an empty one are both a zero-length result', () => {
    expect(conditionCursor(null).count).toBe(0);
    expect(conditionCursor(stream([])).count).toBe(0);
  });
});

describe('§6.1 the shake filter', () => {
  it('drops a small fast reversal', () => {
    const samples: CursorSampleInput[] = [
      { t: 0, x: 0.5, y: 0.5, c: 'arrow' },
      { t: 0.02, x: 0.505, y: 0.5, c: 'arrow' },
      { t: 0.04, x: 0.5, y: 0.5, c: 'arrow' },
      { t: 0.06, x: 0.505, y: 0.5, c: 'arrow' },
      { t: 1, x: 0.9, y: 0.5, c: 'arrow' },
    ];
    const result = conditionCursor(stream(samples), { minDistanceUv: 0, decimateHz: 0 });
    expect(result.shaken).toBeGreaterThan(0);
  });

  it('keeps a reversal whose legs are larger than the threshold', () => {
    const leg = SHAKE_THRESHOLD_UV * 2;
    const result = conditionCursor(
      stream([
        { t: 0, x: 0.5, y: 0.5, c: 'arrow' },
        { t: 0.02, x: 0.5 + leg, y: 0.5, c: 'arrow' },
        { t: 0.04, x: 0.5, y: 0.5, c: 'arrow' },
      ]),
      { minDistanceUv: 0, decimateHz: 0 },
    );
    expect(result.shaken).toBe(0);
  });

  it('keeps a reversal that took longer than the window', () => {
    const result = conditionCursor(
      stream([
        { t: 0, x: 0.5, y: 0.5, c: 'arrow' },
        { t: 0.4, x: 0.505, y: 0.5, c: 'arrow' },
        { t: 0.8, x: 0.5, y: 0.5, c: 'arrow' },
      ]),
      { minDistanceUv: 0, decimateHz: 0 },
    );
    expect(result.shaken).toBe(0);
  });

  it('keeps motion that does not reverse, however small and fast', () => {
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 50; i++) samples.push({ t: i / 120, x: 0.3 + i * 0.002, y: 0.5, c: 'a' });
    const result = conditionCursor(stream(samples), { minDistanceUv: 0, decimateHz: 0 });
    expect(result.shaken).toBe(0);
  });
});

describe('§6.1 decimation', () => {
  it('halves a 120 Hz log to 60 Hz without moving the ends', () => {
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 240; i++) samples.push({ t: i / 120, x: 0.1 + i * 0.003, y: 0.5, c: 'a' });
    const result = conditionCursor(stream(samples));
    expect(result.count).toBeLessThanOrEqual(samples.length / 2 + 2);
    expect(result.count).toBeGreaterThan(samples.length / 2 - 3);
    expect(result.t[0]).toBeCloseTo(0, 6);
    expect(result.t[result.count - 1]).toBeCloseTo(239 / 120, 6);
  });

  it('collapses a stationary cursor to its ends', () => {
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 600; i++) samples.push({ t: i / 120, x: 0.4, y: 0.6, c: 'a' });
    const result = conditionCursor(stream(samples));
    expect(result.count).toBe(2);
    expect(result.travelUv).toBe(0);
  });

  it('keeps one sample per pixel of travel, not one per 60 Hz tick', () => {
    // A tenth of a pixel per sample: 600 samples is 60 px of travel. The minimum
    // distance is measured from the last *kept* sample, so what survives is the
    // travel, not the clock — 60-ish samples rather than the 300 a 60 Hz decimation
    // alone would leave.
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 600; i++) {
      samples.push({ t: i / 120, x: 0.4 + i * DEFAULT_MIN_DISTANCE_UV * 0.1, y: 0.6, c: 'a' });
    }
    const result = conditionCursor(stream(samples));
    expect(result.count).toBeGreaterThan(50);
    expect(result.count).toBeLessThan(70);
  });
});

describe('§6.1 the cursor-shape debounce', () => {
  it('replaces a 200 ms I-beam flicker with the dominant shape', () => {
    const samples: CursorSample[] = [];
    for (let i = 0; i < 500; i++) {
      const t = i / 100;
      samples.push({ t, x: 0.5, y: 0.5, c: t >= 2 && t < 2.2 ? 'ibeam' : 'arrow' });
    }
    const replaced = stabilizeCursorShapes(samples, 1);
    expect(replaced).toBe(1);
    expect(samples.every((s) => s.c === 'arrow')).toBe(true);
  });

  it('keeps a shape that is held for longer than the window', () => {
    const samples: CursorSample[] = [];
    for (let i = 0; i < 500; i++) {
      const t = i / 100;
      samples.push({ t, x: 0.5, y: 0.5, c: t >= 2 && t < 3.5 ? 'ibeam' : 'arrow' });
    }
    const replaced = stabilizeCursorShapes(samples, 1);
    expect(replaced).toBe(0);
    expect(samples.some((s) => s.c === 'ibeam')).toBe(true);
  });

  it('does nothing to a log with one shape in it', () => {
    const samples: CursorSample[] = [{ t: 0, x: 0, y: 0, c: 'arrow' }];
    expect(stabilizeCursorShapes(samples, 1)).toBe(0);
  });
});

describe('§6.6 travel totals', () => {
  it('rawTravelUv measures the log, travelUv what came out of §6.1', () => {
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 400; i++) {
      // A steady drift with a one-pixel tremor on top: §6.1 should keep the drift and
      // drop the tremor, so the conditioned travel is the smaller of the two.
      samples.push({
        t: i / 120,
        x: 0.2 + i * 0.001 + (i % 2 === 0 ? 1 : -1) / 1728,
        y: 0.5,
        c: 'a',
      });
    }
    const result = conditionCursor(stream(samples));
    expect(result.rawTravelUv).toBeGreaterThan(result.travelUv);
    expect(result.travelUv).toBeGreaterThan(0.3);
  });
});
