/**
 * Compiled channels — the two ways a channel is evaluated, and nothing else.
 *
 * Architecture report §3.4:
 *
 * > A channel is evaluated one of two ways, and **mixing them within a channel is a
 * > validation error**.
 * >
 * > **Curve channels** (`hold`, `linear`, `cubic`) are evaluated pointwise,
 * > `O(log n)` by binary search, no state. The ease on the *outgoing* keyframe
 * > governs the segment.
 * >
 * > **Spring channels** … are integrated over the whole channel on a fixed 8 ms
 * > grid at compile time, and sampling is an index + lerp.
 *
 * Both evaluators write into a caller-owned `Float64Array` and allocate nothing,
 * because §3.6 calls `resolve` — which calls these — *"the one hot-path function …
 * no allocation, no locking, no simulation"*.
 *
 * ## `curveIndex`, and why a binary search was not enough
 *
 * §3.6 declares `curveIndex: Map<string, Uint32Array>` — *"binary-search
 * acceleration"*. It is a uniform bucket table over the channel's time span:
 * bucket *b* holds the index of the last key at or before that bucket's start, so
 * a lookup is one multiply, one floor, one array read and a scan bounded by the
 * keys in that bucket. With as many buckets as keys the expected scan is O(1) and
 * there is no loop whose length depends on the size of the project — which is what
 * a thirty-minute channel with two thousand generated keys needs from the function
 * that runs sixty times a second.
 */

import type { Channel, Ease, Keyframe, SpringParams } from '@loom/format';
import { cubicBezierEase } from './bezier.ts';
import {
  MAX_SPRING_TABLE_SEC,
  precomputeSpring,
  readKeyValue,
  springTableEndSec,
  SPRING_GRID_SEC,
  type SpringTable,
} from './spring.ts';

export class ChannelCompileError extends Error {
  readonly channelKey: string;
  constructor(channelKey: string, message: string) {
    super(`${channelKey}: ${message}`);
    this.name = 'ChannelCompileError';
    this.channelKey = channelKey;
  }
}

export type ChannelKind = 'curve' | 'spring';

/** What a compiled channel offers the hot path. */
export interface CompiledChannel {
  /** `<trackId>.<name>`, or `<trackId>#<spanId>.<name>` for a span's channel. */
  readonly key: string;
  /** Components per sample: 1 for a scalar, 2 for a `center`, n for anything else. */
  readonly width: number;
  readonly kind: ChannelKind;
  /** Writes `width` components into `out`. Allocates nothing. */
  evaluate(t: number, out: Float64Array): void;
}

const EASE_HOLD = 0;
const EASE_LINEAR = 1;
const EASE_CUBIC = 2;

function easeCode(ease: Ease | undefined): number {
  switch (ease?.kind) {
    case 'linear':
      return EASE_LINEAR;
    case 'cubic':
      return EASE_CUBIC;
    default:
      // `hold` and a missing ease both hold. A key with `ease: {kind:'spring'}` never
      // reaches here: a channel with one spring key is a spring channel entire.
      return EASE_HOLD;
  }
}

/**
 * How wide a channel is, from its keys.
 *
 * The widest key wins, so a channel whose first key was written as a scalar and
 * whose second is a pair still evaluates as a pair rather than silently dropping a
 * component. Missing components read as 0.
 */
export function channelWidth(keys: readonly Keyframe[]): number {
  let width = 1;
  for (const key of keys) {
    if (Array.isArray(key.v)) width = Math.max(width, key.v.length);
  }
  return width;
}

/**
 * Which evaluator a channel uses — and the refusal when it asks for both.
 *
 * `packages/format`'s validator states the same rule over a document read from
 * disk. It is restated here because `compile` is also handed documents that never
 * touched a disk (a generator's output, a test fixture), and §3.4's rule is about
 * what the two evaluators would disagree by — 82.6 px — not about where the
 * document came from.
 */
