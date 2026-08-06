/**
 * §6.1 input conditioning — what happens to the cursor log before anything reads it.
 *
 * Architecture report §6.1, in order: a shake filter, decimation to 60 Hz with a
 * one-pixel minimum distance, and a cursor-shape debounce. Every constant below is
 * §6.1's, with the Cap file it is ported from named at the constant.
 *
 * ## Why this is not in the sampler
 *
 * `@loom/sampler`'s header says it explicitly: *"§6.1's shake filter, decimation to
 * 60 Hz and cursor-shape debounce are edit-time transforms with tuned constants, and
 * applying them at write time would destroy the data the tuning needs."* The log on
 * disk is generous and raw; this is the first thing that reads it, and the tuning
 * lives here where a regeneration can change it.
 *
 * ## The sanity pass, and why it comes first
 *
 * §6.6 requires a hostile fixture — *"teleports, NaNs, duplicated timestamps,
 * zero-length recordings"* — to be survivable. Everything downstream of here does
 * arithmetic on `Float64Array`s and would propagate a `NaN` into a spring table, a
 * keyframe and then into `edit.json`, where `validateEditDocument` refuses it and the
 * recording stops opening. So the *only* place that decides what a usable sample is,
 * is the first loop of {@link conditionCursor}: non-finite fields and time that does
 * not move forward are dropped and counted, positions outside the recorded display
 * are clamped onto it (a cursor on a second display cannot be framed by a camera
 * looking at this one), and nothing past this point has to ask again.
 *
 * A **teleport** is not hostile input and is not filtered: a display reconfiguration,
 * a `CGWarpMouseCursorPosition` and a fast flick all produce one, they are real, and
 * §6.2's dead zone plus §6.3's spring are what turn a jump into a camera move. What
 * §6.6 asks of a teleport is that it not crash, not that it not move the camera.
 */

import type { Seconds } from '@loom/format';
import { MAX_SPRING_TABLE_SEC } from '../spring.ts';
import type { CursorEventStream } from '../streams.ts';

/** §6.1, from Cap `crates/rendering/src/cursor_interpolation.rs:521`. ~52 px at 3456 wide. */
export const SHAKE_THRESHOLD_UV = 0.015;

/** §6.1: the reversal only counts as shake if it happened inside this window. */
export const SHAKE_WINDOW_SEC = 0.1;

/** §6.1: *"Decimate to 60 Hz … Halves the work with no visible effect."* */
export const DECIMATE_HZ = 60;

/**
 * §6.1's *"1-pixel minimum distance"* (Cap `cursor_interpolation.rs:579`), in UV.
 *
 * The log is normalized against the *logical* display (§2.5), so a pixel is
 * `1 / logicalWidth`. 1920 is the default rather than a measurement: the caller that
 * has `recording.json` open should pass the real width, and being wrong by a factor
 * of two here moves a threshold that already sits three orders below anything visible.
 */
export const DEFAULT_MIN_DISTANCE_UV = 1 / 1920;

/**
 * §6.1's cursor-shape debounce: *"replaces segments shorter than 1000 ms with the
 * dominant pointer shape"* (Cap `crates/project/src/cursor.rs:76-190`).
 */
export const SHAPE_STABILIZE_SEC = 1;

/**
 * The largest source time a cursor sample may claim, in seconds.
 *
 * `MAX_SPRING_TABLE_SEC` — twelve hours — because that is where the *consumer* stops:
 * `compileChannel` refuses a spring channel whose last key sits past it, by name, and a
 * generator that emitted such a key would produce a track that cannot be compiled and
 * therefore cannot be measured against §6.6 or drawn. So the refusal happens here,
 * where the input is, rather than three layers down inside the generator's own budget
 * check.
 *
 * The failure this catches is real and specific: §2.5's `t` is `(tUs − t0Us) / 1e6`,
 * and a log written with `t0Us = 0` carries **machine uptime** — the smoke script
 * measured 2,678,930 s of it (`AGENTS.md` § Sharp edges). Those samples are not a
 * thirty-one-day recording; they are a log whose origin was never subtracted, and
 * rebasing them here would silently move every generated effect relative to the media
 * it was generated against. They are dropped and counted instead.
 */
export const MAX_SOURCE_TIME_SEC = MAX_SPRING_TABLE_SEC;

export interface ConditioningParams {
  shakeThresholdUv: number;
  shakeWindowSec: Seconds;
  decimateHz: number;
  minDistanceUv: number;
  shapeStabilizeSec: Seconds;
  /** See {@link MAX_SOURCE_TIME_SEC}. */
  maxSourceTimeSec: Seconds;
}

