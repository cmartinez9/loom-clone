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
 * ## Failing closed, and only where failing closed is the point
 *
 * **Refusing a frame is `blur` and `mask`'s alone.** They are privacy features: when
 * one does not apply, the user has published something they meant to hide, and it
 * fails *silently* — the frame looks finished, it is simply not redacted. So there
 * are three behaviours for those two, and the line between them is who made the
 * decision:
 *
 *  - **The document says not to draw.** A resolved `opacity` of 0 draws nothing, for
 *    every kind including these two. That is authored intent — a blur fading in has
 *    a zero at its first key — and honouring it is not a failure.
 *  - **We do not know where to redact.** {@link readAnnotationGeometry} throws, and
 *    the throw comes straight out of `render()`. A frame whose redaction could not be
 *    placed must not be composited at all; there is nothing safe to draw. `Compositor`
 *    clears the render target before letting that throw out, so what a caller who
 *    catches it can still publish is the background and never the unredacted picture.
 *  - **We know where, and cannot blur it.** The region is filled **opaque** instead,
 *    and {@link AnnotationPass.privacyFallbacks} counts it. A solid redaction is
 *    stronger than the one asked for, never weaker, so this direction is always safe
 *    — and it is the reason a blur too large for {@link MAX_BLUR_PASSES} does not
 *    quietly become a small one.
 *
 * A `text` span with no atlas does **not** refuse the frame. Text failing to render
 * is cosmetic and *visible*; a redaction failing to render is invisible and publishes
 * a secret, and treating the two identically is how a rule written for redactions
 * came to brick every frame of a preview whose atlas had not been built yet. The span
 * is skipped, the rest of the frame composites, and
 * {@link AnnotationPass.textSpansWithoutAtlas} counts it so the caller can say so —
 * `PreviewLoop` reports the first one through its `onError` and stays quiet until the
 * condition clears. An atlas comes from `rasterizeGlyphs` + `uploadTextAtlas` in
 * `@loom/compositor/raster`; `text-atlas.ts` says why preview and export must pass
 * the same one.
 */

