/**
 * The analytic spring itself — is it the right spring, and is it really analytic?
 *
 * §3.4 requires the **closed-form** solution rather than Euler or RK4, *"so the
 * result is exact at any step size and identical on every machine"*. That is a
 * checkable claim and this file checks it: stepping the fixed 8 ms grid is compared
 * against the closed form evaluated directly from the initial state at each grid
 * time. For a single step target those two must agree to `float32`, because they are
 * the same function — and a forward-Euler integrator on the identical grid must
 * *not* agree, which is the control that proves the comparison discriminates.
 *
 * The parameters and the numbers it is checked against are §6.3's and §6.4's,
 * measured on this machine and reproduced in §12.5.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPRING,
  precomputeSpring,
  SPRING_GRID_SEC,
  springConstants,
  springSettleSec,
  springStep,
} from '../src/index.ts';
import type { Keyframe, SpringParams } from '@loom/format';

function step(
  position: number,
  velocity: number,
  target: number,
  dt: number,
  params: SpringParams,
) {
  const out = new Float64Array(2);
  springStep(position, velocity, target, dt, springConstants(params), out);
  return { position: out[0] ?? 0, velocity: out[1] ?? 0 };
}

describe('the spring, against §6.3', () => {
  it("reproduces Cap's ScreenMovementSpring constants", () => {
    const { omega0, zeta } = springConstants(DEFAULT_SPRING);
    // ω₀ = √(k/m) = √(200/2.25) = 9.428…, ζ = c/(2√(km)) = 40/42.426… = 0.9428…
    expect(omega0).toBeCloseTo(9.43, 2);
    expect(zeta).toBeCloseTo(0.943, 3);
    expect(zeta).toBeLessThan(1); // "slightly underdamped"
  });

  it('overshoots by about 0.014% and settles in about 0.45 s', () => {
    const { omega0, zeta } = springConstants(DEFAULT_SPRING);
    const overshoot = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
    expect(overshoot).toBeGreaterThan(0.0001);
    expect(overshoot).toBeLessThan(0.0003); // §6.3's "≈ 0.014%"

    // Step from 0 to 1 and find when it is within 2% and stays there.
    let position = 0;
    let velocity = 0;
    let settledAt: number | null = null;
    for (let n = 1; n <= 200; n++) {
      const next = step(position, velocity, 1, SPRING_GRID_SEC, DEFAULT_SPRING);
      position = next.position;
      velocity = next.velocity;
      const within = Math.abs(position - 1) < 0.02;
      if (within && settledAt === null) settledAt = n * SPRING_GRID_SEC;
      if (!within) settledAt = null;
    }
    expect(settledAt).not.toBeNull();
    // 4/(ζω₀) ≈ 0.45 s — "a deliberate, camera-like move".
    expect(settledAt ?? 0).toBeGreaterThan(0.3);
    expect(settledAt ?? 0).toBeLessThan(0.6);
    expect(4 / (zeta * omega0)).toBeCloseTo(0.45, 2);
  });

  it('trails a moving target by friction/tension seconds — §6.4', () => {
    // §12.5: "predicted steady-state trail = friction/tension = 0.200 s; measured
    // trail chasing a 0.4 UV/s ramp = 0.196 s". Reproduced here so a change to the
    // step function that broke the dynamics — rather than the arithmetic — is caught.
    const rate = 0.4;
    const dt = SPRING_GRID_SEC;
    let position = 0;
    let velocity = 0;
    let trail = 0;
    for (let n = 1; n <= 2000; n++) {
      const t = n * dt;
      const next = step(position, velocity, rate * t, dt, DEFAULT_SPRING);
      position = next.position;
      velocity = next.velocity;
      if (t > 5) trail = (rate * t - position) / rate;
    }
    expect(trail).toBeCloseTo(DEFAULT_SPRING.friction / DEFAULT_SPRING.tension, 2);
    expect(trail).toBeCloseTo(0.196, 2);
  });

  it('handles all three damping regimes and reaches the target in each', () => {
    const regimes: { name: string; params: SpringParams; expect: 'under' | 'critical' | 'over' }[] =
      [
        {
          name: 'underdamped',
          params: { tension: 200, mass: 2.25, friction: 20 },
          expect: 'under',
        },
        // ζ = c/(2√(km)) = 1 exactly at c = 2√(200·2.25) = 42.4264…
        {
          name: 'critically damped',
          params: { tension: 200, mass: 2.25, friction: 2 * Math.sqrt(200 * 2.25) },
          expect: 'critical',
        },
        { name: 'overdamped', params: { tension: 200, mass: 2.25, friction: 200 }, expect: 'over' },
      ];

    for (const regime of regimes) {
      const { zeta } = springConstants(regime.params);
      if (regime.expect === 'under') expect(zeta).toBeLessThan(1);
      if (regime.expect === 'critical') expect(zeta).toBe(1);
      if (regime.expect === 'over') expect(zeta).toBeGreaterThan(1);

      let position = 0;
      let velocity = 0;
      const settle = springSettleSec(regime.params);
      const steps = Math.ceil(settle / SPRING_GRID_SEC);
      expect(steps).toBeGreaterThan(10);
      let overshoot = 0;
      for (let n = 0; n < steps; n++) {
        const next = step(position, velocity, 1, SPRING_GRID_SEC, regime.params);
        position = next.position;
        velocity = next.velocity;
        overshoot = Math.max(overshoot, position - 1);
      }
      expect(position, `${regime.name} did not reach its target`).toBeCloseTo(1, 3);
      if (regime.expect !== 'under') {
        // Neither critical nor overdamped may overshoot at all — that is what the
        // three separate closed forms are for.
        expect(overshoot, `${regime.name} overshot`).toBeLessThan(1e-9);
      }
    }
  });

  it('is exact at any step size: one 0.4 s step equals fifty 8 ms steps', () => {
    // The property Euler and RK4 do not have, and the reason §3.4 insists on the
    // closed form: the answer does not depend on how the interval was divided.
    const big = step(0, 0, 1, 0.4, DEFAULT_SPRING);
    let position = 0;
    let velocity = 0;
    for (let n = 0; n < 50; n++) {
      const next = step(position, velocity, 1, SPRING_GRID_SEC, DEFAULT_SPRING);
      position = next.position;
      velocity = next.velocity;
    }
    expect(position).toBeCloseTo(big.position, 12);
    expect(velocity).toBeCloseTo(big.velocity, 12);
  });
});

// ---------------------------------------------------------------------------
// Grid stepping vs. the closed form, with a Euler control.
// ---------------------------------------------------------------------------

/** A single step target: rest at 0, jump to 1 at t = 0. */
const STEP_KEYS: Keyframe[] = [
  { t: 0, v: 0, ease: { kind: 'spring' } },
  { t: SPRING_GRID_SEC, v: 1, ease: { kind: 'spring' } },
];

