/**
 * The phase-11 golden gate, renderer half.
 *
 * Architecture report §4.5 defines the test this extends:
 *
 * > renders a fixture project at 24 fixed timestamps through both the preview path
 * > and the export path at the same output size and asserts a per-pixel max delta
 * > of 0.
 *
 * **The preview path here is the shipping `PreviewLoop`** and the export path is a
 * fixed-timestamp loop of the kind phase 8 owns — `resolve` then `Compositor.render`
 * then `readPixels`, with no preview machinery in it. Both drive the *same*
 * `Compositor` instance and the same `CompiledTimeline`, which is the arrangement
 * §4.5 is about: they cannot disagree because there is one `resolve()` and one
 * `render()`.
 *
 * Nothing in this file reaches into the export pipeline. Phase 8 owns that; when it
 * lands, the loop in {@link exportFrame} is the two lines that get replaced by a call
 * into it, and every assertion above stays where it is.
 *
 * ## Why equality is only a third of the gate
 *
 * A preview and an export that both draw **no annotation at all** agree perfectly.
 * So each timestamp also produces:
 *
 *  - a third render with the annotation tracks *disabled*, and the count of pixels
 *    that differ — the annotations must actually change the picture;
 *  - where those changed pixels are, against boxes `fixture.ts` computes with its own
 *    arithmetic — so a mapping that drifts under zoom is caught rather than followed;
 *  - per-kind probes inside each kind's own box, so "the arrow stopped drawing" is a
 *    distinguishable failure from "the rectangle stopped drawing";
 *  - the mask's centre pixel, exactly, and the blur region's variance against the
 *    same region unblurred — the two privacy features, checked as *effects on pixels*
 *    rather than as draw calls that were issued.
 *
 * ## And the controls
 *
 * Every one of those checks is accompanied by something that makes it fail on
 * purpose, reported as {@link Control}s and asserted by `test/phase11-golden.test.ts`.
 * A golden-frame test that cannot fail is worse than none: it is a green tick over an
 * unredacted export.
 */

import { Compositor } from '@loom/compositor';
import { rasterizeGlyphs, uploadTextAtlas } from '@loom/compositor/raster';
import type { TextAtlas } from '@loom/compositor';
import { compile, EMPTY_COMPILE_CONTEXT, resolve, type CompiledTimeline } from '@loom/edl';
import {
  PreviewLoop,
  type FrameScheduler,
  type PreviewSource,
} from '../../apps/renderer/src/preview/index.ts';
import {
  BOXES,
  DURATION_SEC,
  expectedBoxPx,
  fixtureDocument,
  MASK_FILL,
  OUTPUT_SIZE,
  expectedFadingWeight,
  expectedRevealProgress,
  PARKED_RANGE,
  paintSource,
  SOURCE_SIZE,
  TIMESTAMPS,
} from './fixture.ts';
import type { Control, GoldenReport, KindProbe, TimestampReport } from './report.ts';

declare global {
  interface Window {
    golden: {
      finish: (report: GoldenReport) => Promise<void>;
      log: (message: string) => void;
    };
  }
}

const logs: string[] = [];
function note(message: string): void {
  logs.push(message);
  window.golden.log(message);
}

/** Slack for a one-pixel coverage ramp, a half stroke and the blur's feather. */
const BOX_PAD_PX = 14;

/** A tolerance-free comparison: the largest per-channel difference between two frames. */
function maxDelta(a: Uint8Array, b: Uint8Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (d > worst) worst = d;
  }
  return worst;
}

function rgbaAt(pixels: Uint8Array, x: number, y: number): [number, number, number, number] {
  const at = (y * OUTPUT_SIZE[0] + x) * 4;
  return [pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0, pixels[at + 3] ?? 0];
}

