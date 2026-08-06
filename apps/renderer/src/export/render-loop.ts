/**
 * The export loop.
 *
 * Architecture report §5.3 writes it out, and this is that pseudo-code with the
 * bookkeeping filled in:
 *
 * ```
 * for each output frame n at t_out = n / outputFps:            # CFR output
 *     state  = resolve(compiled, t_out)
 *     screen = screenReader.frameAt(state.sourceTime)          # hold-last
 *     compositor.render({screen, webcam, cursor}, state)       # into the backing store
 *     vf = new VideoFrame(canvas, { timestamp: round(n * 1e6 / outputFps), … })
 *     encoder.encode(vf, { keyFrame: n % (outputFps * 2) === 0 })
 *     vf.close()
 *     while (encoder.encodeQueueSize > 8) await nextOutput()
 * ```
 *
 * ## The line this class exists to hold
 *
 * §4.5 splits everything into *"must be identical"* and *"may differ"*, and the
 * split is between **state** and **scheduling**. So this loop is `PreviewLoop` with
 * a different clock and nothing else:
 *
 * | | preview (`preview-loop.ts`) | export (here) |
 * |---|---|---|
 * | clock | `requestAnimationFrame`, wall time | `n / fps`, a counter |
 * | a miss | held, counted, **never waited on** | waited for, then a loud failure |
 * | state | `resolve(compiled, t)` | `resolve(compiled, t)` — same call |
 * | frame selection | `screen.frameAt(state.sourceTime)` | same call, same reader type |
 * | compositing | `Compositor.render` | `Compositor.render` |
 *
 * Two of those rows differ and both are scheduling. Everything that reaches a pixel
 * is the same function called with the same arguments — which is what makes the
 * golden-frame gate a *check* rather than a hope, and why the encoder lives outside
 * this class: a loop that owned a `VideoEncoder` could not be run by a test that
 * only wants the pixels.
 *
 * ## Why a miss is fatal here and not in preview
 *
 * §4.3's *"if `frameAt` misses, hold the previous frame and count it — do not
 * block"* is a rule about a loop that has 16 ms and a person watching. An export has
 * neither, and a held frame in an export is not a dropped frame — it is a **wrong**
 * frame, permanently, in a file the user is about to delete the sources of. So the
 * loop awaits the decode; and if the index says a frame exists and the decoder will
 * not produce it, {@link ExportStallError} names the time it gave up at.
 *
 * A `null` frame where the *index* has nothing — before a part starts, or in the
 * hole a §7.4 camera unplug leaves — is not a miss. The compositor holds (§4.3), the
 * previous picture stays, and {@link ExportRenderReport.heldFrames} counts it, so
 * "the source had no picture here" and "decode never caught up" are never the same
 * number.
 */

import { resolve, type CompiledTimeline, type ResolvedState } from '@loom/edl';
import type { CompositorFrames } from '@loom/compositor';
import type { Seconds } from '@loom/format';
import { exportFrameCount } from '@loom/ipc';
import type { PreviewSource } from '../preview/index.ts';

/**
 * What the export loop reads frames from.
 *
 * `PreviewSource` plus one question preview never has to ask: *which* frame does the
 * index put here? `FrameRing.frameAtMicros` is hold-last **within the ring**, so a
 * reader whose decode has not caught up returns an older frame rather than `null` —
 * §4.3's correct behaviour for a preview, and a wrong frame in a file for an export.
 * `TrackReader` and `SourceReader` both answer it; a source that does not is taken at
 * its word, which is what keeps the seam narrow enough for a test to supply one.
 */
export interface ExportVideoSource extends PreviewSource {
  selectionMicros?(t: Seconds): number;
}

