/**
 * The spring-mass-damper, solved in closed form and precomputed on a fixed grid.
 *
 * Architecture report §3.4 — **the one rule you must not break**:
 *
 * > Spring channels are **not** a per-segment curve. The keyframes become **step
 * > targets** for a spring-mass-damper that is integrated over the whole channel on
 * > a **fixed 8 ms grid at compile time**, and sampling is an index + lerp.
 *
 * ## Why that is a rule and not a preference
 *
 * §3.4 measured the alternative. The same keyframe targets integrated per-frame at
 * 60 fps instead of on the fixed grid diverge by **0.02390 UV — 82.6 px at 3456
 * wide**. A 60 fps preview and a 30 fps export would then put the zoom in visibly
 * different places, and one dropped preview frame would permanently shift the
 * framing for the rest of the shot, because a frame-rate integrator carries its
 * error forward as state. The fixed grid has no such state: sample *n* is a
 * function of the keyframes and *n* alone. §12.5 costs the precompute at 13.6 ms
 * and 1.7 MB for a thirty-minute project, which is the entire price of never
 * having that class of bug.
 *
 * ## Why analytic, not Euler or RK4
 *
 * §3.4 again: *"Use the **analytic** (closed-form) solution … so the result is
 * exact at any step size and identical on every machine."* A numerical integrator's
 * answer depends on its step size, so an 8 ms grid and a 16.7 ms frame would
 * disagree even if both were run at compile time — and its per-step truncation
 * error accumulates over a thirty-minute channel. The closed form below is the
 * exact solution of `m·x'' + c·x' + k·x = 0` about the target, evaluated at `dt`;
 * it is a pure function of `(position, velocity, target, dt)` with no accumulated
 * error and no step-size dependence at all. `packages/edl/test/spring.test.ts`
 * pins that: stepping the grid is compared against the closed form evaluated
 * directly at each grid time, with a forward-Euler control that must fail.
 *
 * Ported from Cap's `crates/rendering/src/spring_mass_damper.rs:22-76`, which the
 * report adopts by name; the three damping regimes are the three cases of the
 * characteristic equation and all three are handled.
 */

import type { Keyframe, SpringParams } from '@loom/format';

/**
 * The grid. Eight milliseconds, everywhere, forever.
 *
 * Not a tuning knob: it is the number that makes preview and export agree. §12.5's
 * sample counts (7,502 for one minute) are this constant, and
 * `spring-determinism.test.ts` asserts them back, so changing it here fails there.
 */
export const SPRING_GRID_SEC = 0.008;

/**
 * How long past the last keyframe the table runs, as a multiple of `1/decay`.
 *
 * Past the end of the table the last sample is held forever, so this is not "when
 * has it settled enough to look right" — it is "how small must the *permanent*
 * error be". A critically damped response still holds `e^{-M}(1 + M)` of its step
 * at `M/(ζω₀)`: at §6.3's settling rule of 4 that is 9%, at twice it 3×10⁻³ — and
 * 3×10⁻³ of a full-frame UV move is **ten pixels at 3456 wide**, permanently, which
 * is the same order as the divergence §3.4 wrote the fixed grid to avoid. Sixteen
 * puts it at 1.9×10⁻⁶, a hundredth of a pixel. The cost is 225 extra samples at the
 * default parameters.
 */
const SETTLE_DECAY_MULTIPLES = 16;

/**
 * Hard ceiling on that tail, in seconds.
 *
 * A heavily overdamped channel (friction ≫ 2√(km)) decays at `ω₀(ζ − √(ζ²−1))`,
 * which tends to zero as friction grows — an unbounded tail from a set of
 * parameters validation happily accepts. Sixty seconds of grid is 7,500 samples;
 * past it the spring is static to well under a pixel for any usable parameters.
 */
const MAX_SETTLE_SEC = 60;

/** Undamped natural frequency and damping ratio — §6.3's ω₀ and ζ. */
export interface SpringConstants {
  /** rad/s. `√(k/m)`. */
  omega0: number;
  /** Dimensionless. `c / (2√(km))`. `< 1` underdamped, `1` critical, `> 1` over. */
  zeta: number;
}