/** Luma variance inside a pixel rect. What a blur destroys and nothing else does. */
function variance(
  pixels: Uint8Array,
  rect: { x0: number; y0: number; x1: number; y1: number },
): number {
  const x0 = Math.max(0, Math.ceil(rect.x0));
  const y0 = Math.max(0, Math.ceil(rect.y0));
  const x1 = Math.min(OUTPUT_SIZE[0] - 1, Math.floor(rect.x1));
  const y1 = Math.min(OUTPUT_SIZE[1] - 1, Math.floor(rect.y1));
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [r, g, b] = rgbaAt(pixels, x, y);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luma;
      sumSq += luma * luma;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** Mean per-channel absolute difference over the RGB of a pixel rect. */
function meanAbsDiff(
  a: Uint8Array,
  b: Uint8Array,
  rect: { x0: number; y0: number; x1: number; y1: number },
): number {
  const x0 = Math.max(0, Math.ceil(rect.x0));
  const y0 = Math.max(0, Math.ceil(rect.y0));
  const x1 = Math.min(OUTPUT_SIZE[0] - 1, Math.floor(rect.x1));
  const y1 = Math.min(OUTPUT_SIZE[1] - 1, Math.floor(rect.y1));
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const at = (y * OUTPUT_SIZE[0] + x) * 4;
      sum +=
        Math.abs((a[at] ?? 0) - (b[at] ?? 0)) +
        Math.abs((a[at + 1] ?? 0) - (b[at + 1] ?? 0)) +
        Math.abs((a[at + 2] ?? 0) - (b[at + 2] ?? 0));
      count += 3;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** Pixels whose RGB differs between two whole frames. */
function changedPixels(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let at = 0; at < a.length; at += 4) {
    if (a[at] !== b[at] || a[at + 1] !== b[at + 1] || a[at + 2] !== b[at + 2]) count += 1;
  }
  return count;
}

function insideAny(
  boxes: { x0: number; y0: number; x1: number; y1: number }[],
  x: number,
  y: number,
): boolean {
  for (const box of boxes) {
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return true;
  }
  return false;
}

/** A scheduler that never fires: the gate drives `renderOnce` itself. */
const manualScheduler: FrameScheduler = {
  request: () => 0,
  cancel: () => undefined,
};

async function run(): Promise<GoldenReport> {
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE[0];
  canvas.height = OUTPUT_SIZE[1];
  document.body.append(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    // The preview path is judged by what reached the canvas, and the canvas is
    // cleared after a composite unless this is set.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (gl === null) throw new Error('no WebGL2 context');
  // Bound to its own const so the null check survives into the closures below.
  const context: WebGL2RenderingContext = gl;

  const glRenderer = (() => {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const value: unknown =
      ext === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    return typeof value === 'string' ? value : 'unknown';
  })();
  note(`gl renderer: ${glRenderer}`);

  // The atlas is rasterised from whatever `document.fonts` has resolved, and a
  // `@font-face` only loads when something asks for it. Without both of these the
  // gate would quietly measure the fallback face — which would still pass, and
  // would stop proving that the shipped one reaches the pixels.
  await document.fonts.load('600 72px "Mona Sans"');
  await document.fonts.ready;
  const raster = rasterizeGlyphs({ emPx: 72 });
  const atlas: TextAtlas = uploadTextAtlas(gl, raster);
  note(`text atlas: ${String(raster.glyphs.size)} glyphs, cap ${raster.capHeight.toFixed(3)} em`);

  const sourceCanvas = new OffscreenCanvas(SOURCE_SIZE[0], SOURCE_SIZE[1]);
  paintSource(sourceCanvas);
  const frame = new VideoFrame(sourceCanvas, { timestamp: 0 });

  const compositor = new Compositor(gl, OUTPUT_SIZE);
  const withAnnotations = compile(fixtureDocument({ annotations: true }), EMPTY_COMPILE_CONTEXT);
  const without = compile(fixtureDocument({ annotations: false }), EMPTY_COMPILE_CONTEXT);

  const source: PreviewSource = {
    frameAt: () => frame,
    prime: () => Promise.resolve(),
    release: () => undefined,
    hasSourceFrameAt: () => true,
    liveFrames: 1,
    ringCapacity: 8,
  };
  const loop = new PreviewLoop({
    compositor,
    screen: source,
    durationSec: DURATION_SEC,
    timeline: withAnnotations,
    // The *same* atlas object the export path is handed below. That identity is the
    // whole of "glyphs cannot differ between the two paths".
    textAtlas: atlas,
    scheduler: manualScheduler,
  });

  const frames = { screen: frame, textAtlas: atlas };
  const bytes = OUTPUT_SIZE[0] * OUTPUT_SIZE[1] * 4;
  const exportBuffer = new Uint8Array(bytes);
  const plainBuffer = new Uint8Array(bytes);

  /** The export path: fixed timestamp, `resolve`, `render`, read the framebuffer. */
  function exportFrame(timeline: CompiledTimeline, t: number, into: Uint8Array): Uint8Array {
    compositor.render(frames, resolve(timeline, t));
    return compositor.readPixels(into);
  }

  /** The preview path: the shipping loop, then read what reached the canvas. */
  function previewFrame(t: number): Uint8Array {
    loop.seek(t);
    loop.renderOnce();
    return readCanvas(context);
  }

  const timestamps: TimestampReport[] = [];
  for (const t of TIMESTAMPS) {
    const state = resolve(withAnnotations, t);
    const zoom = { amount: state.zoom.amount, center: [...state.zoom.center] as [number, number] };

    exportFrame(withAnnotations, t, exportBuffer);
    const annotated = exportBuffer.slice();
    const preview = previewFrame(t);
    const delta = maxDelta(annotated, preview);

    exportFrame(without, t, plainBuffer);

    const parkedActive = t >= PARKED_RANGE[0] && t <= PARKED_RANGE[1];
    const expected: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const probeRects = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
    for (const [name, box] of Object.entries(BOXES)) {
      if (name === 'parked' && !parkedActive) continue;
      if (name === 'fading' && expectedFadingWeight(t) <= 0) continue;
      // The revealing stroke is authored to draw nothing at t=0 — `progress` is 0
      // there — so its box is not an expectation at that instant. It is still a
      // probe: `outsideExpected` would count the ink as stray otherwise.
      if (name === 'revealing' && expectedRevealProgress(t) <= 0) continue;
      const rect = expectedBoxPx(box, zoom, BOX_PAD_PX);
      expected.push(rect);
      probeRects.set(name, rect);
    }

    let changedPixels = 0;
    let outsideExpected = 0;
    const probes: Record<string, KindProbe> = {};
    for (const [name, rect] of probeRects) {
      probes[name] = { changed: 0, area: rectArea(rect) };
    }
    let parkedChanged = 0;
    const parkedRect = expectedBoxPx(BOXES['parked']!, zoom, 0);

    for (let y = 0; y < OUTPUT_SIZE[1]; y++) {
      for (let x = 0; x < OUTPUT_SIZE[0]; x++) {
        const at = (y * OUTPUT_SIZE[0] + x) * 4;
        if (
          annotated[at] === plainBuffer[at] &&
          annotated[at + 1] === plainBuffer[at + 1] &&
          annotated[at + 2] === plainBuffer[at + 2]
        ) {
          continue;
        }
        changedPixels += 1;
        if (!insideAny(expected, x, y)) outsideExpected += 1;
        for (const [name, rect] of probeRects) {
          if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) {
            const probe = probes[name];
            if (probe !== undefined) probe.changed += 1;
          }
        }
        if (
          !parkedActive &&
          x >= parkedRect.x0 &&
          x <= parkedRect.x1 &&
          y >= parkedRect.y0 &&
          y <= parkedRect.y1
        ) {
          parkedChanged += 1;
        }
      }
    }

    // Opaque white over the fixture's pattern: the mean difference is linear in the
    // track's window weight, measured inside the box so no antialiased edge dilutes
    // it. Read out of the frame the export path produced.
    const fadingBox = expectedBoxPx(BOXES['fading']!, zoom, -6);
    const fadingMeanDiff = meanAbsDiff(annotated, plainBuffer, fadingBox);

    const maskBox = expectedBoxPx(BOXES['mask']!, zoom, 0);
    const maskCentre = rgbaAt(
      annotated,
      Math.round((maskBox.x0 + maskBox.x1) / 2),
      Math.round((maskBox.y0 + maskBox.y1) / 2),
    );

    // The blur's variance is measured well inside the region, so the feathered edge
    // — which is half unblurred by construction — cannot flatter the ratio.
    const blurBox = expectedBoxPx(BOXES['blur']!, zoom, -8);
    const blurred = variance(annotated, blurBox);
    const plain = variance(plainBuffer, blurBox);

    timestamps.push({
      t,
      zoomAmount: zoom.amount,
      maxDelta: delta,
      changedPixels,
      outsideExpected,
      probes,
      maskCentre,
      blurVarianceRatio: plain > 0 ? blurred / plain : Number.NaN,
      parkedChanged,
      parkedActive,
      fadingMeanDiff,
      fadingWeight: expectedFadingWeight(t),
      revealProgress: expectedRevealProgress(t),
    });
  }

  const controls = runControls(gl, compositor, frames, atlas, exportBuffer);

  frame.close();
  const report: GoldenReport = {
    ok: true,
    error: null,
    contextLost: gl.isContextLost(),
    environment: {
      glRenderer,
      electron: '',
      chrome: navigator.userAgent,
    },
    outputSize: [OUTPUT_SIZE[0], OUTPUT_SIZE[1]],
    sourceSize: [SOURCE_SIZE[0], SOURCE_SIZE[1]],
    timestamps,
    controls,
    privacyFallbacks: compositor.annotations.privacyFallbacks,
    textTruncations: compositor.annotations.textTruncations,
    textSpansWithoutAtlas: compositor.annotations.textSpansWithoutAtlas,
    strokesWithoutScratch: compositor.annotations.strokesWithoutScratch,
    atlasGlyphs: raster.glyphs.size,
    logs,
  };
  loop.stop();
  compositor.dispose();
  return report;
}

function rectArea(rect: { x0: number; y0: number; x1: number; y1: number }): number {
  const w = Math.max(0, Math.min(OUTPUT_SIZE[0], rect.x1) - Math.max(0, rect.x0));
  const h = Math.max(0, Math.min(OUTPUT_SIZE[1], rect.y1) - Math.max(0, rect.y0));
  return Math.round(w * h);
}

/**
 * Read the canvas's own drawing buffer, top row first.
 *
 * `Compositor.readPixels` flips its framebuffer read into row order; this does the
 * same for the default framebuffer, so the two paths are compared in the same
 * orientation and a flip bug in either would show up as a difference rather than
 * cancelling out.
 */
function readCanvas(gl: WebGL2RenderingContext): Uint8Array {
  const [width, height] = OUTPUT_SIZE;
  const buffer = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
  const stride = width * 4;
  const row = new Uint8Array(stride);
  for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
    const topAt = top * stride;
    const bottomAt = bottom * stride;
    row.set(buffer.subarray(topAt, topAt + stride));
    buffer.copyWithin(topAt, bottomAt, bottomAt + stride);
    buffer.set(row, bottomAt);
  }
  return buffer;
}