/** What the loop needs from a compositor. `Compositor` satisfies it as-is. */
export interface ExportCompositor {
  render(frames: CompositorFrames, state: ResolvedState): void;
  /**
   * Blit the render target to the canvas the encoder reads.
   *
   * §5.2's decisive property is that there is **no readback**: the encoder is handed
   * the canvas, not a pixel array. That only stays true — and only stays identical
   * to what the golden test reads out of the render target — while the canvas is
   * exactly the output size, so the blit is 1:1. {@link ExportRenderLoop} asserts
   * nothing about it; the page that builds the two does.
   */
  present(): void;
  readonly outputSize: readonly [number, number];
  /**
   * Whether the driver has taken the context away. `Compositor` exposes it already.
   *
   * The export path is the one place this *must* be consulted, and the reason is
   * that a lost context is **silent**: every GL call becomes a no-op and the canvas
   * keeps whatever it last held. Preview survives that — §4.3 holds the previous
   * picture for a tick and the next frame repaints. An export does not: it hands the
   * canvas to `new VideoFrame(canvas)` and encodes whatever is on it, so a lost
   * context becomes black or stale frames written into a file that then passes every
   * one of §7.5's five checks and is recorded verified-good.
   *
   * That is the failure the captain's retention decision cannot survive: phase 9
   * deletes the user's **only** copy of the raw sources on the strength of a
   * verified-good export. `Compositor.readPixels` already refuses to hand back
   * pixels from a lost context for the same reason; the export path never calls it,
   * so the refusal has to live here.
   *
   * Note this is *not* covered by the gate's relaunch predicate. That protects the
   * gate's own measurement from a runner whose GPU process dies. A real user has no
   * second attempt and no comparator.
   */
  readonly contextLost: boolean;
}

/** One composited output frame, handed to the caller to encode. */
export interface ExportedFrame {
  /** 0-based output frame number. */
  index: number;
  /** Where it sits on the *timeline*, seconds. */
  timelineTimeSec: Seconds;
  /** §5.3's `round(n * 1e6 / outputFps)`. */
  timestampUs: number;
  /** §5.3's `n % (outputFps * 2) === 0`. */
  isKey: boolean;
  /** False when the source had no picture here and the previous composite stands. */
  hadSourceFrame: boolean;
}

export interface ExportRenderReport {
  framesRendered: number;
  /** Frames composited from a source frame. */
  drawnFrames: number;
  /** Frames where the *index* had nothing, so the previous composite was held. */
  heldFrames: number;
  /** Times the loop had to await a decode that was not ready. */
  waits: number;
}

export interface ExportRenderLoopOptions {
  compositor: ExportCompositor;
  screen: ExportVideoSource;
  timeline: CompiledTimeline;
  /** Output frame rate. CFR — §5.3. */
  fps: number;
  /** §5.3: *"Keyframes every 2 seconds so the exported file scrubs well."* */
  keyframeIntervalSec?: number;
  /** How far ahead each `prime` asks for. §4.2's target. */
  lookaheadSec?: number;
  /** Seconds of decoded frames kept behind the read head. */
  retainBehindSec?: number;
  /**
   * Called once per composited frame, with the picture in the render target and on
   * the canvas. The caller encodes; awaiting it is where §5.3's backpressure lives.
   */
  onFrame: (frame: ExportedFrame) => Promise<void> | void;
  onProgress?: (renderedSec: Seconds, totalSec: Seconds) => void;
  /** Cancellation. Checked once per frame, so cancel is bounded by one composite. */
  signal?: AbortSignal;
}

/** §10.2's watchdog, applied to the export loop: a clear error beats a hang. */
export const STALL_TIMEOUT_MS = 5000;

/** Longest single wait for a decode before the watchdog is consulted again. */
const PRIME_POLL_MS = 50;

/**
 * The GL context died mid-export. §10.2: a clear error beats a spinner — and beats a
 * file of black frames far more.
 */
export class ExportContextLostError extends Error {
  readonly atIndex: number;
  constructor(atIndex: number) {
    super(
      `the WebGL context was lost while compositing output frame ${atIndex}; the export ` +
        'is refused rather than encoding frames nothing drew (architecture report §10.2). ' +
        'A lost context is silent — every GL call becomes a no-op and the canvas keeps ' +
        'its last contents — so continuing would write a file that passes every §7.5 ' +
        'check and shows nothing.',
    );
    this.name = 'ExportContextLostError';
    this.atIndex = atIndex;
  }
}

export class ExportStallError extends Error {
  readonly atSec: Seconds;
  constructor(atSec: Seconds, forMs: number) {
    super(
      `the export waited ${Math.round(forMs)}ms for the source frame at ` +
        `${atSec.toFixed(3)}s, which the index says exists. Decode has stopped ` +
        '(architecture report §10.2).',
    );
    this.name = 'ExportStallError';
    this.atSec = atSec;
  }
}

export class ExportCancelledError extends Error {
  constructor() {
    super('the export was cancelled');
    this.name = 'ExportCancelledError';
  }
}

export class ExportRenderLoop {
  readonly frameCount: number;