export function springConstants(params: SpringParams): SpringConstants {
  const { tension: k, mass: m, friction: c } = params;
  const omega0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  return { omega0, zeta };
}

/**
 * The slowest decay rate in the response, in nepers per second.
 *
 * For an under- or critically-damped spring both roots decay at `ζω₀`. For an
 * overdamped one the two real roots decay at different rates and the slower —
 * `ω₀(ζ − √(ζ²−1))` — is what the settling time is governed by.
 */
export function springDecayRate(params: SpringParams): number {
  const { omega0, zeta } = springConstants(params);
  if (zeta <= 1) return zeta * omega0;
  return omega0 * (zeta - Math.sqrt(zeta * zeta - 1));
}

/** Seconds of grid kept past the last keyframe. */
export function springSettleSec(params: SpringParams): number {
  const decay = springDecayRate(params);
  if (!(decay > 0) || !Number.isFinite(decay)) return MAX_SETTLE_SEC;
  return Math.min(MAX_SETTLE_SEC, SETTLE_DECAY_MULTIPLES / decay);
}

/**
 * Hard ceiling on the grid one channel may span, in seconds.
 *
 * The table is sized from the last keyframe's `t`, and nothing upstream bounds
 * that: `validateChannel` requires a finite `t` and no more, so a seconds/
 * milliseconds slip in a generator, or a hand-edited `edit.json` — the case
 * `bezier.ts` is explicit about staying openable for — would size the allocation
 * instead of the recording. A key at `t = 1e6` is 125 million samples (~1 GB for a
 * 2-wide channel) and one at `t = 1e9` is a `RangeError` thrown out of `compile`.
 * Twelve hours is longer than any recording this app can make and still only 5.4
 * million samples, so the bound refuses the slip and never the real project.
 */
export const MAX_SPRING_TABLE_SEC = 12 * 60 * 60;

/** Where this channel's grid would end: its last key, plus the settle tail. */
export function springTableEndSec(keys: readonly Keyframe[], params: SpringParams): number {
  if (keys.length === 0) return 0;
  const lastT = keys[keys.length - 1]?.t ?? 0;
  return Math.max(0, lastT) + springSettleSec(params);
}

/**
 * One analytic step of a scalar spring, written into `out` as `[position, velocity]`.
 *
 * Exact for any `dt`. `out` is a caller-owned two-element scratch so the precompute
 * loop allocates nothing.
 */
export function springStep(
  position: number,
  velocity: number,
  target: number,
  dt: number,
  constants: SpringConstants,
  out: Float64Array,
): void {
  const { omega0, zeta } = constants;
  // Solve about the target: the displacement `x` obeys the homogeneous equation.
  const x0 = position - target;
  const v0 = velocity;

  if (dt === 0) {
    out[0] = position;
    out[1] = velocity;
    return;
  }

  if (zeta < 1) {
    // Underdamped: a decaying oscillation at the damped frequency.
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega0 * dt);
    const cos = Math.cos(omegaD * dt);
    const sin = Math.sin(omegaD * dt);
    const b = (v0 + zeta * omega0 * x0) / omegaD;
    const x = decay * (x0 * cos + b * sin);
    const v = decay * (v0 * cos - ((omega0 * omega0 * x0 + zeta * omega0 * v0) / omegaD) * sin);
    out[0] = target + x;
    out[1] = v;
    return;
  }

  if (zeta === 1) {
    // Critically damped: the repeated-root case, `(A + Bt)e^{-ω₀t}`.
    const decay = Math.exp(-omega0 * dt);
    const b = v0 + omega0 * x0;
    out[0] = target + decay * (x0 + b * dt);
    out[1] = decay * (v0 - omega0 * dt * b);
    return;
  }

  // Overdamped: two distinct real roots.
  const root = omega0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * omega0 + root;
  const r2 = -zeta * omega0 - root;
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  const e1 = Math.exp(r1 * dt);
  const e2 = Math.exp(r2 * dt);
  out[0] = target + c1 * e1 + c2 * e2;
  out[1] = c1 * r1 * e1 + c2 * r2 * e2;
}

