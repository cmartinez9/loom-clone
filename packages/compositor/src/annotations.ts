/**
 * `AnnotationPass` — the phase 11 half of a composite.
 *
 * `Compositor.render` draws the screen and then hands the render target to this,
 * once, with the two rects the screen pass already computed. Everything here is a
 * draw call over numbers `@loom/edl` produced; there is no second reading of the
 * document and no second opinion about geometry, which is what §4.5 requires of
 * *"annotation geometry, colour, opacity"*.
 *
 * ## Order is document order, with no exceptions
 *
 * §3.5's stacking rule is *"tracks … in array order"*, and `resolve` pushes spans
 * into `state.annotations` in track order and then span order. This draws them in
 * exactly that order and special-cases nothing — a blur placed after a rectangle
 * blurs the rectangle, because that is what "later spans are on top" means. A rule
 * with an exception in it is a rule two people will read differently.
 *
 * ## Failing closed
 *
 * `blur` and `mask` are privacy features: when one does not apply, the user has
 * published something they meant to hide, and it fails *silently* — the frame looks
 * finished, it is simply not redacted. So there are three behaviours here, and the
 * line between them is who made the decision:
 *
 *  - **The document says not to draw.** A resolved `opacity` of 0 draws nothing, for
 *    every kind including these two. That is authored intent — a blur fading in has
 *    a zero at its first key — and honouring it is not a failure.
 *  - **We do not know where to redact.** {@link readAnnotationGeometry} throws, and
 *    the throw comes straight out of `render()`. A frame whose redaction could not be
 *    placed must not be composited at all; there is nothing safe to draw.
 *  - **We know where, and cannot blur it.** The region is filled **opaque** instead,
 *    and {@link AnnotationPass.privacyFallbacks} counts it. A solid redaction is
 *    stronger than the one asked for, never weaker, so this direction is always safe
 *    — and it is the reason a blur too large for {@link MAX_BLUR_PASSES} does not
 *    quietly become a small one.
 *
 * A `text` span with no atlas throws for the same reason `Compositor` throws when
 * handed a webcam frame it has no pass for: an annotation that silently does not
 * appear is a bug report nobody enjoys receiving, and this one can hide a caption
 * the user believes is in their video.
 */

