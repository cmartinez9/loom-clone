/**
 * `@loom/compositor` — the one compositor.
 *
 * Architecture report §1.3: *"Compositor class over a `WebGL2RenderingContext`.
 * Pure draw calls."* No framework, no DOM beyond the GL context, no I/O — §1.3
 * again: *"`edl` and `compositor` being framework-free is what lets a headless test
 * render frame 1,234 of a fixture project and compare it byte-for-byte against the
 * exporter's frame 1,234."* That test is phase 8's gate (§4.5); this package is
 * built as though it already exists.
 */

export { Compositor, type CompositorFrames, type CompositorOptions } from './compositor.ts';

export { contentRect, MIN_ZOOM, rectToNdc, sourceSampleRect, type Rect } from './geometry.ts';

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

export { identityState, type ResolvedState, type ResolvedZoom } from './resolved-state.ts';

export { SCREEN_FRAGMENT_SHADER, SCREEN_VERTEX_SHADER, UNIT_QUAD } from './shaders.ts';
