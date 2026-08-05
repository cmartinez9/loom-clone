/**
 * Phase 6's gate, run for real.
 *
 * Architecture report §8: *"Scrub and play a 4K fixture with **no frame over
 * 16 ms** at 1440p viewport; live `VideoFrame` count never exceeds the ring cap."*
 *
 * This runs in an Electron renderer because that is the only place the claim can
 * actually be tested: a real `VideoDecoder`, a real WebGL2 context on ANGLE-Metal, a
 * real 4K H.264 stream, and the shipping `PreviewLoop` — not a copy of it. Node can
 * check the seek rule and the frame lifetimes (`packages/decode/test`), and does;
 * it cannot check a frame budget.
 *
 * ## Making the pass mean something
 *
 * A preview that draws nothing draws it in well under a millisecond, so a bare
 * timing assertion is satisfiable by a black screen. Three things stop that:
 *
 *  1. **Every scrub target is verified by reading pixels back.** The fixture encodes
 *     its frame number in a band of black-and-white cells; the gate composites,
 *     reads the framebuffer and decodes the number. Wrong frame, wrong number,
 *     failed gate.
 *  2. **Playback hit rate is reported and asserted.** Misses are what a starved
 *     decoder produces.
 *  3. **Warmup is measured and reported separately**, rather than being quietly
 *     excluded. Shader link and the first 4K texture upload are one-time costs; the
 *     numbers are in the report either way.
 *  4. **The composite is sampled all the way through each scrub's settle window**,
 *     not only once it has settled. That window is composited entirely out of
 *     `frameAt` misses, so it is where §4.3's "a miss holds the previous frame"
 *     either happens or does not — and a run that flashed the background through
 *     every backward scrub would otherwise pass 1, 2 and 3 unchanged. The detector
 *     has a control of its own at the end of the run.
 *
 * ## Making the *budget* mean something on a host that cannot hold it
 *
 * §8's bound is asserted on the worst frame with no allowance, which is right, and on
 * a shared paravirtual CI host that bound has been decided by the host rather than by
 * the renderer. So an environment control runs inside the measured phases' own frames —
 * a fixed span of arithmetic with none of this code in it, taken a quarter of the wall
 * clock at a time — and a second control runs a deliberately-slowed compositor through
 * the same instrument so the first can never become an escape hatch.
 * `budget-control.ts` is the whole argument; `test/phase6-gate.test.ts` is where both
 * are judged.
 */

import { Compositor, contentRect, describeRenderer } from '@loom/compositor';
import { DemuxIndex, fetchByteRangeReader, hasWebCodecs, SourceReader } from '@loom/decode';
import {
  FRAME_BUDGET_MS,
  PreviewLoop,
  type FrameScheduler,
  type PreviewSource,
} from '../../apps/renderer/src/preview/index.ts';
import { burn, controlSink, EnvironmentControl, NO_CONTROL } from './budget-control.ts';
import { CODE_BIT_COUNT, codeCellCenter, FIXTURE_SIZE, generate4kPart } from './fixture.ts';
import type { GateBridge, GateReport, PhaseMetrics, PlaySample, ScrubCheck } from './report.ts';

declare global {
  interface Window {
    gate: GateBridge;
  }
}

/** §8's "1440p viewport". */
const VIEWPORT: [number, number] = [2560, 1440];
const MEDIA_PATH = 'media/screen.000.h264';
const WARMUP_FRAMES = 12;
const SCRUB_TARGETS = 12;
const SETTLE_TIMEOUT_MS = 4000;
/** Side of the block sampled to tell a picture from the letterbox background. */
const PROBE_PX = 8;
/**
 * Mean luma at or below this is the background, not a picture.
 *
 * The fixture paints every frame at 42% lightness under at most a 22% black
 * overlay, so the darkest legitimate composite reads about 57; the background is
 * exactly 0. The threshold sits far from both.
 */
