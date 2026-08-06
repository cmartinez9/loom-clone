/**
 * §6.6 the seasickness budget — **a check, not a vibe**.
 *
 * Architecture report §6.6, in full:
 *
 * > "Smooth, not jittery" becomes three assertions the generator runs on its own
 * > output before returning it:
 * >
 * > ```
 * > max |dCenter/dt|   ≤ 0.35 UV/s      # pan speed
 * > max |d²Center/dt²| ≤ 1.2  UV/s²     # pan acceleration
 * > totalCameraTravel  ≤ 1.5 × totalCursorTravel
 * > ```
 * >
 * > If any fails, widen the rest box by 20% and regenerate, up to three attempts,
 * > then return the best attempt with a warning in the UI.
 *
 * The three numbers are {@link SEASICKNESS_BUDGET} and nothing may move them. They
 * are what the phase-10 gate asserts on ten real recordings, and
 * `packages/edl/test/seasickness-control.test.ts` is the control that proves they can
 * fail — a comfort check that cannot fail is decoration, which is the argument
 * `packages/format/test/kill-mid-write.test.ts` makes with its naive writer.
 *
 * ## What is measured: the resolved state, not the keyframes
 *
 * The keyframes are the spring's *step targets*, not the camera. What a viewer sees
 * is `resolve()`'s `zoom` — the spring sampled off its fixed 8 ms grid (§3.4),
 * folded through §3.5's stack with the `blendMs` crossfade at every `activeRanges`
 * edge. A crossfade is camera motion; so is a generated track showing through under a
 * manual one. Measuring anything but `resolve` would measure a camera the product
 * does not have, so this compiles a real document and calls the real hot path.
 *
 * ## …and the *visible* centre, which is not always the resolved one
 *
 * `sourceSampleRect` (`packages/compositor/src/geometry.ts`) clamps the sampled rect
 * into the frame, so the centre the viewer actually gets is
 * `clamp(center, 0.5/amount, 1 − 0.5/amount)`. Two consequences, and both decide
 * whether this check measures anything:
 *
 * - At `amount = 1` the whole frame is shown and **every** centre resolves to 0.5.
 *   Centre motion there is invisible, and a budget computed off the raw centre would
 *   report a pan nobody saw — which is exactly what a generated `center`-only
 *   cursor-follow track measured on its own would do, since with no `amount` track
 *   in the document the amount is 1 everywhere and the *whole* measurement is
 *   fictional. {@link framingTrack} is why `measureTrack` is not vacuous.
 * - A generator that let the centre wander outside that range would report more
 *   motion than the viewer saw and could fail on motion that does not exist.
 *
 * So the metric is taken on the clamped centre. The four lines that clamp it are a
 * restatement of `sourceSampleRect`'s bound, not an import: §4.5 requires preview and
 * export to agree on that rect, `compositor` already depends on `edl`, and
 * `packages/edl/test/budget.test.ts` pins the two against each other rather than
 * leaving the agreement to this comment. `rawCentreTravelUv` is reported beside it so
 * a divergence between the two is visible rather than silently absorbed.
 *
 * ## The grid it is measured on
 *
 * `SPRING_GRID_SEC` — 8 ms, the finest interval the model can represent. Nothing
 * hides between two samples, because between two samples there is nothing: the spring
 * table has one entry per grid point and `resolve` lerps. Sampling at a frame rate
 * instead would alias exactly the jitter this exists to catch, and a control that
 * jitters at 60 Hz would sail through a 60 Hz measurement.
 *
 * Speed is a forward difference — the average speed across one grid interval, which
 * is what an eye integrates — and acceleration is the central second difference.
 */

import type { EditDocument, Seconds, Track } from '@loom/format';
import { compile, EMPTY_COMPILE_CONTEXT } from '../compile.ts';
import { resolve } from '../resolve.ts';
import { SPRING_GRID_SEC } from '../spring.ts';
import { ALWAYS } from '../tracks.ts';
import type { ConditionedCursor } from './conditioning.ts';