/** A precomputed spring channel: `count` samples of `width` components each. */
export interface SpringTable {
  /** Interleaved, `width` values per sample. Grid time of sample *n* is `n · 8 ms`. */
  samples: Float32Array;
  count: number;
  width: number;
}

/**
 * Turn keyframes into step targets and integrate the whole channel on the grid.
 *
 * The grid is anchored at **time zero of the channel's own domain**, so sample *n*
 * is at `n · SPRING_GRID_SEC` and nothing about the anchor depends on the keys, the
 * project, or the order in which channels were compiled. That is what makes two
 * independent precomputes byte-identical, which is §12.5's determinism claim and
 * this package's second acceptance gate.
 *
 * Within a step the target is held at the value it had at the **start** of the
 * step — a zero-order hold, the definition of "the keyframes become step targets".
 * A key therefore takes effect at the first grid point at or after its `t`; its
 * placement is quantized to 8 ms and to nothing else.
 *
 * `clamp` is applied to what is **stored**, never to the spring's internal state:
 * clamping the state would change the dynamics, and §3.3 declares `clamp` as a
 * bound on the channel's value, not as a wall the mass bounces off.
 *
 * The table is sized by the keys, so a key far out of range sizes the allocation:
 * {@link MAX_SPRING_TABLE_SEC} is the bound, and `compileChannel` is where a channel
 * that exceeds it is refused by name before this runs.
 */
export function precomputeSpring(
  keys: readonly Keyframe[],
  width: number,
  params: SpringParams,
  clamp: readonly [number, number] | null,
): SpringTable {
  if (keys.length === 0 || width <= 0) {
    return { samples: new Float32Array(0), count: 0, width: Math.max(0, width) };
  }

  const constants = springConstants(params);
  const dt = SPRING_GRID_SEC;
  const endSec = springTableEndSec(keys, params);
  // §12.5: 60 s → 7,502 samples; 600 s → 75,002; 1800 s → 225,002. Two guard
  // samples past the end so a lerp at the final grid point always has a right
  // neighbour to reach for.
  const count = Math.floor(endSec / dt) + 2;
  const samples = new Float32Array(count * width);

  const lo = clamp?.[0] ?? Number.NEGATIVE_INFINITY;
  const hi = clamp?.[1] ?? Number.POSITIVE_INFINITY;

  // Per-component state. The spring is scalar; a vector channel is `width`
  // independent springs sharing one set of parameters and one set of step times,
  // which is what makes a 2-wide `center` channel move diagonally rather than
  // along one axis at a time.
  const position = new Float64Array(width);
  const velocity = new Float64Array(width);
  const step = new Float64Array(2);

  // The spring starts at rest on the first key, so a channel whose first key is at
  // t = 12 s is already there at t = 0 rather than sweeping in from zero.
  readKeyValue(keys[0]?.v, width, position);

  let keyIndex = 0;
  for (let n = 0; n < count; n++) {
    const time = n * dt;
    while (keyIndex + 1 < keys.length && (keys[keyIndex + 1]?.t ?? Infinity) <= time) keyIndex++;

    const base = n * width;
    for (let c = 0; c < width; c++) {
      const value = position[c] ?? 0;
      samples[base + c] = value < lo ? lo : value > hi ? hi : value;
    }

    // Advance to the next grid point under the target in force during this step.
    const targetKey = keys[keyIndex];
    const targetIsActive = (targetKey?.t ?? 0) <= time;
    for (let c = 0; c < width; c++) {
      const target = targetIsActive ? componentOf(targetKey?.v, c) : (position[c] ?? 0);
      springStep(position[c] ?? 0, velocity[c] ?? 0, target, dt, constants, step);
      position[c] = step[0] ?? 0;
      velocity[c] = step[1] ?? 0;
    }
  }

  return { samples, count, width };
}

/** The `width` components of a keyframe value, written into `out`. */
export function readKeyValue(
  value: number | readonly number[] | undefined,
  width: number,
  out: Float64Array,
): void {
  for (let c = 0; c < width; c++) out[c] = componentOf(value, c);
}

function componentOf(value: number | readonly number[] | undefined, index: number): number {
  if (typeof value === 'number') return index === 0 ? value : 0;
  if (Array.isArray(value)) return (value as readonly number[])[index] ?? 0;
  return 0;
}
