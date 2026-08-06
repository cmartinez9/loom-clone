/**
 * Text annotations: the atlas seam, and the layout that must not have two versions.
 *
 * ## Why the atlas is handed in rather than built here
 *
 * `@loom/compositor` is pure (§1.3, and `eslint.config.mjs` enforces it): DOM
 * *types*, and exactly one DOM *value* — the GL context it is handed. Rasterising a
 * font needs a second one, an `OffscreenCanvas`, so the raster lives outside and
 * arrives as a {@link TextAtlas}: a texture plus metrics.
 *
 * That is not only a purity dodge. §4.5 puts annotation geometry on the
 * must-be-identical list, and glyph rasterisation is the one part of an annotation
 * that a *renderer* decides rather than we do. Preview and export therefore share
 * **one atlas object**, built once by `rasterizeGlyphs` and `uploadTextAtlas` in
 * `@loom/compositor/raster` — this package's one impure subpath, and the only
 * supported way to make one; identical pixels then hold by construction rather than
 * by both sides happening to ask the same canvas the same question. A pass handed no
 * atlas at all skips its `text` spans and counts them
 * (`AnnotationPass.textSpansWithoutAtlas`) rather than refusing the frame: that is
 * `blur` and `mask`'s alone. What this package owns is everything downstream of
 * the raster — where each glyph goes — and {@link layoutText} is that, as arithmetic
 * over numbers, so it is the same in both paths for the same reason `resolve` is.
 *
 * ## Units
 *
 * Every metric is in **em**, so one atlas serves every size. `capHeight` is what
 * `fontSizeY` is measured against — cap height rather than em box, because "5% of
 * the frame height" should mean the height of a capital letter, which is what a
 * person sees, and not the invisible box around it that varies by typeface.
 */

/** One glyph's place in the atlas and its metrics, all normalised. */
export interface GlyphMetric {
  /** Sub-rect of the atlas texture, `0..1`, origin top-left. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pen advance, in em. */
  advance: number;
  /** Pen-to-quad offset, in em. `bearingY` is measured **up** from the baseline. */
  bearingX: number;
  bearingY: number;
  /** Quad size, in em. */
  width: number;
  height: number;
}

export interface TextAtlas {
  /** A coverage mask in the alpha channel: white glyphs on transparent. */
  texture: WebGLTexture;
  glyphs: ReadonlyMap<string, GlyphMetric>;
  /** Baseline to baseline, in em. */
  lineHeight: number;
  /** Height of a capital, in em. What `fontSizeY` measures. */
  capHeight: number;
  /** Advance of a glyph that is not in the map, in em. */
  fallbackAdvance: number;
}

/** Floats per glyph in the vertex buffer: six vertices of `(x, y, u, v)`. */
export const FLOATS_PER_GLYPH = 24;

/**
 * The most glyphs one span may draw.
 *
 * A cap rather than a growing buffer, because the buffer is allocated once and
 * written in place — §4.3's first anti-stutter rule reaches here too. A label
 * longer than this is truncated and {@link layoutText} says so in its return value,
 * so a caller can report it rather than wonder.
 */
export const MAX_TEXT_GLYPHS = 512;

/** Where a laid-out string goes, in output pixels. */
export interface TextBox {
  /** Centre, output pixels, origin top-left. */
  cx: number;
  cy: number;
  /** Half-extent, output pixels. */
  hx: number;
  hy: number;
}

export interface TextLayoutResult {
  /** Vertices written into the buffer. Six per drawn glyph. */
  vertexCount: number;
  /** True when the string ran past {@link MAX_TEXT_GLYPHS}. */
  truncated: boolean;
}

/**
 * Lay a string out into `out` as triangle vertices, `(x, y, u, v)` per vertex.
 *
 * Newline-separated lines, no wrapping: an annotation is a label, and a wrapping
 * algorithm is a second thing preview and export would have to agree about
 * character for character. The block is centred vertically on the box; `align`
 * places each line horizontally inside it.
 *
 * `emPx` is the em size in output pixels — a caller converts from `fontSizeY`
 * (a fraction of the frame height, measured as cap height) by
 * `emPx = fontSizeY * pxPerSourceY / atlas.capHeight`.
 *
 * Pure arithmetic, no allocation: `out` is the caller's buffer.
 */
export function layoutText(
  text: string,
  atlas: TextAtlas,
  box: TextBox,
  emPx: number,
  align: 'start' | 'center' | 'end',
  out: Float32Array,
): TextLayoutResult {
  const lines = text.split('\n');
  const lineHeightPx = atlas.lineHeight * emPx;
  const capPx = atlas.capHeight * emPx;
  // The first baseline: the block of `n` cap-height boxes centred on `cy`, then
  // down by half a cap so the *cap* is centred rather than the baseline.
  const firstBaseline = box.cy - ((lines.length - 1) * lineHeightPx) / 2 + capPx / 2;

  let at = 0;
  let glyphs = 0;
  let truncated = false;

  for (let line = 0; line < lines.length; line++) {
    // `for…of` over a string walks code points and allocates nothing — spreading it
    // into an array would, and this runs once per text span per frame.
    const characters = lines[line] ?? '';
    let advance = 0;
    for (const character of characters) {
      advance += (atlas.glyphs.get(character)?.advance ?? atlas.fallbackAdvance) * emPx;
    }

    let pen: number;
    if (align === 'start') pen = box.cx - box.hx;
    else if (align === 'end') pen = box.cx + box.hx - advance;
    else pen = box.cx - advance / 2;

    const baseline = firstBaseline + line * lineHeightPx;

    for (const character of characters) {
      const glyph = atlas.glyphs.get(character);
      if (glyph === undefined) {
        pen += atlas.fallbackAdvance * emPx;
        continue;
      }
      if (glyph.width > 0 && glyph.height > 0) {
        if (glyphs >= MAX_TEXT_GLYPHS) {
          truncated = true;
          break;
        }
        const x0 = pen + glyph.bearingX * emPx;
        const y0 = baseline - glyph.bearingY * emPx;
        const x1 = x0 + glyph.width * emPx;
        const y1 = y0 + glyph.height * emPx;
        // Two triangles, wound the same way as the unit quad's strip.
        at = push(out, at, x0, y0, glyph.u0, glyph.v0);
        at = push(out, at, x1, y0, glyph.u1, glyph.v0);
        at = push(out, at, x0, y1, glyph.u0, glyph.v1);
        at = push(out, at, x1, y0, glyph.u1, glyph.v0);
        at = push(out, at, x1, y1, glyph.u1, glyph.v1);
        at = push(out, at, x0, y1, glyph.u0, glyph.v1);
        glyphs += 1;
      }
      pen += glyph.advance * emPx;
    }
    if (truncated) break;
  }

  return { vertexCount: glyphs * 6, truncated };
}

function push(out: Float32Array, at: number, x: number, y: number, u: number, v: number): number {
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = u;
  out[at + 3] = v;
  return at + 4;
}
