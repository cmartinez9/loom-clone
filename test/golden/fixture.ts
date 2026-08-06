/**
 * The fixture the golden gate renders: a document, a screen picture, and the boxes
 * the test expects each annotation to occupy.
 *
 * ## The boxes are computed here, by hand, on purpose
 *
 * `expectedBoxPx` repeats the source→output arithmetic in four lines rather than
 * calling `sourceToOutput`. That is not duplication to be tidied away: it is the
 * only thing that makes "every changed pixel is inside its annotation's own box" an
 * *independent* check. Sharing the production mapping would move the expectation and
 * the drawing together, and a gate whose expectation follows the defect is a gate
 * that cannot fail. The same argument as `packages/format/test/kill-mid-write.test.ts`
 * killing the real writer rather than a copy.
 *
 * ## The screen picture is high-frequency on purpose
 *
 * The blur check is a variance ratio, and variance is what a blur destroys. A flat
 * or smooth fixture would have almost none to begin with, so a blur that did nothing
 * would still score well. The pattern below is a fine checkerboard with a
 * deterministic per-cell hash on top, drawn at the source's own resolution.
 */

import { annotationSpan, annotationTrack, manualZoomTrack } from '@loom/edl';
import type { EditDocument, Keyframe, Track } from '@loom/format';

export const SOURCE_SIZE: readonly [number, number] = [1280, 720];
/**
 * Deliberately a different aspect from the source, so every frame is letterboxed
 * and the content rect is not the whole output. A gate whose content rect happened
 * to be the identity would not notice a mapping that ignores it.
 */
export const OUTPUT_SIZE: readonly [number, number] = [1024, 640];

export const DURATION_SEC = 12;
/** §4.5: *"a fixture project at 24 fixed timestamps"*. */
export const TIMESTAMP_COUNT = 24;

export const TIMESTAMPS: number[] = Array.from(
  { length: TIMESTAMP_COUNT },
  (_, i) => (i * DURATION_SEC) / TIMESTAMP_COUNT,
);

/**
 * The zoom track's window. Timestamps outside it resolve to amount 1.
 *
 * Placed after {@link FADING_RANGE} ends so the crossfade is measured on frames
 * where the whole source is on screen — a box that is half outside the visible
 * region under zoom would make a mean-over-the-box reading say nothing about the
 * weight.
 */
export const ZOOM_RANGE: [number, number] = [7, 10];
/** The parked annotation track's window. It is silent after this. */
export const PARKED_RANGE: [number, number] = [0, 4];

/**
 * The fading track's window and crossfade.
 *
 * `blendMs` is the other half of §3.5's window and it is invisible to a check that
 * only asks *whether* an annotation drew. This track is drawn opaque white over the
 * fixture's random pattern, so the mean difference inside its box is **exactly**
 * `weight × mean|255 − background|` — linear in the weight, and therefore readable
 * back out of the pixels as the weight itself.
 */
export const FADING_RANGE: [number, number] = [0, 6];
export const FADING_BLEND_MS = 2000;

/**
 * §3.5's window weight, written out here rather than imported from `resolve`.
 *
 * Four lines, for the reason `expectedBoxPx` is four lines: an expectation that
 * calls the implementation moves with it.
 */
export function expectedFadingWeight(t: number): number {
  if (t < FADING_RANGE[0] || t > FADING_RANGE[1]) return 0;
  const blend = FADING_BLEND_MS / 1000;
  return Math.min(1, Math.min(t - FADING_RANGE[0], FADING_RANGE[1] - t) / blend);
}

/** A box in normalized source coordinates: centre and full size. */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * One box per kind, laid out so none overlaps another.
 *
 * Non-overlap is what lets the per-kind probe mean "this kind drew something"
 * rather than "something drew something".
 */
export const BOXES: Record<string, Box> = {
  rect: { cx: 0.15, cy: 0.16, w: 0.18, h: 0.14 },
  ellipse: { cx: 0.45, cy: 0.16, w: 0.18, h: 0.14 },
  highlight: { cx: 0.78, cy: 0.16, w: 0.2, h: 0.12 },
  blur: { cx: 0.15, cy: 0.5, w: 0.24, h: 0.18 },
  mask: { cx: 0.45, cy: 0.5, w: 0.18, h: 0.14 },
  text: { cx: 0.78, cy: 0.5, w: 0.3, h: 0.14 },
  arrow: { cx: 0.28, cy: 0.83, w: 0.42, h: 0.16 },
  fading: { cx: 0.58, cy: 0.83, w: 0.12, h: 0.1 },
  parked: { cx: 0.78, cy: 0.84, w: 0.16, h: 0.12 },
};

