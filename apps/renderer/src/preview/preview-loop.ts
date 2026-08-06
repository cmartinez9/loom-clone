/**
 * The preview loop.
 *
 * Architecture report §4.3 writes it out, and this is that pseudo-code with the
 * bookkeeping filled in **and one domain error corrected**:
 *
 * ```
 * requestAnimationFrame(now):
 *   t = clock.timelineTime(now)
 *   state = resolve(compiled, t)
 *   screen = screenReader.frameAt(state.sourceTime)     # borrowed
 *   compositor.render({screen, ...}, state)
 *   compositor.present()
 *   screenReader.prime(state.sourceTime, 0.5)           # off the critical path
 * ```
 *
 * ## The one place this diverges from §4.3, and why it is the report that is wrong
 *
 * §4.3's own line is `screenReader.prime(t, 0.5)` — the **timeline** time — while the
 * line above it reads `frameAt(state.sourceTime)`. Both cannot be right: §3.1 gives
 * the two domains and `packages/edl/src/clips.ts` is unambiguous that the clip list is
 * the *only* map between them, so an argument is either one or the other. Every method
 * on {@link PreviewSource} is `SourceReader`'s, and every one of them is in **source**
 * time — `prime`, `release` and `hasSourceFrameAt` exactly as much as `frameAt`, which
 * §4.3 already spells correctly. §4.3 was written before §3.1 had a clip list to
 * disagree with, so it reads as though the two were the same number; they are equal
 * only over an identity clip list, which was every document this app could produce
 * until the editor shipped a trim. **§4.3 of the architecture report now carries the
 * matching correction**, made after PR #15 merged; this docblock and the report agree.
 *
 * What it costs to get wrong is latent rather than loud, which is why it survived: the
 * first `sourceStart > 0`, trim or speed change makes preview prime the decoder at the
 * wrong instant, `frameAt(sourceTime)` miss every frame, and §4.3's hold leave one
 * stale picture on screen — with §10.2's watchdog asking `hasSourceFrameAt` about a
 * different instant than the one that missed, so the loud failure degrades into a
 * silent freeze under a scrub bar that still looks correct. Phase 8's export loop
 * (`apps/renderer/src/export/render-loop.ts`) drives the same four methods off
 * `state.sourceTime`; these two are the §4.5 pair that must not disagree.
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
 *  - **Expensive optional passes are skipped while scrubbing.** None are, and the
 *    blur is a deliberate refusal rather than an oversight: §4.5 permits *"preview
 *    may skip blur passes while scrubbing"*, but a redaction is the one pass whose
 *    absence teaches the user their blur is somewhere it is not, and it costs two
 *    full-target draws per region against a 16.67 ms frame. {@link PreviewLoop.scrubbing}
 *    remains the flag a future pass would read — motion blur is phase 13 — and §4.3
 *    is explicit that it must stay a *scheduling* difference and never a *state* one.
 */

import type { CompositorFrames, TextAtlas } from '@loom/compositor';
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
  /**
   * The annotation passes' diagnostics, read after `render`.
   *
   * `@loom/compositor` is pure and has no way to report anything itself, so every
   * condition it can only **degrade** through is left on the pass as a monotonic
   * count and the loop turns it into an `onError`. Optional because it is a
   * diagnostic: a loop wired to something that does not keep one still renders.
   */
  readonly annotations?: AnnotationDegradations;
}

/**
 * The counts of what the annotation passes drew nothing for.
 *
 * Two of them, and they are one interface rather than two because they are one shape
 * of failure: visible, cosmetic, and counted rather than thrown on. `blur` and `mask`
 * are the opposite — they refuse the frame — and are therefore not here.
 */
export interface AnnotationDegradations {
  /** `text` spans skipped for want of a glyph atlas (phase 11). */
  readonly textSpansWithoutAtlas: number;
  /** Strokes skipped because the coverage pass got no scratch target (phase 12). */
  readonly strokesWithoutScratch: number;
}

/**
 * One degrade-and-count condition, as the loop watches it.
 *
 * A table rather than a pair of near-identical methods, so that "the same latching
 * `textSpansWithoutAtlas` uses" is literally the same code and cannot drift. Built
 * once per loop and mutated in place: this is read every frame.
 */
interface Degradation {
  readonly read: (counts: AnnotationDegradations | undefined) => number;
  readonly message: string;
  /** The count as of the previous frame. */
  seen: number;
  /** Latched, in the shape {@link PreviewLoop} already uses for the stall. */
  reported: boolean;
}

