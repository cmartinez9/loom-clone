/**
 * **Phase 7 gate, half two.** Architecture report §8: *"Spring determinism test
 * (§12.5)."* §12.5 states the measurement it is asserting back:
 *
 * ```
 * determinism: two independent precomputes identical = true
 * fixed-8ms-grid vs per-frame-60fps integration, max divergence (UV): 0.02390 = 82.6 px at 3456 wide
 * ```
 *
 * ## Why "identical" and not "close"
 *
 * §4.5 requires preview and export to agree on zoom amount and centre exactly, and
 * phase 8's gate compares their frames pixel for pixel at 24 timestamps. Preview and
 * export each run their own `compile`, so two precomputes of the same channel being
 * *byte* identical is the precondition for that gate being satisfiable at all. A
 * tolerance here would move the disagreement downstream to a pixel comparison that
 * has no tolerance to give.
 *
 * ## Why it cannot pass vacuously
 *
 * Comparing a thing to itself is the classic way this test passes for nothing, so:
 *
 *  - the two precomputes are built from **independently parsed** documents, with
 *    other unrelated precomputes run in between, so shared state or a memoized
 *    result would be caught;
 *  - the tables are asserted to be non-trivial — thousands of samples, hundreds of
 *    distinct values — before they are compared;
 *  - and there are controls. The comparator must catch a per-frame 60 fps *and*
 *    30 fps integration (§3.4's measurement, re-measured here on the dense channel
 *    that shape of divergence actually comes from), a grid step altered by one part
 *    in a million, and a single sample nudged by one `float32` ulp. If it stops
 *    catching any of them, this file fails rather than passing quietly.
 */

import { describe, expect, it } from 'vitest';
import type { EditDocument, Keyframe, SpringParams } from '@loom/format';
import {
  compile,
  DEFAULT_SPRING,
  manualZoomTrack,
  precomputeSpring,
  SPRING_GRID_SEC,
  springConstants,
  springSettleSec,
  springStep,
} from '../src/index.ts';

/** §12.5's channel: a zoom centre chased by the default spring. */
const CENTER_KEYS: Keyframe[] = [
  { t: 0.0, v: [0.5, 0.5], ease: { kind: 'spring' } },
  { t: 0.6, v: [0.312, 0.688], ease: { kind: 'spring' } },
  { t: 3.3, v: [0.402, 0.61], ease: { kind: 'spring' } },
  { t: 5.8, v: [0.86, 0.21], ease: { kind: 'spring' } },
  { t: 9.4, v: [0.14, 0.77], ease: { kind: 'spring' } },
  { t: 12.0, v: [0.5, 0.5], ease: { kind: 'spring' } },
];

const AMOUNT_KEYS: Keyframe[] = [
  { t: 0.0, v: 1.0, ease: { kind: 'spring' } },
  { t: 0.6, v: 1.85, ease: { kind: 'spring' } },
  { t: 9.4, v: 2.6, ease: { kind: 'spring' } },
  { t: 12.0, v: 1.0, ease: { kind: 'spring' } },
];

/** A whole document, so the gate runs through `compile` and not only the kernel. */
function zoomDocument(): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 3,
    output: { size: [1920, 1240], fps: 30, background: { kind: 'none' } },
    clips: [{ id: 'c1', sourceStart: 0, sourceEnd: 30, speed: 1 }],
    tracks: [
      manualZoomTrack({
        id: 't-zoom-spring',
        activeRanges: [[0, 14]],
        amount: AMOUNT_KEYS,
        center: CENTER_KEYS,
        spring: DEFAULT_SPRING,
        amountClamp: [1, 4],
      }),
    ],
  };
}

/** Parse a fresh document from text, so the two runs share no object at all. */
function freshDocument(): EditDocument {
  return JSON.parse(JSON.stringify(zoomDocument())) as EditDocument;
}

function identical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function firstDifferentIndex(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -2;
}

