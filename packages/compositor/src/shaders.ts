/**
 * The screen pass, in GLSL ES 3.00.
 *
 * One quad, one texture, no branching. Architecture report §12.4 measured the whole
 * 4K composite at 0.130 ms and the 1440p preview at 0.010 ms; the screen pass is
 * the cheapest part of that, and this is deliberately the least clever shader that
 * can be correct.
 *
 * Two things in here are load-bearing rather than stylistic:
 *
 * **`precision highp float`.** The fragment stage interpolates a normalized source
 * coordinate. At `mediump` (10 bits of mantissa on some ANGLE backends) a 3456-pixel
 * wide source cannot address its own texels, and preview and export would round
 * differently at different output sizes — a §4.5 violation that would show up as a
 * half-pixel shimmer, not as a crash.
 *
 * **The v flip.** `texImage2D` from a `VideoFrame` uploads the video's first row
 * into the texture's first row, which GL then treats as v = 0 — the *bottom*. The
 * quad therefore samples `1 - a_unit.y` so that the top of the picture lands at the
 * top of the output. Doing it here rather than with `UNPACK_FLIP_Y_WEBGL` keeps the
 * upload a zero-copy IOSurface bind (§12.4); a flip on upload forces a CPU copy.
 */

export const SCREEN_VERTEX_SHADER = `#version 300 es
in vec2 a_unit;

/** Destination rect in NDC: xy = origin, zw = size. */
uniform vec4 u_content;
/** Source rect in normalized, top-left-origin source coordinates: xy = origin, zw = size. */
uniform vec4 u_source;

out vec2 v_uv;

void main() {
  gl_Position = vec4(u_content.xy + a_unit * u_content.zw, 0.0, 1.0);
  v_uv = vec2(u_source.x + a_unit.x * u_source.z,
              u_source.y + (1.0 - a_unit.y) * u_source.w);
}
`;

export const SCREEN_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_screen;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  // Opaque: the screen track has no alpha, and forcing 1.0 keeps the render target
  // identical whether the source uploaded as RGB or RGBA.
  fragColor = vec4(texture(u_screen, v_uv).rgb, 1.0);
}
`;

/** A unit quad as a triangle strip: (0,0) (1,0) (0,1) (1,1). */
export const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
