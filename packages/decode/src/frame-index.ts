/**
 * `DemuxIndex` — the frame index sidecar, in a form the hot path can use.
 *
 * Architecture report §2.4: *"VFR makes this mandatory, not an optimisation."* The
 * sidecar is four parallel arrays (`keyframes`, `pts`, `sizes`, `offsets`) written
 * by main as chunks arrive. This class turns them into typed arrays once and then
 * answers three questions without allocating:
 *
 *  - **Which frame is on screen at time `t`?** `frameAtTime` — the last frame whose
 *    PTS ≤ `t`. §4.2 is explicit that hold-last-frame *is* the correct semantics for
 *    a change-driven source, not a fallback: the scout measured ScreenCaptureKit at
 *    1.4 fps on an idle desktop, so "the last frame that was emitted" is literally
 *    what the screen looked like.
 *  - **Where do I start decoding to reach it?** `keyframeAtOrBefore`.
 *  - **Which bytes are those?** `byteRange` / `spanRange` — §2.4: *"`offsets` lets
 *    the editor seek to a keyframe with a single range request and decode forward,
 *    without parsing the MP4 sample tables at all."*
 *
 * ## Two details that are not incidental
 *
 * **Frame selection is a §4.5 "must be identical" property.** *"Which source frame
 * is selected for a given time"* is on the list of things preview and export may
 * never disagree about. There is therefore exactly one implementation of it — this
 * one — and it compares in integer timescale ticks with a half-tick tolerance
 * rather than in floating-point seconds, so the same `t` always picks the same
 * frame regardless of who asked.
 *
 * **Decode order is not presentation order.** Screen capture through WebCodecs in
 * realtime latency mode has no B-frames, so `pts` is ascending in practice — but an
 * index whose `pts` is not ascending is legal, and a binary search over it would
 * silently return the wrong frame. The constructor detects that once and builds a
 * presentation-order permutation; everything downstream searches that.
 */

import type { FrameIndexDoc, Seconds } from '@loom/format';
import { validateFrameIndexDoc } from '@loom/format';

/** A half-open byte range, `end` exclusive — the shape `fetch` and `subarray` want. */
export interface ByteSpan {
  start: number;
  /** Exclusive. */
  end: number;
}

/** `-1` from a frame lookup means "no frame at or before that time". */
export const NO_FRAME = -1;

/** Half a timescale tick, so a `t` that lands exactly on a PTS picks that frame. */
const TICK_EPSILON = 0.5;

function at(array: Float64Array | Uint32Array, i: number, what: string): number {
  const value = array[i];
  if (value === undefined) {
    throw new RangeError(
      `${what} index ${String(i)} is out of range (length ${String(array.length)})`,
    );
  }
  return value;
}

export interface DemuxIndexInit {
  timescale: number;
  /** Frame numbers (decode order) that are keyframes, ascending. */
  keyframes: ArrayLike<number>;
  /** Presentation timestamp per frame in `timescale` units, decode order. */
  pts: ArrayLike<number>;
  /** Byte size per frame, decode order. */
  sizes: ArrayLike<number>;
  /** Byte offset of each frame within the media part, decode order. */
  offsets: ArrayLike<number>;
}

export class DemuxIndex {
  readonly timescale: number;
  readonly frameCount: number;

  /** `pts` in timescale units, decode order. */
  readonly #pts: Float64Array;
  readonly #sizes: Float64Array;
  readonly #offsets: Float64Array;
  readonly #keyframes: Uint32Array;
  /** `true` at frame `i` when `i` is a keyframe — O(1) instead of a search. */
  readonly #isKey: Uint8Array;
  /**
   * Frame numbers sorted by PTS. Identical to `[0..n)` for the ordinary ascending
   * case, in which lookups are a plain binary search over `#pts`.
   */
  readonly #presentation: Uint32Array;
  readonly #ptsAscending: boolean;

