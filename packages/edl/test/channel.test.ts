/**
 * Curve channels, and the refusal that keeps the two evaluators apart.
 *
 * §3.4: *"**Curve channels** (`hold`, `linear`, `cubic`) are evaluated pointwise,
 * `O(log n)` by binary search, no state. The ease on the *outgoing* keyframe governs
 * the segment."* That last clause is the one that is easy to get backwards, and
 * getting it backwards produces a timeline where every ease is applied one segment
 * late — visible, but only if you are looking for it.
 */

import { describe, expect, it } from 'vitest';
import type { Channel, Keyframe } from '@loom/format';
import {
  ChannelCompileError,
  channelWidth,
  classifyChannel,
  compileChannel,
  cubicBezierEase,
  CurveChannel,
  DEFAULT_SPRING,
  MAX_SPRING_TABLE_SEC,
  SpringChannel,
} from '../src/index.ts';

function evaluate(
  channel: { evaluate: (t: number, out: Float64Array) => void; width: number },
  t: number,
): number[] {
  const out = new Float64Array(channel.width);
  channel.evaluate(t, out);
  return Array.from(out);
}

const CURVE: Keyframe[] = [
  { t: 1, v: 10, ease: { kind: 'hold' } },
  { t: 2, v: 20, ease: { kind: 'linear' } },
  { t: 4, v: 40, ease: { kind: 'cubic', p1: [0.32, 0], p2: [0, 1] } },
  { t: 6, v: 0, ease: { kind: 'hold' } },
];

describe('curve channels', () => {
  const channel = new CurveChannel('t.amount', CURVE, null);

  it('holds the first and last value outside the keyed range', () => {
    expect(evaluate(channel, -50)).toEqual([10]);
    expect(evaluate(channel, 0.999)).toEqual([10]);
    expect(evaluate(channel, 6)).toEqual([0]);
    expect(evaluate(channel, 1e6)).toEqual([0]);
  });

  it('applies the OUTGOING keyframe’s ease to the segment after it', () => {
    // `hold` on the key at t=1 means the whole of [1, 2) is 10 and the value only
    // steps at 2. If the ease were read from the *incoming* key instead, this
    // segment would interpolate.
    expect(evaluate(channel, 1)).toEqual([10]);
    expect(evaluate(channel, 1.5)).toEqual([10]);
    expect(evaluate(channel, 1.999999)).toEqual([10]);
    expect(evaluate(channel, 2)).toEqual([20]);

    // `linear` on the key at t=2 governs [2, 4].
    expect(evaluate(channel, 3)).toEqual([30]);
    expect(evaluate(channel, 2.5)).toEqual([25]);
  });

  it('eases a cubic segment without changing its endpoints', () => {
    expect(evaluate(channel, 4)).toEqual([40]);
    const mid = evaluate(channel, 5)[0] ?? 0;
    // cubic-bezier(0.32, 0, 0, 1) is slow-in fast-out: at the midpoint it is past
    // the linear halfway value.
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(40);
    expect(mid).not.toBeCloseTo(20, 3);
  });

  it('interpolates every component of a vector channel', () => {
    const vector = new CurveChannel(
      't.center',
      [
        { t: 0, v: [0, 1], ease: { kind: 'linear' } },
        { t: 2, v: [1, 0], ease: { kind: 'hold' } },
      ],
      null,
    );
    expect(vector.width).toBe(2);
    expect(evaluate(vector, 1)).toEqual([0.5, 0.5]);
  });

  it('clamps what it returns, at every ease', () => {
    const clamped = new CurveChannel('t.amount', CURVE, [12, 30]);
    expect(evaluate(clamped, 0)).toEqual([12]);
    expect(evaluate(clamped, 3.5)).toEqual([30]);
    expect(evaluate(clamped, 6)).toEqual([12]);
  });

  it('agrees with a plain scan at every key, and between every pair of keys', () => {
    // The bucket index is an optimisation; a linear scan is the definition. They
    // must agree everywhere, or a dense channel resolves differently from a sparse
    // one for reasons nobody would think to look for.
    const times: number[] = [];
    for (let i = 0; i < 400; i++) times.push(-1 + (i * 9) / 400);
    for (const key of CURVE) times.push(key.t, key.t - 1e-9, key.t + 1e-9);

    for (const t of times) {
      expect(evaluate(channel, t), `at t=${t}`).toEqual(scanReference(CURVE, t));
    }
  });

  it('the bucket index really is an index over the keys — §3.6’s `curveIndex`', () => {
    const many: Keyframe[] = Array.from({ length: 500 }, (_, i) => ({
      t: i * 0.037,
      v: Math.sin(i),
      ease: { kind: 'linear' } as const,
    }));
    const dense = new CurveChannel('t.dense', many, null);
    expect(dense.buckets.length).toBe(many.length);
    expect(dense.buckets).toBeInstanceOf(Uint32Array);
    for (let i = 0; i < 2000; i++) {
      const t = (i * 500 * 0.037) / 2000;
      expect(evaluate(dense, t), `dense at t=${t}`).toEqual(scanReference(many, t));
    }
  });
});

