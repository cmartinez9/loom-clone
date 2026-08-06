/**
 * §6.5 auto-zoom-on-click → keyframes.
 *
 * Architecture report §6.5's five steps, in order, with its `AutoZoomParams` as
 * {@link DEFAULT_AUTO_ZOOM_PARAMS}:
 *
 * > 1. **Cluster greedily.** A click joins the current cluster if the resulting
 * >    bounding box stays within `clusterBox` of the visible zoomed viewport;
 * >    otherwise start a new cluster.
 * > 2. **Per cluster, emit a zoom shape:** `start = firstClick.t - preRollSec`,
 * >    `end = lastClick.t + postRollSec`,
 * >    `amount = clamp(targetFill / max(bboxW, bboxH), 1.2, 2.5)`, `center = clusterCenter`.
 * > 3. **Edge-snap the center** so the zoomed viewport stays inside the frame.
 * > 4. **Merge** segments whose gap is under `mergeGapSec`; **drop** any shorter than
 * >    `minDurationSec`.
 * > 5. **Emit four keyframes per segment** on `amount` (1 → A → A → 1) and keyframes
 * >    on `center` that track the cluster centroid as it drifts, all with
 * >    `ease: 'spring'`.
 *
 * The output is an ordinary `Track` and it stacks under the user's manual one (§3.5).
 * `activeRanges` is the merged segment list, so between segments the track has no
 * opinion at all and whatever is below — a cursor-follow track, usually — shows
 * through, crossfading over `blendMs` at each edge.
 *
 * ## `clusterBox` is a fraction of the frame, and the numbers say so
 *
 * §6.5 calls it *"max cluster bbox as a fraction of the visible zoomed viewport"*, and
 * read literally against step 2 that is not satisfiable: substituting
 * `amount = targetFill / max(w,h)` into `w ≤ clusterBox[0] / amount` gives
 * `targetFill ≤ clusterBox[0]`, i.e. `0.6 ≤ 0.5`, for every width-dominant cluster.
 * The constants resolve it instead: `clusterBox[0] = targetFill / amountRange[0]`
 * exactly — `0.6 / 1.2 = 0.5` — so `clusterBox` is the bbox **as a fraction of the
 * frame** at which the amount reaches its floor, and admitting a click while the bbox
 * fits inside it is the same rule stated on the other side. `clusterBox[1] = 0.7` is
 * looser than `0.6 / 1.2` because frames are wider than they are tall and a column of
 * clicks should not be split the way a row of them would be. This is a reading of a
 * loose phrase against exact numbers, and it is written down here rather than left in
 * the code.
 *
 * ## `activeRanges` runs past the last keyframe, by the spring's settling time
 *
 * §3.5's crossfade exists so a handover does not pop, and it only achieves that where
 * the two sides *agree* at the edge. At a segment's `start` they do: the last keys of
 * the previous segment left the spring settled on the identity, so the window ramping
 * 0 → 1 changes nothing. At `end` they do **not** — the last keys say `amount = 1` and
 * `centre = [0.5, 0.5]`, but the spring is still on its way there, because a spring
 * reaches a step target asymptotically and §6.5 put that target at the same instant the
 * range closes. The window then drags the difference to identity over `blendMs`,
 * turning a 1.2 s post-roll zoom-out into a 250 ms one.
 *
 * Measured on the ten real recordings before the tail was added: the worst pan
 * acceleration in **nine of ten** fell within 0.25 s of a segment `end` — 47 to 177
 * UV/s² against §6.6's 1.2, and speeds of 0.47 to 2.17 UV/s against 0.35. With the
 * tail the same measurement is inside the budget. So the range ends
 * `4 / (ζω₀)` after the last keyframe — §6.3's own settling rule, the interval it calls
 * *"a deliberate, camera-like move"* — by which point the track's value really is the
 * identity and the crossfade really is the no-op §3.5 assumes. The cost is that the
 * track keeps its (identity) opinion for another half-second, which is invisible:
 * `amount` is 1 there, and at `amount = 1` `sourceSampleRect` shows the whole frame
 * whatever the centre says.
 *
 * ## What this generator's own §6.6 figure says, and why it is reported not gated
 *
 * §6.6's remedy is *"widen the rest box"*, which is cursor-follow's knob; this
 * generator has no rest box, so the budget is measured on its output and reported
 * rather than gated (`AutoZoomResult.budget`). On the ten real recordings it is **over
 * budget** — after the settle tail above, 9–66 UV/s² against 1.2 and 0.42–2.17 UV/s
 * against 0.35 — and the reason is geometric rather than a defect to fix here.
 *
 * `sourceSampleRect` clamps the sampled rect into the frame, so the legal centre at
 * magnification `a` is `[0.5/a, 1 − 0.5/a]` — an interval that **opens as the zoom
 * tightens**. A centre edge-snapped for the segment's full `amount` is therefore not
 * legal at the intermediate amounts the spring passes through, and what the viewer sees
 * during the pre-roll is the framing sliding outward as the zoom makes the corner
 * reachable. That is a real picture, correctly measured; making it slower means a
 * longer `preRollSec`, a lower `amountRange[1]`, or a centre that is not snapped to the
 * edge — all of them §6.5's specified numbers. It is the same open question as
 * `cursor-follow.ts`'s `COMFORT_LADDER` (§6.6's budget against §6's parameters), it is
 * recorded in `AGENTS.md`, and it is not answered here unilaterally.
 *
 * ## Why the centre keys start and end at the frame centre
 *
 * That is what §2.6's reference document does (`t-zoom-auto`: `[0.500, 0.500]` at the
 * segment start, the centroid thereafter), and the geometry makes it forced rather
 * than stylistic: at `amount = 1` the whole frame is visible, `sourceSampleRect`
 * clamps the sampled rect to the frame, and **every** centre resolves to 0.5. A
 * segment whose amount begins and ends at 1 therefore has no other legal centre at
 * its edges, and springing the centre back as the amount returns to 1 is what stops
 * that clamp from happening as a jump.
 */