/**
 * The controls.
 *
 * Each one puts a *known* defect in front of a check this gate relies on and records
 * whether the check saw it. They are the difference between "the assertions passed"
 * and "the assertions mean something".
 */
function runControls(
  gl: WebGL2RenderingContext,
  compositor: Compositor,
  frames: { screen: VideoFrame; textAtlas: TextAtlas },
  atlas: TextAtlas,
  buffer: Uint8Array,
): Control[] {
  const controls: Control[] = [];
  const t = 1;

  // 1. The comparator itself. Render one path from a state whose annotation opacity
  //    has been nudged by the smallest amount a byte can carry, and require the
  //    per-pixel comparison to see it. If this ever reads `detected: false`, the
  //    delta-0 assertion above is passing because nothing can move it.
  {
    const timeline = compile(fixtureDocument({ annotations: true }), EMPTY_COMPILE_CONTEXT);
    compositor.render(frames, resolve(timeline, t));
    const reference = compositor.readPixels(buffer).slice();

    const perturbed = resolve(timeline, t);
    for (const annotation of perturbed.annotations) {
      const opacity = annotation.values.get('opacity');
      if (opacity !== undefined) opacity[0] = 0.5;
    }
    compositor.render(frames, perturbed);
    const moved = compositor.readPixels(buffer).slice();
    const delta = maxDelta(reference, moved);
    controls.push({
      name: 'comparator-sees-a-perturbed-annotation',
      detected: delta > 0,
      detail: `max per-channel delta ${String(delta)} after halving every annotation's opacity`,
    });
  }

  // 2. A blur whose region cannot be read must refuse the frame, not draw nothing.
  {
    const document_ = fixtureDocument({ annotations: true });
    for (const track of document_.tracks) {
      for (const span of track.spans ?? []) {
        if (span.type === 'blur') delete span.channels?.['center'];
      }
    }
    const timeline = compile(document_, EMPTY_COMPILE_CONTEXT);
    let threw = '';
    try {
      compositor.render(frames, resolve(timeline, t));
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    controls.push({
      name: 'a-blur-with-no-region-refuses-the-frame',
      detected: threw !== '',
      detail: threw === '' ? 'render() returned normally' : threw,
    });
  }

  // 3. A text span with no atlas must NOT refuse — refusing is the two privacy kinds'
  //    alone. The span is skipped, the rest of the frame (including its redactions)
  //    still composites, and the condition is *observable*, which is what the preview
  //    loop turns into a single `onError`. All three, or this is not detected: a
  //    build that threw, one that drew nothing, and one that skipped silently each
  //    fail it for their own reason.
  {
    const timeline = compile(fixtureDocument({ annotations: true }), EMPTY_COMPILE_CONTEXT);
    const plainTimeline = compile(fixtureDocument({ annotations: false }), EMPTY_COMPILE_CONTEXT);
    const before = compositor.annotations.textSpansWithoutAtlas;
    let threw = '';
    let changed = 0;
    try {
      compositor.render({ screen: frames.screen }, resolve(timeline, t));
      const withoutAtlas = compositor.readPixels(buffer).slice();
      compositor.render(frames, resolve(plainTimeline, t));
      const plain = compositor.readPixels(buffer);
      changed = changedPixels(withoutAtlas, plain);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    const reported = compositor.annotations.textSpansWithoutAtlas - before;
    controls.push({
      name: 'a-text-span-with-no-atlas-degrades-and-is-reported',
      detected: threw === '' && reported > 0 && changed > 1000,
      detail:
        threw !== ''
          ? `render() threw: ${threw}`
          : `${String(reported)} span(s) counted, ${String(changed)} pixels still drew`,
    });
  }

  // 4. A blur too large to produce is redacted solid rather than weakly blurred.
  {
    const document_ = fixtureDocument({ annotations: true });
    for (const track of document_.tracks) {
      for (const span of track.spans ?? []) {
        if (span.type === 'blur') span.style = { blurPx: 100_000, feather: 0.004 };
      }
    }
    const before = compositor.annotations.privacyFallbacks;
    const timeline = compile(document_, EMPTY_COMPILE_CONTEXT);
    compositor.render(frames, resolve(timeline, t));
    const pixels = compositor.readPixels(buffer);
    const box = expectedBoxPx(BOXES['blur']!, { amount: 1, center: [0.5, 0.5] }, -8);
    const remaining = variance(pixels, box);
    const fallbacks = compositor.annotations.privacyFallbacks - before;
    controls.push({
      name: 'an-unproducible-blur-is-redacted-solid',
      detected: fallbacks > 0 && remaining < 1,
      detail: `${String(fallbacks)} fallback(s), residual variance ${remaining.toFixed(4)}`,
    });
  }

  // 5. The variance probe can tell a blurred region from an unblurred one at all.
  //    Without this, a ratio assertion could be passing on a fixture with no detail
  //    in it — the same hole as a golden test on a black frame.
  {
    const timeline = compile(fixtureDocument({ annotations: false }), EMPTY_COMPILE_CONTEXT);
    compositor.render(frames, resolve(timeline, t));
    const plain = compositor.readPixels(buffer);
    const box = expectedBoxPx(BOXES['blur']!, { amount: 1, center: [0.5, 0.5] }, -8);
    const v = variance(plain, box);
    controls.push({
      name: 'the-fixture-has-detail-for-a-blur-to-destroy',
      detected: v > 500,
      detail: `unblurred luma variance ${v.toFixed(1)}`,
    });
  }

  // 6. The mask probe reads a real pixel, not a fixed constant.
  {
    const timeline = compile(fixtureDocument({ annotations: false }), EMPTY_COMPILE_CONTEXT);
    compositor.render(frames, resolve(timeline, t));
    const plain = compositor.readPixels(buffer);
    const box = expectedBoxPx(BOXES['mask']!, { amount: 1, center: [0.5, 0.5] }, 0);
    const centre = rgbaAt(
      plain,
      Math.round((box.x0 + box.x1) / 2),
      Math.round((box.y0 + box.y1) / 2),
    );
    const isMask =
      centre[0] === MASK_FILL[0] && centre[1] === MASK_FILL[1] && centre[2] === MASK_FILL[2];
    controls.push({
      name: 'the-mask-probe-is-not-reading-the-masks-colour-by-accident',
      detected: !isMask,
      detail: `with annotations off the centre reads rgb(${centre.slice(0, 3).join(',')})`,
    });
  }

  // 7. The atlas actually rasterised ink. An empty atlas would draw no text and the
  //    per-kind probe would be the only thing that noticed — this says so directly.
  {
    let ink = 0;
    for (const glyph of atlas.glyphs.values()) if (glyph.width > 0) ink += 1;
    controls.push({
      name: 'the-text-atlas-has-ink',
      detected: ink > 40,
      detail: `${String(ink)} glyphs with a non-empty quad`,
    });
  }

  void gl;
  return controls;
}

void (async () => {
  try {
    const report = await run();
    await window.golden.finish(report);
  } catch (error) {
    await window.golden.finish({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      contextLost: false,
      environment: { glRenderer: 'unknown', electron: '', chrome: navigator.userAgent },
      outputSize: [OUTPUT_SIZE[0], OUTPUT_SIZE[1]],
      sourceSize: [SOURCE_SIZE[0], SOURCE_SIZE[1]],
      timestamps: [],
      controls: [],
      privacyFallbacks: 0,
      textTruncations: 0,
      textSpansWithoutAtlas: 0,
      strokesWithoutScratch: 0,
      atlasGlyphs: 0,
      logs,
    });
  }
})();