const BLACK_LUMA = 8;
/**
 * The control for the environment control: how far past the budget a deliberately
 * slowed compositor is pushed, and for how many frames.
 *
 * Four budgets, not one over: the point is not that a slowed compositor scrapes past
 * the line but that it fails on either branch of the judgement — including the branch
 * that has just excused the host — and 66.67 ms clears the `TRACKS_CONTROL` ceiling on
 * any control reading that could have got there. Twenty-four frames costs under two
 * seconds and is enough for the gate to insist the phase really ran.
 */
const SLOW_COMPOSITE_MS = FRAME_BUDGET_MS * 4;
const SLOW_CONTROL_FRAMES = 24;

const logs: string[] = [];
function log(message: string): void {
  logs.push(message);
  window.gate.log(message);
}

/**
 * Whether the driver has taken the WebGL context away, and where we noticed.
 *
 * A lost context is silent by design: every GL call becomes a no-op, `readPixels`
 * leaves the caller's buffer exactly as it was, and `getParameter` answers `null`.
 * On a shared paravirtual GPU that has happened here mid-run, and without this the
 * gate went on measuring: every readback scratch kept the last pixels it had really
 * read, the whole-frame reader of the day flipped them in place so every other
 * reading came out upside down, and what emerged was a plausible-looking set of
 * wrong frame numbers and a control that could no longer see its own black. The
 * instrument dying has to be distinguishable from a result, so the run is abandoned
 * the moment it is seen — which is why every reader below checks *before* it reads.
 */
const lost: { where: string | null } = { where: null };

function checkContext(gl: WebGL2RenderingContext, where: string): void {
  if (lost.where === null && !gl.isContextLost()) return;
  lost.where ??= where;
  throw new Error(`the WebGL context was lost (noticed at ${lost.where}); the gate cannot measure`);
}

function snapshot(metrics: {
  count: number;
  maxMs: number;
  maxAt: number;
  meanMs: number;
  overBudget: number;
  percentileMs: (p: number) => number;
}): PhaseMetrics {
  return {
    count: metrics.count,
    maxMs: metrics.maxMs,
    maxAt: metrics.maxAt,
    meanMs: metrics.meanMs,
    p50Ms: metrics.percentileMs(0.5),
    p99Ms: metrics.percentileMs(0.99),
    overBudget: metrics.overBudget,
  };
}

/**
 * `requestAnimationFrame`, with a fallback for a renderer that is not producing
 * compositor frames.
 *
 * The measurement is per-frame *work*, so it does not depend on which of these
 * drives it — but the run does depend on something driving it at all, and a hidden
 * or occluded window on a headless CI machine may never tick rAF. Which one was
 * used is recorded in the report rather than hidden.
 */
async function chooseScheduler(): Promise<{ scheduler: FrameScheduler; mode: 'raf' | 'timer' }> {
  const ticked = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, 1000);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (ticked) {
    return {
      mode: 'raf',
      scheduler: {
        request: (callback) => requestAnimationFrame(callback),
        cancel: (handle) => {
          cancelAnimationFrame(handle);
        },
      },
    };
  }
  return {
    mode: 'timer',
    scheduler: {
      request: (callback) =>
        window.setTimeout(() => {
          callback(performance.now());
        }, 6),
      cancel: (handle) => {
        window.clearTimeout(handle);
      },
    },
  };
}

/**
 * A scheduler wrapper that lets the gate await "n more frames", and offers each of
 * them to the environment control.
 *
 * `afterFrame` is called immediately after the measured frame body returns, inside the
 * same scheduler dispatch. That placement is the whole value of the control: it is
 * exposed to the same host, in the same window, in the same frames as the measurement
 * it is a control for, rather than describing a machine from a second earlier. See
 * `budget-control.ts`.
 */
function counting(
  inner: FrameScheduler,
  afterFrame: () => void,
): {
  scheduler: FrameScheduler;
  frames: () => number;
  after: (n: number) => Promise<void>;
} {
  let frames = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  const scheduler: FrameScheduler = {
    request: (callback) =>
      inner.request((nowMs) => {
        callback(nowMs);
        afterFrame();
        frames += 1;
        for (let i = waiters.length - 1; i >= 0; i--) {
          const waiter = waiters[i];
          if (waiter !== undefined && frames >= waiter.at) {
            waiters.splice(i, 1);
            waiter.resolve();
          }
        }
      }),
    cancel: (handle) => {
      inner.cancel(handle);
    },
  };
  return {
    scheduler,
    frames: () => frames,
    after: (n) => new Promise<void>((resolve) => waiters.push({ at: frames + n, resolve })),
  };
}

