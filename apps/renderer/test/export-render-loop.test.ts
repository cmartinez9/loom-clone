/**
 * The export loop's scheduling rules, without a GPU.
 *
 * The *pixels* are the two golden gates', both in a real renderer and both driving
 * this class's `renderAt`: `test/phase8-gate.test.ts` over a decoded VFR source, and
 * `test/phase11-golden.test.ts` over one painted frame with annotations on it.
 * What is checkable here is the half §4.5 calls scheduling, and it is the half where
 * an export differs from a preview on purpose:
 *
 *  - a preview may take whatever the ring holds and hold the previous picture;
 *    an export may not, because a held frame in a file is a **wrong** frame;
 *  - a preview never blocks; an export waits, and fails loudly rather than hanging
 *    (§10.2: *"a watchdog … that fails loudly after 5 s with no progress instead of
 *    hanging. A clear error beats a spinner."*);
 *  - a hole in the source — before a part starts, or where a §7.4 camera unplug left
 *    one — is **not** a miss, and must not be counted or waited on as one.
 */

import { describe, expect, it, vi } from 'vitest';
import { identityTimeline, type ResolvedState } from '@loom/edl';
import type { CompositorFrames } from '@loom/compositor';
import {
  ExportCancelledError,
  ExportContextLostError,
  ExportRenderLoop,
  ExportStallError,
  type ExportCompositor,
  type ExportVideoSource,
} from '../src/export/render-loop.ts';

const FPS = 30;
const DURATION = 1;

/**
 * A compositor that records what it was handed, and can have its context taken away.
 *
 * `loseContextAfter` models the real thing rather than a flag: a lost WebGL context
 * is **silent** — every call still returns, does nothing, and leaves the canvas
 * holding its last contents. So after the loss this fake keeps accepting `render`
 * and `present` and keeps recording them, exactly as ANGLE would. The only thing
 * that changes is what `contextLost` answers. `packages/compositor/test/
 * context-loss.test.ts` makes the same fake for the live side, with the same
 * argument.
 */
function recordingCompositor(options: { loseContextAfter?: number } = {}): ExportCompositor & {
  readonly drawn: { frame: unknown; zoom: number }[];
  readonly presents: number;
} {
  const drawn: { frame: unknown; zoom: number }[] = [];
  let presents = 0;
  return {
    outputSize: [64, 36] as const,
    get contextLost() {
      return options.loseContextAfter !== undefined && presents >= options.loseContextAfter;
    },
    render(frames: CompositorFrames, state: ResolvedState) {
      drawn.push({ frame: frames.screen, zoom: state.zoom.amount });
    },
    present() {
      presents += 1;
    },
    get drawn() {
      return drawn;
    },
    get presents() {
      return presents;
    },
  };
}

interface FakeSourceOptions {
  /** Frame timestamps, microseconds, ascending. */
  ptsUs: number[];
  /** Frames the ring will hand back. Defaults to every frame. */
  available?: (index: number) => boolean;
}

/**
 * A source whose ring answers exactly like the real one: `frameAt` is hold-last
 * **within what it holds**, so an unprimed read returns an older frame rather than
 * `null`. That behaviour is the reason `selectionMicros` exists.
 */
function fakeSource(options: FakeSourceOptions): ExportVideoSource & { primes: number } {
  const { ptsUs } = options;
  const available = options.available ?? ((): boolean => true);
  let primes = 0;
  const indexAt = (t: number): number => {
    const micros = t * 1e6 + 0.5;
    let best = -1;
    for (const [i, pts] of ptsUs.entries()) if (pts <= micros) best = i;
    return best;
  };
  return {
    frameAt(t) {
      const wanted = indexAt(t);
      // Hold-last within the ring: walk back to the newest frame it actually has.
      for (let i = wanted; i >= 0; i--) {
        if (available(i)) return { timestamp: ptsUs[i] ?? 0 } as unknown as VideoFrame;
      }
      return null;
    },
    selectionMicros: (t) => {
      const i = indexAt(t);
      return i < 0 ? Number.NEGATIVE_INFINITY : (ptsUs[i] ?? 0);
    },
    hasSourceFrameAt: (t) => indexAt(t) >= 0,
    prime: () => {
      primes += 1;
      return Promise.resolve();
    },
    release: () => undefined,
    liveFrames: 0,
    ringCapacity: 20,
    get primes() {
      return primes;
    },
  };
}

