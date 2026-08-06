/**
 * The preview loop's contract, driven by a synthetic scheduler.
 *
 * The 16 ms budget itself is asserted against a real 4K decode and a real WebGL2
 * context in `test/gate/`. What is checked here is everything about the loop that
 * a stopwatch cannot see: that it never awaits decode, that a miss holds rather
 * than blocks, that a borrowed frame is not retained past the draw, and that the
 * §10.2 watchdog fires on a real stall and *not* on an idle desktop — which is the
 * distinction that makes it useful rather than noisy.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CompositorFrames } from '@loom/compositor';
import { identityTimeline, type ResolvedState } from '@loom/edl';
import {
  PreviewLoop,
  type FrameScheduler,
  type PreviewCompositor,
  type PreviewSource,
} from '../src/preview/preview-loop.ts';

/** A scheduler the test steps by hand, so "one frame" means one frame. */
class ManualScheduler implements FrameScheduler {
  #next = 1;
  #pending = new Map<number, (nowMs: number) => void>();
  nowMs = 0;

  request(callback: (nowMs: number) => void): number {
    const handle = this.#next++;
    this.#pending.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.#pending.delete(handle);
  }

  /** Advance the clock and run whatever was scheduled. */
  tick(deltaMs = 16): void {
    this.nowMs += deltaMs;
    const due = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, callback] of due) callback(this.nowMs);
  }

  get pending(): number {
    return this.#pending.size;
  }
}

interface RecordingCompositor {
  render(frames: CompositorFrames, state: ResolvedState): void;
  present(): void;
  readonly renders: { screen: VideoFrame | null; time: number }[];
  readonly presents: number;
}

function recordingCompositor(): RecordingCompositor {
  const renders: { screen: VideoFrame | null; time: number }[] = [];
  let presents = 0;
  return {
    render(frames, state) {
      renders.push({ screen: frames.screen, time: state.sourceTime });
    },
    present() {
      presents += 1;
    },
    renders,
    get presents() {
      return presents;
    },
  };
}

interface StubSource extends PreviewSource {
  primeCalls: { t: number; ahead: number }[];
  releaseCalls: number[];
  frames: Map<number, VideoFrame>;
  liveFrames: number;
  primeResult: Promise<void>;
}

function stubSource(
  options: { has?: (t: number) => boolean; frameAt?: (t: number) => VideoFrame | null } = {},
): StubSource {
  const source = {
    primeCalls: [] as { t: number; ahead: number }[],
    releaseCalls: [] as number[],
    frames: new Map<number, VideoFrame>(),
    liveFrames: 0,
    ringCapacity: 20,
    primeResult: Promise.resolve(),
    frameAt(t: number) {
      return options.frameAt?.(t) ?? null;
    },
    prime(t: number, ahead: number) {
      source.primeCalls.push({ t, ahead });
      return source.primeResult;
    },
    release(t: number) {
      source.releaseCalls.push(t);
    },
    hasSourceFrameAt(t: number) {
      return options.has?.(t) ?? true;
    },
  };
  return source;
}

/** A stand-in for a decoded frame. The loop only ever passes it through. */
function fakeVideoFrame(timestampUs: number): VideoFrame {
  return { timestamp: timestampUs, close: () => undefined } as unknown as VideoFrame;
}

/**
 * A compositor that models the real one's **render target**, so "nothing unredacted
 * is left presentable" can be asserted rather than assumed.
 *
 * `render` puts the screen picture in the target and then the annotations over it;
 * a redaction it cannot place clears the target to the background *before* the throw
 * leaves, which is `Compositor.render`'s contract. `present` publishes whatever the
 * target holds at that moment. The test can therefore look at both what a caller
 * could publish and what one actually did.
 */
