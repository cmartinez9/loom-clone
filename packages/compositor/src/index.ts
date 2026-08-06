/**
 * `@loom/compositor` — the one compositor.
 *
 * Architecture report §1.3: *"Compositor class over a `WebGL2RenderingContext`.
 * Pure draw calls."* No framework, no DOM beyond the GL context, no I/O — §1.3
 * again: *"`edl` and `compositor` being framework-free is what lets a headless test
 * render frame 1,234 of a fixture project and compare it byte-for-byte against the
 * exporter's frame 1,234."* That test is §4.5's, and two gates are it. Phase 8's
 * `test/phase8-gate.test.ts` drives this compositor from the shipping `PreviewLoop`
 * and the shipping `ExportRenderLoop` in two GL contexts; phase 11's
 * `test/phase11-golden.test.ts` is it for the annotation passes, 24 timestamps
 * through the preview loop and through a fixed-timestamp export loop. Both compare
 * at a max per-pixel delta of 0.
 *
 * One subpath breaks the purity rule on purpose and says why in its own docblock:
 * `@loom/compositor/raster` rasterises glyphs into a `TextAtlas` and needs a canvas
 * to do it. Same bargain as `@loom/format/fs`.
 */

export { Compositor, type CompositorFrames, type CompositorOptions } from './compositor.ts';

export { AnnotationPass, type AnnotationContext } from './annotations.ts';

export {
  BLUR_FRAGMENT_SHADER,
  FULL_QUAD_VERTEX_SHADER,
  KIND_ARROW,
  KIND_ELLIPSE,
  KIND_RECT,
  MAX_BLUR_PASSES,
  MAX_BLUR_TAPS,
  MAX_PASS_SIGMA_PX,
  REGION_FRAGMENT_SHADER,
  SHAPE_FRAGMENT_SHADER,
  SHAPE_VERTEX_SHADER,
  TEXT_FRAGMENT_SHADER,
  TEXT_VERTEX_SHADER,
} from './annotation-shaders.ts';

export {
  FLOATS_PER_GLYPH,
  layoutText,
  MAX_TEXT_GLYPHS,
  type GlyphMetric,
  type TextAtlas,
  type TextBox,
  type TextLayoutResult,
} from './text-atlas.ts';

export {
  contentRect,
  MIN_ZOOM,
  rectToNdc,
  sourceSampleRect,
  sourceToOutput,
  type Rect,
  type SourceToOutput,
} from './geometry.ts';

export {
  createRenderTarget,
  createSampledTexture,
  deleteRenderTarget,
  describeRenderer,
  GlError,
  linkProgram,
  requireUniform,
  type RenderTarget,
} from './gl-util.ts';

export { GpuTimer } from './gpu-timer.ts';

export { SCREEN_FRAGMENT_SHADER, SCREEN_VERTEX_SHADER, UNIT_QUAD } from './shaders.ts';