/** §6.6's three numbers. Not tunable, not widened, not given a tolerance. */
export interface SeasicknessLimits {
  /** `max |dCenter/dt|`, UV per second. */
  panSpeedUvPerSec: number;
  /** `max |d²Center/dt²|`, UV per second squared. */
  panAccelUvPerSec2: number;
  /** `totalCameraTravel / totalCursorTravel`. */
  travelRatio: number;
}

export const SEASICKNESS_BUDGET: SeasicknessLimits = {
  panSpeedUvPerSec: 0.35,
  panAccelUvPerSec2: 1.2,
  travelRatio: 1.5,
};

export type SeasicknessMetric = 'panSpeed' | 'panAccel' | 'travelRatio';

export interface SeasicknessReport {
  /** `max |dCenter/dt|` over the measured span, UV/s. */
  panSpeedUvPerSec: number;
  /** `max |d²Center/dt²|` over the measured span, UV/s². */
  panAccelUvPerSec2: number;
  /** `Σ|Δcentre|` over the grid, UV, on the visible (clamped) centre. */
  cameraTravelUv: number;
  /** The same sum on the *unclamped* centre. Reported so the two cannot silently part. */
  rawCentreTravelUv: number;
  /** `Σ|Δcursor|` over the raw log that survived the sanity pass, UV. */
  cursorTravelUv: number;
  /** `cameraTravelUv / cursorTravelUv`, or 0 when the cursor never moved. */
  travelRatio: number;
  /** Source time of the worst pan speed, so a diagnosis can name a moment. */
  worstPanSpeedAtSec: Seconds;
  worstPanAccelAtSec: Seconds;
  /** Grid samples whose raw centre sat outside the visible range. Diagnostic. */
  clampedSamples: number;
  sampleCount: number;
  gridSec: Seconds;
  measuredSpanSec: Seconds;
  pass: boolean;
  failures: SeasicknessMetric[];
}

/** The report for a track with nothing to measure. Passes: a still frame is not queasy. */
export function emptySeasicknessReport(): SeasicknessReport {
  return {
    panSpeedUvPerSec: 0,
    panAccelUvPerSec2: 0,
    cameraTravelUv: 0,
    rawCentreTravelUv: 0,
    cursorTravelUv: 0,
    travelRatio: 0,
    worstPanSpeedAtSec: 0,
    worstPanAccelAtSec: 0,
    clampedSamples: 0,
    sampleCount: 0,
    gridSec: SPRING_GRID_SEC,
    measuredSpanSec: 0,
    pass: true,
    failures: [],
  };
}

/**
 * A one-clip document over a set of tracks, for measuring and for nothing else.
 *
 * `speed: 1` and `sourceStart: 0` make timeline time and source time the same number,
 * so a source-anchored track (§3.2 — every generated effect track) is measured at the
 * times its keyframes were written in. A caller measuring a stack that includes a
 * `domain: 'timeline'` track builds its own document instead.
 */
export function measurementDocument(tracks: readonly Track[], durationSec: Seconds): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 0,
    output: { size: [1920, 1080], fps: 30, background: { kind: 'none' } },
    clips: [
      {
        id: 'whole-source',
        sourceStart: 0,
        sourceEnd: Math.max(SPRING_GRID_SEC, durationSec),
        speed: 1,
      },
    ],
    tracks: [...tracks],
  };
}

/**
 * A constant magnification, as the bottom of a measurement stack.
 *
 * §6.2's rest box and §6.5's edge snap are both fractions of the *visible zoomed
 * viewport*, and so is the clamp that decides what a centre means at all. A
 * `center`-only cursor-follow track therefore has no measurable camera on its own —
 * at amount 1 every centre resolves to 0.5. This supplies the framing the follow was
 * generated for, so the budget is taken on the picture the user would see.
 *
 * `origin: 'manual'`, because it is not generated and must never be mistaken for a
 * generated track by anything that regenerates; it exists only inside a measurement
 * document.
 */