class TargetCompositor implements PreviewCompositor {
  /** What a `present()` would publish right now. */
  target: 'background' | 'unredacted-screen' | 'redacted-composite' = 'background';
  /** What the last `present()` did publish. */
  published: 'nothing' | 'background' | 'unredacted-screen' | 'redacted-composite' = 'nothing';
  /** The frames object the loop handed over, kept so the test can look at it after. */
  handed: CompositorFrames | null = null;
  /** Stands in for a `blur` span whose region cannot be read. */
  refuse = false;
  /** Stands in for a `text` span drawn with no atlas: skipped, counted, not fatal. */
  skipText = false;
  renders = 0;
  presents = 0;
  readonly annotations = { textSpansWithoutAtlas: 0 };

  render(frames: CompositorFrames): void {
    this.renders += 1;
    this.handed = frames;
    this.target = 'unredacted-screen';
    if (this.skipText) this.annotations.textSpansWithoutAtlas += 1;
    if (this.refuse) {
      this.target = 'background';
      throw new Error('annotation "a-blur": blur has no usable `center` channel');
    }
    this.target = 'redacted-composite';
  }

  present(): void {
    this.presents += 1;
    this.published = this.target;
  }
}

function loopWith(
  source: StubSource,
  extra: Partial<{
    onStall: (info: { atSec: number; forMs: number }) => void;
    onError: (e: Error) => void;
  }> = {},
): { loop: PreviewLoop; scheduler: ManualScheduler; compositor: RecordingCompositor } {
  const scheduler = new ManualScheduler();
  const compositor = recordingCompositor();
  const loop = new PreviewLoop({
    compositor,
    screen: source,
    durationSec: 10,
    scheduler,
    now: () => scheduler.nowMs,
    ...extra,
  });
  return { loop, scheduler, compositor };
}