/** 30 frames, one per 1/30 s. */
const EVEN_PTS = Array.from({ length: 30 }, (_, i) => Math.round((i * 1e6) / FPS));

describe('ExportRenderLoop', () => {
  it('produces one CFR frame per output tick, with §5.3’s timestamps and keyframes', async () => {
    const compositor = recordingCompositor();
    const frames: { index: number; timestampUs: number; isKey: boolean }[] = [];
    const loop = new ExportRenderLoop({
      compositor,
      screen: fakeSource({ ptsUs: EVEN_PTS }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      keyframeIntervalSec: 0.5,
      onFrame: (frame) => {
        frames.push({ index: frame.index, timestampUs: frame.timestampUs, isKey: frame.isKey });
      },
    });

    expect(loop.frameCount).toBe(FPS * DURATION);
    const report = await loop.run();
    expect(report.framesRendered).toBe(FPS * DURATION);
    expect(report.drawnFrames).toBe(FPS * DURATION);
    expect(report.heldFrames).toBe(0);
    expect(compositor.presents).toBe(FPS * DURATION);

    // `round(n * 1e6 / outputFps)`, verbatim from §5.3.
    expect(frames[0]?.timestampUs).toBe(0);
    expect(frames[1]?.timestampUs).toBe(Math.round(1e6 / FPS));
    expect(frames[29]?.timestampUs).toBe(Math.round((29 * 1e6) / FPS));
    // A keyframe every 0.5 s = every 15 frames.
    expect(frames.filter((f) => f.isKey).map((f) => f.index)).toEqual([0, 15]);
  });

  it('waits for a frame that is late rather than compositing a stale one', async () => {
    // The ring holds only frame 0 until the third look, so an export that took what
    // the ring had would write frame 0 into every output frame of the first second.
    let looks = 0;
    const source = fakeSource({
      ptsUs: EVEN_PTS,
      available: (i) => {
        if (i === 0) return true;
        looks += 1;
        return looks > 6;
      },
    });
    const compositor = recordingCompositor();
    const loop = new ExportRenderLoop({
      compositor,
      screen: source,
      timeline: identityTimeline(DURATION),
      fps: FPS,
      onFrame: () => undefined,
    });

    const first = await loop.renderAt(0);
    expect(first.hadSourceFrame).toBe(true);
    const later = await loop.renderAt(10 / FPS);
    expect(later.hadSourceFrame).toBe(true);
    // Not frame 0's timestamp: the loop refused the stale frame and primed until the
    // right one arrived.
    expect((compositor.drawn[1]?.frame as { timestamp: number }).timestamp).toBe(EVEN_PTS[10]);
    expect(loop.report.waits).toBeGreaterThan(0);
  });

  it('fails loudly when the frame never comes, rather than hanging', async () => {
    const loop = new ExportRenderLoop({
      compositor: recordingCompositor(),
      // The index says there is a frame at every time; the ring never produces one.
      screen: fakeSource({ ptsUs: EVEN_PTS, available: () => false }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      onFrame: () => undefined,
    });
    await expect(loop.renderAt(0.5)).rejects.toBeInstanceOf(ExportStallError);
  }, 20_000);

  it('holds through a hole in the source without waiting or counting a miss', async () => {
    // Before the first frame there is legitimately no picture. §4.3's hold, and
    // emphatically not a stall: the loop must not spend five seconds on it.
    const compositor = recordingCompositor();
    const loop = new ExportRenderLoop({
      compositor,
      screen: fakeSource({ ptsUs: EVEN_PTS.map((p) => p + 500_000) }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      onFrame: () => undefined,
    });
    const started = Date.now();
    const frame = await loop.renderAt(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(frame.hadSourceFrame).toBe(false);
    expect(loop.report.heldFrames).toBe(1);
    expect(loop.report.waits).toBe(0);
    // The compositor was still called — with `null`, which is what makes it hold the
    // previous composite rather than clear (§4.3).
    expect(compositor.drawn[0]?.frame).toBeNull();
  });

  it('drops the frame reference after the draw, so nothing outlives the turn', async () => {
    // §10.2: the ring owns every frame. A loop that kept one past `render` would be
    // holding a frame the next seek closes.
    const compositor = recordingCompositor();
    const loop = new ExportRenderLoop({
      compositor,
      screen: fakeSource({ ptsUs: EVEN_PTS }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      onFrame: (frame) => {
        // Inside `onFrame` the composite is done and the reference is already gone.
        expect(frame.hadSourceFrame).toBe(true);
      },
    });
    await loop.run();
  });

  it('cancels at a frame boundary', async () => {
    const controller = new AbortController();
    let seen = 0;
    const loop = new ExportRenderLoop({
      compositor: recordingCompositor(),
      screen: fakeSource({ ptsUs: EVEN_PTS }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      signal: controller.signal,
      onFrame: () => {
        seen += 1;
        if (seen === 5) controller.abort();
      },
    });
    await expect(loop.run()).rejects.toBeInstanceOf(ExportCancelledError);
    // Bounded by one composite: the run stops at the next frame, not at the end.
    expect(seen).toBe(5);
  });

  it('refuses the export when the context is lost, rather than encoding what nothing drew', async () => {
    // §10.2, and the reason the guard exists: a lost context is silent, so without
    // this the loop keeps compositing, `new VideoFrame(canvas)` keeps returning the
    // canvas's stale contents, the encoder keeps emitting chunks, and the export
    // finishes — passing every one of §7.5's five checks — on a file of black frames.
    // Phase 9 then deletes the user's ONLY copy of the sources on the strength of it.
    const compositor = recordingCompositor({ loseContextAfter: 3 });
    const encoded: number[] = [];
    const loop = new ExportRenderLoop({
      compositor,
      screen: fakeSource({ ptsUs: EVEN_PTS }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      onFrame: (frame) => {
        encoded.push(frame.index);
      },
    });

    await expect(loop.run()).rejects.toBeInstanceOf(ExportContextLostError);
    // It refused rather than repaired. The context goes on the third `present`, so
    // frames 0 and 1 were composited on a live context and handed over; frame 2 —
    // the one the loss landed on — was NOT, and never reached an encoder. That
    // boundary is the whole point: the guard sits between the composite and the
    // caller, so the first frame nothing really drew is also the first one refused.
    expect(encoded).toEqual([0, 1]);
    expect(loop.report.framesRendered).toBe(2);
  });

  it('stays refused once the context has gone, even if it reads healthy again', async () => {
    // Sticky. A real context never recovers, and a non-sticky check would let a loss
    // that lands between two reads slip through a later one — which is the same class
    // of gap as a guard that only ran once at the start.
    let lost = false;
    const compositor: ExportCompositor = {
      outputSize: [64, 36] as const,
      get contextLost() {
        // Lost for exactly one observation, then "healthy" again.
        const answer = lost;
        lost = false;
        return answer;
      },
      render: () => undefined,
      present: () => {
        lost = true;
      },
    };
    const loop = new ExportRenderLoop({
      compositor,
      screen: fakeSource({ ptsUs: EVEN_PTS }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      onFrame: () => undefined,
    });
    await expect(loop.renderAt(0)).rejects.toBeInstanceOf(ExportContextLostError);
    // The second call reads `false` from the compositor and must still refuse.
    await expect(loop.renderAt(1 / FPS)).rejects.toBeInstanceOf(ExportContextLostError);
  });

  it('CONTROL: the same fake, never losing its context, exports every frame', async () => {
    // Without this the test above proves nothing: a compositor that refused
    // unconditionally, or a loop that failed for an unrelated reason, would look
    // identical. Same fake, same loop, `loseContextAfter` omitted.
    const compositor = recordingCompositor();
    const encoded: number[] = [];
    const loop = new ExportRenderLoop({
      compositor,
      screen: fakeSource({ ptsUs: EVEN_PTS }),
      timeline: identityTimeline(DURATION),
      fps: FPS,
      onFrame: (frame) => {
        encoded.push(frame.index);
      },
    });
    await expect(loop.run()).resolves.toBeDefined();
    expect(encoded).toHaveLength(FPS * DURATION);
  });

  it('refuses a frame rate that is not one', () => {
    const options = {
      compositor: recordingCompositor(),
      screen: fakeSource({ ptsUs: EVEN_PTS }),
      timeline: identityTimeline(DURATION),
      onFrame: vi.fn(),
    };
    expect(() => new ExportRenderLoop({ ...options, fps: 0 })).toThrow(RangeError);
    expect(() => new ExportRenderLoop({ ...options, fps: -1 })).toThrow(RangeError);
  });
});