export function framingTrack(amount: number, id = 't-measure-framing'): Track {
  return {
    id,
    kind: 'transform',
    target: 'zoom',
    domain: 'source',
    origin: 'manual',
    blend: 'replace',
    blendMs: 0,
    activeRanges: ALWAYS,
    enabled: true,
    channels: {
      amount: { keys: [{ t: 0, v: Math.max(1, amount), ease: { kind: 'hold' } }] },
    },
  };
}

/** The visible centre: `sourceSampleRect`'s clamp, restated. See the module header. */
export function visibleCentre(centre: number, amount: number): number {
  const half = 0.5 / (Number.isFinite(amount) && amount > 1 ? amount : 1);
  const lo = half;
  const hi = 1 - half;
  if (lo >= hi) return 0.5;
  return centre < lo ? lo : centre > hi ? hi : centre;
}

export interface MeasureOptions {
  /** How long to walk. Defaults to the document's own compiled duration. */
  durationSec?: Seconds;
  /** §6.6's denominator. `rawTravelUv` from the conditioned log is the usual source. */
  cursorTravelUv: number;
  limits?: SeasicknessLimits;
}

/**
 * Walk a document's resolved zoom on the 8 ms grid and answer §6.6.
 *
 * `resolve` hands back its own borrowed state object (§3.6); the three numbers are
 * read out of it inside the loop, which is the discipline `state.ts` asks for.
 */
export function measureSeasickness(doc: EditDocument, options: MeasureOptions): SeasicknessReport {
  const limits = options.limits ?? SEASICKNESS_BUDGET;
  const compiled = compile(doc, EMPTY_COMPILE_CONTEXT);
  const span = options.durationSec ?? compiled.durationSec;
  const dt = SPRING_GRID_SEC;
  const count = Math.floor(span / dt) + 1;
  if (!(count > 2)) {
    const empty = emptySeasicknessReport();
    empty.cursorTravelUv = options.cursorTravelUv;
    empty.measuredSpanSec = Math.max(0, span);
    return empty;
  }

  const cx = new Float64Array(count);
  const cy = new Float64Array(count);
  let clampedSamples = 0;
  let rawTravel = 0;
  let previousRawX = 0;
  let previousRawY = 0;
  for (let n = 0; n < count; n++) {
    const state = resolve(compiled, n * dt);
    const rawX = state.zoom.center[0];
    const rawY = state.zoom.center[1];
    const x = visibleCentre(rawX, state.zoom.amount);
    const y = visibleCentre(rawY, state.zoom.amount);
    if (x !== rawX || y !== rawY) clampedSamples++;
    if (n > 0) rawTravel += Math.hypot(rawX - previousRawX, rawY - previousRawY);
    previousRawX = rawX;
    previousRawY = rawY;
    cx[n] = x;
    cy[n] = y;
  }

  let maxSpeed = 0;
  let maxSpeedAt = 0;
  let travel = 0;
  for (let n = 0; n + 1 < count; n++) {
    const dx = (cx[n + 1] ?? 0) - (cx[n] ?? 0);
    const dy = (cy[n + 1] ?? 0) - (cy[n] ?? 0);
    const step = Math.hypot(dx, dy);
    travel += step;
    const speed = step / dt;
    if (speed > maxSpeed) {
      maxSpeed = speed;
      maxSpeedAt = n * dt;
    }
  }

  let maxAccel = 0;
  let maxAccelAt = 0;
  const dt2 = dt * dt;
  for (let n = 1; n + 1 < count; n++) {
    const ax = ((cx[n + 1] ?? 0) - 2 * (cx[n] ?? 0) + (cx[n - 1] ?? 0)) / dt2;
    const ay = ((cy[n + 1] ?? 0) - 2 * (cy[n] ?? 0) + (cy[n - 1] ?? 0)) / dt2;
    const accel = Math.hypot(ax, ay);
    if (accel > maxAccel) {
      maxAccel = accel;
      maxAccelAt = n * dt;
    }
  }

  // A cursor that never moved cannot be exceeded by a factor, so the ratio is
  // reported as 0 and that assertion is vacuous — which is the honest reading of
  // "1.5 × zero". A camera that moved over a still cursor still fails, on speed and
  // on acceleration.
  const ratio = options.cursorTravelUv > 0 ? travel / options.cursorTravelUv : 0;

  const failures: SeasicknessMetric[] = [];
  if (maxSpeed > limits.panSpeedUvPerSec) failures.push('panSpeed');
  if (maxAccel > limits.panAccelUvPerSec2) failures.push('panAccel');
  if (ratio > limits.travelRatio) failures.push('travelRatio');

  return {
    panSpeedUvPerSec: maxSpeed,
    panAccelUvPerSec2: maxAccel,
    cameraTravelUv: travel,
    rawCentreTravelUv: rawTravel,
    cursorTravelUv: options.cursorTravelUv,
    travelRatio: ratio,
    worstPanSpeedAtSec: maxSpeedAt,
    worstPanAccelAtSec: maxAccelAt,
    clampedSamples,
    sampleCount: count,
    gridSec: dt,
    measuredSpanSec: span,
    pass: failures.length === 0,
    failures,
  };
}

