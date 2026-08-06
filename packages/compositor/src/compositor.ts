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
 * Phase 6 drew the screen track and nothing else. The passes that follow attach to
 * the same FBO in the same `render()` call: phase 11's annotations are here
 * (`AnnotationPass`), and the bubble (7) and cursor (5) are not yet. Handing this
 * class a `webcam` or `cursor` today throws rather than being quietly ignored,
 * because "the webcam did not appear" is a bug report nobody enjoys receiving.
 *
 * The other throw out of `render` is a redaction that could not be placed, and it is
 * a *refusal* rather than a missing pass: the render target is cleared to the
 * background on the way out, so a caller that catches it and still calls
 * {@link Compositor.present} or reads the framebuffer gets the letterbox colour and
 * never the unredacted picture. Only `blur` and `mask` reach it; `annotations.ts`
 * draws the line and says why a missing glyph atlas is on the other side of it.
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
 *
 * A third, quieter one falls out of those: the source texture is uploaded once per
 * *frame of the recording*, not once per composite. `render` still draws on every
 * call — state changes between two composites of the same frame, and a spring-driven
 * zoom (`@loom/edl`) changes it every tick — but it does not re-upload pixels the
 * texture already holds. See the comment on the upload; it is where the budget
 * actually goes.
 */

import { AnnotationPass, type AnnotationContext } from './annotations.ts';
import { contentRect, rectToNdc, sourceSampleRect, type Rect } from './geometry.ts';
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
import type { ResolvedState } from '@loom/edl';
import { SCREEN_FRAGMENT_SHADER, SCREEN_VERTEX_SHADER, UNIT_QUAD } from './shaders.ts';
import type { TextAtlas } from './text-atlas.ts';

/**
 * The frames a composite draws from, per §4.1.
 *
 * `webcam` and `cursor` are declared here because §4.1 declares them and later
 * phases fill them in; passing either today is an error, not a no-op.
 */
export interface CompositorFrames {
  screen: VideoFrame | null;
  /** Phase 7. */
  webcam?: VideoFrame | null;
  /** Phase 5. */
  cursor?: { texture: WebGLTexture; hotspot: [number, number]; sizePx: [number, number] } | null;
  /**
   * Phase 11, and required by `text` annotations only.
   *
   * Not part of `ResolvedState` for the reason the background is not: it is a
   * property of the *renderer*, not of the timeline. Preview and export must pass
   * the **same object** — `text-atlas.ts` explains why that is what makes glyphs a
   * §4.5 non-difference rather than a hope about two canvases.
   */
  textAtlas?: TextAtlas | null;
}

export interface CompositorOptions {
  /**
   * Letterbox colour, components `0..1`, in **the render target's own encoding —
   * which is display-encoded, not linear light.**
   *
   * This docstring said "linear-encoded" until phase 14 and was wrong, in the
   * direction that costs the most: `gl-util.ts` makes the target `RGBA8` rather
   * than `SRGB8_ALPHA8`, so `gl.clearColor` stores these values verbatim, and the
   * screen pass uploads its `VideoFrame` with `UNPACK_COLORSPACE_CONVERSION_WEBGL
   * = NONE` into the same target. Every value in this pipeline is display-encoded
   * end to end, exactly as `packages/edl/src/annotations.ts` sets out for
   * annotation colours; a background is not the one exception. Following the old
   * sentence means `srgbToLinear(hex / 255)`, which renders the letterbox visibly
   * darker than the colour that was authored — and, if only one of preview and
   * export takes it, makes the two differ by a gamma curve in a channel §4.5 puts
   * on the must-not-differ list.
   *
   * Nothing catches that today because the default below is `[0, 0, 0]`, where the
   * two encodings agree, and no caller anywhere constructs another background.
   *
   * Not part of `ResolvedState`: §3.6 does not put it there, and a background is a
   * property of the output, not of the timeline. `edit.json`'s `BackgroundSpec`
   * (§2.6) becomes a pass of its own in a later phase — this is the docstring that
   * pass will be written against.
   */
  background?: readonly [number, number, number];
}

const DEFAULT_BACKGROUND: readonly [number, number, number] = [0, 0, 0];

/** The compositor's own, writable view of the context it hands the annotation pass. */
interface MutableAnnotationContext extends AnnotationContext {
  source: Rect;
  content: Rect;
  sourcePixels: [number, number];
  outputSize: [number, number];
  target: RenderTarget;
  textAtlas: TextAtlas | null;
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  readonly gpuTimer: GpuTimer;
  /** Phase 11's passes. Built with the compositor; its programs link once. */
  readonly annotations: AnnotationPass;

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
  /** One row, for the readback flip. Sized on first use and reused after that. */
  #rowScratch = new Uint8Array(0);
  /**
   * The frame whose pixels are already in {@link #screenTexture}.
   *
   * Identity witness, not ownership: it is only ever compared with `!==`, never
   * closed here and never sampled from — `FrameRing` remains the single owner of
   * every `VideoFrame` (§10.2), and the texture keeps its own copy of the pixels
   * once the upload has happened, so the ring is free to close the frame.
   */
  #uploaded: VideoFrame | null = null;
  #frames = 0;
  #disposed = false;

