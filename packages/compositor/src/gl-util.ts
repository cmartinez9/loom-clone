/**
 * The small amount of WebGL2 bookkeeping the compositor needs.
 *
 * Split out because it is the part with no opinions in it: compile, link, allocate,
 * and throw with the driver's own message when any of that fails. A silent
 * `createProgram` failure produces a black preview and no clue, which is the same
 * failure signature as a leaked frame — worth never confusing the two.
 */

export class GlError extends Error {
  override readonly name = 'GlError';
}

export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new GlError('createShader returned null (context lost?)');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new GlError(`${kind} shader failed to compile: ${log}`);
  }
  return shader;
}

export function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new GlError('createProgram returned null (context lost?)');
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // Shaders are reference-counted by the program; detaching now keeps the driver
  // from holding two copies of the source for the life of the app.
  gl.detachShader(program, vertex);
  gl.detachShader(program, fragment);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(no log)';
    gl.deleteProgram(program);
    throw new GlError(`program failed to link: ${log}`);
  }
  return program;
}

export function requireUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) {
    throw new GlError(`uniform ${name} is missing or was optimised away`);
  }
  return location;
}

/**
 * A texture the compositor samples from.
 *
 * `LINEAR` with `CLAMP_TO_EDGE` and no mipmaps: a zoomed preview magnifies, and the
 * one case that minifies (a 4K source in a small viewport) is a single bilinear tap
 * that the export reproduces exactly because it uses the same filter at the same
 * output size.
 */
export function createSampledTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (texture === null) throw new GlError('createTexture returned null (context lost?)');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

export interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

/**
 * An offscreen RGBA8 render target.
 *
 * §4.1 puts `render()` and `present()` on opposite sides of this: *"render(frames,
 * state): draws into the bound FBO; present(): blit to the canvas."* Preview blits;
 * export reads back. Both composite into the same target with the same code, which
 * is the mechanical half of "preview and export cannot disagree" (§4.5).
 */
export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): RenderTarget {
  const texture = createSampledTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null) {
    gl.deleteTexture(texture);
    throw new GlError('createFramebuffer returned null (context lost?)');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new GlError(
      `render target ${String(width)}x${String(height)} is incomplete (status 0x${status.toString(16)})`,
    );
  }
  return { framebuffer, texture, width, height };
}

export function deleteRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget): void {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

/** The renderer string, when the driver will say. Only ever used in diagnostics. */
export function describeRenderer(gl: WebGL2RenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (ext !== null) {
    const unmasked: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    if (typeof unmasked === 'string') return unmasked;
  }
  const renderer: unknown = gl.getParameter(gl.RENDERER);
  return typeof renderer === 'string' ? renderer : 'unknown';
}