import type { IsoTimestamp, Keyframe, Seconds, SpringParams, Track, Vec2 } from '@loom/format';
import { springDecayRate } from '../spring.ts';
import { DEFAULT_SPRING } from '../tracks.ts';
import type { ClickEventStream } from '../streams.ts';
import { type ClickSource, type ClickUnavailable, describeClickUnavailable } from './clicks.ts';
import { measureTrack, type SeasicknessLimits, type SeasicknessReport } from './budget.ts';
import { conditionCursor, type ConditionedCursor } from './conditioning.ts';
import type { CursorEventStream } from '../streams.ts';

/** §2.6's generated track uses 250 ms; the manual one 300. */
export const DEFAULT_GENERATED_BLEND_MS = 250;

/** §6.5's `AutoZoomParams`, verbatim. */
export interface AutoZoomParams {
  preRollSec: Seconds;
  postRollSec: Seconds;
  minDurationSec: Seconds;
  mergeGapSec: Seconds;
  /** Max cluster bbox as a fraction of the frame — see the module header. */
  clusterBox: [number, number];
  targetFill: number;
  amountRange: [number, number];
  edgeSnapRatio: number;
  spring: SpringParams;
  blendMs: number;
}

/**
 * §6.3's settling rule — *"settling ≈ 4/(ζω₀) ≈ 0.45 s"*.
 *
 * Not `springSettleSec`, which is the *table's* tail and uses sixteen multiples
 * because what it bounds is the **permanent** error past the end of the grid. What is
 * being bounded here is a visible handover, and four multiples is 2% of the step —
 * under a pixel at 3456 wide for any amount this generator emits.
 */
export function segmentSettleTailSec(spring: SpringParams): Seconds {
  const decay = springDecayRate(spring);
  return decay > 0 && Number.isFinite(decay) ? 4 / decay : 0;
}

export const DEFAULT_AUTO_ZOOM_PARAMS: AutoZoomParams = {
  preRollSec: 0.6,
  postRollSec: 1.2,
  minDurationSec: 1,
  mergeGapSec: 0.8,
  clusterBox: [0.5, 0.7],
  targetFill: 0.6,
  amountRange: [1.2, 2.5],
  edgeSnapRatio: 0.25,
  spring: DEFAULT_SPRING,
  blendMs: DEFAULT_GENERATED_BLEND_MS,
};

/** One click, after the phase and sanity filters. */
export interface Click {
  t: Seconds;
  x: number;
  y: number;
}