/** The definition the bucket index has to match: walk the keys. */
function scanReference(keys: readonly Keyframe[], t: number): number[] {
  const width = channelWidth(keys);
  const at = (index: number): number[] => {
    const v = keys[index]?.v ?? 0;
    return Array.from({ length: width }, (_, c) =>
      Array.isArray(v) ? (v[c] ?? 0) : c === 0 ? v : 0,
    );
  };
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return [];
  if (t <= first.t) return at(0);
  if (t >= last.t) return at(keys.length - 1);
  let i = 0;
  while (i + 1 < keys.length && (keys[i + 1]?.t ?? Infinity) <= t) i++;
  const t0 = keys[i]?.t ?? 0;
  const t1 = keys[i + 1]?.t ?? t0;
  const raw = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const ease = keys[i]?.ease;
  if (ease?.kind === 'hold') return at(i);
  const u =
    ease?.kind === 'cubic'
      ? cubicBezierEase(raw, ease.p1[0], ease.p1[1], ease.p2[0], ease.p2[1])
      : raw;
  const a = at(i);
  const b = at(i + 1);
  return a.map((v, c) => v + ((b[c] ?? 0) - v) * u);
}

describe('classification — §3.4’s validation error', () => {
  it('refuses a channel that mixes spring and curve easings', () => {
    const mixed: Channel = {
      keys: [
        { t: 0, v: 1, ease: { kind: 'spring' } },
        { t: 1, v: 2, ease: { kind: 'linear' } },
      ],
      spring: DEFAULT_SPRING,
    };
    expect(() => classifyChannel('t.amount', mixed)).toThrow(ChannelCompileError);
    expect(() => classifyChannel('t.amount', mixed)).toThrow(/mixes spring and curve/);
  });

  it('refuses a spring channel with no spring parameters', () => {
    const orphan: Channel = { keys: [{ t: 0, v: 1, ease: { kind: 'spring' } }] };
    expect(() => classifyChannel('t.amount', orphan)).toThrow(/spring parameters/);
    expect(() => compileChannel('t.amount', orphan)).toThrow(/spring parameters/);
  });

  it('refuses a spring channel whose last key would size the grid past the ceiling', () => {
    // The table runs from zero to the last key, and nothing upstream bounds a
    // keyframe `t` — `validateChannel` asks only that it be finite. A
    // seconds/milliseconds slip, or a hand-edited `edit.json`, must therefore come
    // back as a typed refusal naming the channel rather than as a gigabyte of
    // `Float32Array` or a `RangeError` thrown out of `compile`.
    const slipped: Channel = {
      keys: [{ t: 1e6, v: 1, ease: { kind: 'spring' } }],
      spring: DEFAULT_SPRING,
    };
    expect(() => compileChannel('t.amount', slipped)).toThrow(ChannelCompileError);
    expect(() => compileChannel('t.amount', slipped)).toThrow(/t\.amount/);
    expect(() =>
      compileChannel('t.amount', {
        keys: [{ t: 1e9, v: 1, ease: { kind: 'spring' } }],
        spring: DEFAULT_SPRING,
      }),
    ).toThrow(ChannelCompileError);

    // A key inside the ceiling still compiles, so the bound refuses the slip and not
    // the recording: this is thirty minutes, §12.5's own worked example.
    const real = compileChannel('t.amount', {
      keys: [{ t: 1800, v: 1, ease: { kind: 'spring' } }],
      spring: DEFAULT_SPRING,
    });
    expect(real).toBeInstanceOf(SpringChannel);
    expect(MAX_SPRING_TABLE_SEC).toBeGreaterThan(1800);
  });

  it('reports an empty channel as no opinion rather than as zero', () => {
    expect(classifyChannel('t.amount', { keys: [] })).toBeNull();
    expect(compileChannel('t.amount', { keys: [] })).toBeNull();
  });

  it('routes each kind to its own evaluator', () => {
    const curve = compileChannel('t.a', { keys: [{ t: 0, v: 3, ease: { kind: 'hold' } }] });
    const spring = compileChannel('t.b', {
      keys: [{ t: 0, v: 3, ease: { kind: 'spring' } }],
      spring: DEFAULT_SPRING,
    });
    expect(curve).toBeInstanceOf(CurveChannel);
    expect(spring).toBeInstanceOf(SpringChannel);
    expect(curve?.kind).toBe('curve');
    expect(spring?.kind).toBe('spring');
  });
});

describe('cubic-bezier', () => {
  it('is the identity on the diagonal, and pinned at both ends', () => {
    expect(cubicBezierEase(0, 0.42, 0, 0.58, 1)).toBe(0);
    expect(cubicBezierEase(1, 0.42, 0, 0.58, 1)).toBe(1);
    for (const u of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(cubicBezierEase(u, 1 / 3, 1 / 3, 2 / 3, 2 / 3)).toBeCloseTo(u, 12);
    }
  });

  it('is monotonic for an ordinary ease and matches known CSS values', () => {
    // ease-in-out = cubic-bezier(0.42, 0, 0.58, 1); at the midpoint it is exactly 0.5
    // by symmetry, and it never goes backwards.
    expect(cubicBezierEase(0.5, 0.42, 0, 0.58, 1)).toBeCloseTo(0.5, 9);
    let previous = -1;
    for (let i = 0; i <= 200; i++) {
      const value = cubicBezierEase(i / 200, 0.42, 0, 0.58, 1);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('gives the same answer every time it is asked — the iteration count is fixed', () => {
    const once = cubicBezierEase(0.37, 0.32, 0, 0, 1);
    for (let i = 0; i < 100; i++) expect(cubicBezierEase(0.37, 0.32, 0, 0, 1)).toBe(once);
  });
});