describe('two independent precomputes of the same channel produce identical output', () => {
  it('is byte-identical, at the kernel', () => {
    const first = precomputeSpring(CENTER_KEYS, 2, DEFAULT_SPRING, null);

    // Unrelated work in between: different parameters, different widths, different
    // key sets. Anything cached, memoized or carried in module state would show up
    // in the second run.
    precomputeSpring(AMOUNT_KEYS, 1, { tension: 530, mass: 1, friction: 40 }, [1, 4]);
    precomputeSpring(CENTER_KEYS, 2, { tension: 80, mass: 3.5, friction: 90 }, [0, 1]);

    const second = precomputeSpring(
      JSON.parse(JSON.stringify(CENTER_KEYS)) as Keyframe[],
      2,
      { ...DEFAULT_SPRING },
      null,
    );

    // Non-trivial before it is compared: a pair of empty arrays would be identical too.
    expect(first.count).toBeGreaterThan(1000);
    expect(new Set(Array.from(first.samples)).size).toBeGreaterThan(500);

    expect(
      identical(first.samples, second.samples),
      `diverged first at sample ${String(firstDifferentIndex(first.samples, second.samples))}`,
    ).toBe(true);
  });

  it('is byte-identical through `compile`, which is what preview and export each call', () => {
    const a = compile(freshDocument());
    compile(freshDocument()); // a third, unrelated compile in between
    const b = compile(freshDocument());

    const keys = [...a.springSamples.keys()].sort();
    expect(keys).toEqual(['t-zoom-spring.amount', 't-zoom-spring.center']);
    expect([...b.springSamples.keys()].sort()).toEqual(keys);

    for (const key of keys) {
      const left = a.springSamples.get(key);
      const right = b.springSamples.get(key);
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      if (left === undefined || right === undefined) continue;
      expect(left.length).toBeGreaterThan(1000);
      expect(new Set(Array.from(left)).size, `${key} is a constant table`).toBeGreaterThan(100);
      expect(identical(left, right), `${key} differed between two compiles`).toBe(true);
    }
  });

  it('is on the 8 ms grid, at §12.5’s cost', () => {
    // §12.5 costed the precompute for a two-component channel:
    //   1 min: 7,502 samples, 59 KiB | 10 min: 75,002, 586 KiB | 30 min: 225,002, 1758 KiB
    // Reproduced by building channels whose table spans exactly those durations —
    // last key plus the settle tail. If the grid step ever moves, every line fails.
    expect(SPRING_GRID_SEC).toBe(0.008);
    const settle = springSettleSec(DEFAULT_SPRING);
    for (const [minutes, expectedSamples, expectedKiB] of [
      [1, 7502, 59],
      [10, 75002, 586],
      [30, 225002, 1758],
    ] as const) {
      const totalSec = minutes * 60;
      const keys: Keyframe[] = [
        { t: 0, v: [0.5, 0.5], ease: { kind: 'spring' } },
        { t: totalSec - settle, v: [0.2, 0.8], ease: { kind: 'spring' } },
      ];
      const table = precomputeSpring(keys, 2, DEFAULT_SPRING, null);
      expect(table.count, `${minutes} min`).toBe(expectedSamples);
      expect(Math.round(table.samples.byteLength / 1024), `${minutes} min`).toBe(expectedKiB);
    }
  });

  it('costs about what §12.5 says — the precompute is affordable at thirty minutes', () => {
    const settle = springSettleSec(DEFAULT_SPRING);
    const keys: Keyframe[] = [
      { t: 0, v: [0.5, 0.5], ease: { kind: 'spring' } },
      { t: 1800 - settle, v: [0.2, 0.8], ease: { kind: 'spring' } },
    ];
    const started = performance.now();
    const table = precomputeSpring(keys, 2, DEFAULT_SPRING, null);
    const elapsedMs = performance.now() - started;
    // §12.5 measured 13.6 ms on this machine. This is a sanity bound, not a
    // benchmark: a CI runner is slower and a precompute is not on a frame budget.
    // What it rules out is a precompute that became quadratic.
    expect(table.count).toBe(225002);
    expect(elapsedMs).toBeLessThan(2000);
    console.log(
      `spring precompute: 30 min = ${String(table.count)} samples, ` +
        `${elapsedMs.toFixed(1)} ms, ${String(Math.round(table.samples.byteLength / 1024))} KiB`,
    );
  });
});