describe('PreviewLoop', () => {
  it('renders and presents once per scheduled frame, and keeps scheduling', () => {
    const source = stubSource();
    const { loop, scheduler, compositor } = loopWith(source);
    loop.start();
    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    loop.stop();
    expect(compositor.renders.length).toBe(3);
    expect(compositor.presents).toBe(3);
    expect(scheduler.pending).toBe(0);
  });

  it('advances by wall clock while playing, and stops at the duration', () => {
    const source = stubSource();
    const { loop, scheduler } = loopWith(source);
    loop.play();
    scheduler.tick(0); // first frame establishes the clock reference
    scheduler.tick(1000);
    expect(loop.time).toBeCloseTo(1, 6);
    scheduler.tick(20_000);
    expect(loop.time).toBe(10);
    expect(loop.playing).toBe(false);
    loop.stop();
  });

  it('keeps the duration and the compiled timeline the same number', () => {
    // `resolve` clamps into `CompiledTimeline.durationSec`, so a duration held apart
    // from the timeline would let the playhead run past a `sourceTime` that had
    // stopped moving — the preview frozen on the last frame, with no error anywhere.
    const source = stubSource();
    const { loop, scheduler } = loopWith(source);
    loop.durationSec = 30;
    expect(loop.durationSec).toBe(30);
    expect(loop.timeline.durationSec).toBe(30);

    loop.play();
    scheduler.tick(0);
    scheduler.tick(20_000);
    expect(loop.time).toBeCloseTo(20, 6);
    expect(loop.playing).toBe(true);
    loop.stop();

    // And a caller who compiled their own timeline owns the duration: re-lengthing
    // it here would silently throw their edits away.
    loop.timeline = identityTimeline(12);
    expect(loop.durationSec).toBe(12);
    // A shorter timeline takes the playhead with it. `resolve` clamps internally so
    // the picture is right either way, but `time` is what a scrub bar reads, and a
    // paused loop reporting 20 s of a 12 s project is a playhead off its own track.
    expect(loop.time).toBe(12);
    expect(() => {
      loop.durationSec = 40;
    }).toThrow(/timeline/);
  });

  it('brings the playhead back inside a shortened duration', () => {
    const source = stubSource();
    const { loop } = loopWith(source);
    loop.durationSec = 30;
    loop.seek(25);
    loop.durationSec = 12;
    expect(loop.time).toBe(12);
  });

  it('does not advance while paused, so a seek stays put', () => {
    const source = stubSource();
    const { loop, scheduler } = loopWith(source);
    loop.start();
    loop.seek(4.2);
    scheduler.tick(500);
    scheduler.tick(500);
    expect(loop.time).toBeCloseTo(4.2, 6);
    loop.stop();
  });

  it('primes off the critical path and never awaits it — §4.3', () => {
    const source = stubSource();
    // A prime that never settles must not stop the loop rendering.
    source.primeResult = new Promise<void>(() => undefined);
    const { loop, scheduler, compositor } = loopWith(source);
    loop.play();
    for (let i = 0; i < 5; i++) scheduler.tick();
    loop.stop();
    expect(compositor.renders.length).toBe(5);
    expect(source.primeCalls.length).toBeGreaterThanOrEqual(5);
    expect(source.primeCalls.every((call) => call.ahead === 0.5)).toBe(true);
  });

  it('reports a prime failure rather than swallowing it into an unhandled rejection', async () => {
    const source = stubSource();
    source.primeResult = Promise.reject(new Error('loom://: HTTP 404'));
    const onError = vi.fn();
    const { loop, scheduler } = loopWith(source, { onError });
    loop.start();
    scheduler.tick();
    loop.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/404/);
  });

  it('holds nothing: the borrowed frame is dropped after the draw', () => {
    const frame = fakeVideoFrame(0);
    const source = stubSource({ frameAt: () => frame });
    const scheduler = new ManualScheduler();
    // Keep the very object the loop hands to `render`, so the test can look at it
    // once the frame body has returned.
    let handed: CompositorFrames | null = null;
    const loop = new PreviewLoop({
      compositor: {
        render: (frames) => {
          handed = frames;
          expect(frames.screen).toBe(frame);
        },
        present: () => undefined,
      },
      screen: source,
      durationSec: 10,
      scheduler,
      now: () => scheduler.nowMs,
    });

    loop.start();
    scheduler.tick();
    loop.stop();

    // The loop reuses one frames object (§4.3: nothing allocates in the loop), and
    // clears its reference before returning. The ring is then the only owner, which
    // is what lets `releaseBefore` close the frame on schedule (§10.2).
    expect(handed).not.toBeNull();
    expect((handed as unknown as CompositorFrames).screen).toBeNull();
  });

  it('hands the compositor the text atlas it was constructed with, every frame', () => {
    // The atlas is an object identity, not a value: `@loom/compositor/raster` is
    // explicit that preview and export must share *one* raster, and the loop's job
    // is to pass along whatever it was given rather than to fetch one of its own.
    const atlas = { capHeight: 0.7 } as unknown as NonNullable<CompositorFrames['textAtlas']>;
    const scheduler = new ManualScheduler();
    const seen: unknown[] = [];
    const loop = new PreviewLoop({
      compositor: {
        render: (frames) => {
          seen.push(frames.textAtlas);
        },
        present: () => undefined,
      },
      screen: stubSource(),
      durationSec: 10,
      textAtlas: atlas,
      scheduler,
      now: () => scheduler.nowMs,
    });

    loop.start();
    scheduler.tick();
    scheduler.tick();
    loop.stop();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(atlas);
    expect(seen[1]).toBe(atlas);
  });

  it('defaults the atlas to null rather than leaving it undefined', () => {
    const scheduler = new ManualScheduler();
    let handed: CompositorFrames | null = null;
    const loop = new PreviewLoop({
      compositor: {
        render: (frames) => {
          handed = frames;
        },
        present: () => undefined,
      },
      screen: stubSource(),
      durationSec: 10,
      scheduler,
      now: () => scheduler.nowMs,
    });
    loop.start();
    scheduler.tick();
    loop.stop();
    expect((handed as unknown as CompositorFrames).textAtlas).toBeNull();
  });

  it('reuses one frames object and one state object across frames — §4.3', () => {
    const source = stubSource({ frameAt: () => fakeVideoFrame(0) });
    const scheduler = new ManualScheduler();
    const seenFrames = new Set<CompositorFrames>();
    const seenStates = new Set<ResolvedState>();
    const loop = new PreviewLoop({
      compositor: {
        render: (frames, state) => {
          seenFrames.add(frames);
          seenStates.add(state);
        },
        present: () => undefined,
      },
      screen: source,
      durationSec: 10,
      scheduler,
      now: () => scheduler.nowMs,
    });
    loop.play();
    for (let i = 0; i < 20; i++) scheduler.tick();
    loop.stop();
    expect(seenFrames.size).toBe(1);
    expect(seenStates.size).toBe(1);
  });

  it('releases behind the playhead so the ring drains as playback advances', () => {
    const source = stubSource();
    const { loop, scheduler } = loopWith(source);
    loop.play();
    scheduler.tick(0);
    scheduler.tick(1000);
    loop.stop();
    const last = source.releaseCalls[source.releaseCalls.length - 1] ?? 0;
    expect(last).toBeCloseTo(loop.time - 0.1, 6);
  });

  it('tracks the live-frame high-water mark for the gate to assert on', () => {
    const source = stubSource();
    const { loop, scheduler } = loopWith(source);
    loop.start();
    source.liveFrames = 3;
    scheduler.tick();
    source.liveFrames = 17;
    scheduler.tick();
    source.liveFrames = 2;
    scheduler.tick();
    loop.stop();
    expect(loop.peakLiveFrames).toBe(17);
  });

  it('records frame time as the work, not the interval between callbacks', () => {
    const source = stubSource();
    const scheduler = new ManualScheduler();
    const compositor = recordingCompositor();
    // A `now()` that jumps 4 ms across each frame body, inside 16 ms callbacks.
    let reads = 0;
    const loop = new PreviewLoop({
      compositor,
      screen: source,
      durationSec: 10,
      scheduler,
      now: () => {
        const value = scheduler.nowMs + (reads % 2 === 0 ? 0 : 4);
        reads += 1;
        return value;
      },
    });
    loop.start();
    scheduler.tick(16);
    scheduler.tick(16);
    loop.stop();
    expect(loop.metrics.count).toBe(2);
    expect(loop.metrics.maxMs).toBeCloseTo(4, 6);
    expect(loop.metrics.overBudget).toBe(0);
  });
});

