/**
 * `Compositor` — one WebGL2 composite, called by preview and by export.
 *
 * Architecture report §4.1 declares the class and this file implements it:
 *
 * ```ts
 * export class Compositor {
 *   constructor(gl: WebGL2RenderingContext, outputSize: [number, number]);
 *   resize(outputSize: [number, number]): void;
 *   render(frames: CompositorFrames, state: ResolvedState): void;  // into the bound FBO
 *   present(): void;                                                // blit to the canvas
 * }
 * ```
 *
 * §4.1 also explains why WebGL2 rather than canvas 2D, and it is not throughput —
 * the composite measured 0.130 ms at 4K and 0.010 ms at 1440p, roughly 120× under
 * budget. It is capability: analytic antialiasing on the bubble's rounded edge,
 * per-pixel blur and mask annotations, and enough headroom to render the preview at
 * *full* 4K when paused, which is what makes pixel equality with the exporter
 * checkable at all.
 *
 * Phase 6 draws the screen track and nothing else. The passes that follow — bubble
 * (phase 4), cursor (5), annotations and blur/mask (11) — attach to the same FBO in
 * the same `render()` call. Handing this class a `webcam` or `cursor` today throws
 * rather than being quietly ignored, because "the webcam did not appear" is a bug
 * report nobody enjoys receiving.
 *
 * ## The two rules this class exists to keep
 *
 * **Nothing allocates in `render`.** §4.3's first anti-stutter rule. Uniform
 * locations, the vertex array, the uniform scratch buffers and the render target
 * are all built in the constructor or in `resize`. (The report notes its own spike
 * called `getUniformLocation` per draw and says out loud that that was spike code.)
 *
 * **The preview render target is the viewport size, but it samples the full
 * resolution source texture** (§4.3). Downscaling the source would make zoomed
 * preview soft and unlike the export. So the screen texture is always allocated at
 * the frame's own size and the zoom is a change of sample rect, never of texture.
 */

import { contentRect, rectToNdc, sourceSampleRect } from './geometry.ts';
import {
  createRenderTarget,
  createSampledTexture,
  deleteRenderTarget,
  GlError,
  linkProgram,
  requireUniform,
  type RenderTarget,
} from './gl-util.ts';
import { GpuTimer } from './gpu-timer.ts';
import type { ResolvedState } from './resolved-state.ts';
import { SCREEN_FRAGMENT_SHADER, SCREEN_VERTEX_SHADER, UNIT_QUAD } from './shaders.ts';

/**
 * The frames a composite draws from, per §4.1.
 *
 * `webcam` and `cursor` are declared here because §4.1 declares them and later
 * phases fill them in; passing either today is an error, not a no-op.
 */
export interface CompositorFrames {
  screen: VideoFrame | null;
  /** Phase 4. */
  webcam?: VideoFrame | null;
  /** Phase 5. */
  cursor?: { texture: WebGLTexture; hotspot: [number, number]; sizePx: [number, number] } | null;
}

export interface CompositorOptions {
  /**
   * Letterbox colour, linear-encoded RGB in `[0..1]`.
   *
   * Not part of `ResolvedState`: §3.6 does not put it there, and a background is a
   * property of the output, not of the timeline. `edit.json`'s `BackgroundSpec`
   * (§2.6) becomes a pass of its own in a later phase.
   */
  background?: readonly [number, number, number];
}

