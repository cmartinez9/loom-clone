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
 */

import { Compositor, contentRect, describeRenderer } from '@loom/compositor';
import { DemuxIndex, fetchByteRangeReader, hasWebCodecs, SourceReader } from '@loom/decode';
import { PreviewLoop, type FrameScheduler } from '../../apps/renderer/src/preview/index.ts';
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

const logs: string[] = [];
function log(message: string): void {
  logs.push(message);
  window.gate.log(message);
}

function snapshot(metrics: {
  count: number;
  maxMs: number;
  meanMs: number;
  overBudget: number;
  percentileMs: (p: number) => number;
}): PhaseMetrics {
  return {
    count: metrics.count,
    maxMs: metrics.maxMs,
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

/** A scheduler wrapper that lets the gate await "n more frames". */
function counting(inner: FrameScheduler): {
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

/** Decode the frame number out of composited pixels. `-1` when the band is unreadable. */
function readFrameCode(pixels: Uint8Array, viewport: [number, number]): number {
  const content = contentRect(FIXTURE_SIZE, viewport);
  if (content.width < 1 || content.height < 1) return -1;
  let value = 0;
  for (let bit = 0; bit < CODE_BIT_COUNT; bit++) {
    const [u, v] = codeCellCenter(bit);
    const x = Math.round(content.x + u * content.width);
    const y = Math.round(content.y + v * content.height);
    if (x < 0 || y < 0 || x >= viewport[0] || y >= viewport[1]) return -1;
    const offset = (y * viewport[0] + x) * 4;
    const r = pixels[offset] ?? 0;
    const g = pixels[offset + 1] ?? 0;
    const b = pixels[offset + 2] ?? 0;
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
  const compositor = new Compositor(gl, VIEWPORT);
  log(`webgl2 renderer: ${describeRenderer(gl)}`);

  const chosen = await chooseScheduler();
  const clock = counting(chosen.scheduler);
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

  const pixels = new Uint8Array(VIEWPORT[0] * VIEWPORT[1] * 4);

  // ---- warmup: shader link is done, but the first 4K upload and the first decode
  // are one-time costs and belong in the report rather than in the budget.
  loop.seek(0);
  loop.start();
  await clock.after(WARMUP_FRAMES);
  const warmup = snapshot(loop.metrics);
  loop.metrics.reset();

  // ---- scrub -------------------------------------------------------------
  const scrubChecks: ScrubCheck[] = [];
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
      const held = reader.ring.frameAt(targetSec);
      if (held !== null && held.timestamp === expectedMicros) break;
      await clock.after(1);
    }
    const settleMs = performance.now() - startedAt;
    // One more frame so the composite reflects the settled ring, then read back.
    await clock.after(2);
    compositor.readPixels(pixels);
    scrubChecks.push({
      targetSec,
      expectedFrame,
      observedFrame: readFrameCode(pixels, VIEWPORT),
      settleMs,
    });
  }
  const scrub = snapshot(loop.metrics);
  loop.metrics.reset();

  // ---- play --------------------------------------------------------------
  const hitsBefore = reader.stats.hits;
  const missesBefore = reader.stats.misses;
  loop.seek(0);
  await clock.after(2);
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
      compositor.readPixels(pixels);
      playSamples.push({
        atSec,
        expectedFrame: index.frameAtTime(atSec),
        observedFrame: readFrameCode(pixels, VIEWPORT),
      });
      nextSampleAtSec = atSec + part.durationSec / 8;
    }
  }
  const play = snapshot(loop.metrics);
  loop.stop();

  const stats = reader.stats;
  const peakLiveFrames = Math.max(loop.peakLiveFrames, stats.peakLive);
  reader.close();
  const liveFramesAtEnd = reader.liveFrames;
  compositor.dispose();

  if (trouble.loopError !== null) throw trouble.loopError;
  if (trouble.stalled !== null) throw new Error(trouble.stalled);

  return {
    ok: true,
    environment: {
      glRenderer: describeRenderer(gl),
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
    scrubChecks,
    playSamples,
    playHits: stats.hits - hitsBefore,
    playMisses: stats.misses - missesBefore,
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
      scrubChecks: [],
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