describe('PreviewLoop and the annotation surface’s two failure modes', () => {
  function refusingLoop(compositor: TargetCompositor): {
    loop: PreviewLoop;
    scheduler: ManualScheduler;
    onError: ReturnType<typeof vi.fn>;
  } {
    const scheduler = new ManualScheduler();
    const onError = vi.fn();
    const loop = new PreviewLoop({
      compositor,
      screen: stubSource({ frameAt: () => fakeVideoFrame(0) }),
      durationSec: 10,
      scheduler,
      now: () => scheduler.nowMs,
      onError,
    });
    return { loop, scheduler, onError };
  }

  it('degrades a text span with no atlas, and reports it once per run rather than per frame', () => {
    // Refusing a frame is `blur` and `mask`'s alone: text failing to render is
    // cosmetic and visible, where a redaction failing is invisible and publishes a
    // secret. `textAtlas` defaults to null, so the wider rule made *any* text span
    // refuse *every* frame with no editor open at all.
    const compositor = new TargetCompositor();
    compositor.skipText = true;
    const { loop, scheduler, onError } = refusingLoop(compositor);

    loop.start();
    for (let i = 0; i < 30; i++) scheduler.tick();

    expect(compositor.renders).toBe(30);
    expect(compositor.presents).toBe(30);
    expect(compositor.published).toBe('redacted-composite');
    expect(loop.running).toBe(true);
    expect(scheduler.pending).toBe(1);
    // Once for the run, not sixty times a second.
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/atlas/);

    // And the latch clears with the condition, so a later run is reported again.
    compositor.skipText = false;
    for (let i = 0; i < 5; i++) scheduler.tick();
    expect(onError).toHaveBeenCalledOnce();
    compositor.skipText = true;
    scheduler.tick();
    expect(onError).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('refuses an unplaceable redaction loudly, without publishing it, leaking it or wedging', () => {
    const compositor = new TargetCompositor();
    const { loop, scheduler, onError } = refusingLoop(compositor);

    loop.start();
    scheduler.tick();
    expect(compositor.published).toBe('redacted-composite');

    compositor.refuse = true;
    for (let i = 0; i < 30; i++) scheduler.tick();

    // Loud: a refused redaction was the whole point of failing closed.
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/center/);
    // Non-publishing: neither what a caller could present nor what one did present is
    // the screen picture with the redaction missing.
    expect(compositor.target).toBe('background');
    expect(compositor.published).not.toBe('unredacted-screen');
    expect(compositor.presents).toBe(1);
    // Leak-free: §10.2's `VideoFrame` lifetime holds on the throw path too.
    expect(compositor.handed).not.toBeNull();
    expect(compositor.handed?.screen).toBeNull();
    // Not wedged: the loop is still running and the next frame is still armed.
    expect(loop.running).toBe(true);
    expect(scheduler.pending).toBe(1);
    expect(compositor.renders).toBe(31);

    // Revivable in both senses: the next placeable frame composites and presents,
    // and a `stop()`/`start()` pair still re-arms the scheduler.
    compositor.refuse = false;
    scheduler.tick();
    expect(compositor.published).toBe('redacted-composite');
    compositor.refuse = true;
    scheduler.tick();
    expect(onError).toHaveBeenCalledTimes(2);

    loop.stop();
    expect(scheduler.pending).toBe(0);
    loop.start();
    expect(scheduler.pending).toBe(1);
    loop.stop();
  });
});