import {
  AnnotationError,
  isAnnotationKind,
  newAnnotationGeometry,
  readAnnotationGeometry,
  readAnnotationStyle,
  type AnnotationGeometry,
  type AnnotationKind,
  type AnnotationStyle,
  type ResolvedAnnotation,
  type Rgba,
} from '@loom/edl';
import {
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
import { rectToNdc, sourceToOutput, type Rect } from './geometry.ts';
import {
  createRenderTarget,
  deleteRenderTarget,
  GlError,
  linkProgram,
  requireUniform,
  type RenderTarget,
} from './gl-util.ts';
import { UNIT_QUAD } from './shaders.ts';
import { FLOATS_PER_GLYPH, layoutText, MAX_TEXT_GLYPHS, type TextAtlas } from './text-atlas.ts';

/**
 * Below this σ, in output pixels, a Gaussian moves no light between neighbouring
 * pixels and the "blur" is the identity. `0.17` is a 0.5 px radius at the 3σ the
 * tap count is chosen from — half a pixel, which is not a redaction.
 */
const MIN_EFFECTIVE_SIGMA_PX = 0.17;

/** What `render` needs to place a source-anchored annotation on the output. */
export interface AnnotationContext {
  /** The visible region of the source, normalized — `sourceSampleRect(state.zoom)`. */
  source: Rect;
  /** Where the source is drawn in the output, in pixels — `contentRect(...)`. */
  content: Rect;
  /** The source's own pixel size. Only `blurPx`, which is in source pixels, needs it. */
  sourcePixels: readonly [number, number];
  outputSize: readonly [number, number];
  /** The target `Compositor.render` drew the screen into. Read and written here. */
  target: RenderTarget;
  /** Required by, and only by, `text` spans. */
  textAtlas?: TextAtlas | null;
}

/** One span's compile-time reading, cached on the identity of its resolved record. */
interface Prepared {
  kind: AnnotationKind | null;
  style: AnnotationStyle | null;
  /** A style this build refuses. Rethrown every frame; never swallowed once read. */
  error: AnnotationError | null;
  geometry: AnnotationGeometry;
}

export class AnnotationPass {
  readonly gl: WebGL2RenderingContext;

  /**
   * Regions filled solid because the blur they asked for could not be produced.
   *
   * Not an error and not silent: an exporter reads it and can tell the user *"three
   * regions were redacted solid"*, which is a true statement about their file. Zero
   * on every ordinary run.
   */
  privacyFallbacks = 0;

  /** Text spans truncated at {@link MAX_TEXT_GLYPHS}. Diagnostic, like the above. */
  textTruncations = 0;

  readonly #quad: WebGLBuffer;

  readonly #shape: WebGLProgram;
  readonly #shapeVao: WebGLVertexArrayObject;
  readonly #uShape: {
    quad: WebGLUniformLocation;
    pxRect: WebGLUniformLocation;
    kind: WebGLUniformLocation;
    box: WebGLUniformLocation;
    line: WebGLUniformLocation;
    params: WebGLUniformLocation;
    fill: WebGLUniformLocation;
    stroke: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
  };

  readonly #blur: WebGLProgram;
  readonly #blurVao: WebGLVertexArrayObject;
  readonly #uBlur: {
    step: WebGLUniformLocation;
    sigma: WebGLUniformLocation;
    taps: WebGLUniformLocation;
  };

  readonly #region: WebGLProgram;
  readonly #regionVao: WebGLVertexArrayObject;
  readonly #uRegion: {
    quad: WebGLUniformLocation;
    pxRect: WebGLUniformLocation;
    box: WebGLUniformLocation;
    params: WebGLUniformLocation;
    outputSize: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
  };

  readonly #text: WebGLProgram;
  readonly #textVao: WebGLVertexArrayObject;
  readonly #textBuffer: WebGLBuffer;
  readonly #textVertices = new Float32Array(MAX_TEXT_GLYPHS * FLOATS_PER_GLYPH);
  readonly #uText: {
    outputSize: WebGLUniformLocation;
    fill: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
  };

  /** Preallocated uniform payloads — §4.3: nothing allocates in the loop. */
  readonly #v4a = new Float32Array(4);
  readonly #v4b = new Float32Array(4);
  readonly #v4c = new Float32Array(4);
  readonly #v4d = new Float32Array(4);
  readonly #v4e = new Float32Array(4);
  readonly #v2 = new Float32Array(2);

  readonly #prepared = new WeakMap<ResolvedAnnotation, Prepared>();

  /** Ping-pong for the separable blur. Allocated on the first blur, not before. */
  #scratchA: RenderTarget | null = null;
  #scratchB: RenderTarget | null = null;

  #disposed = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    const quad = gl.createBuffer();
    if (quad === null) throw new GlError('createBuffer returned null (context lost?)');
    this.#quad = quad;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.#shape = linkProgram(gl, SHAPE_VERTEX_SHADER, SHAPE_FRAGMENT_SHADER);
    this.#shapeVao = this.#unitQuadVao(this.#shape);
    this.#uShape = {
      quad: requireUniform(gl, this.#shape, 'u_quad'),
      pxRect: requireUniform(gl, this.#shape, 'u_pxRect'),
      kind: requireUniform(gl, this.#shape, 'u_kind'),
      box: requireUniform(gl, this.#shape, 'u_box'),
      line: requireUniform(gl, this.#shape, 'u_line'),
      params: requireUniform(gl, this.#shape, 'u_params'),
      fill: requireUniform(gl, this.#shape, 'u_fill'),
      stroke: requireUniform(gl, this.#shape, 'u_stroke'),
      opacity: requireUniform(gl, this.#shape, 'u_opacity'),
    };

    this.#blur = linkProgram(gl, FULL_QUAD_VERTEX_SHADER, BLUR_FRAGMENT_SHADER);
    this.#blurVao = this.#unitQuadVao(this.#blur);
    this.#uBlur = {
      step: requireUniform(gl, this.#blur, 'u_step'),
      sigma: requireUniform(gl, this.#blur, 'u_sigma'),
      taps: requireUniform(gl, this.#blur, 'u_taps'),
    };
    gl.useProgram(this.#blur);
    gl.uniform1i(requireUniform(gl, this.#blur, 'u_src'), 1);

    this.#region = linkProgram(gl, SHAPE_VERTEX_SHADER, REGION_FRAGMENT_SHADER);
    this.#regionVao = this.#unitQuadVao(this.#region);
    this.#uRegion = {
      quad: requireUniform(gl, this.#region, 'u_quad'),
      pxRect: requireUniform(gl, this.#region, 'u_pxRect'),
      box: requireUniform(gl, this.#region, 'u_box'),
      params: requireUniform(gl, this.#region, 'u_params'),
      outputSize: requireUniform(gl, this.#region, 'u_outputSize'),
      opacity: requireUniform(gl, this.#region, 'u_opacity'),
    };
    gl.useProgram(this.#region);
    gl.uniform1i(requireUniform(gl, this.#region, 'u_src'), 1);

    this.#text = linkProgram(gl, TEXT_VERTEX_SHADER, TEXT_FRAGMENT_SHADER);
    this.#uText = {
      outputSize: requireUniform(gl, this.#text, 'u_outputSize'),
      fill: requireUniform(gl, this.#text, 'u_fill'),
      opacity: requireUniform(gl, this.#text, 'u_opacity'),
    };
    gl.useProgram(this.#text);
    gl.uniform1i(requireUniform(gl, this.#text, 'u_atlas'), 1);

    const textBuffer = gl.createBuffer();
    const textVao = gl.createVertexArray();
    if (textBuffer === null || textVao === null) {
      throw new GlError('createBuffer/createVertexArray returned null (context lost?)');
    }
    this.#textBuffer = textBuffer;
    this.#textVao = textVao;
    gl.bindVertexArray(textVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, textBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.#textVertices.byteLength, gl.DYNAMIC_DRAW);
    const px = gl.getAttribLocation(this.#text, 'a_px');
    const uv = gl.getAttribLocation(this.#text, 'a_uv');
    if (px < 0 || uv < 0) throw new GlError('the text program is missing a_px/a_uv');
    gl.enableVertexAttribArray(px);
    gl.vertexAttribPointer(px, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.useProgram(null);
  }

  #unitQuadVao(program: WebGLProgram): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (vao === null) throw new GlError('createVertexArray returned null (context lost?)');
    const location = gl.getAttribLocation(program, 'a_unit');
    if (location < 0) throw new GlError('attribute a_unit is missing');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
  }

  /**
   * Draw every annotation that covers this instant, in order.
   *
   * The caller has already bound and drawn into `context.target`; this leaves it
   * bound and leaves blending disabled again, so `Compositor.render` needs to know
   * nothing about what happened in here.
   */
  render(annotations: readonly ResolvedAnnotation[], context: AnnotationContext): void {
    if (annotations.length === 0) return;
    const gl = this.gl;
    const map = sourceToOutput(context.source, context.content);

    gl.enable(gl.BLEND);
    // Straight alpha for colour, and **the destination's alpha is left alone**.
    // The screen pass writes an opaque target and a composite is opaque; blending
    // alpha too would leave `1 - a + a²` wherever an annotation is semi-transparent,
    // which is invisible on screen and a per-pixel difference the moment one path
    // reads the framebuffer and the other reads a canvas that forces alpha to 1.
    // A §4.5 divergence that shows up only in the alpha channel is exactly the kind
    // a golden test exists to refuse.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    try {
      for (const annotation of annotations) {
        const prepared = this.#prepare(annotation);
        const kind = prepared.kind;
        if (kind === null) continue;
        if (prepared.error !== null) throw prepared.error;
        const style = prepared.style;
        if (style === null) continue;

        const geometry = prepared.geometry;
        readAnnotationGeometry(annotation, kind, geometry);
        // Authored intent, not a failure: see the module comment's three cases.
        if (geometry.opacity <= 0) continue;

        switch (kind) {
          case 'blur':
            this.#drawBlur(context, map, geometry, style);
            break;
          case 'mask':
            this.#drawShape(context, map, geometry, style, KIND_RECT, style.fill, [0, 0, 0, 0]);
            break;
          // A highlight *is* a rectangle; what makes it a highlighter rather than a
          // box is its defaults — a translucent fill and no outline — and those live
          // in `readAnnotationStyle`, where every default this build has is stated.
          case 'highlight':
          case 'rect':
            this.#drawShape(context, map, geometry, style, KIND_RECT, style.fill, style.stroke);
            break;
          case 'ellipse':
            this.#drawShape(context, map, geometry, style, KIND_ELLIPSE, style.fill, style.stroke);
            break;
          case 'arrow':
            this.#drawShape(context, map, geometry, style, KIND_ARROW, style.fill, style.stroke);
            break;
          case 'text':
            this.#drawText(context, map, geometry, style, annotation.id);
            break;
        }
      }
    } finally {
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      gl.useProgram(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, context.target.framebuffer);
      gl.viewport(0, 0, context.outputSize[0], context.outputSize[1]);
    }
  }

  #prepare(annotation: ResolvedAnnotation): Prepared {
    const cached = this.#prepared.get(annotation);
    if (cached !== undefined) return cached;
    const kind = isAnnotationKind(annotation.type) ? annotation.type : null;
    let style: AnnotationStyle | null = null;
    let error: AnnotationError | null = null;
    if (kind !== null) {
      try {
        style = readAnnotationStyle(annotation.id, kind, annotation.style);
      } catch (thrown) {
        if (!(thrown instanceof AnnotationError)) throw thrown;
        error = thrown;
      }
    }
    const prepared: Prepared = { kind, style, error, geometry: newAnnotationGeometry() };
    this.#prepared.set(annotation, prepared);
    return prepared;
  }

  // ---- the shape pass --------------------------------------------------------

  #drawShape(
    context: AnnotationContext,
    map: ReturnType<typeof sourceToOutput>,
    geometry: AnnotationGeometry,
    style: AnnotationStyle,
    kind: number,
    fill: Rgba,
    stroke: Rgba,
  ): void {
    const gl = this.gl;
    const strokePx = style.strokeWidth * map.scaleX;
    const cornerPx = style.cornerRadius * map.scaleX;
    const headLengthPx = style.headLength * map.scaleX;
    const headWidthPx = style.headWidth * map.scaleX;

    const cx = map.originX + map.scaleX * geometry.cx;
    const cy = map.originY + map.scaleY * geometry.cy;
    const hx = map.scaleX * geometry.hx;
    const hy = map.scaleY * geometry.hy;

    // One pixel for the coverage ramp, half a stroke for an outline centred on the
    // edge, and the arrow head's half-width because it is wider than its shaft.
    const margin =
      1 + strokePx / 2 + (kind === KIND_ARROW ? Math.max(headWidthPx / 2, headLengthPx) : 0);
    const pxRect: Rect = {
      x: cx - hx - margin,
      y: cy - hy - margin,
      width: 2 * (hx + margin),
      height: 2 * (hy + margin),
    };

    gl.useProgram(this.#shape);
    this.#setRect(this.#uShape.quad, this.#uShape.pxRect, pxRect, context.outputSize);
    gl.uniform1i(this.#uShape.kind, kind);
    this.#set4(this.#uShape.box, this.#v4b, cx, cy, hx, hy);
    this.#set4(
      this.#uShape.line,
      this.#v4c,
      map.originX + map.scaleX * geometry.x0,
      map.originY + map.scaleY * geometry.y0,
      map.originX + map.scaleX * geometry.x1,
      map.originY + map.scaleY * geometry.y1,
    );
    this.#set4(this.#uShape.params, this.#v4d, strokePx, cornerPx, headLengthPx, headWidthPx);
    this.#setColor(this.#uShape.fill, this.#v4e, fill);
    this.#setColor(this.#uShape.stroke, this.#v4a, stroke);
    gl.uniform1f(this.#uShape.opacity, geometry.opacity);

    gl.bindFramebuffer(gl.FRAMEBUFFER, context.target.framebuffer);
    gl.viewport(0, 0, context.outputSize[0], context.outputSize[1]);
    gl.bindVertexArray(this.#shapeVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---- the privacy pass ------------------------------------------------------

  #drawBlur(
    context: AnnotationContext,
    map: ReturnType<typeof sourceToOutput>,
    geometry: AnnotationGeometry,
    style: AnnotationStyle,
  ): void {
    const [width, height] = context.outputSize;
    const sourceWidth = context.sourcePixels[0];
    // `blurPx` is in source pixels (§2.6). Output pixels per source pixel is the
    // contain-fit scale times the zoom, which is exactly `scaleX / sourceWidth` —
    // so a zoomed-in redaction blurs harder, in step with the content it covers.
    const outPxPerSourcePx = sourceWidth > 0 ? map.scaleX / sourceWidth : 0;
    const sigma = (style.blurPx * outPxPerSourcePx) / 3;

    const passes = Math.max(1, Math.ceil((sigma / MAX_PASS_SIGMA_PX) ** 2));
    if (!(sigma >= MIN_EFFECTIVE_SIGMA_PX) || passes > MAX_BLUR_PASSES) {
      this.#redactSolid(context, map, geometry, style);
      return;
    }

    let scratch: { a: RenderTarget; b: RenderTarget };
    try {
      scratch = this.#ensureScratch(width, height);
    } catch (thrown) {
      if (!(thrown instanceof GlError)) throw thrown;
      this.#redactSolid(context, map, geometry, style);
      return;
    }

    const gl = this.gl;
    const sigmaPass = sigma / Math.sqrt(passes);
    const taps = Math.min(MAX_BLUR_TAPS, Math.max(1, Math.ceil(3 * sigmaPass)));

    gl.disable(gl.BLEND);
    gl.useProgram(this.#blur);
    gl.uniform1f(this.#uBlur.sigma, sigmaPass);
    gl.uniform1i(this.#uBlur.taps, taps);
    gl.bindVertexArray(this.#blurVao);
    gl.activeTexture(gl.TEXTURE1);

    let read = context.target.texture;
    for (let pass = 0; pass < passes; pass++) {
      // Horizontal, then vertical. Reading the render target's own texture while
      // writing to a scratch one is well defined; writing to the target is what is
      // not, which is why the result comes back through the region pass below.
      this.#blurAxis(read, scratch.b, 1 / width, 0, width, height);
      this.#blurAxis(scratch.b.texture, scratch.a, 0, 1 / height, width, height);
      read = scratch.a.texture;
    }

    gl.enable(gl.BLEND);
    this.#compositeRegion(context, map, geometry, style, scratch.a);
    gl.activeTexture(gl.TEXTURE0);
  }

  #blurAxis(
    source: WebGLTexture,
    into: RenderTarget,
    stepX: number,
    stepY: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.viewport(0, 0, width, height);
    this.#v2[0] = stepX;
    this.#v2[1] = stepY;
    gl.uniform2fv(this.#uBlur.step, this.#v2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  #compositeRegion(
    context: AnnotationContext,
    map: ReturnType<typeof sourceToOutput>,
    geometry: AnnotationGeometry,
    style: AnnotationStyle,
    from: RenderTarget,
  ): void {
    const gl = this.gl;
    const cx = map.originX + map.scaleX * geometry.cx;
    const cy = map.originY + map.scaleY * geometry.cy;
    const hx = map.scaleX * geometry.hx;
    const hy = map.scaleY * geometry.hy;
    const featherPx = style.feather * map.scaleX;
    const cornerPx = style.cornerRadius * map.scaleX;
    const margin = featherPx + 1;

    gl.useProgram(this.#region);
    this.#setRect(
      this.#uRegion.quad,
      this.#uRegion.pxRect,
      {
        x: cx - hx - margin,
        y: cy - hy - margin,
        width: 2 * (hx + margin),
        height: 2 * (hy + margin),
      },
      context.outputSize,
    );
    this.#set4(this.#uRegion.box, this.#v4b, cx, cy, hx, hy);
    this.#v2[0] = cornerPx;
    this.#v2[1] = featherPx;
    gl.uniform2fv(this.#uRegion.params, this.#v2);
    this.#v2[0] = context.outputSize[0];
    this.#v2[1] = context.outputSize[1];
    gl.uniform2fv(this.#uRegion.outputSize, this.#v2);
    gl.uniform1f(this.#uRegion.opacity, geometry.opacity);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, context.target.framebuffer);
    gl.viewport(0, 0, context.outputSize[0], context.outputSize[1]);
    gl.bindVertexArray(this.#regionVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * The fallback: fill the region opaque.
   *
   * Stronger than the redaction that was asked for, never weaker. Counted so a
   * caller can say it happened; not thrown, because a document asking for a blur
   * this build cannot produce is still a document whose privacy is intact once this
   * runs.
   */
  #redactSolid(
    context: AnnotationContext,
    map: ReturnType<typeof sourceToOutput>,
    geometry: AnnotationGeometry,
    style: AnnotationStyle,
  ): void {
    this.privacyFallbacks += 1;
    const fill: Rgba = style.fill[3] > 0 ? style.fill : [0, 0, 0, 1];
    this.#drawShape(context, map, geometry, style, KIND_RECT, fill, [0, 0, 0, 0]);
  }

  #ensureScratch(width: number, height: number): { a: RenderTarget; b: RenderTarget } {
    const a = this.#scratchA;
    const b = this.#scratchB;
    if (a !== null && b !== null && a.width === width && a.height === height) return { a, b };
    this.#releaseScratch();
    const next = createRenderTarget(this.gl, width, height);
    let second: RenderTarget;
    try {
      second = createRenderTarget(this.gl, width, height);
    } catch (thrown) {
      deleteRenderTarget(this.gl, next);
      throw thrown;
    }
    this.#scratchA = next;
    this.#scratchB = second;
    return { a: next, b: second };
  }

  #releaseScratch(): void {
    if (this.#scratchA !== null) deleteRenderTarget(this.gl, this.#scratchA);
    if (this.#scratchB !== null) deleteRenderTarget(this.gl, this.#scratchB);
    this.#scratchA = null;
    this.#scratchB = null;
  }

  // ---- the text pass ---------------------------------------------------------

  #drawText(
    context: AnnotationContext,
    map: ReturnType<typeof sourceToOutput>,
    geometry: AnnotationGeometry,
    style: AnnotationStyle,
    id: string,
  ): void {
    if (style.text === '') return;
    const atlas = context.textAtlas ?? null;
    if (atlas === null) {
      throw new AnnotationError(
        id,
        'a text annotation was resolved but no text atlas was supplied. Build one with ' +
          '`buildTextAtlas` from @loom/design and pass it as `frames.textAtlas`; a caption ' +
          'that silently does not appear is worse than a refused frame',
      );
    }
    const capPx = style.fontSizeY * map.scaleY;
    const emPx = atlas.capHeight > 0 ? capPx / atlas.capHeight : 0;
    if (!(emPx > 0)) return;

    const layout = layoutText(
      style.text,
      atlas,
      {
        cx: map.originX + map.scaleX * geometry.cx,
        cy: map.originY + map.scaleY * geometry.cy,
        hx: map.scaleX * geometry.hx,
        hy: map.scaleY * geometry.hy,
      },
      emPx,
      style.align,
      this.#textVertices,
    );
    if (layout.truncated) this.textTruncations += 1;
    if (layout.vertexCount === 0) return;

    const gl = this.gl;
    gl.useProgram(this.#text);
    this.#v2[0] = context.outputSize[0];
    this.#v2[1] = context.outputSize[1];
    gl.uniform2fv(this.#uText.outputSize, this.#v2);
    this.#setColor(this.#uText.fill, this.#v4a, style.fill);
    gl.uniform1f(this.#uText.opacity, geometry.opacity);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
    gl.bindVertexArray(this.#textVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#textBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#textVertices, 0, layout.vertexCount * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, context.target.framebuffer);
    gl.viewport(0, 0, context.outputSize[0], context.outputSize[1]);
    gl.drawArrays(gl.TRIANGLES, 0, layout.vertexCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // ---- uniform plumbing ------------------------------------------------------

  #setRect(
    quad: WebGLUniformLocation,
    pxRect: WebGLUniformLocation,
    rect: Rect,
    outputSize: readonly [number, number],
  ): void {
    const ndc = rectToNdc(rect, outputSize);
    this.#set4(quad, this.#v4a, ndc.x, ndc.y, ndc.width, ndc.height);
    this.#set4(pxRect, this.#v4b, rect.x, rect.y, rect.width, rect.height);
  }

  #set4(
    location: WebGLUniformLocation,
    scratch: Float32Array,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    scratch[0] = x;
    scratch[1] = y;
    scratch[2] = z;
    scratch[3] = w;
    this.gl.uniform4fv(location, scratch);
  }

  #setColor(location: WebGLUniformLocation, scratch: Float32Array, color: Rgba): void {
    this.#set4(location, scratch, color[0], color[1], color[2], color[3]);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const gl = this.gl;
    this.#releaseScratch();
    gl.deleteBuffer(this.#quad);
    gl.deleteBuffer(this.#textBuffer);
    gl.deleteVertexArray(this.#shapeVao);
    gl.deleteVertexArray(this.#blurVao);
    gl.deleteVertexArray(this.#regionVao);
    gl.deleteVertexArray(this.#textVao);
    gl.deleteProgram(this.#shape);
    gl.deleteProgram(this.#blur);
    gl.deleteProgram(this.#region);
    gl.deleteProgram(this.#text);
  }
}
