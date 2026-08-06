/**
 * `@loom/compositor/raster` — the one impure corner of the compositor.
 *
 * Same shape as `@loom/format/fs`: the package's main entry is pure and this
 * subpath is the half that touches something. Here that something is a canvas —
 * rasterising glyphs needs a second DOM *value* beyond the GL context, and
 * `eslint.config.mjs` keeps `packages/compositor/src/**` down to one. Everything
 * downstream of the raster (where a glyph goes) stays in `text-atlas.ts`, where it
 * is arithmetic and both paths run it.
 *
 * **There must be exactly one caller per process, and preview and export must share
 * its result.** §4.5 puts annotation geometry on the must-be-identical list, and a
 * glyph raster is the one part of an annotation the *renderer* decides rather than
 * we do. Two calls to `rasterizeGlyphs` on the same machine will agree in practice;
 * one call and one atlas makes them agree by construction, which is the difference
 * between a property and a hope.
 *
 * The fonts are the Pressroom ones and they are self-hosted (`@loom/design/css`
 * declares the `@font-face` rules and the bundler emits the woff2 files). This
 * module does not load them — it draws with whatever family it is given — so a
 * caller **must** await `document.fonts.ready`, or the raster is the fallback face
 * and every label in the export is set in the wrong typeface.
 */

import type { GlyphMetric, TextAtlas } from '../text-atlas.ts';

/** The rasterised glyphs, before they are a GL texture. */
export interface GlyphRaster {
  image: ImageData;
  glyphs: Map<string, GlyphMetric>;
  lineHeight: number;
  capHeight: number;
  fallbackAdvance: number;
}

export interface RasterizeOptions {
  /** A CSS font family. Pressroom's UI face is `Mona Sans`. */
  fontFamily?: string;
  fontWeight?: string;
  /**
   * The em size the glyphs are rasterised at, in pixels.
   *
   * Not the size they are *drawn* at — {@link GlyphMetric} is in em and the shader
   * scales — but the resolution the coverage mask is captured at. 72 keeps a 5%-of-
   * frame-height cap crisp at 4K, where that cap is about 110 output pixels and the
   * atlas is being magnified rather than minified.
   */
  emPx?: number;
  /** Defaults to printable ASCII. */
  charset?: string;
  /** Widest the atlas may be. Rows wrap at this. */
  maxWidth?: number;
}

const DEFAULT_CHARSET = (() => {
  let text = '';
  for (let code = 0x20; code <= 0x7e; code++) text += String.fromCharCode(code);
  return text + '£€–—‘’“”…•→←↑↓✓×';
})();

/** Transparent padding between glyphs, so `LINEAR` cannot sample a neighbour. */
const PAD = 2;

export class RasterError extends Error {
  override readonly name = 'RasterError';
}

/**
 * Draw every character of `charset` into one coverage mask and measure it.
 *
 * White on transparent: the shader reads the alpha channel and takes the colour
 * from a uniform, so one atlas serves every colour an annotation is ever set to.
 */
export function rasterizeGlyphs(options: RasterizeOptions = {}): GlyphRaster {
  const emPx = Math.max(8, Math.round(options.emPx ?? 72));
  const family = options.fontFamily ?? 'Mona Sans';
  const weight = options.fontWeight ?? '600';
  const charset = options.charset ?? DEFAULT_CHARSET;
  const maxWidth = Math.max(256, options.maxWidth ?? 1024);
  const font = `${weight} ${String(emPx)}px "${family}"`;

  const measure = context(1, 1);
  measure.font = font;

  interface Placed {
    character: string;
    metrics: TextMetrics;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Pen-to-left-edge and baseline-to-top-edge, in pixels. */
    left: number;
    top: number;
  }

  const placed: Placed[] = [];
  let penX = PAD;
  let penY = PAD;
  let rowHeight = 0;
  let usedWidth = 0;

  for (const character of charset) {
    const metrics = measure.measureText(character);
    const left = -metrics.actualBoundingBoxLeft;
    const top = metrics.actualBoundingBoxAscent;
    const width = Math.ceil(metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight);
    const height = Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
    if (width <= 0 || height <= 0) {
      // A space: an advance and no ink. Recorded with a zero-size quad so layout
      // still moves the pen and the draw skips it.
      placed.push({ character, metrics, x: 0, y: 0, width: 0, height: 0, left, top });
      continue;
    }
    if (penX + width + PAD > maxWidth) {
      penX = PAD;
      penY += rowHeight + PAD;
      rowHeight = 0;
    }
    placed.push({ character, metrics, x: penX, y: penY, width, height, left, top });
    penX += width + PAD;
    if (penX > usedWidth) usedWidth = penX;
    if (height > rowHeight) rowHeight = height;
  }

  const atlasWidth = Math.max(1, Math.min(maxWidth, usedWidth + PAD));
  const atlasHeight = Math.max(1, penY + rowHeight + PAD);
  const draw = context(atlasWidth, atlasHeight);
  draw.font = font;
  draw.fillStyle = '#ffffff';
  draw.textAlign = 'left';
  draw.textBaseline = 'alphabetic';
  draw.clearRect(0, 0, atlasWidth, atlasHeight);

  const glyphs = new Map<string, GlyphMetric>();
  for (const glyph of placed) {
    if (glyph.width > 0) {
      // The pen goes where the glyph's ink starts, offset by its own bearings.
      draw.fillText(glyph.character, glyph.x - glyph.left, glyph.y + glyph.top);
    }
    glyphs.set(glyph.character, {
      u0: glyph.x / atlasWidth,
      v0: glyph.y / atlasHeight,
      u1: (glyph.x + glyph.width) / atlasWidth,
      v1: (glyph.y + glyph.height) / atlasHeight,
      advance: glyph.metrics.width / emPx,
      bearingX: glyph.left / emPx,
      bearingY: glyph.top / emPx,
      width: glyph.width / emPx,
      height: glyph.height / emPx,
    });
  }

  const capital = measure.measureText('H');
  const capHeight = capital.actualBoundingBoxAscent / emPx;
  const ascent = measure.measureText('Hg').fontBoundingBoxAscent;
  const descent = measure.measureText('Hg').fontBoundingBoxDescent;
  const lineHeight =
    Number.isFinite(ascent + descent) && ascent + descent > 0 ? (ascent + descent) / emPx : 1.2;

  return {
    image: draw.getImageData(0, 0, atlasWidth, atlasHeight),
    glyphs,
    lineHeight,
    capHeight: capHeight > 0 ? capHeight : 0.7,
    fallbackAdvance: measure.measureText(' ').width / emPx,
  };
}

/**
 * Upload a raster into a GL texture and pair it with its metrics.
 *
 * `LINEAR`/`CLAMP_TO_EDGE` and no mipmaps, for the reason `createSampledTexture`
 * gives: annotation text is magnified far more often than minified, and a mip chain
 * would make the glyph edge depend on the output size — a §4.5 divergence between a
 * 1440p preview and a 4K export of the same document.
 */
export function uploadTextAtlas(gl: WebGL2RenderingContext, raster: GlyphRaster): TextAtlas {
  const texture = gl.createTexture();
  if (texture === null) throw new RasterError('createTexture returned null (context lost?)');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, raster.image);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return {
    texture,
    glyphs: raster.glyphs,
    lineHeight: raster.lineHeight,
    capHeight: raster.capHeight,
    fallbackAdvance: raster.fallbackAdvance,
  };
}

function context(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new RasterError('OffscreenCanvas 2d context is unavailable');
  return ctx;
}