export function classifyChannel(channelKey: string, channel: Channel): ChannelKind | null {
  let spring = 0;
  let curve = 0;
  for (const key of channel.keys) {
    if (key.ease.kind === 'spring') spring++;
    else curve++;
  }
  if (spring > 0 && curve > 0) {
    throw new ChannelCompileError(
      channelKey,
      `channel mixes spring and curve easings (${spring} spring, ${curve} curve); ` +
        'a channel must be entirely one or the other (architecture report §3.4)',
    );
  }
  if (spring === 0 && curve === 0) return null;
  if (spring > 0) {
    if (channel.spring === undefined) {
      throw new ChannelCompileError(channelKey, 'a spring channel must carry spring parameters');
    }
    return 'spring';
  }
  return 'curve';
}

/** Pointwise `hold` / `linear` / `cubic`, with §3.6's bucket index. */
export class CurveChannel implements CompiledChannel {
  readonly key: string;
  readonly width: number;
  readonly kind = 'curve' as const;

  /** §3.6's `curveIndex` entry for this channel. */
  readonly buckets: Uint32Array;

  readonly #times: Float64Array;
  readonly #values: Float64Array;
  readonly #eases: Uint8Array;
  /** Four control-point coordinates per key; only read for `cubic`. */
  readonly #bezier: Float64Array;
  readonly #count: number;
  readonly #bucketStep: number;
  readonly #clampLo: number;
  readonly #clampHi: number;