/**
 * The row of the composite the frame-code band lands on, counted from the top.
 *
 * `fixture.ts` paints every cell of the band across the top of the frame, so all
 * twelve share one `v` and the whole code lives on a single row of the composited
 * picture. `-1` when it does not land inside the viewport at all.
 */
function codeRow(viewport: [number, number]): number {
  const content = contentRect(FIXTURE_SIZE, viewport);
  if (content.width < 1 || content.height < 1) return -1;
  const [, v] = codeCellCenter(0);
  const y = Math.round(content.y + v * content.height);
  return y < 0 || y >= viewport[1] ? -1 : y;
}

/** Decode the frame number out of that one row. `-1` when the band is unreadable. */
function readFrameCode(row: Uint8Array, viewport: [number, number]): number {
  const content = contentRect(FIXTURE_SIZE, viewport);
  if (content.width < 1 || content.height < 1) return -1;
  let value = 0;
  for (let bit = 0; bit < CODE_BIT_COUNT; bit++) {
    const [u] = codeCellCenter(bit);
    const x = Math.round(content.x + u * content.width);
    if (x < 0 || x >= viewport[0]) return -1;
    const offset = x * 4;
    const r = row[offset] ?? 0;
    const g = row[offset + 1] ?? 0;
    const b = row[offset + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Mid-grey is not a legitimate reading of a black-or-white cell; treat it as
    // unreadable rather than guessing, so a blurred or blank frame fails loudly.
    if (luma > 40 && luma < 215) return -1;
    if (luma >= 215) value |= 1 << bit;
  }
  return value;
}

async function run(): Promise<GateReport> {
  if (!hasWebCodecs()) throw new Error('this renderer has no WebCodecs; the gate cannot run');

  const options = await window.gate.options();
  log(`generating a ${String(FIXTURE_SIZE[0])}x${String(FIXTURE_SIZE[1])} fixture`);
  const part = await generate4kPart({ frameCount: options.frameCount, gopSize: options.gopSize });
  log(
    `encoded ${String(part.frameCount)} frames (${String(part.bytes.byteLength)} bytes, ` +
      `${part.hardwareAcceleration}) in ${part.encodeMs.toFixed(0)} ms`,
  );

  await window.gate.write(MEDIA_PATH, part.bytes);
  await window.gate.write(
    'media/screen.000.index.json',
    new TextEncoder().encode(JSON.stringify(part.doc)),
  );

  // From here on the gate reads the part exactly as the editor will: through
  // `loom://` with byte ranges, served by main's `serveFile` (§1.4, §2.4).
  const index = DemuxIndex.fromDoc(part.doc, MEDIA_PATH);
  const reader = new SourceReader({
    bytes: fetchByteRangeReader(`loom://fixture/${MEDIA_PATH}`, {
      byteLength: part.bytes.byteLength,
    }),
    index,
    config: part.config,
  });

  const canvas = document.createElement('canvas');
  canvas.width = VIEWPORT[0];
  canvas.height = VIEWPORT[1];
  document.body.append(canvas);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (gl === null) throw new Error('no WebGL2 context; the gate cannot run');
  // Recorded rather than prevented: every GL object this run depends on — the
  // program, the screen texture, the render target — goes with the context, so there
  // is nothing to restore into. What matters is knowing, and knowing early.
  canvas.addEventListener('webglcontextlost', () => {
    lost.where ??= 'the webglcontextlost event';
  });
  const compositor = new Compositor(gl, VIEWPORT);
  // Read here rather than only at the end: a context lost mid-run answers `null` to
  // every query, and "unknown" in the report should not be the first anyone hears.
  const glRenderer = describeRenderer(gl);
  log(`webgl2 renderer: ${glRenderer}`);

  const chosen = await chooseScheduler();
  // Armed per phase, below. Until then it is inert and costs a branch a frame.
  const control = new EnvironmentControl();
  const clock = counting(chosen.scheduler, () => {
    control.tick();
  });
  const trouble: { loopError: Error | null; stalled: string | null } = {
    loopError: null,
    stalled: null,
  };
  const loop = new PreviewLoop({
    compositor,
    screen: reader,
    durationSec: part.durationSec,
    scheduler: clock.scheduler,
    onError: (error) => {
      trouble.loopError = error;
    },
    onStall: (info) => {
      trouble.stalled = `preview stalled at ${info.atSec.toFixed(3)}s for ${info.forMs.toFixed(0)}ms`;
    },
  });

  // ---- reading the composite back ----------------------------------------
  // Both readers below read a *slice*, through `gl.readPixels` on the compositor's
  // own target, rather than calling `Compositor.readPixels`.
  //
  // A whole-frame readback at 1440p is 14.7 MB out of the GPU synchronously plus an
  // in-place flip of the same 14.7 MB, and the gate used to do exactly that eighteen
  // times — twelve scrub targets and six playback samples — *inside* the very windows
  // whose single worst frame it then judges against 16.7 ms with no allowance.
  //
  // Measured here, on an M5 Pro with hardware decode and everything else in this run
  // costing 0.2–0.5 ms a frame: **20.8 ms, 29.6 ms and 97.8 ms** for the three whole
  // frames, against **0.1–0.2 ms** for one row. One readback is one to six times the
  // entire frame budget, and the frame after it has to push a CPU-backed 30 MB
  // `texImage2D` through the transfer path it just drained — already ~5 ms of the
  // budget on the paravirtual GPU CI runs on. So the instrument was the largest
  // single cost in the window it was measuring, and it landed on a handful of frames
  // rather than spreading: CI reported one play frame at 82 ms and one at 180 ms in
  // runs whose own p99 was 2.2 ms and 6.6 ms, and 15.3 ms against a 16.7 ms bound in
  // the run either side of them that passed.
  //
  // Neither reader needs a whole frame. The settle probe needs eight by eight pixels
  // at the middle of the picture to tell a composite from the background; the frame
  // code needs exactly one row, because `fixture.ts` puts every cell of the band on
  // one. That is 82 KB across a run instead of 265 MB, and nothing the gate asserts
  // is read from a pixel that is no longer fetched.
  const bandRow = codeRow(VIEWPORT);
  if (bandRow < 0) throw new Error('the frame-code band does not land inside the viewport');
  const band = new Uint8Array(VIEWPORT[0] * 4);
  const readCode = (where: string): number => {
    // Before the read, for the same reason as the probe below: `readPixels` is a
    // no-op on a lost context and `band` is reused, so a stale row would decode into
    // a plausible frame number nothing ever composited.
    checkContext(gl, where);
    gl.bindFramebuffer(gl.FRAMEBUFFER, compositor.framebuffer);
    // `readPixels` is bottom-up; the band is `bandRow` rows down from the top.
    gl.readPixels(0, VIEWPORT[1] - 1 - bandRow, VIEWPORT[0], 1, gl.RGBA, gl.UNSIGNED_BYTE, band);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return readFrameCode(band, VIEWPORT);
  };

  const probe = new Uint8Array(PROBE_PX * PROBE_PX * 4);
  const content = contentRect(FIXTURE_SIZE, VIEWPORT);
  const centreLuma = (): number => {
    // Before the read, not after: a no-op `readPixels` would leave `probe` holding
    // the last picture it really saw, and every sample from then on would report a
    // lit composite whatever was — or was not — on screen.
    checkContext(gl, 'the settle probe');
    const x = Math.round(content.x + content.width / 2 - PROBE_PX / 2);
    // `readPixels` is bottom-up; the centre of the picture is the centre either way.
    const y = Math.round(VIEWPORT[1] - content.y - content.height / 2 - PROBE_PX / 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, compositor.framebuffer);
    gl.readPixels(x, y, PROBE_PX, PROBE_PX, gl.RGBA, gl.UNSIGNED_BYTE, probe);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let total = 0;
    for (let i = 0; i < probe.length; i += 4) {
      const r = probe[i] ?? 0;
      const g = probe[i + 1] ?? 0;
      const b = probe[i + 2] ?? 0;
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    return total / (PROBE_PX * PROBE_PX);
  };

  // ---- warmup: shader link is done, but the first 4K upload and the first decode
  // are one-time costs and belong in the report rather than in the budget.
  loop.seek(0);
  loop.start();
  await clock.after(WARMUP_FRAMES);
  const warmup = snapshot(loop.metrics);
  loop.metrics.reset();
  // Armed at exactly the frame the scrub phase's own metrics start from, and offered
  // every scheduler dispatch from here on — it spins on the ones a wall clock says to,
  // not on every one, because the display's refresh rate is not this gate's to choose.
  // What it does cost, a quarter of the thread, is deliberate: a control that costs
  // nothing is never exposed to what it exists to catch, since a host stall lands
  // inside a window in proportion to how much of the clock that window occupies.
  // `budget-control.ts` argues both halves.
  control.arm();

  // "The picture went black" only means something once there is a picture.
  const litAt = performance.now();
  while (centreLuma() <= BLACK_LUMA && performance.now() - litAt < SETTLE_TIMEOUT_MS) {
    await clock.after(1);
  }
  log(`first picture composited after ${(performance.now() - litAt).toFixed(0)} ms of warmup`);

  // ---- scrub -------------------------------------------------------------
  const scrubChecks: ScrubCheck[] = [];
  let settleSamples = 0;
  let settleBlackFrames = 0;
  for (let i = 0; i < SCRUB_TARGETS; i++) {
    // Deliberately not monotonic: forward jumps, backward jumps and a re-visit,
    // which is what a hand on a scrubber produces and what makes the reader seek.
    const fraction = ((i * 7) % SCRUB_TARGETS) / SCRUB_TARGETS;
    const targetSec = fraction * part.durationSec;
    const expectedFrame = index.frameAtTime(targetSec);
    const expectedMicros = expectedFrame < 0 ? -1 : index.ptsMicros(expectedFrame);

    const startedAt = performance.now();
    loop.seek(targetSec, { scrubbing: true });
    // Poll the ring rather than `frameAt`, so waiting does not pollute the hit and
    // miss counters the report uses to prove the preview was not blank.
    while (performance.now() - startedAt < SETTLE_TIMEOUT_MS) {
      const held = reader.ring.frameAtMicros(expectedMicros);
      if (held !== null && held.timestamp === expectedMicros) break;
      await clock.after(1);
      // Every frame of the window a seek leaves the ring empty, not just the one at
      // the end of it: §4.3 says a miss holds the previous picture, and the whole
      // point of the settle window is that it is composited entirely out of misses.
      settleSamples += 1;
      if (centreLuma() <= BLACK_LUMA) settleBlackFrames += 1;
    }
    const settleMs = performance.now() - startedAt;
    // One more frame so the composite reflects the settled ring, then read back.
    await clock.after(2);
    scrubChecks.push({
      targetSec,
      expectedFrame,
      observedFrame: readCode(`the readback for scrub target ${String(i)}`),
      settleMs,
    });
  }

  // Back to the start, and waited out like every other target above. This is the
  // largest backward jump of the run — a full ring closed, the decoder reset, a
  // fresh GOP fetched and decoded — and it is a *scrub*: measured here, in the
  // window whose bound covers exactly that kind of frame, rather than billed to
  // playback, which used to inherit it along with the misses it produces. Playback
  // then starts from a settled playhead, which is what §8's "play" means.
  const firstFrame = index.frameAtTime(0);
  const firstMicros = firstFrame < 0 ? -1 : index.ptsMicros(firstFrame);
  loop.seek(0);
  const rewoundAt = performance.now();
  while (performance.now() - rewoundAt < SETTLE_TIMEOUT_MS) {
    const held = reader.ring.frameAtMicros(firstMicros);
    if (held !== null && held.timestamp === firstMicros) break;
    await clock.after(1);
  }
  await clock.after(2);
  const scrub = snapshot(loop.metrics);
  const scrubControl = control.snapshot();
  loop.metrics.reset();
  control.reset();

  // ---- play --------------------------------------------------------------
  const hitsBefore = reader.stats.hits;
  const missesBefore = reader.stats.misses;
  loop.play();
  const playStartedAt = performance.now();
  const playSamples: PlaySample[] = [];
  let nextSampleAtSec = part.durationSec / 8;
  while (loop.playing && performance.now() - playStartedAt < part.durationSec * 1000 + 15_000) {
    await clock.after(10);
    // Read the picture back a handful of times while it plays. Timing alone cannot
    // tell a preview that is advancing from one that is holding frame 0 very
    // efficiently; the frame-number band can.
    if (loop.time >= nextSampleAtSec && playSamples.length < 6) {
      const atSec = loop.time;
      playSamples.push({
        atSec,
        expectedFrame: index.frameAtTime(atSec),
        observedFrame: readCode(`the readback at ${atSec.toFixed(2)}s of playback`),
      });
      nextSampleAtSec = atSec + part.durationSec / 8;
    }
  }
  const play = snapshot(loop.metrics);
  const playControl = control.snapshot();
  control.reset();
  loop.stop();
  // Read here, not at the end: the slow-compositor control below moves them.
  const playHits = reader.stats.hits - hitsBefore;
  const playMisses = reader.stats.misses - missesBefore;

  // ---- the control for the environment control ---------------------------
  // The two phases above defer §8's absolute number to a host that can hold it, on the
  // evidence of a spin measured in their own frames. That deferral is only honest
  // while a compositor that has actually got slow still fails — otherwise the deferred
  // branch is a way to pass by compositing badly on a busy machine, and the bound
  // proves nothing anywhere. So the shipping `PreviewLoop` is run again here over a
  // deliberately-slowed compositor: the real one, wrapped so that `render` burns
  // {@link SLOW_COMPOSITE_MS} on top of the composite it just did, inside the frame
  // body the gate measures. The environment control keeps spinning beside it, and
  // `test/phase6-gate.test.ts` requires the same judgement that excused the host to
  // fail this. Nothing in `packages/compositor` is touched; what is proved is the
  // gate's judgement, which is the thing that changed.
  //
  // Its source is a stub that never has a frame, so `Compositor.render` holds the
  // previous picture (§4.3) and the decoder, the ring and the reader's statistics are
  // left exactly as playback finished with them.
  const slowSource: PreviewSource = {
    frameAt: () => null,
    prime: () => Promise.resolve(),
    release: () => undefined,
    hasSourceFrameAt: () => false,
    liveFrames: 0,
    ringCapacity: reader.ringCapacity,
  };
  const slowLoop = new PreviewLoop({
    compositor: {
      render: (frames, state) => {
        compositor.render(frames, state);
        burn(SLOW_COMPOSITE_MS);
      },
      present: () => {
        compositor.present();
      },
    },
    screen: slowSource,
    durationSec: part.durationSec,
    scheduler: clock.scheduler,
  });
  control.arm();
  slowLoop.start();
  await clock.after(SLOW_CONTROL_FRAMES);
  slowLoop.stop();
  const slowFrames = snapshot(slowLoop.metrics);
  const slowControl = control.snapshot();
  control.disarm();
  log(
    `control: a compositor slowed by ${SLOW_COMPOSITE_MS.toFixed(2)} ms measured ` +
      `${slowFrames.maxMs.toFixed(2)} ms worst over ${slowFrames.count} frames, beside a ` +
      `${slowControl.maxMs.toFixed(2)} ms worst spin`,
  );
  // Read once, so nothing above can be optimised away as a loop with no result.
  log(`control spins accumulated ${controlSink().toFixed(3)}`);

  // ---- the control for the count above -----------------------------------
  // Phase 6's first cut cleared the render target before it discovered it had no
  // frame to draw, so every miss presented the background and a backward scrub
  // flashed black. Reproduce exactly that sequence — clear, present — and require
  // the detector to see it. Run last, and with the loop stopped, so the black it
  // deliberately leaves behind cannot be mistaken for a hold by anything after it.
  const litLuma = centreLuma();
  compositor.clearToBackground();
  compositor.present();
  const controlDetectsBlack = litLuma > BLACK_LUMA && centreLuma() <= BLACK_LUMA;
  log(`control: lit ${litLuma.toFixed(1)} then cleared, detected=${String(controlDetectsBlack)}`);

  const stats = reader.stats;
  const peakLiveFrames = Math.max(loop.peakLiveFrames, stats.peakLive);
  reader.close();
  const liveFramesAtEnd = reader.liveFrames;
  compositor.dispose();

  if (trouble.loopError !== null) throw trouble.loopError;
  if (trouble.stalled !== null) throw new Error(trouble.stalled);

  return {
    ok: true,
    contextLost: false,
    environment: {
      glRenderer,
      scheduler: chosen.mode,
      hardwareEncode: part.hardwareAcceleration,
      electron: navigator.userAgent,
      chrome: navigator.userAgent,
    },
    fixture: {
      width: FIXTURE_SIZE[0],
      height: FIXTURE_SIZE[1],
      frameCount: part.frameCount,
      durationSec: part.durationSec,
      byteLength: part.bytes.byteLength,
      codec: part.codec,
      observedFps: part.durationSec > 0 ? part.frameCount / part.durationSec : 0,
      longestHoldSec: part.longestHoldSec,
      encodeMs: part.encodeMs,
    },
    viewport: VIEWPORT,
    ringCapacity: stats.ringCapacity,
    peakLiveFrames,
    liveFramesAtEnd,
    warmup,
    scrub,
    play,
    control: { scrub: scrubControl, play: playControl },
    slowCompositor: {
      injectedMs: SLOW_COMPOSITE_MS,
      frames: slowFrames,
      control: slowControl,
    },
    scrubChecks,
    settleSamples,
    settleBlackFrames,
    controlDetectsBlack,
    playSamples,
    playHits,
    playMisses,
    decodedFrames: stats.decoded,
    seeks: stats.seeks,
    bytesRead: stats.bytesRead,
    gpuCompositeMs: compositor.gpuTimer.lastMs,
    logs,
  };
}

const EMPTY_METRICS: PhaseMetrics = {
  count: 0,
  maxMs: 0,
  maxAt: -1,
  meanMs: 0,
  p50Ms: 0,
  p99Ms: 0,
  overBudget: 0,
};

run().then(
  (report) => window.gate.finish(report),
  (error: unknown) => {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
    return window.gate.finish({
      ok: false,
      error: message,
      contextLost: lost.where !== null,
      environment: {
        glRenderer: 'unknown',
        scheduler: 'raf',
        hardwareEncode: 'unknown',
        electron: navigator.userAgent,
        chrome: navigator.userAgent,
      },
      fixture: {
        width: 0,
        height: 0,
        frameCount: 0,
        durationSec: 0,
        byteLength: 0,
        codec: '',
        observedFps: 0,
        longestHoldSec: 0,
        encodeMs: 0,
      },
      viewport: VIEWPORT,
      ringCapacity: 0,
      peakLiveFrames: 0,
      liveFramesAtEnd: 0,
      warmup: EMPTY_METRICS,
      scrub: EMPTY_METRICS,
      play: EMPTY_METRICS,
      control: { scrub: NO_CONTROL, play: NO_CONTROL },
      slowCompositor: {
        injectedMs: SLOW_COMPOSITE_MS,
        frames: EMPTY_METRICS,
        control: NO_CONTROL,
      },
      scrubChecks: [],
      settleSamples: 0,
      settleBlackFrames: 0,
      controlDetectsBlack: false,
      playSamples: [],
      playHits: 0,
      playMisses: 0,
      decodedFrames: 0,
      seeks: 0,
      bytesRead: 0,
      gpuCompositeMs: null,
      logs,
    });
  },
);