// ---------------------------------------------------------------------------
// The controls.
// ---------------------------------------------------------------------------

/**
 * §3.4's alternative: integrate per-frame at 60 fps instead of on the fixed grid.
 *
 * Analytic steps, same closed form, same keyframes — only the grid differs. Then
 * resampled onto the 8 ms grid so the two can be compared sample for sample, which
 * is exactly the comparison a 60 fps preview and a 30 fps export would be making of
 * each other's framing.
 */
function perFrameTable(
  keys: readonly Keyframe[],
  width: number,
  params: SpringParams,
  gridCount: number,
  fps: number,
): Float32Array {
  const dt = 1 / fps;
  const constants = springConstants(params);
  const scratch = new Float64Array(2);
  const position = new Float64Array(width);
  const velocity = new Float64Array(width);
  const firstValue = keys[0]?.v;
  for (let c = 0; c < width; c++) {
    position[c] = Array.isArray(firstValue) ? (firstValue[c] ?? 0) : (firstValue ?? 0);
  }

  const frameCount = Math.ceil((gridCount * SPRING_GRID_SEC) / dt) + 2;
  const frames = new Float64Array(frameCount * width);
  let keyIndex = 0;
  for (let n = 0; n < frameCount; n++) {
    const time = n * dt;
    while (keyIndex + 1 < keys.length && (keys[keyIndex + 1]?.t ?? Infinity) <= time) keyIndex++;
    for (let c = 0; c < width; c++) frames[n * width + c] = position[c] ?? 0;
    const key = keys[keyIndex];
    const active = (key?.t ?? 0) <= time;
    for (let c = 0; c < width; c++) {
      const value = key?.v;
      const target = active
        ? Array.isArray(value)
          ? (value[c] ?? 0)
          : (value ?? 0)
        : (position[c] ?? 0);
      springStep(position[c] ?? 0, velocity[c] ?? 0, target, dt, constants, scratch);
      position[c] = scratch[0] ?? 0;
      velocity[c] = scratch[1] ?? 0;
    }
  }

  // Resample onto the 8 ms grid, linearly — the same lerp `SpringChannel` uses.
  const out = new Float32Array(gridCount * width);
  for (let n = 0; n < gridCount; n++) {
    const scaled = (n * SPRING_GRID_SEC) / dt;
    const index = Math.min(frameCount - 2, Math.floor(scaled));
    const frac = scaled - index;
    for (let c = 0; c < width; c++) {
      const v0 = frames[index * width + c] ?? 0;
      const v1 = frames[(index + 1) * width + c] ?? 0;
      out[n * width + c] = v0 + (v1 - v0) * frac;
    }
  }
  return out;
}

/**
 * A dense channel — a target every 100 ms, as a cursor-follow generator produces.
 *
 * §3.4's 82.6 px was measured on a channel of that shape rather than on §2.6's
 * hand-placed one: a sparse channel settles between its keys, and two integrators
 * that both reach the same settled value only disagree during the transients. What
 * a generated track is made of is transients, which is exactly why the rule matters
 * most for the tracks phase 10 will produce.
 */
const DENSE_KEYS: Keyframe[] = Array.from({ length: 201 }, (_, i) => {
  const t = Math.round(i * 0.1 * 1e6) / 1e6;
  return {
    t,
    v: [0.5 + 0.45 * Math.sin(t * 2.1), 0.5 + 0.45 * Math.cos(t * 1.3)],
    ease: { kind: 'spring' },
  } satisfies Keyframe;
});

/** Max |difference| between two same-length tables, in pixels at 3456 wide. */
function worstPx(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return worst * 3456;
}