describe('PreviewLoop stall watchdog — §10.2', () => {
  it('fires when the source says a frame exists and decode never delivers it', () => {
    const onStall = vi.fn();
    const source = stubSource({ frameAt: () => null, has: () => true });
    const { loop, scheduler } = loopWith(source, { onStall });
    loop.play();
    for (let i = 0; i < 400; i++) scheduler.tick(16);
    loop.stop();
    expect(onStall).toHaveBeenCalledOnce();
    expect((onStall.mock.calls[0]?.[0] as { forMs: number }).forMs).toBeGreaterThanOrEqual(5000);
  });

  it('does NOT fire on an idle desktop, where there is legitimately no frame', () => {
    // The scout measured ScreenCaptureKit at 1.4 fps on an idle desktop (§4.2). A
    // watchdog that treated "no new frame for five seconds" as a stall would fire
    // constantly on exactly the recordings this app is for.
    const onStall = vi.fn();
    const source = stubSource({ frameAt: () => null, has: () => false });
    const { loop, scheduler } = loopWith(source, { onStall });
    loop.play();
    for (let i = 0; i < 400; i++) scheduler.tick(16);
    loop.stop();
    expect(onStall).not.toHaveBeenCalled();
  });

  it('does not fire while frames are arriving, and resets on a seek', () => {
    const onStall = vi.fn();
    let hit = true;
    const source = stubSource({ frameAt: () => (hit ? fakeVideoFrame(0) : null), has: () => true });
    const { loop, scheduler } = loopWith(source, { onStall });
    loop.play();
    for (let i = 0; i < 100; i++) scheduler.tick(16);
    hit = false;
    for (let i = 0; i < 200; i++) scheduler.tick(16);
    loop.seek(1); // a seek is progress; the clock starts again
    for (let i = 0; i < 200; i++) scheduler.tick(16);
    loop.stop();
    expect(onStall).not.toHaveBeenCalled();
  });
});