export const DEFAULT_CONDITIONING: ConditioningParams = {
  shakeThresholdUv: SHAKE_THRESHOLD_UV,
  shakeWindowSec: SHAKE_WINDOW_SEC,
  decimateHz: DECIMATE_HZ,
  minDistanceUv: DEFAULT_MIN_DISTANCE_UV,
  shapeStabilizeSec: SHAPE_STABILIZE_SEC,
  maxSourceTimeSec: MAX_SOURCE_TIME_SEC,
};

/**
 * A cursor log after §6.1, plus the two travel totals §6.6's third assertion needs.
 *
 * Parallel arrays rather than objects because the generators walk them a few times
 * each and the hostile fixture is 120 Hz for as long as the recording is.
 */
export interface ConditionedCursor {
  count: number;
  /** Source time of each surviving sample, strictly increasing. */
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Cursor-image id after the shape debounce. Same length as `t`. */
  imageId: string[];
  /** `Σ|Δp|` over the samples that survived the sanity pass — §6.6's denominator. */
  rawTravelUv: number;
  /** `Σ|Δp|` over what came out. Reported, never asserted on. */
  travelUv: number;
  /**
   * Samples the sanity pass refused: non-finite, time that did not move forward, or a
   * source time past {@link MAX_SOURCE_TIME_SEC}.
   */
  rejected: number;
  /** Samples whose position was outside `[0,1]²` and was clamped onto the display. */
  clamped: number;
  /** Samples the §6.1 shake filter dropped. */
  shaken: number;
  /** Shape segments shorter than `shapeStabilizeSec` that were replaced. */
  shapesStabilized: number;
}

/** The zero-length case, named so callers do not have to build one. */
export const EMPTY_CONDITIONED_CURSOR: ConditionedCursor = {
  count: 0,
  t: new Float64Array(0),
  x: new Float64Array(0),
  y: new Float64Array(0),
  imageId: [],
  rawTravelUv: 0,
  travelUv: 0,
  rejected: 0,
  clamped: 0,
  shaken: 0,
  shapesStabilized: 0,
};

