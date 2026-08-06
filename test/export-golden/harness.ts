/**
 * **Phase 8's gate**, run for real.
 *
 * Architecture report §8: *"Golden-frame test: preview and export pixel-identical at
 * 24 timestamps."* §4.5 states it in full:
 *
 * > `packages/compositor/test/golden.spec.ts` renders a fixture project at 24 fixed
 * > timestamps through both the preview path and the export path at the same output
 * > size and asserts a per-pixel max delta of 0. It is a required CI check.
 *
 * It lives here rather than in `packages/compositor/test/` for the reason phase 6's
 * gate does: a WebGL2 context, a `VideoDecoder` and a `VideoEncoder` only exist in a
 * renderer, and a comparison between two paths is worth nothing unless both are the
 * *shipping* paths. So this runs `PreviewLoop` and `ExportRenderLoop` — the real
 * ones, from `apps/renderer/src` — over two independent `SourceReader`s and two
 * independent WebGL2 contexts, and compares what each leaves in its render target.
 *
 * ## Why two of everything
 *
 * Preview and export are two *processes* in the shipping app: the editor window and
 * the hidden export window (§1.2), each with its own GL context, its own decoder and
 * its own frame ring. A test that shared one compositor between the two paths would
 * prove they agree when they are the same object, which is not the claim. Two
 * contexts is also the only way to catch a divergence that lives in context creation
 * — an unpack flag, a colour-space conversion, a premultiply — which is exactly the
 * class of bug §5.2 rejects the readback pipeline to avoid.
 *
 * ## Not phase 11's gate
 *
 * `test/golden/` checks that annotations change the picture, where they change it,
 * and that the mask and blur are effects on pixels — over one painted source frame,
 * with the export path standing in as `resolve` + `render`. This one checks the axis
 * that stand-in cannot: a real decoded VFR stream, the shipping `ExportRenderLoop`,
 * two independent contexts, and the encoded file at the end. The seam phase 11 asked
 * for is `ExportRenderLoop.renderAt`, which is what this harness calls.
 *
 * ## Making the pass mean something
 *
 * A comparison of two black frames is zero. So the run also carries:
 *
 *  - **an identity control** — the export path composited twice, which must be 0, so
 *    a comparator that always answered "different" is visible;
 *  - **two divergence controls** — the real `ExportRenderLoop`, run once with its
 *    timeline shifted by one output frame and once over a reader whose frame
 *    selection is off by one source frame. Those are §4.5's two "must be identical"
 *    properties, perturbed one at a time, and each must make the same comparison
 *    non-zero. Without them, "the two paths agree" and "the test cannot see a
 *    disagreement" read identically;
 *  - **a zoom that moves**, spring-driven on §3.4's fixed 8 ms grid, so the state
 *    being compared is a different non-trivial value at each of the 24 timestamps
 *    rather than the identity;
 *  - **the finished file**, decoded back and read for the frame numbers painted into
 *    the fixture, so the canvas → encoder → muxer → disk half of the export is
 *    checked too — the golden comparison reads the render target, and the render
 *    target is not the thing the user ends up with.
 */

import { Compositor, contentRect } from '@loom/compositor';
import { hasWebCodecs } from '@loom/decode';
import {
  ALWAYS,
  DEFAULT_SPRING,
  compile,
  identityState,
  manualZoomTrack,
  resolve,
  EMPTY_COMPILE_CONTEXT,
  type CompiledTimeline,
} from '@loom/edl';
import { newEditDocument, type EditDocument } from '@loom/format';
import { PreviewLoop, type PreviewSource } from '../../apps/renderer/src/preview/index.ts';
import {
  ExportRenderLoop,
  type ExportVideoSource,
} from '../../apps/renderer/src/export/render-loop.ts';
import { VideoExportEncoder } from '../../apps/renderer/src/export/encode.ts';
import { verifyByDecoding } from '../../apps/renderer/src/export/verify-decode.ts';
import { openVideoTrack, type TrackReader } from '../../apps/renderer/src/media/track-reader.ts';
import { CODE_BIT_COUNT, codeCellCenter, generate4kPart } from '../gate/fixture.ts';
import type { ControlOutcome, GoldenBridge, GoldenReport, GoldenSample } from './report.ts';