import {
  AnnotationError,
  isAnnotationKind,
  newAnnotationGeometry,
  readAnnotationGeometry,
  readAnnotationStyle,
  readStrokePoints,
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
  MAX_STROKE_SEGMENTS_PER_BATCH,
  REGION_FRAGMENT_SHADER,
  SHAPE_FRAGMENT_SHADER,
  SHAPE_VERTEX_SHADER,
  STROKE_COMPOSITE_FRAGMENT_SHADER,
  STROKE_COVERAGE_FRAGMENT_SHADER,
  STROKE_FLOATS_PER_VERTEX,
  STROKE_VERTEX_SHADER,
  STROKE_VERTS_PER_SEGMENT,
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
  /**
   * A `stroke` span's polyline in its own `-1..1` box, and the cumulative arc
   * length along it in those units.
   *
   * Both read once, here, because neither changes: the shape of a hand-drawn line
   * is fixed at the instant the pen came up (`@loom/edl`'s `readStrokePoints` says
   * why it is in `style` rather than in a channel). The lengths are the reveal's
   * denominator and are measured in box units rather than in output pixels — a box
   * whose aspect is the one the pen drew at maps the two proportionally, and
   * measuring in pixels would put an O(n) walk on the frame path to buy a reveal
   * that is only different when the user has squashed the ink.
   */
  points: Float32Array | null;
  lengths: Float32Array | null;
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

  /**
   * Text spans skipped because no atlas was supplied.
   *
   * The observable half of "a missing atlas degrades rather than refuses". This
   * package is pure — it has no `onError` to call and no way to acquire one — so the
   * condition is left here as state, monotonically, and the caller reads it after
   * `render` and decides what to say. `PreviewLoop` reports the first frame of a run
   * and then stays quiet: at 60 fps an unconditional report is sixty errors a second,
   * which is its own defect.
   */
  textSpansWithoutAtlas = 0;

  /**
   * Strokes skipped because no scratch target could be allocated.
   *
   * The stroke pass's counterpart to {@link textSpansWithoutAtlas}, and the same
   * bargain: ink that cannot be drawn is skipped and counted, never thrown on, so a
   * GL context under memory pressure costs the annotation and not the frame. The
   * privacy kinds do the opposite — see {@link privacyFallbacks}.
   */
  strokesWithoutScratch = 0;

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

  readonly #strokeCoverage: WebGLProgram;
  readonly #strokeComposite: WebGLProgram;
  readonly #strokeVao: WebGLVertexArrayObject;
  readonly #strokeBuffer: WebGLBuffer;
  readonly #strokeVertices = new Float32Array(
    MAX_STROKE_SEGMENTS_PER_BATCH * STROKE_VERTS_PER_SEGMENT * STROKE_FLOATS_PER_VERTEX,
  );
  readonly #uStrokeCoverage: {
    outputSize: WebGLUniformLocation;
    half: WebGLUniformLocation;
  };
  readonly #uStrokeComposite: {
    quad: WebGLUniformLocation;
    pxRect: WebGLUniformLocation;
    outputSize: WebGLUniformLocation;
    ink: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
  };
  readonly #strokeCompositeVao: WebGLVertexArrayObject;

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

    this.#strokeCoverage = linkProgram(gl, STROKE_VERTEX_SHADER, STROKE_COVERAGE_FRAGMENT_SHADER);
    this.#uStrokeCoverage = {
      outputSize: requireUniform(gl, this.#strokeCoverage, 'u_outputSize'),
      half: requireUniform(gl, this.#strokeCoverage, 'u_half'),
    };

    this.#strokeComposite = linkProgram(gl, SHAPE_VERTEX_SHADER, STROKE_COMPOSITE_FRAGMENT_SHADER);
    this.#strokeCompositeVao = this.#unitQuadVao(this.#strokeComposite);
    this.#uStrokeComposite = {
      quad: requireUniform(gl, this.#strokeComposite, 'u_quad'),
      pxRect: requireUniform(gl, this.#strokeComposite, 'u_pxRect'),
      outputSize: requireUniform(gl, this.#strokeComposite, 'u_outputSize'),
      ink: requireUniform(gl, this.#strokeComposite, 'u_ink'),
      opacity: requireUniform(gl, this.#strokeComposite, 'u_opacity'),
    };
    gl.useProgram(this.#strokeComposite);
    gl.uniform1i(requireUniform(gl, this.#strokeComposite, 'u_src'), 1);

    const strokeBuffer = gl.createBuffer();
    const strokeVao = gl.createVertexArray();
    if (strokeBuffer === null || strokeVao === null) {
      throw new GlError('createBuffer/createVertexArray returned null (context lost?)');
    }
    this.#strokeBuffer = strokeBuffer;
    this.#strokeVao = strokeVao;
    gl.bindVertexArray(strokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, strokeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.#strokeVertices.byteLength, gl.DYNAMIC_DRAW);
    const strokePx = gl.getAttribLocation(this.#strokeCoverage, 'a_px');
    const strokeSeg = gl.getAttribLocation(this.#strokeCoverage, 'a_seg');
    if (strokePx < 0 || strokeSeg < 0) {
      throw new GlError('the stroke program is missing a_px/a_seg');
    }
    const stride = STROKE_FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(strokePx);
    gl.vertexAttribPointer(strokePx, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(strokeSeg);
    gl.vertexAttribPointer(strokeSeg, 4, gl.FLOAT, false, stride, 8);
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
            this.#drawText(context, map, geometry, style);
            break;
          case 'stroke':
            this.#drawStroke(context, map, geometry, style, prepared);
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
    const points = kind === 'stroke' ? readStrokePoints(annotation.style) : null;
    const prepared: Prepared = {
      kind,
      style,
      error,
      geometry: newAnnotationGeometry(),
      points,
      lengths: points === null ? null : cumulativeLengths(points),
    };
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

  // ---- the stroke pass (phase 12) -------------------------------------------

  /**
   * One hand-drawn stroke: capsules into a scratch, then the scratch down as ink.
   *
   * ## Why the scratch, in one sentence you can check
   *
   * Consecutive capsules **must** overlap — that is what makes a joint round rather
   * than a notch — so compositing them one by one into the frame draws the ink over
   * itself at every joint. At `alpha = 1` nothing shows; at a highlighter's 0.35, or
   * anywhere inside a `blendMs` crossfade, the line grows a string of dark beads.
   * `blendEquation(MAX)` into a scratch makes overlap idempotent and the stroke is
   * then composited exactly once, at exactly its own alpha.
   *
   * ## Why it fails by not drawing
   *
   * A stroke is a decoration, so every branch here that cannot proceed **returns**.
   * That is the opposite of `blur` and `mask` two functions up, and deliberately so:
   * §7's rule for the overlay is that it is an accessory — ink that fails to render
   * is visible and costs a line, where a redaction that fails to render is invisible
   * and costs a secret.
   */
  #drawStroke(
    context: AnnotationContext,
    map: ReturnType<typeof sourceToOutput>,
    geometry: AnnotationGeometry,
    style: AnnotationStyle,
    prepared: Prepared,
  ): void {
    const points = prepared.points;
    const lengths = prepared.lengths;
    if (points === null || lengths === null) return;
    const ink = style.stroke;
    if (ink[3] <= 0) return;

    // `progress` is 1 for a finished stroke, and a stroke still under the pen is
    // truncated by arc length rather than by point count — a slow, dense stretch
    // and a fast, sparse one then reveal at the same speed. A dot has no length at
    // all and is drawn whole the moment `progress` leaves zero.
    if (!(geometry.progress > 0)) return;
    const drawn = (lengths[lengths.length - 1] ?? 0) * geometry.progress;

    const halfPx = Math.max(0.5, (style.strokeWidth * map.scaleX) / 2);
    const cx = map.originX + map.scaleX * geometry.cx;
    const cy = map.originY + map.scaleY * geometry.cy;
    const hx = map.scaleX * geometry.hx;
    const hy = map.scaleY * geometry.hy;
    const margin = halfPx + 1;
    const pxRect: Rect = {
      x: cx - hx - margin,
      y: cy - hy - margin,
      width: 2 * (hx + margin),
      height: 2 * (hy + margin),
    };

    const [width, height] = context.outputSize;
    let scratch: { a: RenderTarget; b: RenderTarget };
    try {
      scratch = this.#ensureScratch(width, height);
    } catch (thrown) {
      if (!(thrown instanceof GlError)) throw thrown;
      // No scratch, no ink. Counted rather than thrown for the reason above.
      this.strokesWithoutScratch += 1;
      return;
    }

    const gl = this.gl;
    // Scissored to the stroke's own rectangle, so clearing the scratch costs the
    // stroke's area and not the frame's — a page of annotations is otherwise a
    // full-target clear per span.
    const sx = Math.max(0, Math.floor(pxRect.x));
    const sw = Math.min(width - sx, Math.ceil(pxRect.width) + 1);
    // GL's scissor box has a bottom-left origin and `pxRect` a top-left one, so the
    // y is flipped exactly once, here.
    const sy = Math.max(0, Math.floor(height - (pxRect.y + pxRect.height)));
    const sh = Math.min(height - sy, Math.ceil(pxRect.height) + 1);
    if (sw <= 0 || sh <= 0) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.a.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sx, sy, sw, sh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.#strokeCoverage);
    this.#v2[0] = width;
    this.#v2[1] = height;
    gl.uniform2fv(this.#uStrokeCoverage.outputSize, this.#v2);
    gl.uniform1f(this.#uStrokeCoverage.half, halfPx);
    gl.bindVertexArray(this.#strokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#strokeBuffer);
    this.#drawStrokeSegments(points, lengths, drawn, cx, cy, hx, hy, halfPx);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.disable(gl.SCISSOR_TEST);

    // Back to what `render()` set up, before anything else draws.
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);

    gl.useProgram(this.#strokeComposite);
    this.#setRect(this.#uStrokeComposite.quad, this.#uStrokeComposite.pxRect, pxRect, [
      width,
      height,
    ]);
    this.#v2[0] = width;
    this.#v2[1] = height;
    gl.uniform2fv(this.#uStrokeComposite.outputSize, this.#v2);
    this.#setColor(this.#uStrokeComposite.ink, this.#v4c, ink);
    gl.uniform1f(this.#uStrokeComposite.opacity, geometry.opacity);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scratch.a.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, context.target.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.#strokeCompositeVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Fill the vertex buffer with the polyline's capsule quads and draw them.
   *
   * Batched at {@link MAX_STROKE_SEGMENTS_PER_BATCH} rather than truncated there: a
   * stroke that stops halfway along is a wrong picture that looks like a deliberate
   * one, and this file's rule is that a failure is loud or absent, never partial.
   *
   * Each quad is the segment's oriented bounding box grown by `half + 1` in both
   * directions — along the segment as well as across it, because the caps are round
   * and a box that stopped at the endpoints would clip them.
   */
  #drawStrokeSegments(
    points: Float32Array,
    lengths: Float32Array,
    drawn: number,
    cx: number,
    cy: number,
    hx: number,
    hy: number,
    halfPx: number,
  ): void {
    const vertices = this.#strokeVertices;
    const stride = STROKE_FLOATS_PER_VERTEX;
    const segments = lengths.length - 1;
    const grow = halfPx + 1;
    let cursor = 0;
    let batched = 0;

    // A tap of the pen is one point and no segments. It is still ink — a round dot
    // of the stroke's own width — so it is emitted as a zero-length capsule, which
    // is the case `sdSegment`'s `max(dot(ba, ba), 1e-6)` already answers correctly.
    //
    // This branch is also the whole of a dot's reveal, and it deliberately never
    // consults `drawn`: a single point has no arc length, so `drawn` is 0 for it at
    // every `progress` and a truncation measured against it would draw nothing at
    // all, forever. `#drawStroke`'s `progress > 0` is the only gate a dot gets, which
    // is the right one — a dot is either not yet drawn or complete.
    if (segments < 1) {
      this.#appendStrokeQuad(
        vertices,
        0,
        cx + (points[0] ?? 0) * hx,
        cy + (points[1] ?? 0) * hy,
        cx + (points[0] ?? 0) * hx,
        cy + (points[1] ?? 0) * hy,
        grow,
      );
      this.#flushStrokeBatch(vertices, STROKE_VERTS_PER_SEGMENT * stride);
      return;
    }

    for (let i = 0; i < segments; i++) {
      const from = lengths[i] ?? 0;
      if (from >= drawn) break;
      const to = lengths[i + 1] ?? 0;
      // The one partly-drawn segment: shortened to exactly where the pen had got
      // to, so the tip advances smoothly instead of jumping a segment at a time.
      const fraction = to > from ? Math.min(1, (drawn - from) / (to - from)) : 1;

      const ax = cx + (points[i * 2] ?? 0) * hx;
      const ay = cy + (points[i * 2 + 1] ?? 0) * hy;
      const fullBx = cx + (points[i * 2 + 2] ?? 0) * hx;
      const fullBy = cy + (points[i * 2 + 3] ?? 0) * hy;
      const bx = ax + (fullBx - ax) * fraction;
      const by = ay + (fullBy - ay) * fraction;

      this.#appendStrokeQuad(vertices, cursor, ax, ay, bx, by, grow);
      cursor += STROKE_VERTS_PER_SEGMENT * stride;
      batched += 1;
      if (batched === MAX_STROKE_SEGMENTS_PER_BATCH) {
        this.#flushStrokeBatch(vertices, cursor);
        cursor = 0;
        batched = 0;
      }
    }
    if (cursor > 0) this.#flushStrokeBatch(vertices, cursor);
  }

  /**
   * Six vertices for one capsule, each carrying the segment it belongs to.
   *
   * The quad is the segment's oriented bounding box grown by `grow` in both
   * directions — **along** it as well as across it, because the caps are round and a
   * box that stopped at the endpoints would clip them into flat ends.
   */
  #appendStrokeQuad(
    vertices: Float32Array,
    at: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    grow: number,
  ): void {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    // A zero-length segment is a dot, and a direction cannot be taken from it — the
    // axes are then the identity and the quad is the cap's own box.
    const ux = len > 1e-6 ? dx / len : 1;
    const uy = len > 1e-6 ? dy / len : 0;
    const nx = -uy;
    const ny = ux;

    const corners = [
      ax - ux * grow - nx * grow,
      ay - uy * grow - ny * grow,
      bx + ux * grow - nx * grow,
      by + uy * grow - ny * grow,
      bx + ux * grow + nx * grow,
      by + uy * grow + ny * grow,
      ax - ux * grow - nx * grow,
      ay - uy * grow - ny * grow,
      bx + ux * grow + nx * grow,
      by + uy * grow + ny * grow,
      ax - ux * grow + nx * grow,
      ay - uy * grow + ny * grow,
    ];
    let cursor = at;
    for (let v = 0; v < STROKE_VERTS_PER_SEGMENT; v++) {
      vertices[cursor] = corners[v * 2] ?? 0;
      vertices[cursor + 1] = corners[v * 2 + 1] ?? 0;
      vertices[cursor + 2] = ax;
      vertices[cursor + 3] = ay;
      vertices[cursor + 4] = bx;
      vertices[cursor + 5] = by;
      cursor += STROKE_FLOATS_PER_VERTEX;
    }
  }

  #flushStrokeBatch(vertices: Float32Array, floats: number): void {
    const gl = this.gl;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, floats);
    gl.drawArrays(gl.TRIANGLES, 0, floats / STROKE_FLOATS_PER_VERTEX);
  }

  // ---- the text pass ---------------------------------------------------------

  #drawText(
    context: AnnotationContext,
    map: ReturnType<typeof sourceToOutput>,
    geometry: AnnotationGeometry,
    style: AnnotationStyle,
  ): void {
    if (style.text === '') return;
    const atlas = context.textAtlas ?? null;
    if (atlas === null) {
      // Skipped, counted, and the rest of the frame — including every redaction on
      // it — still composites. See the module comment for why this one is not a
      // refusal and `textSpansWithoutAtlas` for who says so out loud.
      this.textSpansWithoutAtlas += 1;
      return;
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
    gl.deleteBuffer(this.#strokeBuffer);
    gl.deleteVertexArray(this.#shapeVao);
    gl.deleteVertexArray(this.#blurVao);
    gl.deleteVertexArray(this.#regionVao);
    gl.deleteVertexArray(this.#textVao);
    gl.deleteVertexArray(this.#strokeVao);
    gl.deleteVertexArray(this.#strokeCompositeVao);
    gl.deleteProgram(this.#shape);
    gl.deleteProgram(this.#blur);
    gl.deleteProgram(this.#region);
    gl.deleteProgram(this.#text);
    gl.deleteProgram(this.#strokeCoverage);
    gl.deleteProgram(this.#strokeComposite);
  }
}

/**
 * Cumulative arc length along a polyline, in the span's own box units.
 *
 * `out[i]` is the distance from the first point to point `i`, so `out[n-1]` is the
 * whole length and a `progress` of `p` is drawn up to `p * out[n-1]`. Computed once
 * per span, in `#prepare`, because the shape never changes.
 *
 * Box units rather than output pixels, and the difference is only visible when the
 * user has scaled the ink anisotropically: at the aspect the pen actually drew at
 * the two are proportional, and measuring in pixels would put an O(points) walk on
 * every frame of the reveal to buy a case nobody has yet.
 */
function cumulativeLengths(points: Float32Array): Float32Array {
  const count = points.length >> 1;
  const out = new Float32Array(count);
  let total = 0;
  for (let i = 1; i < count; i++) {
    const dx = (points[i * 2] ?? 0) - (points[i * 2 - 2] ?? 0);
    const dy = (points[i * 2 + 1] ?? 0) - (points[i * 2 - 1] ?? 0);
    total += Math.hypot(dx, dy);
    out[i] = total;
  }
  return out;
}
