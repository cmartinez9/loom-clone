/**
 * §6.2 the dead zone, and §6.4's phase lead.
 *
 * §6.2 states three properties in three bullets and this file is one describe per
 * bullet, plus the two things the report does not spell out but the geometry forces:
 * the box is a fraction of the *visible zoomed viewport*, and the centre is clamped so
 * the viewport stays inside the frame.
 */

import { describe, expect, it } from 'vitest';
import {
  clampCentre,
  constantFollowGeometry,
  followTarget,
  halfViewport,
  DEFAULT_REST_BOX,
} from '../src/generators/dead-zone.ts';
import { conditionCursor } from '../src/generators/conditioning.ts';
import { leadSecondsFor, scaleSpring } from '../src/generators/cursor-follow.ts';
import { DEFAULT_SPRING } from '../src/tracks.ts';
import { arrayCursorStream, type CursorSampleInput } from '../src/streams.ts';

function conditioned(samples: CursorSampleInput[]): ReturnType<typeof conditionCursor> {
  return conditionCursor(arrayCursorStream(samples), { minDistanceUv: 0, decimateHz: 0 });
}

const AMOUNT = 2;
const options = {
  restBox: DEFAULT_REST_BOX,
  geometry: constantFollowGeometry(AMOUNT),
};

describe('§6.2 “while the cursor is inside the rest box, the target does not move at all”', () => {
  it('a cursor wandering inside the box moves nothing', () => {
    const half = halfViewport(AMOUNT);
    const inside = DEFAULT_REST_BOX[0] * half * 0.9;
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 200; i++) {
      samples.push({ t: i / 120, x: 0.5 + Math.sin(i / 5) * inside, y: 0.5, c: 'a' });
    }
    const target = followTarget(conditioned(samples), options);
    const first = target.x[0] ?? 0;
    for (let i = 0; i < target.count; i++) expect(target.x[i]).toBeCloseTo(first, 12);
    expect(target.atRest).toBe(target.count);
  });
});

describe('§6.2 “the target moves by exactly the amount needed to put the cursor on the box edge”', () => {
  it('leaves the cursor exactly one half-box from the target, not at its centre', () => {
    const half = halfViewport(AMOUNT);
    const halfBox = DEFAULT_REST_BOX[0] * half;
    const samples: CursorSampleInput[] = [
      { t: 0, x: 0.5, y: 0.5, c: 'a' },
      { t: 0.1, x: 0.5 + halfBox + 0.05, y: 0.5, c: 'a' },
    ];
    const target = followTarget(conditioned(samples), options);
    expect(target.x[1]).toBeCloseTo(0.5 + 0.05, 10);
    // …and *not* at the cursor, which is what "not at the center" rules out.
    expect(target.x[1]).not.toBeCloseTo(0.5 + halfBox + 0.05, 3);
  });
});

describe('§6.2 “the box travels with the target”', () => {
  it('sustained motion produces one continuous pan that trails by a half-box', () => {
    const half = halfViewport(AMOUNT);
    const halfBox = DEFAULT_REST_BOX[0] * half;
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 200; i++) samples.push({ t: i / 120, x: 0.2 + i * 0.002, y: 0.5, c: 'a' });
    const target = followTarget(conditioned(samples), options);
    const last = target.count - 1;
    expect(target.x[last]).toBeCloseTo((samples[last]?.x ?? 0) - halfBox, 6);
    // Monotone: a continuous pan, never a step back.
    for (let i = 1; i < target.count; i++) {
      expect(target.x[i]).toBeGreaterThanOrEqual(target.x[i - 1] ?? 0);
    }
  });
});

describe('the box is a fraction of the visible zoomed viewport', () => {
  it('halves when the magnification doubles', () => {
    const move = (amount: number): number => {
      const samples: CursorSampleInput[] = [
        { t: 0, x: 0.5, y: 0.5, c: 'a' },
        { t: 0.1, x: 0.72, y: 0.5, c: 'a' },
      ];
      const target = followTarget(conditioned(samples), {
        restBox: DEFAULT_REST_BOX,
        geometry: constantFollowGeometry(amount),
      });
      return (target.x[1] ?? 0) - 0.5;
    };
    // At 2× the box is half as wide, so the target moves further for the same cursor.
    expect(move(2)).toBeGreaterThan(move(1.5));
    expect(halfViewport(4)).toBeCloseTo(0.125, 12);
  });

  it('follows a zoom that changes over source time', () => {
    let amount = 1.2;
    const geometry = { amountAt: (): number => amount };
    const samples: CursorSampleInput[] = [
      { t: 0, x: 0.5, y: 0.5, c: 'a' },
      { t: 0.1, x: 0.9, y: 0.5, c: 'a' },
    ];
    const gentle = followTarget(conditioned(samples), { restBox: DEFAULT_REST_BOX, geometry });
    amount = 3;
    const tight = followTarget(conditioned(samples), { restBox: DEFAULT_REST_BOX, geometry });
    expect(tight.x[1]).not.toBeCloseTo(gentle.x[1] ?? 0, 4);
  });
});