// `exportGolden`, not `golden`: phase 11's harness declares a `Window.golden` of its
// own shape and both files are in one TypeScript program. The two gates are
// deliberately separate (see this file's header), so they get separate globals.
declare global {
  interface Window {
    exportGolden: GoldenBridge;
  }
}

/** The fixture's size. Smaller than phase 6's 4K: this gate measures pixels, not time. */
const FIXTURE_SIZE: [number, number] = [1920, 1080];
/** Same aspect, so `contentRect` fills and the frame-code band lands where it is looked for. */
const OUTPUT_SIZE: [number, number] = [1280, 720];
const FIXTURE_FRAMES = 90;
const GOP = 30;
const FPS = 30;
/** §4.5's number, and the reason this file exists. */
const TIMESTAMP_COUNT = 24;
const SETTLE_TIMEOUT_MS = 8000;
const EXPORT_BITRATE = 8_000_000;

const logs: string[] = [];
function log(message: string): void {
  logs.push(message);
  window.exportGolden.log(message);
}

/**
 * A lost context makes every reading below a fiction. See `test/gate/harness.ts`.
 *
 * On a virtualised runner it is a real event and not a hypothetical: Chromium's GPU
 * process exits on a context loss and takes every context in it, so all four of this
 * harness's contexts go at once. Every reader therefore checks *before* it reads —
 * and "reads" includes the export pass, where the read is `new VideoFrame(canvas)`
 * rather than a `readPixels`. A run that notices is a run that can say `contextLost`
 * instead of stopping with nothing to report.
 */
const lost: { where: string | null } = { where: null };
function checkContext(gl: WebGL2RenderingContext, where: string): void {
  if (lost.where === null && !gl.isContextLost()) return;
  lost.where ??= where;
  throw new Error(`the WebGL context was lost (noticed at ${lost.where}); nothing can be compared`);
}

interface Path {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  compositor: Compositor;
  reader: TrackReader;
}

/**
 * One composite path: a canvas, a context, a compositor and a reader of its own.
 *
 * Built the same way for both sides on purpose — every context option here is one
 * that could make the same `VideoFrame` upload differently, and the point of the
 * gate is that neither path gets to choose differently.
 */
async function openPath(url: string, indexUrl: string, durationSec: number): Promise<Path> {
  const canvas = new OffscreenCanvas(OUTPUT_SIZE[0], OUTPUT_SIZE[1]);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (gl === null) throw new Error('no WebGL2 context');
  // Recorded rather than prevented: the program, the textures and the render target
  // all go with the context, so there is nothing to restore into. What matters is
  // knowing, and knowing before the next thing reads. Same listener, same reason, as
  // `test/gate/harness.ts`.
  canvas.addEventListener('webglcontextlost', () => {
    lost.where ??= 'the webglcontextlost event';
  });
  const reader = await openVideoTrack({
    parts: [{ mediaUrl: url, indexUrl, startTimeSec: 0, durationSec }],
  });
  return { canvas, gl, compositor: new Compositor(gl, OUTPUT_SIZE), reader };
}

function disposePath(path: Path): void {
  path.reader.close();
  path.compositor.dispose();
}

/**
 * Wait until the reader actually holds the frame the index puts at `sourceTime`.
 *
 * The preview loop is entitled to miss and hold (§4.3) and the export loop is not,
 * so a comparison taken before the preview has settled would be comparing a held
 * picture against a correct one — a difference that says nothing about either path.
 * Both sides are settled the same way before either is read.
 */
