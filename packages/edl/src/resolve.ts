/**
 * `resolve` — the one hot-path function.
 *
 * Architecture report §3.6: *"Hot path. No allocation, no locking, no simulation.
 * Called once per rendered frame."* And §3.5, which is the whole of how a generated
 * track and a hand-authored one relate:
 *
 * ```
 * resolve('zoom', t):
 *     value = identity                                     (amount 1.0, center [0.5,0.5])
 *     for track in tracks where target == 'zoom' and enabled, in array order:
 *         w = window(track, t)                             # 0 outside activeRanges,
 *                                                          # crossfading over blendMs at the edges
 *         if w == 0: continue
 *         v = evaluateChannels(track, t)
 *         value = mix(value, blendOp(track.blend, value, v), w)
 *     return value
 * ```
 *
 * `compile` has already turned every one of those words into a number, so what is
 * left here is array walking. Nothing in this file allocates, nothing awaits,
 * nothing integrates: the spring was integrated at compile time on the fixed 8 ms
 * grid and sampling it is an index and a lerp (§3.4). **Integrating at frame rate
 * anywhere — including in a "fast path" for preview — is the one rule §3.4 says not
 * to break**, and it is worth 82.6 px of divergence at 3456 wide.
 *
 * ## Budget
 *
 * §8's frame is 16.67 ms, and `resolve` is measured at **0.08 µs for an identity
 * timeline and ~0.3 µs for a thirty-minute, 3000-key document** — four orders of
 * magnitude under it, and the second figure is the point: the cost does not grow
 * with the recording. Do not reach for the phase-6 gate's CI numbers as the headroom
 * this fits inside; that gate certifies the budget on target hardware, and its CI
 * frame carries a ~30 MB CPU-backed upload no user of this app will ever run.
 * `packages/edl/test/hot-path.test.ts` therefore pins the two properties that would
 * cost a frame — no allocation, and a *ratio* between a long document and a short
 * one measured in the same window — rather than a millisecond from one machine.
 *
 * The costs here are: one binary search over the clip list, and for each enabled
 * track a walk of its `activeRanges` plus one bucket lookup or one grid index per
 * channel it owns. There is no path whose length depends on the length of the
 * recording.
 *
 * ## The returned object is borrowed
 *
 * There is exactly one `ResolvedState` per `CompiledTimeline` and `resolve`
 * overwrites it. That is what "no allocation" costs; `cloneResolvedState` is the
 * way out for a caller that needs to keep one.
 */

import type { Seconds } from '@loom/format';
import { clipIndexAt, sourceTimeAt } from './clips.ts';
import {
  BLEND_ADD,
  BLEND_MULTIPLY,
  DOMAIN_TIMELINE,
  type CompiledMuteLayer,
  type CompiledStack,
  type CompiledTimeline,
} from './compile.ts';
import type { ResolvedState } from './state.ts';

/**
 * §3.5's `window(track, t)`: 0 outside `activeRanges`, crossfading over `blendMs`
 * at the edges.
 *
 * The two ramps are taken as a minimum so a range shorter than two crossfades fades
 * up and straight back down instead of exceeding 1 in the middle, and overlapping
 * ranges take the maximum so a track does not dip in the seam between two of its
 * own ranges.
 *
 * An **empty** `activeRanges` is never active, which is the literal reading of "0
 * outside activeRanges" and the one that lets a track be parked without deleting
 * it. "Always" is written `[[0, 1e9]]`, as in §2.6's reference document.
 */
export function windowWeight(ranges: Float64Array, blendSec: number, t: Seconds): number {
  let best = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i] ?? 0;
    const end = ranges[i + 1] ?? 0;
    if (t < start || t > end) continue;
    if (blendSec <= 0) return 1;
    const up = (t - start) / blendSec;
    const down = (end - t) / blendSec;
    let w = up < down ? up : down;
    if (w > 1) w = 1;
    if (w > best) best = w;
    if (best >= 1) return 1;
  }
  return best;
}

/** True when `t` falls inside one of the flattened `[start, end]` pairs. */
function insideSpan(spans: Float64Array, t: Seconds): boolean {
  for (let i = 0; i + 1 < spans.length; i += 2) {
    if (t >= (spans[i] ?? 0) && t <= (spans[i + 1] ?? 0)) return true;
  }
  return false;
}

function layerTime(layer: { domain: number }, sourceTime: Seconds, timelineTime: Seconds): Seconds {
  return layer.domain === DOMAIN_TIMELINE ? timelineTime : sourceTime;
}

function blendOp(blend: number, base: number, value: number): number {
  if (blend === BLEND_ADD) return base + value;
  if (blend === BLEND_MULTIPLY) return base * value;
  return value;
}

/**
 * Fold one target's stack into `stack.acc`, and record whether anything covered `t`.
 *
 * The per-channel reading of "an opinion": a component no layer names keeps its
 * identity, so a zoom track with only `amount` leaves the centre where the track
 * below it put it. Blending and mixing happen componentwise, which is also what
 * makes the `blendMs` crossfade at the edge of an `activeRange` a crossfade of the
 * value rather than of the whole track.
 */
