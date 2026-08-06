/**
 * The annotation passes, in GLSL ES 3.00.
 *
 * Four programs, in the order `render()` runs them:
 *
 *  1. {@link BLUR_FRAGMENT_SHADER} — one axis of a separable Gaussian, over the
 *     whole render target. Run twice per blur span (h then v), and more than twice
 *     when one pass cannot reach the requested σ.
 *  2. {@link REGION_FRAGMENT_SHADER} — put the blurred copy back **only inside the
 *     redacted region**, with a soft edge. This is what makes a blur a blur rather
 *     than a smeared frame.
 *  3. {@link SHAPE_FRAGMENT_SHADER} — arrow, rect, ellipse, highlight and the solid
 *     `mask`, as signed distance fields evaluated in **output pixels**.
 *  4. {@link TEXT_FRAGMENT_SHADER} — glyph quads out of a caller-supplied atlas.
 *
 * ## Why the SDFs are in output pixels and the antialiasing is a fixed 1 px
 *
 * The shape shaders interpolate an output-pixel coordinate rather than a normalized
 * one, so a distance is a distance in pixels and the coverage ramp is
 * `1 - smoothstep(-0.5, 0.5, d)` — exactly one pixel wide, everywhere, with no
 * `fwidth`. Screen-space derivatives would work too and would be identical between
 * preview and export at the same output size, but they are quantised to the
 * hardware's 2×2 quads, and a fixed ramp is one fewer thing that could be quantised
 * differently on two GPUs. §5.6 promises identical pixels *on the same GPU*; there
 * is no reason to spend that promise on antialiasing.
 *
 * `precision highp float` for the same reason `shaders.ts` gives: a mediump
 * fragment stage cannot address a 3456-pixel-wide source, and here it also could
 * not represent a pixel coordinate near 4096 to better than a quarter of a pixel.
 *
 * ## Alpha is straight, not premultiplied
 *
 * These passes run with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` over a target the screen
 * pass wrote as opaque. Every shader below therefore composites its own fill and
 * stroke into straight (non-premultiplied) alpha and hands GL a straight-alpha
 * fragment; `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is already off for the same reason.
 */

/**
 * Taps per side in one Gaussian pass.
 *
 * A pass with `σ` needs about `3σ` taps to be a Gaussian rather than a box, so 24
 * taps is `σ ≤ 8` output pixels in a single pass. Beyond that the pass is repeated:
 * `n` passes of `σ/√n` compose to `σ`, exactly, because convolving two Gaussians
 * adds their variances. That is what keeps a large redaction a *real* blur instead
 * of a clamped one — and a clamped blur on a privacy feature is the failure this
 * whole file is careful about.
 */
export const MAX_BLUR_TAPS = 24;

/** The largest σ, in output pixels, one pass can carry at {@link MAX_BLUR_TAPS}. */
export const MAX_PASS_SIGMA_PX = MAX_BLUR_TAPS / 3;

/**
 * The most passes a single blur span may cost.
 *
 * `8` puts the reachable σ at `8 × √8 ≈ 22.6` output pixels, which is a redaction
 * about 136 px across — far past anything readable. A span that asks for more is
 * *not* clamped: `annotations.ts` fills it solid instead, because a blur weaker than
 * the one the user asked for is the exact failure this feature cannot have.
 */
export const MAX_BLUR_PASSES = 8;

/** A quad placed by an NDC rect, carrying the output-pixel coordinate with it. */
export const SHAPE_VERTEX_SHADER = `#version 300 es
in vec2 a_unit;

/** Destination rect in NDC: xy = origin, zw = size. */
uniform vec4 u_quad;
/** The same rect in output pixels, origin top-left: xy = origin, zw = size. */
uniform vec4 u_pxRect;

out vec2 v_px;

void main() {
  gl_Position = vec4(u_quad.xy + a_unit * u_quad.zw, 0.0, 1.0);
  // NDC y grows up and output pixels grow down, so the unit quad's y is flipped
  // here and nowhere else — the same single flip the screen pass does.
  v_px = vec2(u_pxRect.x + a_unit.x * u_pxRect.z,
              u_pxRect.y + (1.0 - a_unit.y) * u_pxRect.w);
}
`;

/** The whole render target, with its texture coordinate. Used by both blur passes. */
export const FULL_QUAD_VERTEX_SHADER = `#version 300 es
in vec2 a_unit;
out vec2 v_uv;

void main() {
  gl_Position = vec4(a_unit * 2.0 - 1.0, 0.0, 1.0);
  v_uv = a_unit;
}
`;