  constructor(key: string, keys: readonly Keyframe[], clamp: readonly [number, number] | null) {
    const count = keys.length;
    this.key = key;
    this.#count = count;
    this.width = channelWidth(keys);
    this.#times = new Float64Array(count);
    this.#values = new Float64Array(count * this.width);
    this.#eases = new Uint8Array(count);
    this.#bezier = new Float64Array(count * 4);
    this.#clampLo = clamp?.[0] ?? Number.NEGATIVE_INFINITY;
    this.#clampHi = clamp?.[1] ?? Number.POSITIVE_INFINITY;

    const scratch = new Float64Array(this.width);
    for (let i = 0; i < count; i++) {
      const k = keys[i];
      if (k === undefined) continue;
      this.#times[i] = k.t;
      readKeyValue(k.v, this.width, scratch);
      this.#values.set(scratch, i * this.width);
      this.#eases[i] = easeCode(k.ease);
      if (k.ease.kind === 'cubic') {
        this.#bezier[i * 4 + 0] = k.ease.p1[0];
        this.#bezier[i * 4 + 1] = k.ease.p1[1];
        this.#bezier[i * 4 + 2] = k.ease.p2[0];
        this.#bezier[i * 4 + 3] = k.ease.p2[1];
      }
    }

    // One bucket per key: the expected scan is a single comparison, and a channel
    // whose keys cluster (a click burst) still costs only the keys in its bucket.
    const bucketCount = Math.max(1, count);
    const first = this.#times[0] ?? 0;
    const last = this.#times[count - 1] ?? first;
    const span = last - first;
    this.#bucketStep = span > 0 ? span / bucketCount : 0;
    this.buckets = new Uint32Array(bucketCount);
    if (this.#bucketStep > 0) {
      let at = 0;
      for (let b = 0; b < bucketCount; b++) {
        const edge = first + b * this.#bucketStep;
        while (at + 1 < count && (this.#times[at + 1] ?? Infinity) <= edge) at++;
        this.buckets[b] = at;
      }
    }
  }

  evaluate(t: number, out: Float64Array): void {
    const count = this.#count;
    const width = this.width;
    if (count === 0) {
      for (let c = 0; c < width; c++) out[c] = 0;
      return;
    }

    const first = this.#times[0] ?? 0;
    if (t <= first) {
      this.#emit(0, out);
      return;
    }
    const last = this.#times[count - 1] ?? first;
    if (t >= last) {
      this.#emit(count - 1, out);
      return;
    }

    // Bucket, then a short forward scan. Never a loop over the whole channel.
    let i = 0;
    if (this.#bucketStep > 0) {
      const b = Math.floor((t - first) / this.#bucketStep);
      i = this.buckets[b < 0 ? 0 : b >= this.buckets.length ? this.buckets.length - 1 : b] ?? 0;
    }
    while (i + 1 < count && (this.#times[i + 1] ?? Infinity) <= t) i++;

    const t0 = this.#times[i] ?? 0;
    const t1 = this.#times[i + 1] ?? t0;
    const span = t1 - t0;
    const raw = span > 0 ? (t - t0) / span : 0;

    const ease = this.#eases[i];
    if (ease === EASE_HOLD) {
      this.#emit(i, out);
      return;
    }
    let u = raw;
    if (ease === EASE_CUBIC) {
      const b = i * 4;
      u = cubicBezierEase(
        raw,
        this.#bezier[b + 0] ?? 0,
        this.#bezier[b + 1] ?? 0,
        this.#bezier[b + 2] ?? 0,
        this.#bezier[b + 3] ?? 0,
      );
    }

    const a = i * width;
    const z = (i + 1) * width;
    for (let c = 0; c < width; c++) {
      const v0 = this.#values[a + c] ?? 0;
      const v1 = this.#values[z + c] ?? 0;
      out[c] = this.#clamp(v0 + (v1 - v0) * u);
    }
  }

  #emit(index: number, out: Float64Array): void {
    const base = index * this.width;
    for (let c = 0; c < this.width; c++) out[c] = this.#clamp(this.#values[base + c] ?? 0);
  }

  #clamp(value: number): number {
    return value < this.#clampLo ? this.#clampLo : value > this.#clampHi ? this.#clampHi : value;
  }
}

/** A fixed-8 ms-grid table. Sampling is an index and a lerp, per §3.4. */
export class SpringChannel implements CompiledChannel {
  readonly key: string;
  readonly width: number;
  readonly kind = 'spring' as const;

  /** §3.6's `springSamples` entry for this channel. */
  readonly samples: Float32Array;

  readonly #count: number;

  constructor(
    key: string,
    keys: readonly Keyframe[],
    params: SpringParams,
    clamp: readonly [number, number] | null,
  ) {
    // The grid runs from zero to the last key, so the last key sizes the
    // allocation. Nothing upstream bounds a keyframe `t`; refusing the channel by
    // name is what keeps one bad number a typed error rather than a gigabyte or a
    // `RangeError` out of `compile`.
    const endSec = springTableEndSec(keys, params);
    if (!(endSec <= MAX_SPRING_TABLE_SEC)) {
      throw new ChannelCompileError(
        key,
        `its last keyframe puts the spring grid at ${String(endSec)} s, past the ` +
          `${String(MAX_SPRING_TABLE_SEC)} s ceiling; a keyframe time this far out is a ` +
          'unit slip or a hand-edited document, not a recording',
      );
    }
    const table: SpringTable = precomputeSpring(keys, channelWidth(keys), params, clamp);
    this.key = key;
    this.width = table.width;
    this.samples = table.samples;
    this.#count = table.count;
  }

  evaluate(t: number, out: Float64Array): void {
    const width = this.width;
    const count = this.#count;
    if (count === 0) {
      for (let c = 0; c < width; c++) out[c] = 0;
      return;
    }
    if (t <= 0) {
      for (let c = 0; c < width; c++) out[c] = this.samples[c] ?? 0;
      return;
    }
    const scaled = t / SPRING_GRID_SEC;
    const index = Math.floor(scaled);
    if (index >= count - 1) {
      const base = (count - 1) * width;
      for (let c = 0; c < width; c++) out[c] = this.samples[base + c] ?? 0;
      return;
    }
    const frac = scaled - index;
    const a = index * width;
    const b = a + width;
    for (let c = 0; c < width; c++) {
      const v0 = this.samples[a + c] ?? 0;
      const v1 = this.samples[b + c] ?? 0;
      out[c] = v0 + (v1 - v0) * frac;
    }
  }
}

/**
 * Compile one channel, or `null` when it has no keys and therefore no opinion.
 *
 * An empty channel is a normal state — `key.remove` of the last key leaves one —
 * and it must resolve to "this track says nothing about this property" rather than
 * to zero.
 */
export function compileChannel(key: string, channel: Channel): CompiledChannel | null {
  const kind = classifyChannel(key, channel);
  if (kind === null) return null;
  const clamp = channel.clamp ?? null;
  if (kind === 'spring') {
    const spring = channel.spring;
    // `classifyChannel` has already refused this; narrowing it again here is what
    // keeps the constructor's parameter honestly non-optional.
    if (spring === undefined) {
      throw new ChannelCompileError(key, 'a spring channel must carry spring parameters');
    }
    return new SpringChannel(key, channel.keys, spring, clamp);
  }
  return new CurveChannel(key, channel.keys, clamp);
}
