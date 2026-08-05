/**
 * The preview loop.
 *
 * Architecture report §4.3 writes it out, and this is that pseudo-code with the
 * bookkeeping filled in:
 *
 * ```
 * requestAnimationFrame(now):
 *   t = clock.timelineTime(now)
 *   state = resolve(compiled, t)
 *   screen = screenReader.frameAt(state.sourceTime)     # borrowed
 *   compositor.render({screen, ...}, state)
 *   compositor.present()
 *   screenReader.prime(t, 0.5)                          # off the critical path
 * ```
 *
 * It lives in the renderer rather than in a package because it is the *consumer*
 * that wires the two phase-6 packages together: §1.3 keeps `compositor` to pure draw
 * calls and `decode` to the index, ring and reader, and neither of them owns a
 * `requestAnimationFrame`. The exporter (phase 8) drives the same `SourceReader` and
 * the same `Compositor` from a fixed-timestamp loop instead of this one, which is
 * how §4.5's "may differ: scheduling; must not differ: state" line is drawn in code.
 *
 * Phase 7 landed the model, so the loop no longer fills a state in by hand: it calls
 * `resolve(compiled, t)` on a `CompiledTimeline` and hands the result straight to
 * the compositor. A project with no edits is not a special case — it is
 * `identityTimeline(durationSec)`, a real compile of a one-clip document — so there
 * is exactly one path from a timeline time to a composite, and the exporter walks
 * the same one (§4.5).
 *
 * ## The four anti-stutter rules, and where each one is
 *
 *  - **Nothing allocates in the loop.** The state object, the frames object and the
 *    metrics buffer are built once in the constructor and mutated in place.
 *  - **Decode runs ahead, never inline.** `prime` is fire-and-forget with a `catch`;
 *    the loop never awaits it. A miss is counted here and *held* by the compositor,
 *    which leaves the previous composite in the render target. The loop cannot do
 *    the holding itself: the frame it would keep is the ring's, and the next seek
 *    closes it.
 *  - **`prime()` is cancelable.** Scrubbing just calls `seek`, which primes at the
 *    new time; `SourceReader` aborts the old read and abandons the old seek.
 *  - **Expensive optional passes are skipped while scrubbing.** There are none yet
 *    (blur and motion blur are phases 11 and 13), but {@link PreviewLoop.scrubbing}
 *    is the flag they will read, and §4.3 is explicit that it must stay a
 *    *scheduling* difference and never a *state* difference.
 */

import type { CompositorFrames } from '@loom/compositor';
import { identityTimeline, resolve, type CompiledTimeline, type ResolvedState } from '@loom/edl';
import type { Seconds } from '@loom/format';
import { FRAME_BUDGET_MS, FrameMetrics } from './frame-metrics.ts';

/**
 * What the loop needs from a compositor. `Compositor` satisfies it as-is.
 *
 * Narrower than the class on purpose: the loop's job is to call `render` and
 * `present` on a budget, and stating that as an interface keeps the loop's own
 * timing testable without a GL context — while making it structurally impossible
 * for the loop to reach for a preview-only render path that the exporter does not
 * have (§4.2, §4.5).
 */
export interface PreviewCompositor {
  render(frames: CompositorFrames, state: ResolvedState): void;
  present(): void;
}

/** What the loop needs from a decoded source. `SourceReader` satisfies it as-is. */
export interface PreviewSource {
  /** Borrowed — the loop draws from it within the same turn and never closes it. */
  frameAt(t: Seconds): VideoFrame | null;
  prime(t: Seconds, aheadSec: number): Promise<void>;
  release(beforeT: Seconds): void;
  /** Whether the source has a frame at `t` at all. Drives the stall watchdog. */
  hasSourceFrameAt(t: Seconds): boolean;
  readonly liveFrames: number;
  readonly ringCapacity: number;
}

/** `requestAnimationFrame`, as an interface, so a headless run can drive the loop. */
export interface FrameScheduler {
  request(callback: (nowMs: number) => void): number;
  cancel(handle: number): void;
}

export const rafScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => {
    cancelAnimationFrame(handle);
  },
};