/**
 * Measure one generated track at the framing it was generated for.
 *
 * The framing track goes **below** it, so the generated track's own opinion about the
 * centre wins per §3.5 and its opinion about `amount` — if it has one, as auto-zoom
 * does — replaces the constant.
 */
export function measureTrack(
  track: Track,
  durationSec: Seconds,
  cursor: Pick<ConditionedCursor, 'rawTravelUv'>,
  framingAmount: number,
  limits?: SeasicknessLimits,
): SeasicknessReport {
  const doc = measurementDocument([framingTrack(framingAmount), track], durationSec);
  return measureSeasickness(doc, {
    durationSec,
    cursorTravelUv: cursor.rawTravelUv,
    ...(limits === undefined ? {} : { limits }),
  });
}

/**
 * §6.6's *"return the best attempt"*, made an ordering rather than a judgement.
 *
 * Fewest failed assertions first; then the smallest worst overshoot, each metric
 * normalized by its own limit so a speed and an acceleration are comparable. A
 * passing attempt therefore always beats a failing one, and among failures the one
 * that misses by least wins.
 */
export function seasicknessPenalty(
  report: SeasicknessReport,
  limits: SeasicknessLimits = SEASICKNESS_BUDGET,
): number {
  const overshoot = Math.max(
    report.panSpeedUvPerSec / limits.panSpeedUvPerSec,
    report.panAccelUvPerSec2 / limits.panAccelUvPerSec2,
    report.travelRatio / limits.travelRatio,
  );
  return report.failures.length * 1e6 + overshoot;
}

/** One line, for a log or a test that prints its numbers even when it passes. */
export function describeSeasickness(report: SeasicknessReport): string {
  const verdict = report.pass ? 'pass' : `FAIL(${report.failures.join(',')})`;
  return (
    `${verdict} speed ${report.panSpeedUvPerSec.toFixed(4)} UV/s ` +
    `@${report.worstPanSpeedAtSec.toFixed(2)}s, ` +
    `accel ${report.panAccelUvPerSec2.toFixed(4)} UV/s² ` +
    `@${report.worstPanAccelAtSec.toFixed(2)}s, ` +
    `travel ${report.cameraTravelUv.toFixed(3)}/${report.cursorTravelUv.toFixed(3)} = ` +
    `${report.travelRatio.toFixed(3)}×, clamped ${report.clampedSamples}/${report.sampleCount}`
  );
}