/** The mask's fill, in bytes. The gate reads this exact triple back out of a pixel. */
export const MASK_FILL: [number, number, number] = [0x11, 0x22, 0xdd];

const hold = (v: number | number[]): { keys: Keyframe[] } => ({
  keys: [{ t: 0, v, ease: { kind: 'hold' } }],
});

function box(name: keyof typeof BOXES) {
  const b = BOXES[name];
  if (b === undefined) throw new Error(`no box named ${name}`);
  return { center: hold([b.cx, b.cy]), size: hold([b.w, b.h]), opacity: hold(1) };
}

function annotationTracks(): Track[] {
  const arrow = BOXES['arrow'];
  if (arrow === undefined) throw new Error('no arrow box');
  return [
    annotationTrack({
      id: 't-ann',
      spans: [
        annotationSpan({
          id: 'a-rect',
          kind: 'rect',
          start: 0,
          end: DURATION_SEC,
          style: { stroke: '#FF3B30', fill: 'none', strokeWidth: 0.008, cornerRadius: 0.01 },
          channels: box('rect'),
        }),
        annotationSpan({
          id: 'a-ellipse',
          kind: 'ellipse',
          start: 0,
          end: DURATION_SEC,
          style: { stroke: '#2ED573', fill: '#2ED57340', strokeWidth: 0.008 },
          channels: box('ellipse'),
        }),
        annotationSpan({
          id: 'a-highlight',
          kind: 'highlight',
          start: 0,
          end: DURATION_SEC,
          style: { fill: '#FFD60A80' },
          channels: box('highlight'),
        }),
        annotationSpan({
          id: 'a-blur',
          kind: 'blur',
          start: 0,
          end: DURATION_SEC,
          style: { blurPx: 18, feather: 0.004 },
          channels: box('blur'),
        }),
        annotationSpan({
          id: 'a-mask',
          kind: 'mask',
          start: 0,
          end: DURATION_SEC,
          style: {
            fill: `#${MASK_FILL.map((c) => c.toString(16).padStart(2, '0')).join('')}`,
          },
          channels: box('mask'),
        }),
        annotationSpan({
          id: 'a-text',
          kind: 'text',
          start: 0,
          end: DURATION_SEC,
          style: { text: 'REDACTED', fill: '#FFFFFF', fontSizeY: 0.06, align: 'center' },
          channels: box('text'),
        }),
        annotationSpan({
          id: 'a-arrow',
          kind: 'arrow',
          start: 0,
          end: DURATION_SEC,
          style: { stroke: '#FF9F1C', strokeWidth: 0.01, headLength: 0.05, headWidth: 0.035 },
          channels: {
            // Animated, so the span's own channels are exercised rather than just
            // its style — §3.3's *"an animated arrow is free"*.
            //
            // The tip starts a tenth of the box away from the tail rather than on
            // top of it: a zero-length arrow correctly draws nothing, and the gate
            // requires every kind to draw at *every* timestamp.
            from: hold([arrow.cx - arrow.w / 2 + 0.02, arrow.cy + arrow.h / 2 - 0.03]),
            to: {
              keys: [
                {
                  t: 0,
                  v: [arrow.cx - arrow.w / 2 + 0.12, arrow.cy + arrow.h / 2 - 0.05],
                  ease: { kind: 'linear' },
                },
                {
                  t: DURATION_SEC,
                  v: [arrow.cx + arrow.w / 2 - 0.02, arrow.cy - arrow.h / 2 + 0.03],
                  ease: { kind: 'hold' },
                },
              ],
            },
            opacity: hold(1),
          },
        }),
      ],
    }),
    // The crossfade check: opaque white, so the mean difference inside its box is
    // linear in the track's window weight and the weight can be read back out of the
    // composited pixels. `blendMs` is the half of §3.5 that a "did it draw" check
    // cannot see.
    annotationTrack({
      id: 't-fading',
      activeRanges: [FADING_RANGE],
      blendMs: FADING_BLEND_MS,
      spans: [
        annotationSpan({
          id: 'a-fading',
          kind: 'rect',
          start: 0,
          end: DURATION_SEC,
          style: { stroke: '#FFFFFF', fill: '#FFFFFF', strokeWidth: 0.004 },
          channels: box('fading'),
        }),
      ],
    }),
    // The window check: a track that is *enabled* and has a span covering every
    // instant, whose `activeRanges` end at 4 s. After that it must be silent.
    annotationTrack({
      id: 't-parked',
      activeRanges: [PARKED_RANGE],
      spans: [
        annotationSpan({
          id: 'a-parked',
          kind: 'rect',
          start: 0,
          end: DURATION_SEC,
          style: { stroke: '#FFFFFF', fill: '#FFFFFF', strokeWidth: 0.01 },
          channels: box('parked'),
        }),
      ],
    }),
  ];
}