/** A cluster of clicks, before it becomes a segment. */
export interface ClickCluster {
  clicks: Click[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A zoom segment, after §6.5 steps 2–4. */
export interface ZoomSegment {
  start: Seconds;
  end: Seconds;
  /** When the zoom is fully in, and when it starts coming out. */
  holdStart: Seconds;
  holdEnd: Seconds;
  amount: number;
  /** Edge-snapped centroid at each click in the segment, in click order. */
  centres: { t: Seconds; centre: Vec2 }[];
  clicks: number;
}

export interface AutoZoomInput {
  /** The one input that may not be a bare stream. See `clicks.ts`. */
  clicks: ClickSource;
  /** §6.5's signature takes the cursor too; it is what a cluster of one is centred by. */
  cursor?: CursorEventStream | null;
  params?: Partial<AutoZoomParams>;
  trackId?: string;
  inputs?: Record<string, string>;
  generatedAt?: IsoTimestamp;
  durationSec?: Seconds;
  limits?: SeasicknessLimits;
  /** Which mouse buttons count. Defaults to the primary button only. */
  buttons?: readonly number[];
}

export type AutoZoomResult =
  | {
      ok: true;
      track: Track;
      segments: ZoomSegment[];
      /** Reported, never gated: §6.6's remedy is a rest box and this generator has none. */
      budget: SeasicknessReport;
      clicks: number;
      /** True when the tap was live and nobody clicked. A real, different answer. */
      empty: boolean;
    }
  | { ok: false; reason: ClickUnavailable; message: string };

/**
 * Generate an auto-zoom-on-click track, or say why there is none.
 *
 * The failure branch is not an error and not an empty track: §6.5 requires that a
 * declined Accessibility grant leave *"the UI says so plainly rather than producing
 * nothing"*, and an empty generated track is indistinguishable from a live tap that
 * saw no clicks. Those are the two things this signature exists to keep apart —
 * `ok: false` for "there were no clicks to see", `ok: true, empty: true` for "we
 * watched and nothing happened".
 */
export function generateAutoZoom(input: AutoZoomInput): AutoZoomResult {
  if (input.clicks.kind === 'unavailable') {
    return {
      ok: false,
      reason: input.clicks.reason,
      message: describeClickUnavailable(input.clicks.reason),
    };
  }

  const params: AutoZoomParams = { ...DEFAULT_AUTO_ZOOM_PARAMS, ...input.params };
  const trackId = input.trackId ?? 't-zoom-auto';
  const buttons = input.buttons ?? [0];
  const clicks = readClicks(input.clicks.stream, buttons);

  const clusters = clusterClicks(clicks, params);
  const segments = mergeSegments(
    clusters.map((cluster) => segmentOf(cluster, params)),
    params,
  );

  const spanEnd = Math.max(
    input.durationSec ?? 0,
    segments.length > 0 ? (segments[segments.length - 1]?.end ?? 0) : 0,
  );
  const track = buildTrack({
    trackId,
    segments,
    params,
    inputs: input.inputs ?? {},
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });

  // The cursor is conditioned only for §6.6's denominator; nothing about the
  // clustering reads it. A caller that passes none gets a ratio of zero, which the
  // report states rather than hides.
  const cursor: ConditionedCursor = conditionCursor(input.cursor ?? null);
  const framing = params.amountRange[1];
  const budget = measureTrack(track, spanEnd, cursor, framing, input.limits);

  return { ok: true, track, segments, budget, clicks: clicks.length, empty: clicks.length === 0 };
}

/** Sanity-filter the log the same way §6.1 filters the cursor one, and drop `up`s. */
function readClicks(stream: ClickEventStream, buttons: readonly number[]): Click[] {
  const out: Click[] = [];
  let previousT = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < stream.count; i++) {
    // Downs only. An `up` is a second event at the same place and would double every
    // click's weight in a centroid for nothing.
    if (stream.phaseAt(i) !== 'down') continue;
    if (!buttons.includes(stream.buttonAt(i))) continue;
    const t = stream.tAt(i);
    const x = stream.xAt(i);
    const y = stream.yAt(i);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (t < previousT) continue;
    previousT = t;
    out.push({ t, x: clamp01(x), y: clamp01(y) });
  }
  return out;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** §6.5 step 1. Greedy, in time order; a click that would burst the box starts a new one. */
export function clusterClicks(clicks: readonly Click[], params: AutoZoomParams): ClickCluster[] {
  const clusters: ClickCluster[] = [];
  let current: ClickCluster | null = null;
  for (const click of clicks) {
    if (current === null) {
      current = { clicks: [click], minX: click.x, maxX: click.x, minY: click.y, maxY: click.y };
      clusters.push(current);
      continue;
    }
    const minX = Math.min(current.minX, click.x);
    const maxX = Math.max(current.maxX, click.x);
    const minY = Math.min(current.minY, click.y);
    const maxY = Math.max(current.maxY, click.y);
    if (maxX - minX <= params.clusterBox[0] && maxY - minY <= params.clusterBox[1]) {
      current.clicks.push(click);
      current.minX = minX;
      current.maxX = maxX;
      current.minY = minY;
      current.maxY = maxY;
      continue;
    }
    current = { clicks: [click], minX: click.x, maxX: click.x, minY: click.y, maxY: click.y };
    clusters.push(current);
  }
  return clusters;
}

/** §6.5 steps 2 and 3. */
export function segmentOf(cluster: ClickCluster, params: AutoZoomParams): ZoomSegment {
  const first = cluster.clicks[0];
  const last = cluster.clicks[cluster.clicks.length - 1];
  const firstT = first?.t ?? 0;
  const lastT = last?.t ?? firstT;

  const bboxW = cluster.maxX - cluster.minX;
  const bboxH = cluster.maxY - cluster.minY;
  const extent = Math.max(bboxW, bboxH);
  const raw = extent > 0 ? params.targetFill / extent : params.amountRange[1];
  const amount = Math.min(params.amountRange[1], Math.max(params.amountRange[0], raw));

  // §6.5 step 5: the centre keys "track the cluster centroid as it drifts", so the
  // centroid is the running one — of the clicks seen so far — rather than the
  // cluster's final one applied retroactively to its first click.
  const centres: { t: Seconds; centre: Vec2 }[] = [];
  let sumX = 0;
  let sumY = 0;
  cluster.clicks.forEach((click, i) => {
    sumX += click.x;
    sumY += click.y;
    const n = i + 1;
    centres.push({
      t: click.t,
      centre: edgeSnap([sumX / n, sumY / n], amount, params.edgeSnapRatio),
    });
  });

  return {
    // Clamped: there is no recording before zero to pre-roll into, and a negative
    // `activeRanges` start would put a crossfade edge where no frame exists.
    start: Math.max(0, firstT - params.preRollSec),
    end: lastT + params.postRollSec,
    holdStart: firstT,
    holdEnd: lastT,
    amount,
    centres,
    clicks: cluster.clicks.length,
  };
}

/**
 * §6.5 step 3, *"Cap's `calculate_follow_center` with `edge_snap_ratio = 0.25`"*.
 *
 * The hard part is the clamp: at magnification `A` the visible viewport is `1/A` wide
 * and its centre must lie inside `[0.5/A, 1 − 0.5/A]`, or the frame shows background.
 * `edgeSnapRatio` is the soft part — within a quarter of the half-viewport of that
 * boundary, the centre is taken **to** the boundary rather than left hovering just
 * inside it, so a click near a corner is framed flush against the edge instead of
 * leaving a sliver of margin that the next click in the cluster then drifts across.
 *
 * Cap's own function is not available to read from here; this is the reading of the
 * ratio that the sentence §6.5 gives it — *"so the zoomed viewport stays inside the
 * frame"* — supports, and it is stated as a reading.
 */
export function edgeSnap(centre: Vec2, amount: number, ratio: number): Vec2 {
  const half = 0.5 / Math.max(1, amount);
  const snapWithin = Math.max(0, ratio) * half;
  return [snapAxis(centre[0], half, snapWithin), snapAxis(centre[1], half, snapWithin)];
}

function snapAxis(value: number, half: number, snapWithin: number): number {
  const lo = half;
  const hi = 1 - half;
  if (lo >= hi) return 0.5;
  if (value <= lo + snapWithin) return lo;
  if (value >= hi - snapWithin) return hi;
  return value;
}

/**
 * §6.5 step 4: merge segments closer than `mergeGapSec`, then drop the short ones.
 *
 * Merging first and dropping second is the order §6.5 lists, and it matters: two
 * 0.7 s segments 0.3 s apart become one 1.7 s segment rather than two discards.
 * A merged segment takes the larger amount — zooming out between two adjacent
 * clusters and straight back in is the pumping this step exists to remove.
 */
export function mergeSegments(
  segments: readonly ZoomSegment[],
  params: AutoZoomParams,
): ZoomSegment[] {
  const merged: ZoomSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && segment.start - previous.end < params.mergeGapSec) {
      previous.end = Math.max(previous.end, segment.end);
      previous.holdEnd = Math.max(previous.holdEnd, segment.holdEnd);
      previous.amount = Math.max(previous.amount, segment.amount);
      previous.centres = [...previous.centres, ...segment.centres];
      previous.clicks += segment.clicks;
      continue;
    }
    merged.push({ ...segment, centres: [...segment.centres] });
  }
  return merged.filter((segment) => segment.end - segment.start >= params.minDurationSec);
}