/**
 * What the loop needs from a decoded source. `SourceReader` satisfies it as-is.
 *
 * **Every time here is a *source* time** — seconds into the raw recording, §3.1's
 * first domain — because every one of these is a question about the media. The loop
 * holds a *timeline* time and the two are equal only over an identity clip list, so
 * the conversion is `resolve(...).sourceTime` and it belongs on the caller's side of
 * this interface, once per frame. Nothing below may be handed `PreviewLoop.time`.
 */
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
  /**
   * Timeline duration. Playback stops here.
   *
   * It builds the default timeline below, and a caller who supplies `timeline`
   * instead states the duration in its clip list; there is only ever one of them.
   */
  durationSec: Seconds;
  /**
   * The compiled timeline `resolve` reads. Defaults to `identityTimeline(durationSec)`
   * — the recording as captured — so a caller that has a duration and no project
   * still goes through the real model rather than around it.
   */
  timeline?: CompiledTimeline;
  /**
   * §4.2's lookahead target, in **source** seconds — {@link PreviewSource}'s domain,
   * so a clip whose `speed` is not 1 scales what it buys: 0.5 is 0.25 s of playback
   * ahead at 2×, and 1.0 s at 0.5×.
   */
  lookaheadSec?: number;
  /**
   * How far behind the *source* read head frames are kept before being closed —
   * source seconds too, and scaled by clip speed the same way.
   *
   * Compensating for that scaling is not this loop's to do alone: §4.5 puts preview
   * and export on the must-be-identical list. `AGENTS.md` § Sharp edges carries the
   * argument and what a change to it would take.
   */
  retainBehindSec?: number;
  /**
   * The glyph atlas `text` annotations are drawn from (phase 11).
   *
   * Held on the frames object rather than fetched per frame, and it must be the
   * **same object** the exporter is given: `@loom/compositor/raster` explains why
   * one raster shared between the two paths is what makes glyphs a §4.5
   * non-difference rather than two canvases that probably agree.
   */
  textAtlas?: TextAtlas | null;
  scheduler?: FrameScheduler;
  now?: () => number;
  /** Reported when priming fails for a real reason (not a supersession). */
  onError?: (error: Error) => void;
  /**
   * Reported when the loop has wanted a frame that the source says exists, and not
   * got one, for {@link STALL_TIMEOUT_MS}. §10.2: *"a watchdog … that fails loudly
   * after 5 s with no progress instead of hanging. A clear error beats a spinner."*
   *
   * `atSec` is the **source** instant that could not be produced — the domain the
   * question was asked in — and `timelineSec` is where the playhead was while it went
   * unanswered. They are the same number only over an identity clip list.
   */
  onStall?: (info: { atSec: Seconds; timelineSec: Seconds; forMs: number }) => void;
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
  readonly #onStall: (info: { atSec: Seconds; timelineSec: Seconds; forMs: number }) => void;

  readonly #frames: CompositorFrames = { screen: null, textAtlas: null };

  /**
   * Owned by the `CompiledTimeline`, not by the loop: `resolve` returns the same
   * object every call and overwrites it, which is how §3.6 gets "no allocation".
   * The loop reads it within the turn and keeps no reference past `render`.
   */
  #timeline: CompiledTimeline;
  /** True while `#timeline` is the loop's own `identityTimeline`, not a caller's. */
  #ownsTimeline: boolean;

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
  /**
   * A latch, in the shape {@link PreviewLoop.#stallReported} already uses: set on the
   * first report of a run of the condition, cleared when the condition goes away.
   *
   * A refused frame is a property of the *document*, so an unlatched report would
   * fire on every frame for as long as the document says so — sixty errors a second,
   * which is a worse defect than the one being reported. The same argument holds for
   * every entry in {@link PreviewLoop.#degradations}, which is why they latch too.
   */
  #refusalReported = false;
  /**
   * Everything the annotation passes can quietly draw nothing for, and the state that
   * makes each of them a report per *run* rather than per frame.
   */
  readonly #degradations: readonly Degradation[] = [
    {
      read: (counts) => counts?.textSpansWithoutAtlas ?? 0,
      message:
        'a text annotation was resolved but the preview has no glyph atlas, so it was not ' +
        'drawn. Build one with `rasterizeGlyphs` + `uploadTextAtlas` from ' +
        '`@loom/compositor/raster` and pass it as `textAtlas`; the export path has to be ' +
        'handed the same object',
      seen: 0,
      reported: false,
    },
    {
      read: (counts) => counts?.strokesWithoutScratch ?? 0,
      message:
        'a hand-drawn stroke was resolved but the compositor could not allocate the scratch ' +
        'target its coverage pass accumulates into, so the ink was not drawn. The strokes are ' +
        'still in the document; this is GL memory pressure, and the frame it happened on is ' +
        'missing ink the editor believes it is showing',
      seen: 0,
      reported: false,
    },
  ];

  constructor(options: PreviewLoopOptions) {
    this.#compositor = options.compositor;
    this.#screen = options.screen;
    this.#scheduler = options.scheduler ?? rafScheduler;
    this.#now = options.now ?? (() => performance.now());
    this.#lookaheadSec = options.lookaheadSec ?? 0.5;
    this.#retainBehindSec = options.retainBehindSec ?? 0.1;
    this.#ownsTimeline = options.timeline === undefined;
    this.#timeline = options.timeline ?? identityTimeline(Math.max(0, options.durationSec));
    this.#frames.textAtlas = options.textAtlas ?? null;
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
  /**
   * The compiled timeline's duration, and never a second copy of it.
   *
   * `resolve` clamps into `CompiledTimeline.durationSec` (§3.6), so a duration the
   * loop held separately could outrun the one the state comes from: the playhead
   * would keep advancing while `sourceTime` stuck at the old end, and the preview
   * would freeze on the last frame with no error anywhere.
   */
  get durationSec(): Seconds {
    return this.#timeline.durationSec;
  }
  /**
   * Re-length a loop that is showing the recording as captured.
   *
   * That is the only case the duration is the loop's to set: a compiled project's
   * duration is its clip list, and changing it means handing over a recompiled
   * {@link PreviewLoop.timeline}. Silently discarding a caller's timeline here would
   * leave a valid loop showing the wrong picture, so it is refused instead.
   */
  set durationSec(value: Seconds) {
    if (!this.#ownsTimeline) {
      throw new Error(
        'durationSec is the compiled timeline’s; assign `timeline` a recompiled one instead',
      );
    }
    this.#timeline = identityTimeline(Math.max(0, value));
    this.#clampTime();
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
   *
   * A shorter timeline takes the playhead with it. `resolve` clamps internally, so
   * the composite would be right either way — but `time` is what a scrub bar reads,
   * and a paused loop reporting 25 s of a 12 s project is a playhead off the end of
   * its own track until something happens to call `seek`.
   */
  set timeline(value: CompiledTimeline) {
    this.#timeline = value;
    this.#ownsTimeline = false;
    this.#clampTime();
  }

  #clampTime(): void {
    const duration = this.durationSec;
    if (this.#time > duration) this.#time = duration;
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
    if (this.#time >= this.durationSec) this.#time = 0;
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
    this.#time = Math.min(Math.max(0, t), this.durationSec);
    this.#scrubbing = options.scrubbing ?? false;
    this.#lastTickMs = null;
    this.#resetStallWatch();
    // The seek's own prime happens outside a frame, so there is no resolved state to
    // read `sourceTime` off; `resolve` is 0.3 µs on a 30-minute timeline and this is
    // a pointer move, not the 16 ms budget.
    this.#prime(this.#sourceTime());
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
      const durationSec = this.#timeline.durationSec;
      const last = this.#lastTickMs;
      if (last !== null) this.#time = Math.min(durationSec, this.#time + (nowMs - last) / 1000);
      this.#lastTickMs = nowMs;
      if (this.#time >= durationSec) this.#playing = false;
    }

    const t = this.#time;
    // §3.6's one hot-path function. No allocation, no simulation: the spring was
    // integrated on the fixed 8 ms grid at compile time and sampling it here is an
    // index and a lerp. Integrating at frame rate instead — even "just for preview"
    // — is §3.4's one forbidden shortcut, and worth 82.6 px at 3456 wide.
    const state = resolve(this.#timeline, t);
    // The frame's only source-time truth, read out before anything else runs. `state`
    // is the timeline's own object and every `resolve` overwrites it in place — and
    // `seek()` resolves too, through `#sourceTime()` — so a caller's `onError` that
    // re-enters `seek` during `render`, `present` or `#report` would move
    // `state.sourceTime` under the rest of this frame. Nothing below may re-derive it:
    // the four source-domain calls are the same instant by construction, not by the
    // order they happen to sit in.
    const sourceTime = state.sourceTime;

    const frame = this.#screen.frameAt(sourceTime);
    let composited = false;
    try {
      this.#frames.screen = frame;
      this.#compositor.render(this.#frames, state);
      this.#compositor.present();
      composited = true;
    } catch (thrown) {
      // A refused frame — a `blur` or `mask` whose region could not be read — is
      // loud and is not fatal. `Compositor.render` has already cleared the target on
      // its way out, so there is nothing unredacted to publish; `present` is skipped
      // rather than flashing the background over a composite that was correct.
      //
      // The loop keeps running either way. A throw that escaped this callback would
      // leave `#handle` null while `#running` stayed true, which makes `start()` an
      // early return and the loop unrevivable without a `stop()`/`start()` pair — a
      // wedge, not a safety property, and one that reports nothing at all.
      this.#report(thrown);
    } finally {
      // Held only for the length of the draw, on every path out. The ring still owns
      // it; dropping the reference here means nothing out of this function keeps a
      // frame alive (§10.2).
      this.#frames.screen = null;
    }
    // A held frame is not a clean frame. §4.3's hold makes `render` return without
    // drawing when `frameAt` missed, so it composited nothing and is evidence of
    // neither the condition nor its absence — clearing a latch on one would let a
    // seek's alternating misses re-report a persistent document error at frame rate,
    // which is the spam the latch exists to prevent.
    const drew = composited && frame !== null;
    if (drew) this.#refusalReported = false;

    const elapsed = this.#now() - started;
    this.metrics.record(elapsed);

    const live = this.#screen.liveFrames;
    if (live > this.#peakLiveFrames) this.#peakLiveFrames = live;

    // Every callback that can reach the caller sits below the measurement, for the
    // reason `#prime` states: a handler of theirs must not be charged to a frame the
    // phase-6 gate judges on the single worst one, with no allowance.
    this.#watchStall(frame !== null, sourceTime, t, started);
    this.#watchAnnotations(drew);

    // Off the critical path, after the budget has been measured (§4.3).
    this.#prime(sourceTime);
    // Behind the *source* read head. Released in timeline time this is wrong in both
    // directions, and asymmetrically so: with a large `sourceStart` it names an instant
    // before the media begins and frees nothing, while on a *slow* clip — where timeline
    // time runs ahead of source time — it names one the read head has not reached and
    // closes frames still to be drawn. At `speed: 0.5`, timeline 10 is source 5, so
    // `release(9.9)` would close source 5..9.9, none of it drawn yet. A fast clip fails
    // the other way and merely frees too little: at `speed: 2`, timeline 5 is source 10
    // and `release(4.9)` sits far behind the head.
    this.#screen.release(sourceTime - this.#retainBehindSec);
    return elapsed;
  }

  /** The source instant the playhead is on. See {@link PreviewSource}. */
  #sourceTime(): Seconds {
    return resolve(this.#timeline, this.#time).sourceTime;
  }

  #prime(sourceTime: Seconds): void {
    void this.#screen.prime(sourceTime, this.#lookaheadSec).catch((error: unknown) => {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * The first refused frame of a run.
   *
   * Cleared by the next frame that actually draws. A §4.3 hold is not one: it leaves
   * the previous composite in the target without running a pass over it, so it says
   * nothing about whether the document can still be redacted.
   */
  #report(thrown: unknown): void {
    if (this.#refusalReported) return;
    this.#refusalReported = true;
    this.#onError(thrown instanceof Error ? thrown : new Error(String(thrown)));
  }

  /**
   * What the annotation passes drew nothing for — a `text` span with no atlas, a
   * stroke with no scratch target.
   *
   * Neither is a refusal: they are cosmetic and *visible*, where a redaction failing
   * is invisible and publishes a secret. Neither is silent either — a caption or a
   * line the user believes is in their video and is not is exactly the bug report
   * these counts exist to pre-empt, and a count nobody reads buys none of that.
   *
   * A rising count is evidence wherever it comes from — a frame that refused still
   * skipped its text on the way to refusing — so `drew` gates only the *clear*. A
   * §4.3 hold ran no pass, so it cannot raise a count and must not be read as the
   * condition having gone away.
   */
  #watchAnnotations(drew: boolean): void {
    const counts = this.#compositor.annotations;
    for (const condition of this.#degradations) {
      const count = condition.read(counts);
      const skipped = count > condition.seen;
      condition.seen = count;
      if (!skipped) {
        if (drew) condition.reported = false;
        continue;
      }
      if (condition.reported) continue;
      condition.reported = true;
      this.#onError(new Error(condition.message));
    }
  }

  /**
   * §10.2's watchdog.
   *
   * `sourceTime` is what the source is asked about and what is reported: the whole
   * question is whether the *media* has a frame the ring failed to produce, and asked
   * at the timeline instant instead it is a question about a different moment of the
   * recording — which over any non-identity clip list answers "no frame here", resets
   * the watch on every frame, and turns §10.2's *"fails loudly after 5 s with no
   * progress"* into a silent freeze. `timelineSec` rides along because that is the
   * number a scrub bar is showing while it happens.
   */
  #watchStall(hit: boolean, sourceTime: Seconds, timelineSec: Seconds, nowMs: number): void {
    if (hit || !this.#screen.hasSourceFrameAt(sourceTime)) {
      this.#resetStallWatch();
      return;
    }
    this.#missingSinceMs ??= nowMs;
    const forMs = nowMs - this.#missingSinceMs;
    if (forMs >= STALL_TIMEOUT_MS && !this.#stallReported) {
      this.#stallReported = true;
      this.#onStall({ atSec: sourceTime, timelineSec, forMs });
    }
  }

  #resetStallWatch(): void {
    this.#missingSinceMs = null;
    this.#stallReported = false;
  }
}