const DEFAULT_BACKGROUND: readonly [number, number, number] = [0, 0, 0];

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  readonly gpuTimer: GpuTimer;

  #outputSize: [number, number];
  #background: [number, number, number];

  readonly #program: WebGLProgram;
  readonly #vao: WebGLVertexArrayObject;
  readonly #quad: WebGLBuffer;
  readonly #screenTexture: WebGLTexture;
  readonly #uContent: WebGLUniformLocation;
  readonly #uSource: WebGLUniformLocation;

  #target: RenderTarget;
  /** Preallocated uniform payloads — §4.3: nothing allocates in the loop. */
  readonly #contentScratch = new Float32Array(4);
  readonly #sourceScratch = new Float32Array(4);
  #frames = 0;
  #disposed = false;

  constructor(
    gl: WebGL2RenderingContext,
    outputSize: readonly [number, number],
    options: CompositorOptions = {},
  ) {
    this.gl = gl;
    this.#outputSize = [
      Math.max(1, Math.round(outputSize[0])),
      Math.max(1, Math.round(outputSize[1])),
    ];
    const background = options.background ?? DEFAULT_BACKGROUND;
    this.#background = [background[0], background[1], background[2]];

    // Determinism knobs, set once. Any of these left at a browser default would
    // make the same VideoFrame upload differently in two contexts, which is a §4.5
    // divergence that no amount of shader care could undo.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);

    this.#program = linkProgram(gl, SCREEN_VERTEX_SHADER, SCREEN_FRAGMENT_SHADER);
    this.#uContent = requireUniform(gl, this.#program, 'u_content');
    this.#uSource = requireUniform(gl, this.#program, 'u_source');

    const vao = gl.createVertexArray();
    const quad = gl.createBuffer();
    if (vao === null || quad === null) {
      gl.deleteProgram(this.#program);
      throw new GlError('createVertexArray/createBuffer returned null (context lost?)');
    }
    this.#vao = vao;
    this.#quad = quad;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.#program, 'a_unit');
    if (location < 0) throw new GlError('attribute a_unit is missing');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.#screenTexture = createSampledTexture(gl);
    this.#target = createRenderTarget(gl, this.#outputSize[0], this.#outputSize[1]);
    this.gpuTimer = new GpuTimer(gl);

    gl.useProgram(this.#program);
    gl.uniform1i(requireUniform(gl, this.#program, 'u_screen'), 0);
    gl.useProgram(null);
  }

  get outputSize(): readonly [number, number] {
    return this.#outputSize;
  }

  /** Frames composited since construction. */
  get frameCount(): number {
    return this.#frames;
  }

  get background(): readonly [number, number, number] {
    return this.#background;
  }

  set background(value: readonly [number, number, number]) {
    this.#background = [value[0], value[1], value[2]];
  }

  /** The framebuffer `render()` draws into. Export reads back from this. */
  get framebuffer(): WebGLFramebuffer {
    return this.#target.framebuffer;
  }

  resize(outputSize: readonly [number, number]): void {
    this.#assertLive();
    const width = Math.max(1, Math.round(outputSize[0]));
    const height = Math.max(1, Math.round(outputSize[1]));
    if (width === this.#outputSize[0] && height === this.#outputSize[1]) return;
    const next = createRenderTarget(this.gl, width, height);
    deleteRenderTarget(this.gl, this.#target);
    this.#target = next;
    this.#outputSize = [width, height];
  }

  /**
   * Composite one frame into the render target.
   *
   * A `null` screen frame clears to the background and returns — §4.3: *"If
   * `frameAt` misses, hold the previous frame and count it — do not block."* The
   * previous frame is the loop's business; this class simply draws what it is given.
   */
  render(frames: CompositorFrames, state: ResolvedState): void {
    this.#assertLive();
    if (frames.webcam != null) {
      throw new GlError('webcam compositing lands in phase 4 (architecture report §8)');
    }
    if (frames.cursor != null) {
      throw new GlError('cursor compositing lands in phase 5 (architecture report §8)');
    }

    const gl = this.gl;
    const [width, height] = this.#outputSize;

    this.gpuTimer.poll();
    this.gpuTimer.begin();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(this.#background[0], this.#background[1], this.#background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const screen = frames.screen;
    if (screen !== null) {
      // A `VideoFrame`'s intrinsic size as an image source is its *display* size:
      // crop and rotation are already applied. Sampling against coded size would
      // shift the picture by the codec's padding on any source whose height is not
      // a multiple of 16 — 2234 is not.
      const sourceWidth = screen.displayWidth;
      const sourceHeight = screen.displayHeight;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.#screenTexture);
      // The canonical zero-copy path on macOS: §12.4 measured VideoFrame → texture
      // at 0.000 ms because ANGLE binds the frame's IOSurface rather than copying.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, screen);

      const source = sourceSampleRect(state.zoom);
      const content = rectToNdc(
        contentRect([sourceWidth, sourceHeight], this.#outputSize),
        this.#outputSize,
      );

      this.#contentScratch[0] = content.x;
      this.#contentScratch[1] = content.y;
      this.#contentScratch[2] = content.width;
      this.#contentScratch[3] = content.height;
      this.#sourceScratch[0] = source.x;
      this.#sourceScratch[1] = source.y;
      this.#sourceScratch[2] = source.width;
      this.#sourceScratch[3] = source.height;

      gl.useProgram(this.#program);
      gl.uniform4fv(this.#uContent, this.#contentScratch);
      gl.uniform4fv(this.#uSource, this.#sourceScratch);
      gl.bindVertexArray(this.#vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }

    this.gpuTimer.end();
    this.#frames += 1;
  }

  /**
   * Blit the render target to the canvas.
   *
   * Preview's half of §4.1's split. Export never calls this; it reads the same
   * framebuffer back instead, which is why the two cannot diverge.
   */
  present(): void {
    this.#assertLive();
    const gl = this.gl;
    const [width, height] = this.#outputSize;
    const canvasWidth = gl.drawingBufferWidth;
    const canvasHeight = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.#target.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    // Both framebuffers are bottom-left origin, so this is a straight copy; the one
    // and only y flip in the pipeline is in the vertex shader.
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      0,
      0,
      canvasWidth,
      canvasHeight,
      gl.COLOR_BUFFER_BIT,
      width === canvasWidth && height === canvasHeight ? gl.NEAREST : gl.LINEAR,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Read the composited pixels back, RGBA8, **top row first**.
   *
   * `readPixels` hands back GL's bottom-up order; this flips into the row order
   * every image format and every encoder expects. Phase 8's golden-frame test and
   * the exporter's readback both come through here, so "what the preview drew" and
   * "what the export encoded" are the same array by construction.
   *
   * This is a synchronous GPU stall. It belongs in a test and in the export loop,
   * never in the preview loop.
   */
  readPixels(out?: Uint8Array): Uint8Array {
    this.#assertLive();
    const gl = this.gl;
    const [width, height] = this.#outputSize;
    const bytes = width * height * 4;
    const buffer = out !== undefined && out.byteLength >= bytes ? out : new Uint8Array(bytes);
    const scratch = new Uint8Array(bytes);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const stride = width * 4;
    for (let row = 0; row < height; row++) {
      buffer.set(
        scratch.subarray((height - 1 - row) * stride, (height - row) * stride),
        row * stride,
      );
    }
    return buffer;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const gl = this.gl;
    this.gpuTimer.dispose();
    deleteRenderTarget(gl, this.#target);
    gl.deleteTexture(this.#screenTexture);
    gl.deleteBuffer(this.#quad);
    gl.deleteVertexArray(this.#vao);
    gl.deleteProgram(this.#program);
  }

  #assertLive(): void {
    if (this.#disposed) throw new GlError('compositor has been disposed');
  }
}