async function settle(source: PreviewSource, sourceTime: number): Promise<boolean> {
  if (!source.hasSourceFrameAt(sourceTime)) return false;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    await source.prime(sourceTime, 0.5);
    if (source.frameAt(sourceTime) !== null) return true;
    if (Date.now() > deadline) {
      throw new Error(`decode never produced the frame at ${sourceTime.toFixed(3)}s`);
    }
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** Largest per-channel difference, where it is, and how much of the frame differs. */
function compare(
  a: Uint8Array,
  b: Uint8Array,
): { maxDelta: number; atByte: number; differingBytes: number } {
  if (a.byteLength !== b.byteLength) {
    return { maxDelta: 255, atByte: 0, differingBytes: Math.abs(a.byteLength - b.byteLength) };
  }
  let maxDelta = 0;
  let atByte = 0;
  let differingBytes = 0;
  for (let i = 0; i < a.byteLength; i++) {
    const delta = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (delta === 0) continue;
    differingBytes += 1;
    if (delta > maxDelta) {
      maxDelta = delta;
      atByte = i;
    }
  }
  return { maxDelta, atByte, differingBytes };
}

/** The zoom document the 24 timestamps are compared under. */
function zoomDocument(durationSec: number): EditDocument {
  const doc = newEditDocument();
  doc.output = { size: OUTPUT_SIZE, fps: FPS, background: { kind: 'none' } };
  doc.clips = [{ id: 'whole', sourceStart: 0, sourceEnd: durationSec, speed: 1 }];
  doc.tracks = [
    manualZoomTrack({
      id: 'zoom',
      activeRanges: ALWAYS,
      spring: DEFAULT_SPRING,
      // Steps spread across the *whole* recording, not the first third. A spring
      // settles: with the last key at 1.9s of a 5.6s fixture, every timestamp after
      // it resolves to the same number, and a golden comparison over a constant
      // state is one a compositor that ignored `ResolvedState` would also pass. The
      // gate asserts the spread it gets, so this schedule is load-bearing.
      amount: [
        { t: 0.05 * durationSec, v: 1, ease: { kind: 'spring' } },
        { t: 0.2 * durationSec, v: 2.2, ease: { kind: 'spring' } },
        { t: 0.4 * durationSec, v: 1.35, ease: { kind: 'spring' } },
        { t: 0.6 * durationSec, v: 2.6, ease: { kind: 'spring' } },
        { t: 0.8 * durationSec, v: 1.15, ease: { kind: 'spring' } },
      ],
      center: [
        { t: 0.05 * durationSec, v: [0.5, 0.5], ease: { kind: 'spring' } },
        { t: 0.2 * durationSec, v: [0.32, 0.36], ease: { kind: 'spring' } },
        { t: 0.4 * durationSec, v: [0.68, 0.62], ease: { kind: 'spring' } },
        { t: 0.6 * durationSec, v: [0.28, 0.7], ease: { kind: 'spring' } },
        { t: 0.8 * durationSec, v: [0.6, 0.3], ease: { kind: 'spring' } },
      ],
    }),
  ];
  return doc;
}

/** The same document with the zoom moved one output frame later. Control A. */
function skewedDocument(durationSec: number): EditDocument {
  const doc = zoomDocument(durationSec);
  const skew = 1 / FPS;
  for (const track of doc.tracks) {
    for (const channel of Object.values(track.channels)) {
      for (const key of channel.keys) key.t += skew;
    }
  }
  return doc;
}

/**
 * A reader whose frame selection is one source frame late. Control B.
 *
 * Everything else is the shipping `TrackReader`: this wraps it and moves only the
 * one question §4.5 says preview and export may never answer differently — *"which
 * source frame is selected for a given time"*.
 */
function offByOneReader(inner: TrackReader, sourceFrameSec: number): ExportVideoSource {
  // Shifted *consistently*, selection included: the point of the control is a
  // divergence the golden comparison has to see in the pixels, not one the loop's own
  // staleness check rejects before it reaches them.
  return {
    frameAt: (t) => inner.frameAt(t + sourceFrameSec),
    prime: (t, ahead) => inner.prime(t, ahead + sourceFrameSec),
    release: () => undefined,
    hasSourceFrameAt: (t) => inner.hasSourceFrameAt(t + sourceFrameSec),
    selectionMicros: (t) => inner.selectionMicros(t + sourceFrameSec),
    get liveFrames() {
      return inner.liveFrames;
    },
    get ringCapacity() {
      return inner.ringCapacity;
    },
  };
}

/** Read the fixture's frame number out of a composited RGBA buffer. */
function readFrameCode(pixels: Uint8Array): number {
  const content = contentRect(FIXTURE_SIZE, OUTPUT_SIZE);
  if (content.width < 1 || content.height < 1) return -1;
  const [, v] = codeCellCenter(0);
  const y = Math.round(content.y + v * content.height);
  if (y < 0 || y >= OUTPUT_SIZE[1]) return -1;
  let value = 0;
  for (let bit = 0; bit < CODE_BIT_COUNT; bit++) {
    const [u] = codeCellCenter(bit);
    const x = Math.round(content.x + u * content.width);
    if (x < 0 || x >= OUTPUT_SIZE[0]) return -1;
    const offset = (y * OUTPUT_SIZE[0] + x) * 4;
    const luma =
      0.2126 * (pixels[offset] ?? 0) +
      0.7152 * (pixels[offset + 1] ?? 0) +
      0.0722 * (pixels[offset + 2] ?? 0);
    // Mid-grey is not a legitimate reading of a black-or-white cell: a blurred or
    // blank frame fails loudly rather than being guessed at.
    if (luma > 40 && luma < 215) return -1;
    if (luma >= 215) value |= 1 << bit;
  }
  return value;
}

async function run(): Promise<GoldenReport> {
  if (!hasWebCodecs()) throw new Error('this build has no WebCodecs');
  const options = await window.exportGolden.options();
  log(`writing the fixture into ${options.outDir}`);

  const fixture = await generate4kPart({
    size: FIXTURE_SIZE,
    frameCount: FIXTURE_FRAMES,
    gopSize: GOP,
    bitrate: 12_000_000,
  });
  // Handed to main as frames rather than as a blob: main writes them through the
  // capture spine's own writer, so what the export path opens is a real `.loomrec`
  // part with a real `moov` and a real `loom.index/1` sidecar.
  const keyframes = new Set(fixture.doc.keyframes);
  const written = await window.exportGolden.writeFixture({
    width: FIXTURE_SIZE[0],
    height: FIXTURE_SIZE[1],
    fps: FPS,
    avcC: new Uint8Array((fixture.config.description ?? new Uint8Array()) as ArrayBufferLike),
    bytes: fixture.bytes,
    frames: fixture.doc.pts.map((pts, i) => ({
      offset: fixture.doc.offsets[i] ?? 0,
      byteLength: fixture.doc.sizes[i] ?? 0,
      timestampUs: pts,
      isKey: keyframes.has(i),
    })),
    // A screen track's last frame stands for the still screen after it, so the part
    // is told when capture stopped rather than being left to guess (§2.3).
    endTimestampUs: Math.round(fixture.durationSec * 1e6) + Math.round(1e6 / FPS),
  });
  log(
    `fixture ${FIXTURE_SIZE.join('x')} ${written.frameCount} frames / ` +
      `${written.durationSec.toFixed(2)}s, longest hold ${fixture.longestHoldSec.toFixed(2)}s`,
  );

  const mediaUrl = written.mediaUrl;
  const indexUrl = written.indexUrl;
  const durationSec = written.durationSec;

  const preview = await openPath(mediaUrl, indexUrl, durationSec);
  const exporter = await openPath(mediaUrl, indexUrl, durationSec);
  const control = await openPath(mediaUrl, indexUrl, durationSec);
  // Read now rather than at the end: a context that is lost mid-run answers `null` to
  // every query, and this path is closed before the export pass in any case.
  const glRenderer = describeContext(preview.gl);
  log(`webgl2 renderer: ${glRenderer}`);

  const timeline = compile(zoomDocument(durationSec), EMPTY_COMPILE_CONTEXT);
  const frameCount = Math.max(1, Math.round(timeline.durationSec * FPS));
  // Spread across the whole timeline, on exact output-frame boundaries: an export can
  // only ever produce a frame at `n / fps`, so comparing anywhere else would be
  // comparing the preview against a time the export does not have.
  const indices = Array.from({ length: TIMESTAMP_COUNT }, (_, i) =>
    Math.min(frameCount - 1, Math.round((i * (frameCount - 1)) / (TIMESTAMP_COUNT - 1))),
  );

  // ---- the preview path: the shipping loop, driven one frame at a time -------
  const previewLoop = new PreviewLoop({
    compositor: preview.compositor,
    screen: preview.reader,
    durationSec,
    timeline,
    // The scheduler never fires: every frame is taken with `renderOnce`, so the
    // comparison is against a settled composite rather than whichever frame a
    // `requestAnimationFrame` happened to land on.
    scheduler: { request: () => 0, cancel: () => undefined },
  });

  const exportLoop = new ExportRenderLoop({
    compositor: exporter.compositor,
    screen: exporter.reader,
    timeline,
    fps: FPS,
    onFrame: () => undefined,
  });

  const previewPixels = new Uint8Array(OUTPUT_SIZE[0] * OUTPUT_SIZE[1] * 4);
  const exportPixels = new Uint8Array(OUTPUT_SIZE[0] * OUTPUT_SIZE[1] * 4);

  const samples: GoldenSample[] = [];
  for (const index of indices) {
    const atSec = index / FPS;
    const state = resolve(timeline, atSec);
    const sourceTime = state.sourceTime;
    const zoomAmount = state.zoom.amount;

    const previewDrawn = await settle(preview.reader, sourceTime);
    const exportDrawn = await settle(exporter.reader, sourceTime);

    previewLoop.seek(atSec);
    previewLoop.renderOnce();
    checkContext(preview.gl, 'preview readback');
    preview.compositor.readPixels(previewPixels);

    await exportLoop.renderAt(atSec, index);
    checkContext(exporter.gl, 'export readback');
    exporter.compositor.readPixels(exportPixels);

    const diff = compare(previewPixels, exportPixels);
    samples.push({
      index,
      atSec,
      maxDelta: diff.maxDelta,
      atByte: diff.atByte,
      differingBytes: diff.differingBytes,
      zoomAmount,
      drawn: previewDrawn && exportDrawn,
    });
  }
  log(
    `compared ${samples.length} timestamps; worst delta ${Math.max(...samples.map((s) => s.maxDelta))}`,
  );

  // ---- the comparator's own control: the export path, twice ------------------
  let identityMaxDelta = 0;
  for (const index of indices.slice(0, 6)) {
    await exportLoop.renderAt(index / FPS, index);
    exporter.compositor.readPixels(previewPixels);
    await exportLoop.renderAt(index / FPS, index);
    exporter.compositor.readPixels(exportPixels);
    identityMaxDelta = Math.max(identityMaxDelta, compare(previewPixels, exportPixels).maxDelta);
  }

  // ---- the divergence controls ------------------------------------------------
  const controls: ControlOutcome[] = [];

  controls.push(
    await runControl({
      name: 'clock-skew',
      what: 'the export timeline’s zoom keys moved one output frame later (§4.5: zoom amount and centre must be identical)',
      path: control,
      timeline: compile(skewedDocument(durationSec), EMPTY_COMPILE_CONTEXT),
      source: control.reader,
      indices,
      timelineForPreview: timeline,
      previewLoop,
      preview,
      previewPixels,
      controlPixels: exportPixels,
    }),
  );

  const sourceFrameSec = fixture.durationSec / Math.max(1, fixture.frameCount - 1);
  controls.push(
    await runControl({
      name: 'frame-selection',
      what: `the export reader selecting the frame ${sourceFrameSec.toFixed(3)}s later (§4.5: which source frame is selected must be identical)`,
      path: control,
      timeline,
      source: offByOneReader(control.reader, sourceFrameSec),
      indices,
      timelineForPreview: timeline,
      previewLoop,
      preview,
      previewPixels,
      controlPixels: exportPixels,
    }),
  );
  for (const outcome of controls) {
    log(
      `control ${outcome.name}: max delta ${outcome.maxDelta} over ${outcome.differingSamples} samples`,
    );
  }

  // ---- everything the comparison needed is read; let it go ---------------------
  // Before the export pass, not after it. These three readers hold a ring of twenty
  // 1920x1080 frames each, and on a host with no hardware decoder those are CPU-backed
  // copies uploaded into three live contexts. The export pass then opens a fourth
  // context and a `VideoEncoder` on top of that, which is the peak this run reaches
  // and exactly where CI's GPU process exited. Nothing below reads these paths.
  const liveBefore =
    preview.reader.liveFrames + exporter.reader.liveFrames + control.reader.liveFrames;
  log(`live frames before the export pass: ${liveBefore}`);
  disposePath(preview);
  disposePath(exporter);
  disposePath(control);
  // §10.2 is asserted over every path this run opened, so each contributes what it
  // still holds *after* being closed and the total must be zero.
  let liveFramesAtEnd =
    preview.reader.liveFrames + exporter.reader.liveFrames + control.reader.liveFrames;

  // ---- the end-to-end export --------------------------------------------------
  const end = await runEndToEnd(mediaUrl, indexUrl, durationSec, fixture.frameCount);
  liveFramesAtEnd += end.liveFramesAtEnd;

  // ---- and a cancelled export leaves nothing ---------------------------------
  const cancelLeftBehind = await window.exportGolden.cancelProbe();

  return {
    ok: true,
    contextLost: false,
    environment: {
      glRenderer,
      electron: '',
      chrome: navigator.userAgent,
      hardwareEncode: fixture.hardwareAcceleration,
    },
    fixture: {
      width: FIXTURE_SIZE[0],
      height: FIXTURE_SIZE[1],
      frameCount: fixture.frameCount,
      durationSec: fixture.durationSec,
      longestHoldSec: fixture.longestHoldSec,
    },
    outputSize: OUTPUT_SIZE,
    fps: FPS,
    samples,
    identityMaxDelta,
    controls,
    liveFramesAtEnd,
    exported: end.exported,
    cancelLeftBehind,
    logs,
  };
}

interface ControlRun {
  name: string;
  what: string;
  path: Path;
  timeline: CompiledTimeline;
  source: ExportVideoSource;
  indices: number[];
  timelineForPreview: CompiledTimeline;
  previewLoop: PreviewLoop;
  preview: Path;
  previewPixels: Uint8Array;
  controlPixels: Uint8Array;
}

/**
 * Run the **real** `ExportRenderLoop` with one thing perturbed, and put its output
 * through the **same** comparison the gate uses.
 *
 * That is what makes this a control rather than a demonstration: nothing about the
 * measuring apparatus changes, so a non-zero answer here is evidence that a zero
 * answer above was a property of the code and not of the comparator.
 */
async function runControl(run: ControlRun): Promise<ControlOutcome> {
  const loop = new ExportRenderLoop({
    compositor: run.path.compositor,
    screen: run.source,
    timeline: run.timeline,
    fps: FPS,
    onFrame: () => undefined,
  });
  let maxDelta = 0;
  let differingSamples = 0;
  for (const index of run.indices) {
    const atSec = index / FPS;
    const sourceTime = resolve(run.timelineForPreview, atSec).sourceTime;
    await settle(run.preview.reader, sourceTime);
    run.previewLoop.seek(atSec);
    run.previewLoop.renderOnce();
    checkContext(run.preview.gl, `${run.name} preview readback`);
    run.preview.compositor.readPixels(run.previewPixels);

    await loop.renderAt(atSec, index);
    checkContext(run.path.gl, `${run.name} control readback`);
    run.path.compositor.readPixels(run.controlPixels);
    const diff = compare(run.previewPixels, run.controlPixels);
    if (diff.maxDelta > 0) differingSamples += 1;
    maxDelta = Math.max(maxDelta, diff.maxDelta);
  }
  return { name: run.name, what: run.what, maxDelta, differingSamples };
}

/**
 * Compose, encode, mux and verify — then decode the file back and read the frame
 * numbers out of it.
 *
 * The golden comparison above reads the *render target*. What the user ends up with
 * comes off the *canvas*, through `VideoEncoder` and `ExportMp4Writer`. This is the
 * half that checks the second path carries the first path's pictures: an identity
 * timeline, so the fixture's own frame-number band is where the reader looks for it.
 */
async function runEndToEnd(
  mediaUrl: string,
  indexUrl: string,
  durationSec: number,
  fixtureFrames: number,
): Promise<{ exported: GoldenReport['exported']; liveFramesAtEnd: number }> {
  const path = await openPath(mediaUrl, indexUrl, durationSec);
  const doc = newEditDocument();
  doc.output = { size: OUTPUT_SIZE, fps: FPS, background: { kind: 'none' } };
  doc.clips = [{ id: 'whole', sourceStart: 0, sourceEnd: durationSec, speed: 1 }];
  const timeline = compile(doc, EMPTY_COMPILE_CONTEXT);

  let opened = false;
  const encoder = await VideoExportEncoder.open({
    width: OUTPUT_SIZE[0],
    height: OUTPUT_SIZE[1],
    bitrate: EXPORT_BITRATE,
    fps: FPS,
    onConfig: (config) => {
      const description = config.description;
      if (description === undefined) throw new Error('the encoder emitted no avcC');
      opened = true;
      void window.exportGolden.beginExport({
        name: 'Golden',
        width: config.codedWidth ?? OUTPUT_SIZE[0],
        height: config.codedHeight ?? OUTPUT_SIZE[1],
        timescale: FPS * 1000,
        avcC: description,
      });
    },
    onChunk: (chunk) => {
      void window.exportGolden.appendExport({
        data: chunk.data,
        durationUnits: 1000,
        isKey: chunk.isKey,
        timestampUs: chunk.timestampUs,
      });
    },
  });

  const loop = new ExportRenderLoop({
    compositor: path.compositor,
    screen: path.reader,
    timeline,
    fps: FPS,
    onFrame: async (frame) => {
      // The read that matters on this pass: `encode` snapshots the canvas into a
      // `VideoFrame`, and a lost context makes that snapshot whatever was left in the
      // drawing buffer. Checked before, exactly as a readback is.
      checkContext(path.gl, 'the export encode');
      encoder.encode(path.canvas, frame.timestampUs, frame.isKey, Math.round(1e6 / FPS));
      await encoder.drain();
    },
  });

  const report = await loop.run();
  await encoder.close();
  log(`encoded ${encoder.encodedCount} frames from ${report.framesRendered} composites`);
  if (!opened) throw new Error('the export writer was never opened');

  // §7.5's fifth check runs through the shipping code on both sides: main plans it,
  // the renderer's own `verifyByDecoding` answers it.
  window.exportGolden.onVerifyRequest((request) => verifyByDecoding(request));
  const finished = await window.exportGolden.finalizeExport(loop.durationSec);

  const decodedFrames = await readBackFrames(finished.url, path, timeline, fixtureFrames);
  disposePath(path);

  return {
    exported: {
      bytes: finished.bytes,
      durationSec: finished.durationSec,
      expectedDurationSec: loop.durationSec,
      videoSampleCount: finished.videoSampleCount,
      audioSampleCount: finished.audioSampleCount,
      verified: finished.verified,
      verificationFailure: finished.verificationFailure,
      decodedFrames,
    },
    liveFramesAtEnd: path.reader.liveFrames,
  };
}

/**
 * Decode the finished file and read the fixture's frame number out of a handful of
 * its frames.
 *
 * Through the shipping `TrackReader`? No — the file has no `loom.index/1` sidecar,
 * and inventing one would be inventing the answer. It is demuxed by the shipping
 * `parseMovie` (which is what §7.5's verification uses) and composited by the
 * shipping `Compositor`, so what is read back is what a player would see.
 */
async function readBackFrames(
  url: string,
  path: Path,
  timeline: CompiledTimeline,
  fixtureFrames: number,
): Promise<{ index: number; atSec: number; expectedFrame: number; observedFrame: number }[]> {
  const { movieHeaderLength, parseMovie } = await import('@loom/mux');
  const whole = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const headerLength = movieHeaderLength(whole);
  if (headerLength === null) throw new Error('the exported file is not faststart');
  const movie = parseMovie(whole.subarray(0, headerLength));
  const video = movie.tracks.find((track) => track.handler === 'vide');
  if (video === undefined) throw new Error('the exported file has no video track');
  const description = video.codecDescription;
  if (description === null) throw new Error('the exported file carries no avcC');

  const wanted = [
    0,
    Math.floor(video.samples.length / 3),
    Math.floor((video.samples.length * 2) / 3),
  ];
  const out: { index: number; atSec: number; expectedFrame: number; observedFrame: number }[] = [];
  const pixels = new Uint8Array(OUTPUT_SIZE[0] * OUTPUT_SIZE[1] * 4);
  const state = identityState(0);

  for (const target of wanted) {
    // From the sync sample at or before the target, forward. Same rule as §4.2's seek.
    let first = target;
    while (first > 0 && video.samples[first]?.isSync !== true) first -= 1;
    const frames: VideoFrame[] = [];
    const decoder = new VideoDecoder({
      output: (frame) => frames.push(frame),
      error: (error: DOMException) => {
        throw error;
      },
    });
    try {
      decoder.configure({
        codec: avcCodecString(description),
        codedWidth: video.width,
        codedHeight: video.height,
        description,
      });
      for (let i = first; i <= target; i++) {
        const sample = video.samples[i];
        if (sample === undefined) break;
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.isSync ? 'key' : 'delta',
            timestamp: Math.round((sample.decodeUnits / video.timescale) * 1e6),
            data: whole.subarray(sample.offset, sample.offset + sample.byteLength),
          }),
        );
      }
      await decoder.flush();
      const last = frames[frames.length - 1];
      if (last === undefined) throw new Error(`no frame decoded at sample ${target}`);
      path.compositor.render({ screen: last }, state);
      checkContext(path.gl, 'the decoded-file readback');
      path.compositor.readPixels(pixels);
    } finally {
      // Every frame closed, on every path (§10.2).
      for (const frame of frames) frame.close();
      if (decoder.state !== 'closed') decoder.close();
    }

    const atSec = target / FPS;
    const sourceTime = resolve(timeline, atSec).sourceTime;
    // Which fixture frame the index puts on screen at that source time, computed the
    // way the exporter computed it: last PTS ≤ t.
    const expectedFrame = fixtureFrameAt(sourceTime, fixtureFrames);
    out.push({ index: target, atSec, expectedFrame, observedFrame: readFrameCode(pixels) });
  }
  return out;
}