describe('the frame-safe clamp', () => {
  it('never lets the viewport leave the frame', () => {
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 400; i++) {
      samples.push({ t: i / 120, x: i % 2 === 0 ? 0 : 1, y: i % 3 === 0 ? 0 : 1, c: 'a' });
    }
    const target = followTarget(conditioned(samples), options);
    const half = halfViewport(AMOUNT);
    for (let i = 0; i < target.count; i++) {
      expect(target.x[i]).toBeGreaterThanOrEqual(half - 1e-12);
      expect(target.x[i]).toBeLessThanOrEqual(1 - half + 1e-12);
    }
  });

  it('collapses to the frame centre at amount 1, where no other centre is legal', () => {
    expect(clampCentre(0.9, halfViewport(1))).toBe(0.5);
    expect(clampCentre(0.1, halfViewport(1))).toBe(0.5);
  });
});

describe('the target speed cap', () => {
  it('takes longer to arrive and arrives in the same place', () => {
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 400; i++) {
      samples.push({ t: i / 120, x: i < 40 ? 0.3 + i * 0.01 : 0.7, y: 0.5, c: 'a' });
    }
    const cursor = conditioned(samples);
    const free = followTarget(cursor, options);
    const capped = followTarget(cursor, { ...options, maxTargetSpeedUvPerSec: 0.25 });
    const last = free.count - 1;
    expect(capped.x[last]).toBeCloseTo(free.x[last] ?? 0, 6);
    // …but it was behind for the whole of the fast part.
    expect(capped.x[45] ?? 0).toBeLessThan(free.x[45] ?? 0);
  });

  it('holds the target under the cap, sample by sample', () => {
    const samples: CursorSampleInput[] = [];
    for (let i = 0; i < 400; i++)
      samples.push({ t: i / 120, x: 0.02 + i * 0.0024, y: 0.5, c: 'a' });
    const cursor = conditioned(samples);
    const capped = followTarget(cursor, { ...options, maxTargetSpeedUvPerSec: 0.1 });
    for (let i = 1; i < capped.count; i++) {
      const dt = (capped.t[i] ?? 0) - (capped.t[i - 1] ?? 0);
      const step = Math.hypot(
        (capped.x[i] ?? 0) - (capped.x[i - 1] ?? 0),
        (capped.y[i] ?? 0) - (capped.y[i - 1] ?? 0),
      );
      expect(step).toBeLessThanOrEqual(0.1 * dt + 1e-12);
    }
  });
});

describe('§6.4 the phase lead', () => {
  it('is friction / tension — the spring’s own steady-state trail', () => {
    expect(leadSecondsFor(DEFAULT_SPRING, null)).toBeCloseTo(0.2, 12);
  });

  it('lengthens when the comfort ladder softens the spring', () => {
    const soft = scaleSpring(DEFAULT_SPRING, 0.55);
    expect(leadSecondsFor(soft, null)).toBeCloseTo(0.2 / 0.55, 10);
  });

  it('an explicit lead wins, and a negative one is refused rather than reversed', () => {
    expect(leadSecondsFor(DEFAULT_SPRING, 0.4)).toBe(0.4);
    expect(leadSecondsFor(DEFAULT_SPRING, -1)).toBe(0);
  });

  it('scaleSpring keeps ζ and moves only ω₀', () => {
    const zeta = (s: { tension: number; mass: number; friction: number }): number =>
      s.friction / (2 * Math.sqrt(s.tension * s.mass));
    const omega0 = (s: { tension: number; mass: number }): number => Math.sqrt(s.tension / s.mass);
    const soft = scaleSpring(DEFAULT_SPRING, 0.7);
    expect(zeta(soft)).toBeCloseTo(zeta(DEFAULT_SPRING), 12);
    expect(omega0(soft)).toBeCloseTo(omega0(DEFAULT_SPRING) * 0.7, 10);
  });
});
