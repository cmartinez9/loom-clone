/**
 * §6.2 the dead zone — **this is the anti-seasickness mechanism**.
 *
 * Architecture report §6.2, quoted because every line of it is a requirement:
 *
 * > A pure spring-to-cursor follows every wobble, just smoothly. That is what makes
 * > people queasy. The frame should be **still by default and move deliberately**.
 * >
 * > - While the cursor is inside the rest box, **the target does not move at all.**
 * > - When the cursor exits, the target moves by exactly the amount needed to put the
 * >   cursor back **on the box edge** — not at the center.
 * > - The box travels with the target, so sustained motion produces one smooth
 * >   continuous pan, and small motion produces nothing.
 *
 * This module produces the **target** trajectory only. It does no smoothing: the
 * smoothing is §6.3's spring, integrated on the fixed 8 ms grid at compile time by
 * `precomputeSpring`, and the targets computed here become that spring's step
 * targets. Nothing here integrates anything, which is the §3.4 rule stated as a
 * property of the file rather than as a comment on a line.
 *
 * ## The rest box is a fraction of the *visible zoomed viewport*, not of the frame
 *
 * §6.2's `restBox = [0.35, 0.45]` is *"35% of visible width, 45% of visible height"*,
 * and what is visible depends on the zoom. At `amount = 2` the viewport is 0.5 UV
 * wide, so the box is 0.175 UV wide — half what it would be if the fraction were read
 * against the frame. Getting this wrong makes the dead zone twice as large as
 * designed at 2× and four times as large at 4×, which reads as "the follow is
 * broken" rather than as a units bug. {@link FollowGeometry} is where the amount
 * enters, and it is a function of time because the zoom above this track is.
 *
 * ## The frame-safe clamp is not optional, and it is applied to the stored target
 *
 * A camera centred at 0.1 UV with the viewport 0.5 UV wide shows background from
 * −0.15 to 0, which §6.5 calls out for auto-zoom and which is just as true here. The
 * centre is therefore clamped into `[h, 1−h]`, `h = 0.5/amount`, **before** it is
 * stored — so the box travels with the clamped target and a cursor wandering along
 * the left edge of the display moves nothing at all, instead of the target
 * accumulating an off-screen position it has to walk back from.
 */

import type { Seconds } from '@loom/format';
import type { ConditionedCursor } from './conditioning.ts';

/** §6.2: *"restBox = [0.35, 0.45] — 35% of visible width, 45% of visible height"*. */
export const DEFAULT_REST_BOX: readonly [number, number] = [0.35, 0.45];

/**
 * How the camera's magnification enters §6.2's arithmetic.
 *
 * `amountAt` is a function of **source** time because the zoom above a cursor-follow
 * track is a function of source time (§3.2), and because the box and the frame-safe
 * clamp both scale with it. A caller with a constant framing passes
 * {@link constantFollowGeometry}.
 */
export interface FollowGeometry {
  amountAt(sourceTime: Seconds): number;
}

/** The ordinary case: one magnification for the whole recording. */
export function constantFollowGeometry(amount: number): FollowGeometry {
  const safe = Number.isFinite(amount) && amount >= 1 ? amount : 1;
  return { amountAt: () => safe };
}

export interface DeadZoneOptions {
  restBox: readonly [number, number];
  geometry: FollowGeometry;
  /**
   * How fast the target itself may travel, UV per second, or `null` for §6.2 as
   * written.
   *
   * **Not in §6.2, and it is not there by accident** — §6.2's rule places the target
   * relative to the cursor and says nothing about a rate, which means the target's
   * velocity *is* the cursor's velocity from the instant the cursor leaves the box.
   * Measured on the ten real recordings in `packages/edl/test/corpus/`: that puts the
   * camera at 0.28–1.18 UV/s against §6.6's budget of 0.35, and only the two calmest
   * sessions come in under it. `cursor-follow.ts`'s comfort ladder is where this is
   * turned on and why; the rung that carries it is the one §6.6's own "widen the rest
   * box" rung could not reach.
   *
   * What it costs is exactly what a calm camera costs: on a fast flick the camera
   * arrives late and the cursor can leave the visible viewport for a moment. It
   * arrives at the same place — the cap limits the rate, never the destination — so
   * nothing is framed differently once the cursor stops.
   */
  maxTargetSpeedUvPerSec?: number | null;
}