/** Forward Euler on the same grid — the thing §3.4 says not to do. */
function eulerTable(keys: readonly Keyframe[], params: SpringParams, count: number): Float32Array {
  const samples = new Float32Array(count);
  const { tension: k, mass: m, friction: c } = params;
  let position = Number(keys[0]?.v ?? 0);
  let velocity = 0;
  let keyIndex = 0;
  for (let n = 0; n < count; n++) {
    const time = n * SPRING_GRID_SEC;
    while (keyIndex + 1 < keys.length && (keys[keyIndex + 1]?.t ?? Infinity) <= time) keyIndex++;
    samples[n] = position;
    const target = (keys[keyIndex]?.t ?? 0) <= time ? Number(keys[keyIndex]?.v ?? 0) : position;
    const acceleration = (k * (target - position) - c * velocity) / m;
    velocity += acceleration * SPRING_GRID_SEC;
    position += velocity * SPRING_GRID_SEC;
  }
  return samples;
}

describe('the grid is stepped analytically, not integrated', () => {
  const table = precomputeSpring(STEP_KEYS, 1, DEFAULT_SPRING, null);

  it('matches the closed form evaluated directly at every grid time', () => {
    // From the instant the target takes effect the motion is a single closed-form
    // response, so sample n is `springStep(0, 0, 1, (n-1)·dt)` — computed in one
    // step rather than n of them. Agreement to float32 means the stepping is not
    // accumulating anything.
    let worst = 0;
    for (let n = 1; n < table.count; n++) {
      const direct = step(0, 0, 1, (n - 1) * SPRING_GRID_SEC, DEFAULT_SPRING).position;
      worst = Math.max(worst, Math.abs((table.samples[n] ?? 0) - Math.fround(direct)));
    }
    // float32 has ~7 decimal digits; the stored samples are the only rounding.
    expect(worst).toBeLessThan(1e-6);
  });

  it('CONTROL: forward Euler on the same grid does not match', () => {
    // If this ever stops failing, the comparison above is not sensitive enough to
    // tell an integrator from a closed form, and its passing means nothing.
    const euler = eulerTable(STEP_KEYS, DEFAULT_SPRING, table.count);
    let worst = 0;
    for (let n = 1; n < table.count; n++) {
      const direct = step(0, 0, 1, (n - 1) * SPRING_GRID_SEC, DEFAULT_SPRING).position;
      worst = Math.max(worst, Math.abs((euler[n] ?? 0) - direct));
    }
    expect(
      worst,
      'forward Euler agreed with the closed form to float32, so the analytic-exactness ' +
        'assertion above cannot tell the two apart',
    ).toBeGreaterThan(1e-4);
  });

  it('the table actually moves — it is not a run of one value', () => {
    const distinct = new Set(Array.from(table.samples));
    expect(distinct.size).toBeGreaterThan(50);
    expect(table.samples[0]).toBe(0);
    expect(table.samples[table.count - 1]).toBeCloseTo(1, 5);
  });

  it('holds the first key before it, and clamps what it stores', () => {
    const late: Keyframe[] = [
      { t: 12, v: 2, ease: { kind: 'spring' } },
      { t: 13, v: 9, ease: { kind: 'spring' } },
    ];
    const unclamped = precomputeSpring(late, 1, DEFAULT_SPRING, null);
    // Before the first key the spring sits on it rather than sweeping in from zero.
    expect(unclamped.samples[0]).toBe(2);
    expect(unclamped.samples[Math.floor(11 / SPRING_GRID_SEC)]).toBe(2);

    const clamped = precomputeSpring(late, 1, DEFAULT_SPRING, [0, 4]);
    expect(Math.max(...Array.from(clamped.samples))).toBeLessThanOrEqual(4);
    // …and the clamp is on the stored value, not on the dynamics: the unclamped
    // table is the same run of numbers with the ceiling removed.
    expect(clamped.samples[0]).toBe(2);
    expect(Math.max(...Array.from(unclamped.samples))).toBeGreaterThan(4);
  });

  it('runs each component of a vector channel as its own spring', () => {
    const keys: Keyframe[] = [
      { t: 0, v: [0, 0], ease: { kind: 'spring' } },
      { t: 0.1, v: [1, -1], ease: { kind: 'spring' } },
    ];
    const table2 = precomputeSpring(keys, 2, DEFAULT_SPRING, null);
    expect(table2.width).toBe(2);
    const half = Math.floor(0.4 / SPRING_GRID_SEC) * 2;
    // Symmetric targets give symmetric motion — the two components are not sharing
    // state, and neither is lagging the other.
    expect(table2.samples[half] ?? 0).toBeCloseTo(-(table2.samples[half + 1] ?? 0), 6);
  });
});
