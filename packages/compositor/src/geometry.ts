/**
 * The composite's geometry, as pure functions.
 *
 * Everything on §4.5's **"must be identical"** list that concerns the screen track
 * — *"zoom amount and center"* — is decided here and nowhere else. Preview and
 * export call the same two functions with the same state and the same output size,
 * so phase 8's golden-frame test compares two renders that could not have disagreed
 * about where to sample or where to draw.
 *
 * They live outside the GL code on purpose. A function that takes numbers and
 * returns numbers can be checked exhaustively in a Node test, which is the only
 * cheap way to be sure a clamp is right at every corner of its domain.
 *
 * Coordinate conventions, stated once:
 *
 *  - **Source coordinates** are normalized `[0..1]`, origin **top-left**, matching
 *    how a `VideoFrame` is laid out and how `events/cursor.ndjson` records position
 *    (§2.5).
 *  - **Output coordinates** are pixels, origin top-left, size = the render target.
 *  - The shader converts to GL's bottom-left origin; nothing above it does.
 */

import type { ResolvedZoom } from '@loom/edl';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smallest magnification. Below 1 the source would not fill its own frame. */
export const MIN_ZOOM = 1;

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/**
 * The region of the source that is visible, in normalized source coordinates.
 *
 * Width and height both shrink by `1 / amount`, so the visible region always has
 * the source's aspect ratio and a zoom never stretches the picture. The region is
 * then clamped to stay inside the source: a zoom centred near an edge slides
 * against it rather than sampling past it, which is what stops a rounded, smeared
 * `CLAMP_TO_EDGE` border appearing at the screen edges during a cursor-follow zoom.
 *
 * `amount` below 1 is clamped rather than rejected: this runs once per rendered
 * frame with numbers that will one day come from a spring, and a spring overshoots.
 */
export function sourceSampleRect(zoom: ResolvedZoom): Rect {
  const amount = Math.max(MIN_ZOOM, Number.isFinite(zoom.amount) ? zoom.amount : MIN_ZOOM);
  const width = 1 / amount;
  const height = 1 / amount;
  const [cx, cy] = zoom.center;
  return {
    x: clamp(cx - width / 2, 0, 1 - width),
    y: clamp(cy - height / 2, 0, 1 - height),
    width,
    height,
  };
}

/**
 * Where the source is drawn inside the output, in output pixels.
 *
 * Contain-fit, centred: the whole picture is visible and the leftover is letterbox.
 * The preview viewport and the export resolution differ (§4.5 permits exactly that),
 * so this must be a function of both sizes rather than a constant — and it must be
 * float-exact, because rounding it to whole pixels would make a 1440p preview and a
 * 1080p export disagree about sub-pixel placement in a way no golden test could
 * reconcile.
 */
export function contentRect(
  sourceSize: readonly [number, number],
  outputSize: readonly [number, number],
): Rect {
  const [sw, sh] = sourceSize;
  const [ow, oh] = outputSize;
  if (sw <= 0 || sh <= 0 || ow <= 0 || oh <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(ow / sw, oh / sh);
  const width = sw * scale;
  const height = sh * scale;
  return { x: (ow - width) / 2, y: (oh - height) / 2, width, height };
}

/**
 * The affine map from normalized source coordinates to output pixels.
 *
 * `px = originX + scaleX * sx`, `py = originY + scaleY * sy`, both origins top-left.
 *
 * It is the composition of the two rects the screen pass already uses and nothing
 * else, which is the point: an annotation anchored in source coordinates
 * (`@loom/edl/annotations` explains why it must be) lands on exactly the pixels the
 * screen pass drew that part of the source onto. Any second derivation would be a
 * blur that drifts off the thing it redacts under zoom.
 *
 * **The scales differ per axis.** Normalized source coordinates are anisotropic — x
 * over the width, y over the height — so `scaleX` and `scaleY` are equal only on a
 * square frame. Sizes are per-axis fractions and use both; isotropic scalars
 * (stroke width, corner radius, an arrow head) use `scaleX`, the frame-width
 * fraction §2.6's `"strokeWidth": 0.004` is written as.
 */
export interface SourceToOutput {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
}

export function sourceToOutput(source: Rect, content: Rect): SourceToOutput {
  const scaleX = source.width > 0 ? content.width / source.width : 0;
  const scaleY = source.height > 0 ? content.height / source.height : 0;
  return {
    originX: content.x - source.x * scaleX,
    originY: content.y - source.y * scaleY,
    scaleX,
    scaleY,
  };
}

/**
 * A rect in output pixels as an NDC rect, ready for `gl_Position`.
 *
 * Output y grows downward; NDC y grows upward. The flip happens here so the shader
 * stays a straight interpolation and there is one place to be wrong about it.
 */
export function rectToNdc(rect: Rect, outputSize: readonly [number, number]): Rect {
  const [ow, oh] = outputSize;
  if (ow <= 0 || oh <= 0) return { x: -1, y: -1, width: 0, height: 0 };
  return {
    x: (rect.x / ow) * 2 - 1,
    y: 1 - ((rect.y + rect.height) / oh) * 2,
    width: (rect.width / ow) * 2,
    height: (rect.height / oh) * 2,
  };
}
