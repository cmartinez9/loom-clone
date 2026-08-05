/**
 * `SourceReader` — the one decode path.
 *
 * Architecture report §4.2 declares the shape and this file implements it:
 *
 * ```ts
 * export class SourceReader {
 *   constructor(url: string, index: DemuxIndex, config: VideoDecoderConfig);
 *   prime(t: Seconds, aheadSec: number): Promise<void>;
 *   frameAt(t: Seconds): VideoFrame | null;   // borrowed, not owned
 *   release(beforeT: Seconds): void;
 *   close(): void;
 * }
 * ```
 *
 * The constructor takes a {@link SourceReaderInit} rather than a bare `url` for one
 * reason, spelled out because it is a cross-phase contract:
 *
 * ## The frame-input interface
 *
 * Everything this package needs from a captured media part is exactly three things:
 *
 *  1. a {@link ByteRangeReader} over the part's bytes,
 *  2. a {@link DemuxIndex} built from that part's `loom.index/1` sidecar (§2.4), and
 *  3. a `VideoDecoderConfig` — codec string, coded size, and the codec description
 *     (the `avcC` record) when the bitstream is length-prefixed rather than
 *     Annex-B.
 *
 * Nothing else. Not a file layout, not a segment naming convention, not a timing
 * source, not a container. §2.4 is what makes that possible: the index carries a
 * byte offset per frame, so seeking is a range request and decoding forward never
 * touches an MP4 sample table.
 *
 * The capture spine (phase 1) already produces (1) and (2) by definition — they are
 * the declared bundle contents — and already holds (3): §1.4's `MetaMsg` carries
 * `decoderConfig: VideoDecoderConfig` from the capture renderer to main at the
 * moment the encoder emits it. Wiring phase 1's output to this reader is therefore
 * an adapter that supplies those three values. It requires nothing from inside this
 * class. **The one thing an adapter must decide** is where the `description` comes
 * from once the app is restarted and `MetaMsg` is long gone: persist it beside the
 * part, or read it out of the container. That is a capture-side choice; this reader
 * takes whichever config it is handed.
 *
 * ## Lifetimes
 *
 * Every frame this class ever holds is owned by its {@link FrameRing}. The decoder
 * output callback either hands the frame to the ring (which takes ownership and
 * closes what it evicts) or closes it immediately. There is no third branch, on any
 * path, including cancellation and error — §10.2.
 */

import type { Seconds } from '@loom/format';
import type { ByteRangeReader } from './byte-source.ts';
import { NO_FRAME, type DemuxIndex } from './frame-index.ts';
import { DEFAULT_RING_CAPACITY, FrameRing } from './frame-ring.ts';
import { closeQuietly, type ClosableFrame } from './frames.ts';
import { webCodecsDecoderFactory, type DecoderFactory, type VideoDecoderLike } from './decoder.ts';

/** Lookahead target, architecture report §4.2. */
export const DEFAULT_LOOKAHEAD_SEC = 0.5;

/** One range request per keyframe run; 8 MB comfortably covers a 4K GOP. */
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Consecutive decoder errors tolerated before `prime` starts reporting them.
 *
 * A `VideoDecoder` that errors is closed by the platform. Rebuilding it and seeking
 * again recovers from a transient failure, which is worth doing — but retrying
 * forever turns a broken file into a spinner, and §10.2 is explicit that a clear
 * error beats a spinner.
 */
const MAX_DECODER_ERRORS = 8;

/**
 * How long `prime` waits for outputs it is still expecting.
 *
 * Not a correctness bound — it is the difference between "resolves late" and
 * "never resolves" when a decoder stops emitting, which §10.2 says is the single
 * most likely way this app hangs.
 */
const SETTLE_DEADLINE_MS = 2000;

/** Longest single wait between output checks inside a settle. */
const OUTPUT_POLL_MS = 250;

