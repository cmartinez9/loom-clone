/**
 * `FrameRing` — the one owner of every decoded frame.
 *
 * Architecture report §4.2 sets the size and says why: *"Memory is the real 4K
 * constraint, not speed. A decoded 3456×2234 NV12 frame is ~11.6 MB. The ring is
 * capped at 20 frames per source (232 MB) with a hard assertion that live
 * `VideoFrame` count never exceeds it."*
 *
 * The ring is a fixed-capacity circular buffer over frames in ascending
 * presentation order. Three properties matter and are each enforced here rather
 * than asked of callers:
 *
 *  - **Push transfers ownership.** After `push`, the caller must not touch the
 *    frame. If the ring is full it closes its oldest frame *before* taking the new
 *    one, so the ledger never records capacity + 1 even transiently — which is what
 *    makes the gate's assertion an equality-grade statement and not an
 *    approximation.
 *  - **`frameAt` lends.** The returned frame belongs to the ring and is valid until
 *    the next `releaseBefore`, `clear` or `close`. The preview loop renders from it
 *    inside the same turn; nothing stores it.
 *  - **Every exit path closes.** Eviction, release, clear, close and the
 *    stale-push rejection all go through {@link FrameRing.#discard}.
 *
 * Pushes must be in ascending timestamp order, which is what `VideoDecoder` emits.
 * A frame that is not newer than the newest held frame is a stale output from a
 * seek that was abandoned — it is closed, counted, and not stored. Storing it would
 * corrupt the search order; dropping it without closing it is the §10.2 bug.
 */

import { closeQuietly, FrameLedger, type ClosableFrame } from './frames.ts';

/** Ring capacity per source, architecture report §4.2. */
export const DEFAULT_RING_CAPACITY = 20;

export interface FrameRingStats {
  /** Frames evicted to make room for a newer one. */
  evicted: number;
  /** Frames dropped because they were not newer than the newest held frame. */
  rejected: number;
  /** Frames closed by `releaseBefore`. */
  released: number;
}

export class FrameRing<T extends ClosableFrame = VideoFrame> {
  readonly capacity: number;
  readonly ledger: FrameLedger;

  readonly #slots: (T | null)[];
  #head = 0;
  #size = 0;
  #closed = false;
  readonly #stats: FrameRingStats = { evicted: 0, rejected: 0, released: 0 };

  constructor(capacity: number = DEFAULT_RING_CAPACITY, ledger?: FrameLedger) {
    this.ledger = ledger ?? new FrameLedger(capacity);
    if (this.ledger.capacity < capacity) {
      throw new RangeError(
        `ledger capacity ${String(this.ledger.capacity)} is below ring capacity ${String(capacity)}; ` +
          'the leak assertion would trip on correct behaviour',
      );
    }
    this.capacity = capacity;
    this.#slots = new Array<T | null>(capacity).fill(null);
  }

  get size(): number {
    return this.#size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Live frames this ring owns. Never exceeds {@link capacity}. */
  get live(): number {
    return this.#size;
  }

  get stats(): Readonly<FrameRingStats> {
    return this.#stats;
  }

  /** Timestamp (µs) of the oldest held frame, or `null` when empty. */
  get oldestMicros(): number | null {
    return this.#size === 0 ? null : this.#peek(0).timestamp;
  }

  /** Timestamp (µs) of the newest held frame, or `null` when empty. */
  get newestMicros(): number | null {
    return this.#size === 0 ? null : this.#peek(this.#size - 1).timestamp;
  }

  /**
   * Take ownership of `frame`.
   *
   * Returns `true` when the ring stored it and `false` when it closed it as stale.
   * Either way the caller no longer owns the frame — there is no path out of this
   * method that leaves it live and unheld.
   */
  push(frame: T): boolean {
    if (this.#closed) {
      closeQuietly(frame);
      return false;
    }
    const newest = this.newestMicros;
    if (newest !== null && frame.timestamp <= newest) {
      this.#stats.rejected += 1;
      closeQuietly(frame);
      return false;
    }
    if (this.#size === this.capacity) {
      this.#discard(0);
      this.#head = (this.#head + 1) % this.capacity;
      this.#size -= 1;
      this.#stats.evicted += 1;
    }
    // Acquire only once there is room, so `live` never reads capacity + 1.
    this.ledger.acquire();
    this.#slots[(this.#head + this.#size) % this.capacity] = frame;
    this.#size += 1;
    return true;
  }

  /**
   * The frame on screen at `tSec`: the newest held frame whose timestamp ≤ `t`.
   *
   * **Borrowed, not owned — do not close it** (§4.2). `null` means the ring holds
   * nothing at or before `t`, which the preview loop treats as "hold the previous
   * frame and count it" rather than as an error (§4.3).
   */
  frameAt(tSec: number): T | null {
    if (this.#size === 0) return null;
    const micros = tSec * 1_000_000 + 0.5;
    if (this.#peek(0).timestamp > micros) return null;
    let low = 0;
    let high = this.#size - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.#peek(mid).timestamp <= micros) low = mid;
      else high = mid - 1;
    }
    return this.#peek(low);
  }

  /** True when {@link frameAt} would return a frame. */
  covers(tSec: number): boolean {
    return this.frameAt(tSec) !== null;
  }

  /**
   * Close every frame strictly older than the one that covers `tSec`.
   *
   * The frame covering `t` survives, because hold-last-frame means it is still the
   * right thing to draw until the next one arrives. Returns how many were closed.
   */
  releaseBefore(tSec: number): number {
    const micros = tSec * 1_000_000 + 0.5;
    let closed = 0;
    // Keep the last frame at or before `t`: stop as soon as the *second* frame is
    // newer than `t`, because then the first is the one covering it.
    while (this.#size >= 2 && this.#peek(1).timestamp <= micros) {
      this.#discard(0);
      this.#head = (this.#head + 1) % this.capacity;
      this.#size -= 1;
      closed += 1;
    }
    this.#stats.released += closed;
    return closed;
  }

  /** Close everything the ring holds. Returns how many were closed. */
  clear(): number {
    const closed = this.#size;
    for (let i = 0; i < this.#size; i++) this.#discard(i);
    this.#head = 0;
    this.#size = 0;
    return closed;
  }

  /** Close everything and refuse further pushes. Idempotent. */
  close(): void {
    this.clear();
    this.#closed = true;
  }

  #peek(i: number): T {
    const frame = this.#slots[(this.#head + i) % this.capacity];
    if (frame === null || frame === undefined) {
      throw new Error(`frame ring slot ${String(i)} is empty but size is ${String(this.#size)}`);
    }
    return frame;
  }

  /** Close the frame at logical position `i` and clear its slot. Never throws. */
  #discard(i: number): void {
    const slot = (this.#head + i) % this.capacity;
    const frame = this.#slots[slot];
    this.#slots[slot] = null;
    if (frame === null || frame === undefined) return;
    closeQuietly(frame);
    this.ledger.release();
  }
}