/**
 * A zoom that is the identity outside {@link ZOOM_RANGE}.
 *
 * Curve keys rather than spring ones: the spring is phase 7's and has its own
 * determinism gate; what this fixture needs is a zoom that is *exactly* 1 at the
 * timestamps carrying the geometric probes, so the harness can compute the expected
 * boxes without reimplementing an 8 ms grid.
 */
function zoomTrack(): Track {
  return manualZoomTrack({
    id: 't-zoom',
    activeRanges: [ZOOM_RANGE],
    blendMs: 0,
    amount: [
      { t: ZOOM_RANGE[0], v: 1, ease: { kind: 'linear' } },
      { t: 8, v: 2, ease: { kind: 'hold' } },
      { t: 9, v: 2, ease: { kind: 'linear' } },
      { t: ZOOM_RANGE[1], v: 1, ease: { kind: 'hold' } },
    ],
    center: [{ t: ZOOM_RANGE[0], v: [0.4, 0.45], ease: { kind: 'hold' } }],
  });
}

export function fixtureDocument(
  options: { annotations: boolean } = { annotations: true },
): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 1,
    output: { size: [OUTPUT_SIZE[0], OUTPUT_SIZE[1]], fps: 30, background: { kind: 'none' } },
    clips: [{ id: 'c1', sourceStart: 0, sourceEnd: DURATION_SEC, speed: 1 }],
    tracks: [
      zoomTrack(),
      ...annotationTracks().map((track) =>
        options.annotations ? track : { ...track, enabled: false },
      ),
    ],
  };
}

// ---------------------------------------------------------------- geometry

export interface ContentRectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Contain-fit, computed here rather than imported. See the module comment.
 */
export function expectedContentRect(): ContentRectPx {
  const scale = Math.min(OUTPUT_SIZE[0] / SOURCE_SIZE[0], OUTPUT_SIZE[1] / SOURCE_SIZE[1]);
  const width = SOURCE_SIZE[0] * scale;
  const height = SOURCE_SIZE[1] * scale;
  return {
    x: (OUTPUT_SIZE[0] - width) / 2,
    y: (OUTPUT_SIZE[1] - height) / 2,
    width,
    height,
  };
}

/**
 * A normalized-source box in output pixels, at a given zoom.
 *
 * Four lines of arithmetic, written out: visible region, then contain-fit. `pad` is
 * the slack the checks allow for a one-pixel coverage ramp, a half stroke and a
 * blur's feather.
 */
export function expectedBoxPx(
  b: Box,
  zoom: { amount: number; center: [number, number] },
  pad: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const span = 1 / Math.max(1, zoom.amount);
  const sx = Math.min(Math.max(zoom.center[0] - span / 2, 0), 1 - span);
  const sy = Math.min(Math.max(zoom.center[1] - span / 2, 0), 1 - span);
  const content = expectedContentRect();
  const scaleX = content.width / span;
  const scaleY = content.height / span;
  const cx = content.x + (b.cx - sx) * scaleX;
  const cy = content.y + (b.cy - sy) * scaleY;
  const hx = (b.w / 2) * scaleX;
  const hy = (b.h / 2) * scaleY;
  return { x0: cx - hx - pad, y0: cy - hy - pad, x1: cx + hx + pad, y1: cy + hy + pad };
}

// ---------------------------------------------------------------- the picture

/**
 * The screen frame: a fine checkerboard with a deterministic per-cell hash.
 *
 * No `Math.random`. The gate compares two renders of the same picture and a third
 * against them, and a picture that differed between calls would make every number in
 * the report noise.
 */
export function paintSource(canvas: OffscreenCanvas): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('OffscreenCanvas 2d context is unavailable');
  const cell = 4;
  for (let y = 0; y < canvas.height; y += cell) {
    for (let x = 0; x < canvas.width; x += cell) {
      const i = (x / cell) | 0;
      const j = (y / cell) | 0;
      // A cheap integer hash: high-frequency, reproducible, no floating point.
      const h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
      const checker = (i + j) % 2 === 0 ? 0 : 255;
      const r = (h & 0xff) ^ checker;
      const g = ((h >>> 8) & 0xff) ^ checker;
      const b = ((h >>> 16) & 0xff) ^ checker;
      ctx.fillStyle = `rgb(${String(r)},${String(g)},${String(b)})`;
      ctx.fillRect(x, y, cell, cell);
    }
  }
}