/** The follow target, one point per conditioned sample. Same indexing as its input. */
export interface FollowTarget {
  count: number;
  /** Source time — the conditioned cursor's own `t`, unmodified. */
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Samples at which the cursor was inside the box and the target did not move. */
  atRest: number;
}

/** Half the visible viewport, in UV, at a magnification. `0.5` at `amount = 1`. */
export function halfViewport(amount: number): number {
  const safe = Number.isFinite(amount) && amount >= 1 ? amount : 1;
  return 0.5 / safe;
}

/**
 * Clamp a centre so the visible viewport stays inside the frame.
 *
 * At `amount = 1` the whole frame is visible and the only legal centre is 0.5, which
 * falls out of the arithmetic rather than needing a special case: `h = 0.5` makes
 * `[h, 1−h]` the single point 0.5.
 */
export function clampCentre(value: number, half: number): number {
  const lo = half;
  const hi = 1 - half;
  if (lo >= hi) return 0.5;
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * §6.2's rest box, walked over a conditioned cursor log.
 *
 * The target starts on the first sample rather than at the centre of the frame, so a
 * recording that begins with the cursor in a corner does not open with a pan in from
 * the middle. The spring starts at rest on the first key (`precomputeSpring`), which
 * is the other half of that.
 */
export function followTarget(cursor: ConditionedCursor, options: DeadZoneOptions): FollowTarget {
  const count = cursor.count;
  const t = new Float64Array(count);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  if (count === 0) return { count: 0, t, x, y, atRest: 0 };

  const [boxW, boxH] = options.restBox;
  let atRest = 0;

  const firstHalf = halfViewport(options.geometry.amountAt(cursor.t[0] ?? 0));
  let targetX = clampCentre(cursor.x[0] ?? 0.5, firstHalf);
  let targetY = clampCentre(cursor.y[0] ?? 0.5, firstHalf);
  let previousX = targetX;
  let previousY = targetY;

  for (let i = 0; i < count; i++) {
    const time = cursor.t[i] ?? 0;
    const half = halfViewport(options.geometry.amountAt(time));
    // The box is a fraction of the visible viewport, and `2 * half` is that viewport.
    const halfBoxX = boxW * half;
    const halfBoxY = boxH * half;

    const cx = cursor.x[i] ?? 0.5;
    const cy = cursor.y[i] ?? 0.5;

    let moved = false;
    const dx = cx - targetX;
    if (dx > halfBoxX) {
      targetX = cx - halfBoxX;
      moved = true;
    } else if (dx < -halfBoxX) {
      targetX = cx + halfBoxX;
      moved = true;
    }
    const dy = cy - targetY;
    if (dy > halfBoxY) {
      targetY = cy - halfBoxY;
      moved = true;
    } else if (dy < -halfBoxY) {
      targetY = cy + halfBoxY;
      moved = true;
    }

    // Hold the target to a speed. See {@link DeadZoneOptions.maxTargetSpeedUvPerSec}
    // for why this is not in §6.2 and what the ten real recordings measured without
    // it. Applied to the *step*, along the direction the §6.2 rule asked for, so the
    // target keeps heading where §6.2 sent it and only takes longer to get there.
    const cap = options.maxTargetSpeedUvPerSec;
    if (cap !== undefined && cap !== null && cap > 0 && i > 0) {
      const dt = time - (cursor.t[i - 1] ?? time);
      const maxStep = cap * (dt > 0 ? dt : 0);
      const dxT = targetX - previousX;
      const dyT = targetY - previousY;
      const distance = Math.hypot(dxT, dyT);
      if (distance > maxStep && distance > 0) {
        const scale = maxStep / distance;
        targetX = previousX + dxT * scale;
        targetY = previousY + dyT * scale;
        moved = maxStep > 0;
      }
    }

    // Re-clamped every sample, not only when the cursor moved the target: the zoom
    // above this track can change under a stationary cursor, and a centre that was
    // legal at 1.5× shows background at 3×.
    const clampedX = clampCentre(targetX, half);
    const clampedY = clampCentre(targetY, half);
    if (clampedX !== targetX || clampedY !== targetY) moved = true;
    targetX = clampedX;
    targetY = clampedY;

    if (!moved) atRest++;
    t[i] = time;
    x[i] = targetX;
    y[i] = targetY;
    previousX = targetX;
    previousY = targetY;
  }

  return { count, t, x, y, atRest };
}