function foldStack(stack: CompiledStack, sourceTime: Seconds, timelineTime: Seconds): void {
  const acc = stack.acc;
  acc.set(stack.identity);
  stack.covered = false;

  for (const layer of stack.layers) {
    const t = layerTime(layer, sourceTime, timelineTime);
    const w = windowWeight(layer.ranges, layer.blendSec, t);
    if (w <= 0) continue;
    stack.covered = true;

    for (const slot of layer.slots) {
      slot.channel.evaluate(t, stack.scratch);
      for (let c = 0; c < slot.width; c++) {
        const at = slot.offset + c;
        const base = acc[at] ?? 0;
        const blended = blendOp(layer.blend, base, stack.scratch[c] ?? 0);
        acc[at] = base + (blended - base) * w;
      }
    }
  }
}

/** dB → linear. §2.6 stores `gainDb`; §3.6's `ResolvedState.audio` is linear. */
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Resolve one instant. Preview and export both call this and cannot disagree (§3.6).
 *
 * `timelineTime` is clamped into `[0, durationSec]`: a playhead one frame past the
 * end must still produce the last frame's state rather than an extrapolated one.
 */
export function resolve(ct: CompiledTimeline, timelineTime: Seconds): ResolvedState {
  const state = ct.state;
  const duration = ct.durationSec;
  let tt = timelineTime;
  if (!(tt > 0)) tt = 0;
  else if (tt > duration) tt = duration;

  const clipIndex = clipIndexAt(ct.clips, tt);
  const sourceTime = sourceTimeAt(ct.clips, clipIndex, tt);

  state.timelineTime = tt;
  state.sourceTime = sourceTime;
  state.clipIndex = clipIndex;

  // ---- zoom -------------------------------------------------------------
  foldStack(ct.zoom, sourceTime, tt);
  state.zoom.amount = ct.zoom.acc[0] ?? 1;
  state.zoom.center[0] = ct.zoom.acc[1] ?? 0.5;
  state.zoom.center[1] = ct.zoom.acc[2] ?? 0.5;

  // ---- bubble -----------------------------------------------------------
  foldStack(ct.bubble, sourceTime, tt);
  const bubble = state.bubble;
  bubble.center[0] = ct.bubble.acc[0] ?? 0.5;
  bubble.center[1] = ct.bubble.acc[1] ?? 0.5;
  bubble.sizeY = ct.bubble.acc[2] ?? 0;
  bubble.aspect = ct.bubble.acc[3] ?? 1;
  bubble.corner01 = ct.bubble.acc[4] ?? 1;
  bubble.opacity = ct.bubble.acc[5] ?? 0;
  // A channel value, not a flag: §3.3 keeps the bubble's shape as numbers so it can
  // be animated, and `mirror` is stored the same way. Half-way is not a state.
  bubble.mirror = (ct.bubble.acc[6] ?? 0) >= 0.5;
  bubble.visible = ct.bubble.covered && bubble.opacity > 0;

  // ---- cursor -----------------------------------------------------------
  foldStack(ct.cursorStack, sourceTime, tt);
  const stream = ct.cursorStream;
  const cursorIndex = stream === null ? -1 : stream.indexAt(sourceTime);
  if (!ct.cursorStack.covered || stream === null || cursorIndex < 0) {
    // "No cursor here" and "a cursor at (0,0)" are different answers, and phase 5
    // exists so they stay different (§7.3, research trap 2).
    state.cursor = null;
  } else {
    const cursor = (state.cursor ??= { pos: [0, 0], imageId: '', scale: 1, opacity: 1 });
    cursor.pos[0] = stream.xAt(cursorIndex);
    cursor.pos[1] = stream.yAt(cursorIndex);
    cursor.imageId = stream.imageIdAt(cursorIndex);
    cursor.scale = ct.cursorStack.acc[0] ?? 1;
    cursor.opacity = ct.cursorStack.acc[1] ?? 1;
  }

  // ---- annotations ------------------------------------------------------
  const annotations = state.annotations;
  if (annotations.length > 0) annotations.length = 0;
  for (const layer of ct.annotations) {
    const t = layerTime(layer, sourceTime, tt);
    const w = windowWeight(layer.ranges, layer.blendSec, t);
    if (w <= 0) continue;
    for (const span of layer.spans) {
      if (t < span.start || t > span.end) continue;
      for (const channel of span.channels) channel.channel.evaluate(t, channel.out);
      span.resolved.weight = w;
      annotations.push(span.resolved);
    }
  }

  // ---- audio ------------------------------------------------------------
  foldStack(ct.mic, sourceTime, tt);
  foldStack(ct.system, sourceTime, tt);
  state.audio.micGain = gainOf(ct.mic, ct.micMutes, sourceTime, tt);
  state.audio.systemGain = gainOf(ct.system, ct.systemMutes, sourceTime, tt);

  return state;
}

function gainOf(
  stack: CompiledStack,
  mutes: readonly CompiledMuteLayer[],
  sourceTime: Seconds,
  timelineTime: Seconds,
): number {
  for (const mute of mutes) {
    // A mute is a hard zero, not a −∞ dB keyframe: §2.6 models it as a span
    // precisely so it survives every gain edit around it. It is still the owning
    // track's opinion, so §3.5's window gates it exactly as it gates a channel or
    // an annotation span: a track with no weight at `t` has nothing to say there.
    const t = layerTime(mute, sourceTime, timelineTime);
    if (windowWeight(mute.ranges, mute.blendSec, t) <= 0) continue;
    if (insideSpan(mute.spans, t)) return 0;
  }
  return dbToLinear(stack.acc[0] ?? 0);
}