  constructor(init: DemuxIndexInit) {
    const { timescale } = init;
    if (!Number.isFinite(timescale) || timescale <= 0) {
      throw new RangeError(`timescale must be positive, got ${String(timescale)}`);
    }
    const n = init.pts.length;
    if (init.sizes.length !== n || init.offsets.length !== n) {
      throw new RangeError(
        `pts, sizes and offsets must be parallel (got ${String(n)}, ` +
          `${String(init.sizes.length)}, ${String(init.offsets.length)})`,
      );
    }

    this.timescale = timescale;
    this.frameCount = n;
    this.#pts = Float64Array.from(init.pts);
    this.#sizes = Float64Array.from(init.sizes);
    this.#offsets = Float64Array.from(init.offsets);
    this.#keyframes = Uint32Array.from(init.keyframes);
    this.#isKey = new Uint8Array(n);

    let previousKeyframe = -1;
    for (let k = 0; k < this.#keyframes.length; k++) {
      const frame = at(this.#keyframes, k, 'keyframes');
      if (!Number.isInteger(frame) || frame < 0 || frame >= n) {
        throw new RangeError(
          `keyframe ${String(frame)} is not a frame number in [0, ${String(n)})`,
        );
      }
      if (frame <= previousKeyframe) {
        throw new RangeError(
          `keyframes must be strictly ascending, got ${String(frame)} after ${String(previousKeyframe)}`,
        );
      }
      previousKeyframe = frame;
      this.#isKey[frame] = 1;
    }

    let ascending = true;
    for (let i = 1; i < n; i++) {
      if (at(this.#pts, i, 'pts') < at(this.#pts, i - 1, 'pts')) {
        ascending = false;
        break;
      }
    }
    this.#ptsAscending = ascending;
    this.#presentation = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.#presentation[i] = i;
    if (!ascending) {
      // Stable by construction: ties keep decode order, so a duplicate PTS resolves
      // to the frame that was decoded later, which is the one a player would show.
      const order = Array.from(this.#presentation).sort(
        (a, b) => at(this.#pts, a, 'pts') - at(this.#pts, b, 'pts') || a - b,
      );
      this.#presentation.set(order);
    }
  }

  /**
   * Build from a sidecar document, running the format's validator first.
   *
   * Every read in this app is parse → migrate → validate (§2.7). Migration belongs
   * to the caller that read the bytes; validation is cheap enough to repeat here,
   * and a malformed index is a corrupt recording, not a decode bug.
   */
  static fromDoc(doc: unknown, file?: string): DemuxIndex {
    const result = validateFrameIndexDoc(doc);
    if (!result.ok) {
      const where = file ?? 'frame index';
      throw new Error(
        `${where} is not a valid loom.index document: ` +
          result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      );
    }
    const value: FrameIndexDoc = result.value;
    return new DemuxIndex({
      timescale: value.timescale,
      keyframes: value.keyframes,
      pts: value.pts,
      sizes: value.sizes,
      offsets: value.offsets,
    });
  }

  /** PTS of frame `i` in timescale units. */
  pts(i: number): number {
    return at(this.#pts, i, 'pts');
  }

  /** PTS of frame `i` in seconds. */
  ptsSec(i: number): Seconds {
    return at(this.#pts, i, 'pts') / this.timescale;
  }

  /**
   * PTS of frame `i` in **microseconds**, which is the unit WebCodecs stamps on an
   * `EncodedVideoChunk` and reads back off a `VideoFrame`.
   */
  ptsMicros(i: number): number {
    return Math.round((at(this.#pts, i, 'pts') * 1_000_000) / this.timescale);
  }

  isKeyframe(i: number): boolean {
    return this.#isKey[i] === 1;
  }

  /** First presentable time, or `0` for an empty index. */
  get startSec(): Seconds {
    if (this.frameCount === 0) return 0;
    return this.ptsSec(at(this.#presentation, 0, 'presentation'));
  }

  /**
   * PTS of the last frame, in seconds. This is *not* the part's duration — the last
   * frame is held until the part ends, and `recording.json` carries the real
   * `durationSec` (§2.3). Callers wanting duration should ask the recording.
   */
  get lastPtsSec(): Seconds {
    if (this.frameCount === 0) return 0;
    return this.ptsSec(at(this.#presentation, this.frameCount - 1, 'presentation'));
  }

  /**
   * The frame on screen at `t`: the last frame whose PTS ≤ `t`, or {@link NO_FRAME}
   * when `t` precedes the first frame.
   *
   * Hold-last-frame, per §4.2. Allocation-free, and the single authority on frame
   * selection for both preview and export (§4.5).
   */
  frameAtTime(t: Seconds): number {
    const n = this.frameCount;
    if (n === 0) return NO_FRAME;
    const ticks = t * this.timescale + TICK_EPSILON;

    if (this.#ptsAscending) {
      if (at(this.#pts, 0, 'pts') > ticks) return NO_FRAME;
      let low = 0;
      let high = n - 1;
      while (low < high) {
        const mid = (low + high + 1) >>> 1;
        if (at(this.#pts, mid, 'pts') <= ticks) low = mid;
        else high = mid - 1;
      }
      return low;
    }

    const first = at(this.#presentation, 0, 'presentation');
    if (at(this.#pts, first, 'pts') > ticks) return NO_FRAME;
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (at(this.#pts, at(this.#presentation, mid, 'presentation'), 'pts') <= ticks) low = mid;
      else high = mid - 1;
    }
    return at(this.#presentation, low, 'presentation');
  }

  /**
   * The keyframe at or before frame `i` — where a seek to `i` has to start decoding.
   *
   * Returns {@link NO_FRAME} when the index declares no keyframe at or before `i`,
   * which means the part cannot be decoded from that point and the caller must say
   * so rather than feed the decoder garbage.
   */
  keyframeAtOrBefore(i: number): number {
    const keys = this.#keyframes;
    if (keys.length === 0 || i < 0) return NO_FRAME;
    if (at(keys, 0, 'keyframes') > i) return NO_FRAME;
    let low = 0;
    let high = keys.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (at(keys, mid, 'keyframes') <= i) low = mid;
      else high = mid - 1;
    }
    return at(keys, low, 'keyframes');
  }

  /** Bytes of frame `i` within its media part. */
  byteRange(i: number): ByteSpan {
    const start = at(this.#offsets, i, 'offsets');
    return { start, end: start + at(this.#sizes, i, 'sizes') };
  }

  /**
   * One byte range covering frames `from..to` inclusive.
   *
   * Coalescing turns "decode forward from a keyframe" into a single range request.
   * It does not assume the frames are contiguous on disk or even ordered by offset:
   * it takes the hull, and {@link isContiguous} says whether the hull is exactly the
   * frames and nothing else.
   */
  spanRange(from: number, to: number): ByteSpan {
    if (to < from) throw new RangeError(`empty span ${String(from)}..${String(to)}`);
    let start = Infinity;
    let end = -Infinity;
    for (let i = from; i <= to; i++) {
      const offset = at(this.#offsets, i, 'offsets');
      if (offset < start) start = offset;
      const tail = offset + at(this.#sizes, i, 'sizes');
      if (tail > end) end = tail;
    }
    return { start, end };
  }

  /** True when frames `from..to` are laid out back to back with no padding. */
  isContiguous(from: number, to: number): boolean {
    for (let i = from; i < to; i++) {
      if (
        at(this.#offsets, i, 'offsets') + at(this.#sizes, i, 'sizes') !==
        at(this.#offsets, i + 1, 'offsets')
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * The largest `to` in `from..limit` whose coalesced range stays within `maxBytes`.
   *
   * Always returns at least `from`: one frame larger than the budget is still read,
   * because refusing to read it would stall decode forever.
   */
  runWithin(from: number, limit: number, maxBytes: number): number {
    let to = from;
    while (to < limit) {
      const span = this.spanRange(from, to + 1);
      if (span.end - span.start > maxBytes) break;
      to += 1;
    }
    return to;
  }
}