export const KIND_RECT = 0;
export const KIND_ELLIPSE = 1;
export const KIND_ARROW = 2;

const SDF_LIBRARY = `
/** §3.3's rounded-rect SDF, the one the bubble is drawn with. */
float sdRoundRect(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

/**
 * Gradient-normalised ellipse distance.
 *
 * Not the exact ellipse SDF — that needs a quartic root — but the standard
 * first-order normalisation, whose error is well under the one-pixel coverage ramp
 * for any ellipse an annotation is.
 */
float sdEllipse(vec2 p, vec2 halfSize) {
  vec2 h = max(halfSize, vec2(1e-4));
  float k1 = length(p / h);
  float k2 = length(p / (h * h));
  return k2 > 1e-6 ? k1 * (k1 - 1.0) / k2 : -min(h.x, h.y);
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / max(dot(e0, e0), 1e-6), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / max(dot(e1, e1), 1e-6), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / max(dot(e2, e2), 1e-6), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

/**
 * One pixel of coverage, centred on the edge. Negative distance is inside.
 *
 * The edges ascend and the ramp is inverted rather than the other way round:
 * GLSL ES 3.00 §8.3 leaves \`smoothstep\` **undefined** when \`edge0 > edge1\`, and one
 * of the two callers of this shape is the alpha a redaction composites back with.
 */
float coverage(float d) {
  return 1.0 - smoothstep(-0.5, 0.5, d);
}

/** Straight-alpha "over". */
vec4 over(vec4 top, vec4 base) {
  float a = top.a + base.a * (1.0 - top.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((top.rgb * top.a + base.rgb * base.a * (1.0 - top.a)) / a, a);
}
`;

/**
 * Arrow, rect, ellipse, highlight, mask.
 *
 * One program rather than five: the branch is on a uniform, so every fragment of a
 * given draw takes the same path and the cost is a handful of dead instructions,
 * against five programs' worth of state changes and five places for the fill/stroke
 * composition to drift apart. `over()` being shared is the part that matters —
 * §4.5 puts *"annotation geometry, colour, opacity"* on the must-be-identical list,
 * and colour composition is where a second implementation would differ first.
 */
export const SHAPE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

/** 0 = rect, 1 = ellipse, 2 = arrow. */
uniform int u_kind;
/** Box centre and half-extent, output pixels. */
uniform vec4 u_box;
/** Arrow tail and tip, output pixels. */
uniform vec4 u_line;
/** x = stroke width, y = corner radius, z = head length, w = head width. Pixels. */
uniform vec4 u_params;
uniform vec4 u_fill;
uniform vec4 u_stroke;
uniform float u_opacity;

in vec2 v_px;
out vec4 fragColor;

${SDF_LIBRARY}

/** The solid arrow: a shaft that stops at the head, plus the head. */
float sdArrow(vec2 p) {
  vec2 tail = u_line.xy;
  vec2 tip = u_line.zw;
  vec2 along = tip - tail;
  float len = length(along);
  if (len < 1e-4) return 1e6;
  vec2 dir = along / len;
  vec2 side = vec2(-dir.y, dir.x);

  float head = min(u_params.z, len);
  float halfHead = u_params.w * 0.5;
  vec2 neck = tip - dir * head;

  float shaft = sdSegment(p, tail, neck) - u_params.x * 0.5;
  // A head with no width, or none along the shaft, is three collinear points, and
  // \`sdTriangle\`'s winding sign is then \`sign(0.0)\` — zero, which makes its distance
  // \`-0.0\` at *every* fragment and fills the arrow's whole quad at half alpha.
  // \`headWidth\`/\`headLength\` are clamped at 0 rather than refused (a decoration
  // fails leniently), so a document may legitimately carry either as zero: a
  // degenerate head is no head, and the shaft is the whole arrow.
  if (halfHead <= 0.0 || head <= 0.0) return shaft;
  float barb = sdTriangle(p, tip, neck + side * halfHead, neck - side * halfHead);
  return min(shaft, barb);
}