export interface SourceReaderInit<T extends ClosableFrame = VideoFrame> {
  bytes: ByteRangeReader;
  index: DemuxIndex;
  config: VideoDecoderConfig;
  /** Frames per source. Defaults to §4.2's 20. */
  ringCapacity?: number;
  /** Defaults to the real `VideoDecoder`. See `decoder.ts` for why this exists. */
  decoderFactory?: DecoderFactory<T>;
  maxReadBytes?: number;
}

export interface SourceReaderStats {
  /** Frames handed to the ring. */
  decoded: number;
  /** Frames closed on arrival because they precede the requested time. */
  discarded: number;
  /** Chunks submitted to the decoder. */
  submitted: number;
  seeks: number;
  /** `frameAt` calls that found a frame. */
  hits: number;
  /** `frameAt` calls that did not — the preview loop holds the previous frame. */
  misses: number;
  bytesRead: number;
  decoderErrors: number;
  /** Frames alive right now. Never exceeds `ringCapacity` (§4.2, §10.2). */
  live: number;
  /** High-water mark of `live`. */
  peakLive: number;
  ringCapacity: number;
}

export class SourceReader<T extends ClosableFrame = VideoFrame> {
  readonly index: DemuxIndex;

  readonly #bytes: ByteRangeReader;
  readonly #config: VideoDecoderConfig;
  readonly #ring: FrameRing<T>;
  readonly #decoderFactory: DecoderFactory<T>;
  readonly #maxReadBytes: number;

  #decoder: VideoDecoderLike | null = null;
  /** Decode-order frames submitted so far are `[#submittedFrom, #nextFrame)`. */
  #submittedFrom = 0;
  #nextFrame = 0;
  /** Outputs older than this are the tail of a seek and get closed on arrival. */
  #acceptFromMicros = Number.NEGATIVE_INFINITY;
  /**
   * PTS of the newest chunk submitted since the decoder was last reset, or
   * `-Infinity` when nothing has been. An output past it cannot be one of ours.
   */
  #acceptThroughMicros = Number.NEGATIVE_INFINITY;

  /** Bumped by every `prime` and every `close`; stale work checks it and stops. */
  #generation = 0;
  #abort: AbortController | null = null;
  #inflight: Promise<void> | null = null;

  #closed = false;
  #consecutiveDecoderErrors = 0;
  #pendingError: Error | null = null;
  /** Chunks submitted, and outputs seen, since the decoder was last reset. */
  #submissions = 0;
  #outputs = 0;
  readonly #outputWaiters: (() => void)[] = [];