export interface PreviewLoopOptions {
  compositor: PreviewCompositor;
  screen: PreviewSource;
  /** Timeline duration. Playback stops here. */
  durationSec: Seconds;
  /**
   * The compiled timeline `resolve` reads. Defaults to `identityTimeline(durationSec)`
   * — the recording as captured — so a caller that has a duration and no project
   * still goes through the real model rather than around it.
   */
  timeline?: CompiledTimeline;
  /** §4.2's lookahead target. */
  lookaheadSec?: number;
  /** How far behind the playhead frames are kept before being closed. */
  retainBehindSec?: number;
  scheduler?: FrameScheduler;
  now?: () => number;
  /** Reported when priming fails for a real reason (not a supersession). */
  onError?: (error: Error) => void;
  /**
   * Reported when the loop has wanted a frame that the source says exists, and not
   * got one, for {@link STALL_TIMEOUT_MS}. §10.2: *"a watchdog … that fails loudly
   * after 5 s with no progress instead of hanging. A clear error beats a spinner."*
   */
  onStall?: (info: { atSec: Seconds; forMs: number }) => void;
}

/** §10.2's watchdog interval. */
export const STALL_TIMEOUT_MS = 5000;

export class PreviewLoop {
  readonly metrics: FrameMetrics;

  readonly #compositor: PreviewCompositor;
  readonly #screen: PreviewSource;
  readonly #scheduler: FrameScheduler;
  readonly #now: () => number;
  readonly #lookaheadSec: number;
  readonly #retainBehindSec: number;
  readonly #onError: (error: Error) => void;
  readonly #onStall: (info: { atSec: Seconds; forMs: number }) => void;

  readonly #frames: CompositorFrames = { screen: null };

  /**
   * Owned by the `CompiledTimeline`, not by the loop: `resolve` returns the same
   * object every call and overwrites it, which is how §3.6 gets "no allocation".
   * The loop reads it within the turn and keeps no reference past `render`.
   */
  #timeline: CompiledTimeline;

  #durationSec: Seconds;
  #time: Seconds = 0;
  #playing = false;
  #scrubbing = false;
  #handle: number | null = null;
  #running = false;
  #lastTickMs: number | null = null;
  /** When the current run of misses started, or `null` when the last frame hit. */
  #missingSinceMs: number | null = null;
  #stallReported = false;
  #peakLiveFrames = 0;

  constructor(options: PreviewLoopOptions) {
    this.#compositor = options.compositor;
    this.#screen = options.screen;
    this.#scheduler = options.scheduler ?? rafScheduler;
    this.#now = options.now ?? (() => performance.now());
    this.#lookaheadSec = options.lookaheadSec ?? 0.5;
    this.#retainBehindSec = options.retainBehindSec ?? 0.1;
    this.#durationSec = Math.max(0, options.durationSec);
    this.#timeline = options.timeline ?? identityTimeline(this.#durationSec);
    this.#onError = options.onError ?? (() => undefined);
    this.#onStall = options.onStall ?? (() => undefined);
    this.metrics = new FrameMetrics(4096, FRAME_BUDGET_MS);
  }

  get time(): Seconds {
    return this.#time;
  }
  get playing(): boolean {
    return this.#playing;
  }
  get running(): boolean {
    return this.#running;
  }
  /** True between a `seek` and the next `pause`/`play`. See §4.3. */
  get scrubbing(): boolean {
    return this.#scrubbing;
  }
  get durationSec(): Seconds {
    return this.#durationSec;
  }
  set durationSec(value: Seconds) {
    this.#durationSec = Math.max(0, value);
  }
  get timeline(): CompiledTimeline {
    return this.#timeline;
  }
  /**
   * Swap in a recompiled timeline — §3.6's *"`compile` is called on load and on any
   * op that changes a spring channel (debounced 100 ms)"*.
   *
   * Assignment, not a rebuild: the next frame resolves against the new timeline and
   * every frame before it resolved against the old one. There is no instant at
   * which half of one and half of the other is on screen.
   */
  set timeline(value: CompiledTimeline) {
    this.#timeline = value;
  }
  /** High-water mark of live frames observed by the loop. The gate asserts on it. */
  get peakLiveFrames(): number {
    return this.#peakLiveFrames;
  }

