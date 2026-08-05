/**
 * Frame ownership, and the ledger that makes leaks fail loudly.
 *
 * Architecture report §10.2 names `VideoFrame` lifetime leaks as one of the three
 * things most likely to sink this project, and says exactly why: *"WebCodecs frames
 * are manually reference-counted. Forget one `close()` in an error path and the
 * decoder's output pool exhausts; it does not throw, it just stops producing
 * frames."* The report's prescription is three rules, and this file is the first
 * two of them:
 *
 *  1. **One owner for every frame.** That owner is {@link FrameRing}. Nothing else
 *     in this package holds a frame across a turn of the event loop.
 *  2. **An assertion that live frame count ≤ ring capacity, tripping on the first
 *     leak rather than the hundredth.** That is {@link FrameLedger}.
 *
 * (The third — a watchdog on the preview and export loops — belongs to the loops,
 * not here.)
 *
 * The ledger is deliberately not a debug-only build flag. It is an integer compare
 * per decoded frame against a budget of ~30 frames a second; the cost is
 * unmeasurable and the alternative is an assertion that is off exactly when a user
 * hits the bug.
 */

/**
 * The part of `VideoFrame` this package actually depends on.
 *
 * Declaring it structurally is what lets the ring and the reader be exercised in a
 * Node test with no WebCodecs implementation present, without any part of the
 * shipping code path being test-only. `SourceReader` is still generic over one
 * decoder and one ring; only the *platform binding* is substitutable.
 */
export interface ClosableFrame {
  /** Presentation timestamp in **microseconds**, as WebCodecs defines it. */
  readonly timestamp: number;
  close(): void;
}

/** Thrown by {@link FrameLedger.acquire} the first time live frames exceed the cap. */
export class FrameLeakError extends Error {
  override readonly name = 'FrameLeakError';
  constructor(
    readonly live: number,
    readonly capacity: number,
  ) {
    super(
      `live VideoFrame count ${String(live)} exceeded the ring cap ${String(capacity)}; ` +
        'a frame was acquired without a matching close (architecture report §10.2)',
    );
  }
}

/**
 * Counts frames this process owns, and refuses to let the count exceed the cap.
 *
 * Every `acquire()` must be paired with exactly one `release()`. The ring calls
 * both; nothing else should.
 */
export class FrameLedger {
  #live = 0;
  #peak = 0;
  #acquired = 0;
  #released = 0;
  readonly #capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`ring capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }
  /** Frames owned right now. The gate asserts this never exceeds {@link capacity}. */
  get live(): number {
    return this.#live;
  }
  /** High-water mark since construction. */
  get peak(): number {
    return this.#peak;
  }
  get acquired(): number {
    return this.#acquired;
  }
  get released(): number {
    return this.#released;
  }

  acquire(): void {
    this.#live += 1;
    this.#acquired += 1;
    if (this.#live > this.#peak) this.#peak = this.#live;
    if (this.#live > this.#capacity) {
      // Trip on the *first* leak. Leaving the counter high on the way out is
      // deliberate: a caller that swallows this error still sees a poisoned
      // ledger rather than a silently healed one.
      throw new FrameLeakError(this.#live, this.#capacity);
    }
  }

  release(): void {
    if (this.#live === 0) {
      throw new Error('released a frame that was never acquired; the ledger is not balanced');
    }
    this.#live -= 1;
    this.#released += 1;
  }
}

/**
 * Close a frame and never let the close itself throw.
 *
 * Used on error and cancellation paths, where the frame must go away whatever else
 * has gone wrong. A `close()` that throws (a frame already closed by someone else)
 * would otherwise abandon the frames after it in the same loop.
 */
export function closeQuietly(frame: ClosableFrame | null): void {
  if (frame === null) return;
  try {
    frame.close();
  } catch {
    // Nothing useful to do: the frame is gone either way.
  }
}