  readonly #compositor: ExportCompositor;
  readonly #screen: ExportVideoSource;
  readonly #timeline: CompiledTimeline;
  readonly #fps: number;
  readonly #keyEvery: number;
  readonly #lookaheadSec: number;
  readonly #retainBehindSec: number;
  readonly #onFrame: ExportRenderLoopOptions['onFrame'];
  readonly #onProgress: (renderedSec: Seconds, totalSec: Seconds) => void;
  readonly #signal: AbortSignal | undefined;

  /** Preallocated, exactly as the preview loop's is. §4.3's first rule. */
  readonly #frames: CompositorFrames = { screen: null };

  #report: ExportRenderReport = { framesRendered: 0, drawnFrames: 0, heldFrames: 0, waits: 0 };
  /** Output frame the context was first seen lost at. Sticky; see `#assertContextAlive`. */
  #contextLostAt: number | null = null;

  constructor(options: ExportRenderLoopOptions) {
    if (!(options.fps > 0)) throw new RangeError('an export needs a positive frame rate');
    this.#compositor = options.compositor;
    this.#screen = options.screen;
    this.#timeline = options.timeline;
    this.#fps = options.fps;
    this.#keyEvery = Math.max(1, Math.round(options.fps * (options.keyframeIntervalSec ?? 2)));
    this.#lookaheadSec = options.lookaheadSec ?? 0.5;
    this.#retainBehindSec = options.retainBehindSec ?? 0.5;
    this.#onFrame = options.onFrame;
    this.#onProgress = options.onProgress ?? ((): void => undefined);
    this.#signal = options.signal;
    // `exportFrameCount` rather than the arithmetic written out here: main computes
    // the duration §7.5's fourth check expects from the *same* function, so the file
    // is measured against the timeline rather than against the writer's own tally.
    this.frameCount = exportFrameCount(this.#timeline.durationSec, options.fps);
  }

  get report(): Readonly<ExportRenderReport> {
    return this.#report;
  }

  get durationSec(): Seconds {
    return this.frameCount / this.#fps;
  }

  /** Timeline time of output frame `index`. CFR, so it is a division. */
  timeOf(index: number): Seconds {
    return index / this.#fps;
  }

  /**
   * Composite exactly one output frame and leave it in the render target and on the
   * canvas. Does **not** call `onFrame`.
   *
   * This is the golden-frame gate's entry point, and it is the whole export path
   * from a frame number to pixels — no shortcut, no second code path, nothing the
   * full run does that this does not.
   */
  async renderFrame(index: number): Promise<ExportedFrame> {
    return this.renderAt(this.timeOf(index), index);
  }

  /**
   * Composite the export path's picture for an arbitrary timeline instant.
   *
   * `renderFrame` is this with `t = index / fps`, which is the only thing a CFR
   * export ever asks for. It is separate because a **golden-frame test** does not
   * have to work in frame numbers: §4.5's check is *"a fixture project at 24 fixed
   * timestamps through both the preview path and the export path"*, and the preview
   * path is seeked by time. A gate that had to round its timestamps onto this loop's
   * grid would be comparing the two paths at two different instants, which is a
   * difference that says nothing about either.
   *
   * So this is the seam a golden harness calls. `test/export-golden/harness.ts` uses
   * it, and phase 11's `test/golden/harness.ts` has a two-line stand-in for the
   * export path — `resolve` then `render` — which this replaces exactly, with its
   * assertions untouched, when the two branches meet.
   */
  async renderAt(
    timelineTimeSec: Seconds,
    index = Math.round(timelineTimeSec * this.#fps),
  ): Promise<ExportedFrame> {
    this.#throwIfCancelled();
    // §3.6's one hot-path function, called exactly as the preview loop calls it. The
    // spring was integrated on the fixed 8 ms grid at compile time; sampling it is
    // an index and a lerp. Integrating at frame rate for export instead — which
    // would be the natural thing to write here, since export *has* the time — is
    // §3.4's one forbidden shortcut and worth 82.6 px at 3456 wide.
    const state = resolve(this.#timeline, timelineTimeSec);

    // Before the composite: a context already lost has nothing to draw with, and
    // checking only afterwards would spend a decode on it first.
    this.#assertContextAlive(index);

    const frame = await this.#frameAt(state.sourceTime);
    this.#frames.screen = frame;
    this.#compositor.render(this.#frames, state);
    this.#compositor.present();
    // And after: `render` and `present` are the two calls that go silently no-op, so
    // this is the check that stands between a dead context and the encoder. The
    // caller only ever encodes a frame this method *returned*.
    this.#assertContextAlive(index);
    // Held only for the length of the draw; the ring still owns it. No path out of
    // this function keeps a frame alive (§10.2).
    this.#frames.screen = null;

    this.#report.framesRendered += 1;
    if (frame === null) this.#report.heldFrames += 1;
    else this.#report.drawnFrames += 1;

    // Behind the read head, and only after the composite. A release ahead of the
    // draw would close the frame that is about to be uploaded.
    this.#screen.release(state.sourceTime - this.#retainBehindSec);

    return {
      index,
      timelineTimeSec,
      timestampUs: Math.round((index * 1e6) / this.#fps),
      isKey: index % this.#keyEvery === 0,
      hadSourceFrame: frame !== null,
    };
  }

  /** Render and hand over every output frame, in order. */
  async run(): Promise<ExportRenderReport> {
    for (let index = 0; index < this.frameCount; index++) {
      const frame = await this.renderFrame(index);
      await this.#onFrame(frame);
      this.#onProgress(this.timeOf(index + 1), this.durationSec);
    }
    this.#throwIfCancelled();
    // The last frame's composite is checked by `renderAt`, but the encoder is still
    // holding queued frames when it returns; a loss here must not let the pass be
    // reported complete.
    this.#assertContextAlive(this.frameCount - 1);
    return this.#report;
  }

  /**
   * The source frame at `sourceTime`, waited for.
   *
   * Three outcomes, and they are deliberately different things:
   *
   *  - the index has no frame here — `null`, immediately. A hole, not a miss.
   *  - the ring has it — returned without awaiting anything, which is the common
   *    case once the lookahead is running ahead of the loop.
   *  - the index has it and the ring does not — prime, and keep priming until it
   *    arrives or {@link STALL_TIMEOUT_MS} passes.
   */
  async #frameAt(sourceTime: Seconds): Promise<VideoFrame | null> {
    if (!this.#screen.hasSourceFrameAt(sourceTime)) {
      // Still worth priming: the *next* output frame very likely wants a picture,
      // and a source that starts late should not pay a seek for every frame before
      // its first one.
      await this.#prime(sourceTime);
      return null;
    }

    // Primed **before** the frame is taken, on every frame, not only after a miss.
    // The preview loop can take whatever the ring happens to hold and prime
    // afterwards, because a stale frame there is one held tick; here it is a wrong
    // frame in a file, and the ring will keep handing back the same one forever
    // because nothing else is asking it to move.
    let waited = false;
    const deadline = Date.now() + STALL_TIMEOUT_MS;
    for (;;) {
      this.#throwIfCancelled();
      await this.#prime(sourceTime);
      const frame = this.#screen.frameAt(sourceTime);
      if (frame !== null && this.#isSelected(frame, sourceTime)) return frame;
      if (!waited) {
        waited = true;
        this.#report.waits += 1;
      }
      if (Date.now() >= deadline) throw new ExportStallError(sourceTime, STALL_TIMEOUT_MS);
      await new Promise((done) => setTimeout(done, PRIME_POLL_MS));
    }
  }

  /**
   * Is this the frame the *index* puts at `sourceTime`, or an older one the ring
   * still happened to hold?
   *
   * The check that turns §10.2's silent failure into a loud one: an export that
   * composited a stale frame produces a file that plays, is the right length, passes
   * every §7.5 check, and shows the wrong picture.
   */
  #isSelected(frame: VideoFrame, sourceTime: Seconds): boolean {
    const expected = this.#screen.selectionMicros?.(sourceTime);
    if (expected === undefined || !Number.isFinite(expected)) return true;
    return Math.abs(frame.timestamp - expected) <= 0.5;
  }

  async #prime(sourceTime: Seconds): Promise<void> {
    await this.#screen.prime(sourceTime, this.#lookaheadSec);
  }

  /**
   * Refuse the moment the context is gone, and stay refused.
   *
   * **Sticky**, because a WebGL context never comes back and because a loss that
   * lands between two checks must not be able to slip through a later one that
   * happens to read `false`. Once this loop has seen a dead context, every
   * subsequent frame and {@link run}'s own final check fail too.
   */
  #assertContextAlive(index: number): void {
    if (this.#contextLostAt === null && !this.#compositor.contextLost) return;
    this.#contextLostAt ??= index;
    throw new ExportContextLostError(this.#contextLostAt);
  }

  #throwIfCancelled(): void {
    if (this.#signal?.aborted === true) throw new ExportCancelledError();
  }
}