  /** Begin rendering. Idempotent. Rendering continues while paused, so a seek shows. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastTickMs = null;
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    this.#playing = false;
    if (this.#handle !== null) {
      this.#scheduler.cancel(this.#handle);
      this.#handle = null;
    }
  }

  play(): void {
    if (this.#time >= this.#durationSec) this.#time = 0;
    this.#playing = true;
    this.#scrubbing = false;
    this.#lastTickMs = null;
    this.#resetStallWatch();
    this.start();
  }

  pause(): void {
    this.#playing = false;
    this.#scrubbing = false;
    this.#lastTickMs = null;
  }

  /**
   * Jump the playhead. Cheap enough to call on every pointer move.
   *
   * The seek itself is just a new `prime`: `SourceReader` decides whether that means
   * decoding forward or resetting to a keyframe, aborts whatever the previous prime
   * was reading, and never blocks this call.
   */
  seek(t: Seconds, options: { scrubbing?: boolean } = {}): void {
    this.#time = Math.min(Math.max(0, t), this.#durationSec);
    this.#scrubbing = options.scrubbing ?? false;
    this.#lastTickMs = null;
    this.#resetStallWatch();
    this.#prime();
  }

  /** Render exactly one frame, on the caller's schedule. Returns its duration in ms. */
  renderOnce(): number {
    return this.#frame(this.#now());
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#handle = this.#scheduler.request((nowMs) => {
      this.#handle = null;
      this.#frame(nowMs);
      this.#schedule();
    });
  }

  /**
   * One frame. Everything in here is on the 16 ms budget, so everything in here is
   * either O(1) or a draw call — and none of it awaits.
   */
  #frame(nowMs: number): number {
    const started = this.#now();

    if (this.#playing) {
      const last = this.#lastTickMs;
      if (last !== null)
        this.#time = Math.min(this.#durationSec, this.#time + (nowMs - last) / 1000);
      this.#lastTickMs = nowMs;
      if (this.#time >= this.#durationSec) this.#playing = false;
    }

    const t = this.#time;
    // §3.6's one hot-path function. No allocation, no simulation: the spring was
    // integrated on the fixed 8 ms grid at compile time and sampling it here is an
    // index and a lerp. Integrating at frame rate instead — even "just for preview"
    // — is §3.4's one forbidden shortcut, and worth 82.6 px at 3456 wide.
    const state = resolve(this.#timeline, t);

    const frame = this.#screen.frameAt(state.sourceTime);
    this.#frames.screen = frame;
    this.#compositor.render(this.#frames, state);
    this.#compositor.present();
    // Held only for the length of the draw. The ring still owns it; dropping the
    // reference here means no path out of this function keeps a frame alive.
    this.#frames.screen = null;

    const elapsed = this.#now() - started;
    this.metrics.record(elapsed);

    const live = this.#screen.liveFrames;
    if (live > this.#peakLiveFrames) this.#peakLiveFrames = live;

    this.#watchStall(frame !== null, t, started);

    // Off the critical path, after the budget has been measured (§4.3).
    this.#prime();
    this.#screen.release(t - this.#retainBehindSec);
    return elapsed;
  }

  #prime(): void {
    void this.#screen.prime(this.#time, this.#lookaheadSec).catch((error: unknown) => {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  #watchStall(hit: boolean, t: Seconds, nowMs: number): void {
    if (hit || !this.#screen.hasSourceFrameAt(t)) {
      this.#resetStallWatch();
      return;
    }
    this.#missingSinceMs ??= nowMs;
    const forMs = nowMs - this.#missingSinceMs;
    if (forMs >= STALL_TIMEOUT_MS && !this.#stallReported) {
      this.#stallReported = true;
      this.#onStall({ atSec: t, forMs });
    }
  }

  #resetStallWatch(): void {
    this.#missingSinceMs = null;
    this.#stallReported = false;
  }
}
