/**
 * CSS `cubic-bezier(p1x, p1y, p2x, p2y)`, solved the way browsers solve it.
 *
 * §3.3 declares the `cubic` ease as *"CSS cubic-bezier"*, so this has to be the
 * same curve a designer gets from a CSS easing editor: control points P0 = (0,0)
 * and P3 = (1,1) are implicit, the parameter `s` runs 0→1 along the curve, and the
 * eased fraction is `y(s)` where `x(s) = u`.
 *
 * ## Why the iteration count is fixed
 *
 * §4.5 requires preview and export to agree on zoom amount and centre *exactly*.
 * A solver that stopped on a convergence tolerance would run a different number of
 * iterations depending on nothing but arithmetic order, and two builds could land
 * on different last bits. Newton runs a fixed {@link NEWTON_ITERATIONS} times and
 * bisection a fixed {@link BISECTION_ITERATIONS} times, so the result is a pure
 * function of the four control points and `u` — the same on every machine, on
 * every call, forever.
 */

/** Fixed, not "until converged" — see the module comment. */
const NEWTON_ITERATIONS = 8;
/** 32 halvings of [0,1] resolves `s` to 2⁻³², well past `float64` display need. */
const BISECTION_ITERATIONS = 32;
/** Below this the Newton step is degenerate and bisection takes over. */
const MIN_SLOPE = 1e-6;

function bezier(a: number, b: number, s: number): number {
  // The cubic with P0 = 0 and P3 = 1: 3a(1-s)²s + 3b(1-s)s² + s³.
  const inv = 1 - s;
  return 3 * a * inv * inv * s + 3 * b * inv * s * s + s * s * s;
}

function bezierSlope(a: number, b: number, s: number): number {
  const inv = 1 - s;
  return 3 * a * (inv * inv - 2 * inv * s) + 3 * b * (2 * inv * s - s * s) + 3 * s * s;
}

/**
 * The eased fraction for a raw fraction `u` in `[0, 1]`.
 *
 * `p1x` and `p2x` are clamped into `[0, 1]`: outside it the curve is not a
 * function of x and "the eased value at 40% through the segment" has no single
 * answer. CSS clamps the same way, and clamping here rather than rejecting at
 * validation keeps a hand-edited `edit.json` openable.
 */
export function cubicBezierEase(
  u: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;

  const ax = p1x < 0 ? 0 : p1x > 1 ? 1 : p1x;
  const bx = p2x < 0 ? 0 : p2x > 1 ? 1 : p2x;

  // The identity curve — cubic-bezier(t, t, t, t) for any t on the diagonal.
  if (ax === 1 / 3 && bx === 2 / 3 && p1y === 1 / 3 && p2y === 2 / 3) return u;

  let s = u;
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = bezierSlope(ax, bx, s);
    if (Math.abs(slope) < MIN_SLOPE) break;
    const next = s - (bezier(ax, bx, s) - u) / slope;
    if (!Number.isFinite(next)) break;
    s = next;
  }

  if (s < 0 || s > 1) {
    // Newton wandered out of range; bisection cannot.
    let low = 0;
    let high = 1;
    s = u;
    for (let i = 0; i < BISECTION_ITERATIONS; i++) {
      s = (low + high) / 2;
      if (bezier(ax, bx, s) < u) low = s;
      else high = s;
    }
  }

  return bezier(p1y, p2y, s);
}