describe('CONTROL: the comparator catches a precompute that is not the fixed grid', () => {
  const grid = precomputeSpring(CENTER_KEYS, 2, DEFAULT_SPRING, null);

  it('catches a per-frame integration, and re-measures §3.4’s divergence', () => {
    const dense = precomputeSpring(DENSE_KEYS, 2, DEFAULT_SPRING, null);
    const at60 = perFrameTable(DENSE_KEYS, 2, DEFAULT_SPRING, dense.count, 60);
    const at30 = perFrameTable(DENSE_KEYS, 2, DEFAULT_SPRING, dense.count, 30);

    // Both must be caught: the grid is not either of them.
    expect(identical(dense.samples, at60)).toBe(false);
    expect(identical(dense.samples, at30)).toBe(false);

    // And the harm §3.4 actually names — *"a 60 fps preview and a 30 fps export put
    // the zoom in visibly different places"* — is the difference between those two.
    const previewVsExport = worstPx(at60, at30);
    console.log(
      `fixed-8ms-grid vs per-frame: 60 fps ${worstPx(dense.samples, at60).toFixed(1)} px, ` +
        `30 fps ${worstPx(dense.samples, at30).toFixed(1)} px, ` +
        `60 fps preview vs 30 fps export ${previewVsExport.toFixed(1)} px at 3456 wide ` +
        `(§3.4 measured 0.02390 UV = 82.6 px)`,
    );
    // A last-bit difference would satisfy "caught" for a reason that does not
    // matter. This has to be a difference a person can see.
    expect(worstPx(dense.samples, at60)).toBeGreaterThan(10);
    expect(worstPx(dense.samples, at30)).toBeGreaterThan(10);
    expect(previewVsExport).toBeGreaterThan(10);
  });

  it('the fixed grid, by contrast, is the same answer at any sampling rate', () => {
    // The positive half of the same claim: the grid table read at 60 fps and at
    // 30 fps is one set of numbers, so preview and export cannot disagree.
    const dense = precomputeSpring(DENSE_KEYS, 2, DEFAULT_SPRING, null);
    const again = precomputeSpring(DENSE_KEYS, 2, DEFAULT_SPRING, null);
    expect(identical(dense.samples, again.samples)).toBe(true);
    expect(worstPx(dense.samples, again.samples)).toBe(0);
  });

  it('catches a grid step altered by one part in a million', () => {
    // Same integrator, same keys, same everything but 8.000008 ms. If a comparison
    // could not see this it could not see a build that drifted off the grid.
    const nudged = precomputeSpring(CENTER_KEYS, 2, DEFAULT_SPRING, null);
    const dt = SPRING_GRID_SEC * 1.000001;
    const constants = springConstants(DEFAULT_SPRING);
    const scratch = new Float64Array(2);
    const position = new Float64Array([0.5, 0.5]);
    const velocity = new Float64Array(2);
    let keyIndex = 0;
    for (let n = 0; n < nudged.count; n++) {
      const time = n * dt;
      while (keyIndex + 1 < CENTER_KEYS.length && (CENTER_KEYS[keyIndex + 1]?.t ?? 0) <= time) {
        keyIndex++;
      }
      for (let c = 0; c < 2; c++) nudged.samples[n * 2 + c] = position[c] ?? 0;
      const value = CENTER_KEYS[keyIndex]?.v as number[];
      for (let c = 0; c < 2; c++) {
        springStep(position[c] ?? 0, velocity[c] ?? 0, value[c] ?? 0, dt, constants, scratch);
        position[c] = scratch[0] ?? 0;
        velocity[c] = scratch[1] ?? 0;
      }
    }
    expect(identical(grid.samples, nudged.samples)).toBe(false);
  });

  it('catches one sample moved by a single float32 ulp', () => {
    // Proves the comparator compares contents, not lengths or identity.
    const copy = Float32Array.from(grid.samples);
    expect(identical(grid.samples, copy)).toBe(true);
    const at = Math.floor(copy.length / 3);
    const before = copy[at] ?? 0;
    copy[at] = Math.fround(before + Math.max(Math.abs(before), 1e-30) * 1.2e-7);
    expect(copy[at], 'the nudge was swallowed by float32 rounding').not.toBe(before);
    expect(identical(grid.samples, copy)).toBe(false);
    expect(firstDifferentIndex(grid.samples, copy)).toBe(at);
  });
});