  #stats = {
    decoded: 0,
    discarded: 0,
    submitted: 0,
    seeks: 0,
    hits: 0,
    misses: 0,
    bytesRead: 0,
    decoderErrors: 0,
  };

  constructor(init: SourceReaderInit<T>) {
    this.index = init.index;
    this.#bytes = init.bytes;
    this.#config = init.config;
    this.#ring = new FrameRing<T>(init.ringCapacity ?? DEFAULT_RING_CAPACITY);
    // Omitting `decoderFactory` pins `T` to its default, `VideoFrame`; the compiler
    // cannot see that from inside the generic, so the cast says it instead.
    this.#decoderFactory =
      init.decoderFactory ?? (webCodecsDecoderFactory as unknown as DecoderFactory<T>);
    this.#maxReadBytes = init.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  get ring(): FrameRing<T> {
    return this.#ring;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Frames alive right now.
   *
   * A bare integer read, not the `stats` object, because the preview loop samples
   * it every frame and §4.3's first anti-stutter rule is that nothing allocates in
   * the loop.
   */
  get liveFrames(): number {
    return this.#ring.ledger.live;
  }

  get ringCapacity(): number {
    return this.#ring.capacity;
  }

  get stats(): Readonly<SourceReaderStats> {
    return {
      ...this.#stats,
      live: this.#ring.ledger.live,
      peakLive: this.#ring.ledger.peak,
      ringCapacity: this.#ring.capacity,
    };
  }

  /**
   * The frame on screen at `t`, **borrowed — do not close it**.
   *
   * Never decodes, never blocks, never allocates. A `null` means decode has not
   * caught up; §4.3 says hold the previous frame and count it, which is what the
   * `misses` counter is for.
   */
  frameAt(t: Seconds): T | null {
    const frame = this.#ring.frameAtMicros(this.#selectionMicros(t));
    if (frame === null) this.#stats.misses += 1;
    else this.#stats.hits += 1;
    return frame;
  }

  /** Close every frame the ring holds strictly before the one covering `beforeT`. */
  release(beforeT: Seconds): void {
    this.#ring.releaseBeforeMicros(this.#selectionMicros(beforeT));
  }

  /**
   * The timestamp, in microseconds, of the frame the **index** puts on screen at
   * `t` — `-Infinity` when `t` precedes the first frame.
   *
   * Every time-to-frame question this class asks goes through here, because §4.5
   * puts frame selection on the list preview and export may never disagree about
   * and `DemuxIndex.frameAtTime` is its one implementation. The ring is then asked
   * for a frame by timestamp rather than being handed a time to search for itself.
   */
  #selectionMicros(t: Seconds): number {
    const frame = this.index.frameAtTime(t);
    return frame === NO_FRAME ? Number.NEGATIVE_INFINITY : this.index.ptsMicros(frame);
  }

  /**
   * Whether the *source* has a frame at `t` at all, regardless of what is decoded.
   *
   * The preview loop's stall watchdog needs this. A screen track legitimately
   * produces no new frames for many seconds — the scout measured 1.4 fps on an idle
   * desktop (§4.2) — so "no new frame lately" is not evidence of a stall. "The index
   * says there is a frame here and decode still has not produced it" is.
   */
  hasSourceFrameAt(t: Seconds): boolean {
    return this.index.frameAtTime(t) !== NO_FRAME;
  }

  /**
   * Ensure frames covering `[t, t + aheadSec]` are decoded into the ring.
   *
   * **Cancelable** (§4.3): a later `prime` supersedes an earlier one — the in-flight
   * byte read is aborted, the decoder is reset if the new target needs a seek, and
   * the superseded call resolves rather than rejecting. It rejects only for a real
   * failure: an unreadable range, an index with no keyframe to start from, or a
   * decoder that will not recover.
   *
   * Callers on the render path use `void reader.prime(t, 0.5).catch(report)` — the
   * loop must never await this.
   */
  prime(t: Seconds, aheadSec: number = DEFAULT_LOOKAHEAD_SEC): Promise<void> {
    if (this.#closed) return Promise.resolve();
    // The preview loop primes on every rendered frame — sixty times a second. If
    // everything the new call would ask for has already been asked for, superseding
    // the in-flight one would abort its byte read and, worse, re-seek and throw away
    // the frames it is in the middle of decoding. Ride along with it instead.
    if (this.#alreadyRequested(t, aheadSec)) return this.#inflight ?? Promise.resolve();
    const generation = ++this.#generation;
    this.#abort?.abort(new SupersededError());

    const previous = this.#inflight;
    const run = (async (): Promise<void> => {
      if (previous !== null) {
        try {
          await previous;
        } catch {
          // A superseded prime's failure belongs to whoever called it, not to us.
        }
      }
      if (generation !== this.#generation || this.#closed) return;
      await this.#run(generation, t, aheadSec);
    })();

    this.#inflight = run;
    return run;
  }

  /**
   * Close the decoder and every frame. Idempotent.
   *
   * In-flight priming stops at its next generation check; its byte read is aborted
   * and any output that still arrives is closed by the output callback's closed
   * check.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#acceptThroughMicros = Number.NEGATIVE_INFINITY;
    this.#abort?.abort(new SupersededError());
    this.#abort = null;
    const decoder = this.#decoder;
    this.#decoder = null;
    if (decoder !== null) {
      try {
        decoder.close();
      } catch {
        // Already closed by an error callback; the frames are what matter.
      }
    }
    this.#ring.close();
    this.#wake();
  }

  // ---------------------------------------------------------------- internals

  async #run(generation: number, t: Seconds, aheadSec: number): Promise<void> {
    const index = this.index;
    if (index.frameCount === 0) return;
    this.#raiseIfFatal();

    const { first, last } = this.#requestRange(t, aheadSec);

    const controller = new AbortController();
    this.#abort = controller;
    const { signal } = controller;

    if (this.#needsSeek(index, first, t)) {
      const keyframe = index.keyframeAtOrBefore(first);
      if (keyframe === NO_FRAME) {
        throw new Error(
          `frame ${String(first)} has no keyframe at or before it; the index cannot be decoded from there`,
        );
      }
      this.#seekTo(keyframe);
    }
    this.#acceptFromMicros = index.ptsMicros(first);

    while (this.#nextFrame <= last) {
      if (this.#superseded(generation, signal)) return;

      const from = this.#nextFrame;
      const to = index.runWithin(from, last, this.#maxReadBytes);
      const span = index.spanRange(from, to);

      let bytes: Uint8Array;
      try {
        bytes = await this.#bytes.read(span.start, span.end, signal);
      } catch (error) {
        if (this.#superseded(generation, signal)) return;
        throw error instanceof Error ? error : new Error(String(error));
      }
      if (this.#superseded(generation, signal)) return;

      if (this.#decoder?.state !== 'configured') return;
      const decoder = this.#decoder;
      this.#stats.bytesRead += bytes.byteLength;

      for (let i = from; i <= to; i++) {
        const range = index.byteRange(i);
        const micros = index.ptsMicros(i);
        // Raised *before* the submit, because a decoder may answer synchronously.
        if (micros > this.#acceptThroughMicros) this.#acceptThroughMicros = micros;
        decoder.decode({
          type: index.isKeyframe(i) ? 'key' : 'delta',
          timestamp: micros,
          duration: null,
          data: bytes.subarray(range.start - span.start, range.end - span.start),
        });
        this.#stats.submitted += 1;
        this.#submissions += 1;
      }
      this.#nextFrame = to + 1;
    }

    await this.#settle(generation, signal, last);
  }

  /**
   * Wait for what has been submitted to reach the ring, so `prime` is a promise
   * worth awaiting in a test and in the exporter.
   *
   * **Not `flush()`.** Chromium requires a keyframe as the first chunk after
   * `configure()` *and after every `flush()`*, so flushing to learn that outputs had
   * landed would force a re-seek and a whole re-decoded GOP on the very next frame
   * of forward playback (`decoder.ts` says more). Waiting on the output callback
   * costs nothing and does not disturb the decoder.
   *
   * Two exits besides supersession, and both are deliberate: the ring covering the
   * requested range is the real goal, and the decoder having emitted everything it
   * was given is the honest end of the road when it will emit no more. The deadline
   * exists so that a decoder which silently stops — §10.2's exact failure — makes
   * `prime` resolve late rather than never; the loop's watchdog is what turns a
   * persistent version of that into a visible error.
   */
  async #settle(generation: number, signal: AbortSignal, lastFrame: number): Promise<void> {
    const targetMicros = this.index.ptsMicros(lastFrame);
    const deadline = Date.now() + SETTLE_DEADLINE_MS;
    for (;;) {
      if (this.#superseded(generation, signal)) return;
      this.#raiseIfFatal();
      // A decoder that errored was torn down by `#onDecoderError`. Nothing more is
      // coming, so waiting out the deadline would only make a recoverable failure
      // feel like a hang.
      if (this.#decoder?.state !== 'configured') return;
      const newest = this.#ring.newestMicros;
      if (newest !== null && newest + 0.5 >= targetMicros) return;
      if (this.#outputs >= this.#submissions) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await this.#waitForOutput(Math.min(remaining, OUTPUT_POLL_MS));
    }
  }

  /** Resolve on the next decoder output, or after `timeoutMs`, whichever is first. */
  #waitForOutput(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.#outputWaiters.push(finish);
    });
  }

  /** Wake everything waiting on an output — on arrival, on error and on teardown. */
  #wake(): void {
    if (this.#outputWaiters.length === 0) return;
    for (const waiter of this.#outputWaiters.splice(0)) waiter();
  }

  /**
   * Surface a recorded decoder error once retrying has stopped being reasonable.
   *
   * Below the limit the error is left recorded and swallowed: the next prime sees a
   * torn-down decoder, rebuilds it and seeks, which is what recovers from a
   * transient failure. At the limit the file is broken and §10.2 is explicit that a
   * clear error beats a spinner.
   */
  #raiseIfFatal(): void {
    const pending = this.#pendingError;
    if (pending === null) return;
    if (this.#consecutiveDecoderErrors < MAX_DECODER_ERRORS) return;
    this.#pendingError = null;
    throw pending;
  }

  #superseded(generation: number, signal: AbortSignal): boolean {
    return this.#closed || generation !== this.#generation || signal.aborted;
  }

  /**
   * Whether reaching `first` means resetting the decoder and starting at a keyframe.
   *
   * Four reasons, and each is a real case:
   *  - there is no configured decoder yet (first prime, or one that errored);
   *  - the target is behind everything we have submitted — scrubbing backwards;
   *  - the ring no longer holds `t` even though we decoded past it — the frame was
   *    evicted or released and cannot be recovered by decoding forward;
   *  - the keyframe the target needs is ahead of where we stopped — a long forward
   *    jump, where seeking is strictly cheaper than decoding through the gap.
   */
  #needsSeek(index: DemuxIndex, first: number, t: Seconds): boolean {
    if (this.#decoder?.state !== 'configured') return true;
    if (first < this.#submittedFrom) return true;
    if (index.keyframeAtOrBefore(first) > this.#nextFrame) return true;
    if (first >= this.#nextFrame || this.#ring.frameAtMicros(this.#selectionMicros(t)) !== null) {
      return false;
    }

    // Submitted past `t` and the ring does not hold it. Two very different reasons,
    // and treating them alike is expensive in both directions: re-seeking while the
    // decode is merely in flight throws away work that was about to arrive (and, at
    // sixty primes a second, never lets any of it arrive), while waiting on a frame
    // that has already been evicted hangs the preview on it forever.
    const oldest = this.#ring.oldestMicros;
    if (oldest !== null && oldest > index.ptsMicros(first)) return true;
    return this.#outputs >= this.#submissions;
  }

  /**
   * Whether an in-flight or completed prime has already covered `[t, t + ahead]`.
   *
   * "Requested", not "delivered": the point is to avoid disturbing decode that is
   * already under way for exactly this range, not to claim the frames are ready.
   */
  #alreadyRequested(t: Seconds, aheadSec: number): boolean {
    const index = this.index;
    if (index.frameCount === 0) return true;
    const { first, last } = this.#requestRange(t, aheadSec);
    if (this.#needsSeek(index, first, t)) return false;
    return this.#nextFrame > last;
  }

  /** The decode-order frames a prime at `t` wants, clamped to what the ring can hold. */
  #requestRange(t: Seconds, aheadSec: number): { first: number; last: number } {
    const index = this.index;
    let first = index.frameAtTime(t);
    if (first === NO_FRAME) first = 0;
    let last = index.frameAtTime(t + Math.max(0, aheadSec));
    if (last < first) last = first;
    // Never ask for more frames than the ring can hold. With this clamp the oldest
    // frame the ring can be forced to evict is exactly the one *before* `first`, so
    // the frame covering `t` always survives the fill.
    const ceiling = Math.min(first + this.#ring.capacity - 1, index.frameCount - 1);
    return { first, last: Math.min(last, ceiling) };
  }

  #seekTo(keyframe: number): void {
    // Nothing submitted to the old decoder is wanted any more; until the new run
    // submits its first chunk, every arriving output belongs to the abandoned seek.
    this.#acceptThroughMicros = Number.NEGATIVE_INFINITY;
    const existing = this.#decoder;
    if (existing !== null) {
      try {
        existing.reset();
      } catch {
        // A decoder that will not reset is one we rebuild below.
        this.#decoder = null;
      }
    }
    // Frames from before the seek are unreachable now: the new decode starts at a
    // keyframe and pushes in ascending order, and the ring rejects anything that is
    // not newer than its newest frame.
    this.#ring.clear();
    this.#submissions = 0;
    this.#outputs = 0;
    this.#configure();
    this.#submittedFrom = keyframe;
    this.#nextFrame = keyframe;
    this.#stats.seeks += 1;
    this.#wake();
  }

  #configure(): void {
    let decoder = this.#decoder;
    if (decoder === null || decoder.state === 'closed') {
      decoder = this.#createDecoder();
      this.#decoder = decoder;
    }
    if (decoder.state !== 'configured') {
      // Applied here rather than taken from the caller, and applied the same way
      // for preview and for export. It changes *when* frames come out, never what
      // is in them, so it cannot make the two disagree (§4.5) — and without it a
      // decoder may hold several frames back before emitting, which turns every
      // seek into a visible pause.
      decoder.configure({ ...this.#config, optimizeForLatency: true });
    }
  }

  #createDecoder(): VideoDecoderLike {
    return this.#decoderFactory({
      output: (frame: T) => {
        this.#onFrame(frame);
      },
      error: (error: Error) => {
        this.#onDecoderError(error);
      },
    });
  }

  /**
   * The only place a decoded frame is ever held.
   *
   * Four exits, all of which either transfer ownership to the ring or close the
   * frame here.
   */
  #onFrame(frame: T): void {
    this.#outputs += 1;
    try {
      this.#place(frame);
    } finally {
      // Whatever happened to the frame, something may be waiting to hear about it.
      this.#wake();
    }
  }

  /**
   * A decoder can only emit a frame it was given, so
   * `[#acceptFromMicros, #acceptThroughMicros]` — the seek target, and the newest
   * chunk submitted since the last reset — is exactly the set of timestamps that
   * can legitimately arrive. Anything outside it survived the `reset()` that
   * abandoned it, and pushing one of those would be worse than a leak: the ring
   * takes it as its newest frame and then rejects every correct, older frame
   * decoded behind it, so the preview holds the wrong picture with nothing to say
   * about it (§10.2).
   */
  #place(frame: T): void {
    if (this.#closed) {
      closeQuietly(frame);
      this.#stats.discarded += 1;
      return;
    }
    if (frame.timestamp + 0.5 < this.#acceptFromMicros) {
      // Decoding from a keyframe necessarily produces frames before the seek target
      // (§4.2: "discard outputs with pts < t - epsilon").
      closeQuietly(frame);
      this.#stats.discarded += 1;
      return;
    }
    if (frame.timestamp - 0.5 > this.#acceptThroughMicros) {
      closeQuietly(frame);
      this.#stats.discarded += 1;
      return;
    }
    if (this.#ring.push(frame)) {
      this.#stats.decoded += 1;
      this.#consecutiveDecoderErrors = 0;
      this.#pendingError = null;
    } else {
      this.#stats.discarded += 1;
    }
  }

  #onDecoderError(error: Error): void {
    this.#stats.decoderErrors += 1;
    this.#consecutiveDecoderErrors += 1;
    this.#pendingError = error;
    // The platform closes an errored decoder. Dropping the reference makes the next
    // prime rebuild and seek, which recovers from a transient failure; the counter
    // is what stops that from becoming an infinite retry.
    const decoder = this.#decoder;
    this.#decoder = null;
    this.#acceptThroughMicros = Number.NEGATIVE_INFINITY;
    if (decoder !== null) {
      try {
        decoder.close();
      } catch {
        // Already closed by the platform.
      }
    }
    if (this.#consecutiveDecoderErrors >= MAX_DECODER_ERRORS) {
      this.#ring.clear();
    }
    this.#wake();
  }
}

/** A prime that a later prime replaced. Not a failure; callers see a resolved promise. */
export class SupersededError extends Error {
  override readonly name = 'SupersededError';
  constructor() {
    super('superseded by a newer prime');
  }
}