/**
 * The fixture's own frame timing, reproduced.
 *
 * `test/gate/fixture.ts` keeps `gapBefore` private, so the schedule is rebuilt here
 * from the one thing it does expose — the frame numbers painted into the pictures —
 * by asking which frame's PTS is the last at or before `t`. If the two ever disagree
 * the check fails, which is the right way round: this is a *check* on the file, and
 * an expectation derived from the file would not be one.
 */
function fixtureFrameAt(t: number, frameCount: number): number {
  let seconds = 0;
  let best = -1;
  for (let i = 0; i < frameCount; i++) {
    if (i > 0) seconds += i % 17 === 0 ? 0.5 : i % 5 === 0 ? 0.05 : 1 / 30;
    if (seconds <= t + 1e-6) best = i;
    else break;
  }
  return best;
}

function avcCodecString(avcC: Uint8Array): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1] ?? 0)}${hex(avcC[2] ?? 0)}${hex(avcC[3] ?? 0)}`;
}

function describeContext(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = info === null ? null : (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as unknown);
  return typeof raw === 'string' ? raw : String(gl.getParameter(gl.RENDERER));
}

void run().then(
  (report) => window.exportGolden.finish(report),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return window.exportGolden.finish({
      ok: false,
      error: message,
      contextLost: lost.where !== null,
      environment: { glRenderer: '', electron: '', chrome: '', hardwareEncode: '' },
      fixture: { width: 0, height: 0, frameCount: 0, durationSec: 0, longestHoldSec: 0 },
      outputSize: OUTPUT_SIZE,
      fps: FPS,
      samples: [],
      identityMaxDelta: -1,
      controls: [],
      liveFramesAtEnd: -1,
      exported: null,
      cancelLeftBehind: null,
      logs,
    });
  },
);