function buildTrack(init: {
  trackId: string;
  segments: readonly ZoomSegment[];
  params: AutoZoomParams;
  inputs: Record<string, string>;
  generatedAt: IsoTimestamp;
}): Track {
  const { params } = init;
  const amountKeys: Keyframe<number>[] = [];
  const centreKeys: Keyframe<Vec2>[] = [];

  for (const segment of init.segments) {
    // §6.5 step 5: four keys on `amount`, 1 → A → A → 1.
    pushKey(amountKeys, { t: segment.start, v: 1, ease: { kind: 'spring' } });
    pushKey(amountKeys, { t: segment.holdStart, v: segment.amount, ease: { kind: 'spring' } });
    pushKey(amountKeys, { t: segment.holdEnd, v: segment.amount, ease: { kind: 'spring' } });
    pushKey(amountKeys, { t: segment.end, v: 1, ease: { kind: 'spring' } });

    pushKey(centreKeys, { t: segment.start, v: [0.5, 0.5], ease: { kind: 'spring' } });
    for (const { t, centre } of segment.centres) {
      pushKey(centreKeys, { t, v: [centre[0], centre[1]], ease: { kind: 'spring' } });
    }
    pushKey(centreKeys, { t: segment.end, v: [0.5, 0.5], ease: { kind: 'spring' } });
  }

  return {
    id: init.trackId,
    kind: 'transform',
    target: 'zoom',
    domain: 'source',
    origin: 'generated',
    generator: {
      type: 'auto-zoom-on-click',
      params: {
        preRollSec: params.preRollSec,
        postRollSec: params.postRollSec,
        minDurationSec: params.minDurationSec,
        mergeGapSec: params.mergeGapSec,
        clusterBox: [params.clusterBox[0], params.clusterBox[1]],
        targetFill: params.targetFill,
        amountRange: [params.amountRange[0], params.amountRange[1]],
        edgeSnapRatio: params.edgeSnapRatio,
        tension: params.spring.tension,
        mass: params.spring.mass,
        friction: params.spring.friction,
      },
      inputs: { ...init.inputs },
      generatedAt: init.generatedAt,
    },
    blend: 'replace',
    blendMs: params.blendMs,
    // Past the last keyframe by the spring's settling time — see the module header.
    // Overlapping ranges are fine: `windowWeight` takes the maximum over them, so two
    // segments whose tails meet do not dip between them.
    activeRanges: init.segments.map(
      (s) => [s.start, s.end + segmentSettleTailSec(params.spring)] as [Seconds, Seconds],
    ),
    enabled: true,
    channels: {
      amount: {
        keys: amountKeys,
        spring: { ...params.spring },
        // §2.6's own bound on this track. The floor is 1: below it the frame does not
        // fill, and the spring's overshoot at ζ = 0.943 is 0.014% but it is not zero.
        clamp: [1, Math.max(1, params.amountRange[1])],
      },
      center: { keys: centreKeys, spring: { ...params.spring } },
    },
  };
}

/**
 * Append a key, keeping `t` strictly increasing.
 *
 * `validateChannel` refuses a repeated `t` and `precomputeSpring` would apply both at
 * the same 8 ms grid point regardless, so a collision is resolved the way the grid
 * would resolve it: the later key wins. Collisions are ordinary here — a click at the
 * instant a segment starts, two clicks inside one 8 ms window, a merge that lands a
 * hold key on a centre key.
 */
function pushKey<V extends number | Vec2>(keys: Keyframe<V>[], key: Keyframe<V>): void {
  const previous = keys[keys.length - 1];
  if (previous !== undefined && !(key.t > previous.t)) {
    previous.v = key.v;
    return;
  }
  keys.push(key);
}