/** One sanity-checked sample, mid-pipeline. `c` is §2.5's cursor-image id. */
export interface CursorSample {
  t: Seconds;
  x: number;
  y: number;
  c: string;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function distance(a: CursorSample, b: CursorSample): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Run §6.1 over a cursor stream.
 *
 * The three stages are separate loops on purpose: the shake filter is defined over
 * *triples* and decimation over *pairs*, and interleaving them changes which sample
 * is `next` in a way that depends on the decimation state. §6.1 lists them in this
 * order and this keeps them in it.
 */
export function conditionCursor(
  stream: CursorEventStream | null,
  overrides: Partial<ConditioningParams> = {},
): ConditionedCursor {
  const params = { ...DEFAULT_CONDITIONING, ...overrides };
  if (stream === null || stream.count <= 0) return EMPTY_CONDITIONED_CURSOR;

  // ---- 1. sanity: the one place that decides what a usable sample is ---------
  const sane: CursorSample[] = [];
  let rejected = 0;
  let clamped = 0;
  let rawTravel = 0;
  let previousT = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < stream.count; i++) {
    const t = stream.tAt(i);
    const x = stream.xAt(i);
    const y = stream.yAt(i);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) {
      rejected++;
      continue;
    }
    // See MAX_SOURCE_TIME_SEC: past this, the log's origin was never subtracted.
    if (t > params.maxSourceTimeSec) {
      rejected++;
      continue;
    }
    // Not `>=`: §2.5's log is written by one monotonic sampler, so a repeated `t` is
    // either a duplicated line or two events the clock could not separate. Either
    // way a zero-length interval divides in the derivative pass below.
    if (!(t > previousT)) {
      rejected++;
      continue;
    }
    previousT = t;
    const cx = clamp01(x);
    const cy = clamp01(y);
    if (cx !== x || cy !== y) clamped++;
    const sample: CursorSample = { t, x: cx, y: cy, c: stream.imageIdAt(i) };
    const last = sane[sane.length - 1];
    if (last !== undefined) rawTravel += distance(last, sample);
    sane.push(sample);
  }

  if (sane.length === 0) {
    return { ...EMPTY_CONDITIONED_CURSOR, rejected, clamped };
  }

  // ---- 2. shake filter (§6.1) ------------------------------------------------
  // Drop `moves[i]` when it is a direction reversal, *and* both legs are small,
  // *and* it happened inside a short window. `prev` is the last *kept* sample, so a
  // run of shake collapses rather than only its odd-numbered members surviving.
  const steady: CursorSample[] = [];
  let shaken = 0;
  for (let i = 0; i < sane.length; i++) {
    const curr = sane[i];
    if (curr === undefined) continue;
    const prev = steady[steady.length - 1];
    const next = sane[i + 1];
    if (prev === undefined || next === undefined) {
      steady.push(curr);
      continue;
    }
    const ax = curr.x - prev.x;
    const ay = curr.y - prev.y;
    const bx = next.x - curr.x;
    const by = next.y - curr.y;
    const reversal = ax * bx + ay * by < 0;
    const small =
      Math.hypot(ax, ay) < params.shakeThresholdUv && Math.hypot(bx, by) < params.shakeThresholdUv;
    const fast = next.t - prev.t <= params.shakeWindowSec;
    if (reversal && small && fast) {
      shaken++;
      continue;
    }
    steady.push(curr);
  }

  // ---- 3. decimate to 60 Hz with a one-pixel minimum distance (§6.1) ---------
  // Both conditions, not either: a sample that arrives too soon *or* has not moved
  // far enough carries nothing the spring can resolve. The first and the last are
  // always kept, so the conditioned log spans the same interval the raw one did —
  // which is what §6.6's travel ratio and the generated track's `activeRanges` are
  // both measured over.
  // A hair under the nominal interval. Sample times are `i / hz` and the difference of
  // two of them lands either side of `1 / decimateHz` by one ulp, so an exact `<`
  // comparison keeps every second sample and then every third, alternating — 90 of 240
  // rather than 120, for no reason a reader could find. The epsilon is a nanosecond.
  const minInterval = params.decimateHz > 0 ? 1 / params.decimateHz - 1e-9 : 0;
  const kept: CursorSample[] = [];
  for (let i = 0; i < steady.length; i++) {
    const sample = steady[i];
    if (sample === undefined) continue;
    const last = kept[kept.length - 1];
    if (last === undefined || i === steady.length - 1) {
      if (last !== undefined && sample.t <= last.t) continue;
      kept.push(sample);
      continue;
    }
    if (sample.t - last.t < minInterval) continue;
    if (distance(last, sample) < params.minDistanceUv) continue;
    kept.push(sample);
  }

  // ---- 4. cursor-shape debounce (§6.1) --------------------------------------
  const shapesStabilized = stabilizeCursorShapes(kept, params.shapeStabilizeSec);

  const count = kept.length;
  const t = new Float64Array(count);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const imageId = new Array<string>(count);
  let travel = 0;
  for (let i = 0; i < count; i++) {
    const sample = kept[i];
    if (sample === undefined) continue;
    t[i] = sample.t;
    x[i] = sample.x;
    y[i] = sample.y;
    imageId[i] = sample.c;
    const previous = kept[i - 1];
    if (previous !== undefined) travel += distance(previous, sample);
  }

  return {
    count,
    t,
    x,
    y,
    imageId,
    rawTravelUv: rawTravel,
    travelUv: travel,
    rejected,
    clamped,
    shaken,
    shapesStabilized,
  };
}

/**
 * §6.1's cursor-shape debounce, in place. Returns how many segments were replaced.
 *
 * *"A cursor that flickers to I-beam for 200 ms while crossing text should not change
 * the rendered cursor."* Segments shorter than `minSec` become **the dominant pointer
 * shape** — the shape holding the most total time in this recording, which is the
 * reading that makes a run of three different sub-second flickers collapse to one
 * thing rather than to whichever neighbour happened to be longer.
 *
 * Exported because it is the one part of §6.1 whose consumer is not a generator: it
 * is what a cursor sprite should be drawn from (§6.7), and phase 10 does not draw one.
 */
export function stabilizeCursorShapes(samples: CursorSample[], minSec: Seconds): number {
  if (samples.length === 0 || minSec <= 0) return 0;

  const held = new Map<string, number>();
  let start = 0;
  const segments: { from: number; to: number; id: string; seconds: number }[] = [];
  for (let i = 1; i <= samples.length; i++) {
    const here = samples[i];
    const previous = samples[i - 1];
    if (previous === undefined) continue;
    if (here?.c === previous.c) continue;
    const from = samples[start];
    if (from === undefined) continue;
    const seconds = (here?.t ?? previous.t) - from.t;
    segments.push({ from: start, to: i, id: previous.c, seconds });
    held.set(previous.c, (held.get(previous.c) ?? 0) + seconds);
    start = i;
  }

  let dominant = '';
  let dominantSec = -1;
  for (const [id, seconds] of held) {
    if (seconds > dominantSec) {
      dominant = id;
      dominantSec = seconds;
    }
  }
  if (dominant === '') return 0;

  let replaced = 0;
  for (const segment of segments) {
    if (segment.seconds >= minSec || segment.id === dominant) continue;
    replaced++;
    for (let i = segment.from; i < segment.to; i++) {
      const sample = samples[i];
      if (sample !== undefined) sample.c = dominant;
    }
  }
  return replaced;
}