void main() {
  vec2 centre = u_box.xy;
  vec2 halfSize = u_box.zw;

  float d;
  if (u_kind == ${String(KIND_ARROW)}) {
    d = sdArrow(v_px);
  } else if (u_kind == ${String(KIND_ELLIPSE)}) {
    d = sdEllipse(v_px - centre, halfSize);
  } else {
    d = sdRoundRect(v_px - centre, halfSize, min(u_params.y, min(halfSize.x, halfSize.y)));
  }

  // An arrow is a solid shape and §2.6 gives it \`"fill": "none"\` beside a stroke
  // colour, so its body takes the stroke. Every other kind is a fill with an
  // optional outline centred on the edge.
  bool solid = u_kind == ${String(KIND_ARROW)};
  vec4 fillColor = solid ? u_stroke : u_fill;
  float fillA = coverage(d);
  vec4 base = vec4(fillColor.rgb, fillColor.a * fillA);

  vec4 result = base;
  if (!solid && u_params.x > 0.0 && u_stroke.a > 0.0) {
    float strokeA = coverage(abs(d) - u_params.x * 0.5);
    result = over(vec4(u_stroke.rgb, u_stroke.a * strokeA), base);
  }

  fragColor = vec4(result.rgb, result.a * u_opacity);
  if (fragColor.a <= 0.0) discard;
}
`;

/**
 * One axis of a separable Gaussian.
 *
 * The weights are computed rather than looked up so the two axes and every pass
 * share one definition, and the sum is normalised in the shader so a truncated tail
 * cannot darken or lighten the result. `u_taps` is a uniform bound on a loop with a
 * constant maximum, which GLSL ES 3.00 allows and every ANGLE backend unrolls.
 */
export const BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_src;
/** One tap's step, in texture coordinates: (1/width, 0) or (0, 1/height). */
uniform vec2 u_step;
uniform float u_sigma;
uniform int u_taps;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  float inv = 1.0 / max(u_sigma, 1e-4);
  vec3 sum = texture(u_src, v_uv).rgb;
  float weightSum = 1.0;
  for (int i = 1; i <= ${String(MAX_BLUR_TAPS)}; i++) {
    if (i > u_taps) break;
    float x = float(i) * inv;
    float w = exp(-0.5 * x * x);
    vec2 offset = u_step * float(i);
    sum += (texture(u_src, v_uv + offset).rgb + texture(u_src, v_uv - offset).rgb) * w;
    weightSum += 2.0 * w;
  }
  fragColor = vec4(sum / weightSum, 1.0);
}
`;

/**
 * Put a full-target texture back **inside a region**, with a soft edge.
 *
 * The alpha is the region's coverage, so everything outside it is untouched: the
 * blur passes smear the whole frame and this is the only thing that decides where
 * that smear is allowed to land. `u_feather` widens the coverage ramp past the
 * one-pixel default; §2.6's blur span carries `"feather": 0.01`.
 */
export const REGION_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_src;
/** Box centre and half-extent, output pixels. */
uniform vec4 u_box;
/** x = corner radius, y = feather, both output pixels. */
uniform vec2 u_params;
uniform vec2 u_outputSize;
uniform float u_opacity;

in vec2 v_px;
out vec4 fragColor;

${SDF_LIBRARY}

void main() {
  vec2 halfSize = u_box.zw;
  float d = sdRoundRect(v_px - u_box.xy, halfSize, min(u_params.x, min(halfSize.x, halfSize.y)));
  float feather = max(u_params.y, 1.0);
  // Ascending edges, for the reason \`coverage\` gives — and it matters most here:
  // this is the redaction's *own* alpha, so an implementation that took §8.3's
  // undefined branch to zero would leave the blurred copy uncomposited and publish
  // what was under it.
  float a = 1.0 - smoothstep(-feather * 0.5, feather * 0.5, d);
  if (a <= 0.0) discard;
  // The render target's own texture: v = 0 is its bottom row, and v_px is
  // top-left origin, so the y is flipped exactly once here.
  vec2 uv = vec2(v_px.x / u_outputSize.x, 1.0 - v_px.y / u_outputSize.y);
  fragColor = vec4(texture(u_src, uv).rgb, a * u_opacity);
}
`;

/** Glyph quads: pixel position and atlas uv, both per vertex. */
export const TEXT_VERTEX_SHADER = `#version 300 es
in vec2 a_px;
in vec2 a_uv;

uniform vec2 u_outputSize;

out vec2 v_uv;

void main() {
  vec2 ndc = vec2(a_px.x / u_outputSize.x * 2.0 - 1.0,
                  1.0 - a_px.y / u_outputSize.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_uv;
}
`;

/**
 * A glyph, tinted.
 *
 * The atlas is a coverage mask in the alpha channel — white glyphs on transparent —
 * so the colour comes entirely from the uniform and one atlas serves every colour
 * an annotation is ever set to.
 */
export const TEXT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_atlas;
uniform vec4 u_fill;
uniform float u_opacity;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  float a = texture(u_atlas, v_uv).a;
  if (a <= 0.0) discard;
  fragColor = vec4(u_fill.rgb, u_fill.a * a * u_opacity);
}
`;
