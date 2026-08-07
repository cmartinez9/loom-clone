/**
 * The one place a glyph raster is made, for both sides of §4.5.
 *
 * `@loom/compositor/raster` states the rule and cannot enforce it: *"There must be
 * exactly one caller per process, and preview and export must share its result … Two
 * calls to `rasterizeGlyphs` on the same machine will agree in practice; one call and
 * one atlas makes them agree by construction, which is the difference between a
 * property and a hope."* Preview and export are two processes here — a hidden export
 * window per job (§1.2) — so they cannot literally share an object. What they can
 * share is **this function**: one font family, one weight, one em size, one charset,
 * asked for the same way on both paths.
 *
 * ## Awaiting `document.fonts.ready` is not enough, and that is the trap
 *
 * A `@font-face` rule that nothing on the page uses is never fetched — the browser
 * loads a face lazily, on first use — so `document.fonts.ready` resolves *immediately*
 * on a page that declares Pressroom's faces and renders no text. That is exactly the
 * hidden export window: it has no DOM at all. `measureText` would then fall back to a
 * system face, silently, and the labels in an export would be set in a different
 * typeface from the labels in the preview the person approved.
 *
 * `document.fonts.load()` is what forces the fetch, and it is why this exists rather
 * than two calls to `rasterizeGlyphs` with the same options.
 *
 * ## A missing atlas is survivable, so this never throws
 *
 * A `text` span with no atlas is skipped and counted
 * (`AnnotationPass.textSpansWithoutAtlas`) rather than refusing the frame — phase 11's
 * graded rule: text failing to render is cosmetic and visible, where a redaction
 * failing is invisible and publishes a secret. So a machine with no `OffscreenCanvas`
 * 2d context loses its labels and keeps its export.
 */

import { rasterizeGlyphs, type GlyphRaster } from '@loom/compositor/raster';

/** Pressroom's UI face, and the weight annotations are set in. */
export const GLYPH_FONT_FAMILY = 'Mona Sans';
export const GLYPH_FONT_WEIGHT = '600';

/**
 * The em size the coverage mask is captured at.
 *
 * `rasterizeGlyphs`'s own default and repeated here on purpose: it is one of the
 * inputs preview and export must agree on, and a default that drifted in the library
 * would drift on both sides at once only if both took it from the library — which is
 * what this module makes true.
 */
export const GLYPH_EM_PX = 72;

/** The raster, or `null` when this machine could not make one. Never throws. */
export async function loadGlyphRaster(): Promise<GlyphRaster | null> {
  try {
    // The fetch, forced. Without it a page that renders no text never loads the face
    // and the raster is silently the fallback one.
    await document.fonts.load(
      `${GLYPH_FONT_WEIGHT} ${String(GLYPH_EM_PX)}px "${GLYPH_FONT_FAMILY}"`,
    );
    await document.fonts.ready;
  } catch {
    // A page with no font loading at all still gets a raster below, in whatever face
    // the platform gives it — the same face on both paths, since both come here.
  }
  try {
    return rasterizeGlyphs({
      fontFamily: GLYPH_FONT_FAMILY,
      fontWeight: GLYPH_FONT_WEIGHT,
      emPx: GLYPH_EM_PX,
    });
  } catch {
    return null;
  }
}