  /**
   * The one {@link AnnotationContext}, rewritten in place — same bargain as the
   * uniform scratch buffers above and as `resolve`'s single `ResolvedState`.
   */
  readonly #annotationContext: MutableAnnotationContext;

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
    this.annotations = new AnnotationPass(gl);
    this.#annotationContext = {
      source: { x: 0, y: 0, width: 1, height: 1 },
      content: { x: 0, y: 0, width: 0, height: 0 },
      sourcePixels: [0, 0],
      outputSize: [0, 0],
      target: this.#target,
      textAtlas: null,
    };

    gl.useProgram(this.#program);
    gl.uniform1i(requireUniform(gl, this.#program, 'u_screen'), 0);
    gl.useProgram(null);

    this.clearToBackground();
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

  /**
   * Whether the driver has taken the context away.
   *
   * A lost context does not throw: every GL call becomes a no-op and every query
   * answers `null`. Nothing here can recover from it — the program, the textures and
   * the render target are all gone with it — so the value of asking is that a caller
   * can say *"the context was lost"* instead of reporting whatever it happened to be
   * holding. {@link readPixels} asks on the caller's behalf; see the reason there.
   */
  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  resize(outputSize: readonly [number, number]): void {
    this.#assertLive();
    const width = Math.max(1, Math.round(outputSize[0]));
    const height = Math.max(1, Math.round(outputSize[1]));
    if (width === this.#outputSize[0] && height === this.#outputSize[1]) return;
    const next = createRenderTarget(this.gl, width, height);
    deleteRenderTarget(this.gl, this.#target);
    this.#target = next;
    this.#annotationContext.target = next;
    this.#outputSize = [width, height];
    this.clearToBackground();
  }

  /**
   * Fill the render target with the letterbox background.
   *
   * Called once at construction and after every {@link resize}, because a `render`
   * with no frame leaves the target alone and the first composite of all has no
   * previous composite to leave.
   */
  clearToBackground(): void {
    this.#assertLive();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target.framebuffer);
    gl.viewport(0, 0, this.#outputSize[0], this.#outputSize[1]);
    gl.clearColor(this.#background[0], this.#background[1], this.#background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Composite one frame into the render target.
   *
   * A `null` screen frame **holds**: the target is left exactly as it was and
   * nothing is drawn — §4.3: *"If `frameAt` misses, hold the previous frame and
   * count it — do not block."* Holding belongs here rather than in the loop because
   * what is held is pixels in the target, not a `VideoFrame` the loop could keep a
   * reference to: the ring closes those on the next seek, and uploading a closed
   * frame throws. Counting the miss is still the loop's business.
   *
   * Export never passes `null` — it composites the frame the index selects at each
   * fixed timestamp — so this is a §4.5 *scheduling* difference and never a pixel
   * one.
   */
  render(frames: CompositorFrames, state: ResolvedState): void {
    this.#assertLive();
    if (frames.webcam != null) {
      throw new GlError(
        'the compositor has no webcam pass yet: the bubble track lands in phase 7 (architecture report §8)',
      );
    }
    if (frames.cursor != null) {
      throw new GlError('cursor compositing lands in phase 5 (architecture report §8)');
    }

    const screen = frames.screen;
    if (screen === null) return;

    this.gpuTimer.poll();
    this.gpuTimer.begin();
    // Balanced across the refusal below. An unended query leaves `GpuTimer` open and
    // in flight for good: every later `begin()` returns early and `poll()` never sees
    // a result, so `lastMs` freezes at whatever it last read and reports it forever.
    try {
      this.#draw(frames, screen, state);
      this.#frames += 1;
    } finally {
      this.gpuTimer.end();
    }
  }

  /** The composite itself. Split out only so the timer above can bracket it. */
  #draw(frames: CompositorFrames, screen: VideoFrame, state: ResolvedState): void {
    const gl = this.gl;
    const [width, height] = this.#outputSize;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(this.#background[0], this.#background[1], this.#background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // A `VideoFrame`'s intrinsic size as an image source is its *display* size:
    // crop and rotation are already applied. Sampling against coded size would
    // shift the picture by the codec's padding on any source whose height is not
    // a multiple of 16 — 2234 is not.
    const sourceWidth = screen.displayWidth;
    const sourceHeight = screen.displayHeight;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#screenTexture);
    // §12.4 measured VideoFrame → texture at 0.000 ms because ANGLE binds the
    // frame's IOSurface rather than copying — but that is the *hardware* decode
    // path. Where the platform has no 4K hardware H.264 decoder, which is every VM
    // and so every CI runner, the frames are CPU-backed: the same call converts and
    // uploads 30 MB and is then the whole frame budget. Measured by the phase-6
    // gate at 0.3 ms typical on an M5 Pro and 4.8 ms on a paravirtual GPU, against
    // 16.7 ms for everything; the draw and the blit are 0.01 ms beside it.
    //
    // So a frame already in the texture is not uploaded again. `frameAt` is
    // hold-last-frame (§4.2) over a source measured at 1.4 fps idle and 29.4 fps
    // under animation, so most ticks of a 60 Hz loop want the frame the previous
    // tick uploaded — 86% of them in that gate — and a redundant upload costs
    // exactly what a real one does.
    if (screen !== this.#uploaded) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, screen);
      this.#uploaded = screen;
    }

    const source = sourceSampleRect(state.zoom);
    const contentPx = contentRect([sourceWidth, sourceHeight], this.#outputSize);
    const content = rectToNdc(contentPx, this.#outputSize);

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

    // Phase 11, into the same target in the same call. The two rects are handed on
    // rather than recomputed: an annotation is anchored in normalized *source*
    // coordinates (`@loom/edl`'s `annotations.ts` explains why a privacy region has
    // to be), so it lands on the pixels this pass just drew that part of the source
    // onto — under zoom as well as without it — only while both derive from one
    // `sourceSampleRect`.
    //
    // §4.5 permits *"preview may skip blur passes while scrubbing"*. This build does
    // not take that allowance and there is no flag for it: the pass costs two
    // full-target draws per redacted region against a 16.67 ms frame, and a preview
    // that shows the unredacted picture whenever the playhead moves teaches the user
    // their blur is somewhere it is not. If it is ever taken, it must be a
    // *scheduling* difference confined to the preview loop, never a state one, and
    // the golden-frame test must keep judging the unskipped path.
    const context = this.#annotationContext;
    context.source = source;
    context.content = contentPx;
    context.sourcePixels[0] = sourceWidth;
    context.sourcePixels[1] = sourceHeight;
    context.outputSize[0] = width;
    context.outputSize[1] = height;
    context.target = this.#target;
    context.textAtlas = frames.textAtlas ?? null;
    try {
      this.annotations.render(state.annotations, context);
    } catch (thrown) {
      // A redaction that could not be placed refuses the frame — and the target is
      // holding the screen picture *without* it at this instant, which is the one
      // thing a privacy failure must never leave publishable. Clearing is not §4.3's
      // "hold the previous frame": holding is for a `null` frame, and a refusal is
      // not a miss. The throw still leaves, because an export that cannot place a
      // redaction must fail the export rather than encode an unredacted frame.
      this.clearToBackground();
      throw thrown;
    }
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
   *
   * **Throws on a lost context rather than returning `out`.** A lost context makes
   * `gl.readPixels` a no-op, so the caller's buffer keeps whatever was in it — the
   * frame before, for an exporter reading back every frame into one scratch array,
   * and the flip below then turns even *that* into pixels nothing ever drew. Handing
   * those back as a composite is worse than failing: it is fabricated output, and it
   * looks exactly like a real one.
   */
  readPixels(out?: Uint8Array): Uint8Array {
    this.#assertLive();
    const gl = this.gl;
    if (gl.isContextLost())
      throw new GlError('the WebGL context was lost; there is nothing to read');
    const [width, height] = this.#outputSize;
    const bytes = width * height * 4;
    const buffer = out !== undefined && out.byteLength >= bytes ? out : new Uint8Array(bytes);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // The flip is in place, through one retained row, so that `out` actually saves
    // an allocation: an export loop reads back every frame, and a full-frame scratch
    // would be ~30 MB of churn per frame at 4K.
    const stride = width * 4;
    if (this.#rowScratch.length !== stride) this.#rowScratch = new Uint8Array(stride);
    const row = this.#rowScratch;
    for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
      const topAt = top * stride;
      const bottomAt = bottom * stride;
      row.set(buffer.subarray(topAt, topAt + stride));
      buffer.copyWithin(topAt, bottomAt, bottomAt + stride);
      buffer.set(row, bottomAt);
    }
    return buffer;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#uploaded = null;
    const gl = this.gl;
    this.gpuTimer.dispose();
    this.annotations.dispose();
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
