/**
 * A `WebGL2RenderingContext` stub, just real enough to build a `Compositor`.
 *
 * It renders nothing and is not a substitute for the fixture gate, which runs the
 * real compositor on a real ANGLE-Metal context. Its whole purpose is the handful of
 * behaviours a headless test *can* pin down and the gate cannot: what happens when
 * the driver takes the context away, and what the render target is left holding when
 * a composite refuses part-way through.
 *
 * Everything is a `Proxy` returning benign defaults, because the Compositor's
 * constructor touches thirty-odd entry points and stubbing them by hand would rot
 * the moment a pass is added. Only the calls whose return value the constructor
 * actually branches on are given real answers.
 *
 * The two opt-ins below stay opt-in on purpose: a stub that grew a model of the
 * framebuffer for everyone would make the context-loss tests assert against the
 * model rather than against the silence a lost context really produces.
 */

/** The handful of GL constants the Compositor reads off the context. */
const CONSTANTS: Record<string, number> = {
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  COLOR_ATTACHMENT0: 0x8ce0,
  COLOR_BUFFER_BIT: 0x4000,
  TEXTURE_2D: 0x0de1,
  TEXTURE0: 0x84c0,
  RGBA: 0x1908,
  RGBA8: 0x8058,
  UNSIGNED_BYTE: 0x1401,
  FLOAT: 0x1406,
  LINEAR: 0x2601,
  NEAREST: 0x2600,
  CLAMP_TO_EDGE: 0x812f,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  TRIANGLE_STRIP: 0x0005,
  DEPTH_TEST: 0x0b71,
  BLEND: 0x0be2,
  SCISSOR_TEST: 0x0c11,
  CULL_FACE: 0x0b44,
  NONE: 0,
  RENDERER: 0x1f01,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
};

/** What `drawArrays` leaves in a tracked framebuffer. Any non-background value. */
export const DRAWN = 0x7f;

const TIMER_EXTENSION = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };

export interface FakeGlOptions {
  width?: number;
  height?: number;
  /**
   * Model what the framebuffer holds: `clear` fills it from the current
   * `clearColor`, `drawArrays` fills it with {@link DRAWN}, and `readPixels` hands
   * that back. Enough to ask *"what would a `present()` publish right now"*, which
   * is the question a refused redaction has to have a safe answer to.
   */
  trackPixels?: boolean;
  /**
   * Offer `EXT_disjoint_timer_query_webgl2`, so `GpuTimer` really opens and closes
   * queries and a test can check they stay balanced across a throw.
   */
  timerQuery?: boolean;
}

export interface FakeGl {
  gl: WebGL2RenderingContext;
  /** Take the context away, as a driver reset does. */
  loseContext(): void;
  /** Bytes `readPixels` writes into the caller's buffer while the context is live. */
  fill: number;
  /** How many times `readPixels` was actually called through to. */
  readPixelCalls: number;
  readonly clears: number;
  readonly draws: number;
  readonly queryBegins: number;
  readonly queryEnds: number;
}

export function fakeGl(options: FakeGlOptions = {}): FakeGl {
  const width = options.width ?? 64;
  const height = options.height ?? 32;
  const state = {
    lost: false,
    fill: 0x40,
    readPixelCalls: 0,
    clears: 0,
    draws: 0,
    queryBegins: 0,
    queryEnds: 0,
    clearColor: [0, 0, 0, 1],
    pixels: options.trackPixels === true ? new Uint8Array(width * height * 4) : null,
  };

  const target = {
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    isContextLost: () => state.lost,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    checkFramebufferStatus: () => CONSTANTS['FRAMEBUFFER_COMPLETE'],
    getExtension: (name: string) =>
      options.timerQuery === true && name === 'EXT_disjoint_timer_query_webgl2'
        ? TIMER_EXTENSION
        : null,
    getParameter: () => 'fake-gl',
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    createQuery: () => ({}),
    beginQuery: () => {
      state.queryBegins += 1;
    },
    endQuery: () => {
      state.queryEnds += 1;
    },
    clearColor: (r: number, g: number, b: number, a: number) => {
      state.clearColor = [r, g, b, a];
    },
    clear: () => {
      state.clears += 1;
      const pixels = state.pixels;
      if (pixels === null) return;
      const bytes = state.clearColor.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
      for (let at = 0; at < pixels.length; at += 4) {
        pixels[at] = bytes[0] ?? 0;
        pixels[at + 1] = bytes[1] ?? 0;
        pixels[at + 2] = bytes[2] ?? 0;
        pixels[at + 3] = bytes[3] ?? 255;
      }
    },
    drawArrays: () => {
      state.draws += 1;
      state.pixels?.fill(DRAWN);
    },
    /**
     * The behaviour under test lives on the other side of this: a real lost context
     * makes `readPixels` a silent no-op, so the caller's buffer keeps whatever it
     * already held. This reproduces that exactly — it writes nothing when lost.
     */
    readPixels: (
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _format: number,
      _type: number,
      out: Uint8Array,
    ) => {
      state.readPixelCalls += 1;
      if (state.lost) return;
      const pixels = state.pixels;
      if (pixels === null) out.fill(state.fill);
      else out.set(pixels.subarray(0, Math.min(pixels.length, out.length)));
    },
  };

  const gl = new Proxy(target, {
    get(base, property) {
      if (property in base) return base[property as keyof typeof base];
      if (typeof property === 'string' && property in CONSTANTS) return CONSTANTS[property];
      // Every other GL entry point is a no-op that returns nothing.
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;

  return {
    gl,
    loseContext: () => {
      state.lost = true;
    },
    get fill() {
      return state.fill;
    },
    set fill(value: number) {
      state.fill = value;
    },
    get readPixelCalls() {
      return state.readPixelCalls;
    },
    get clears() {
      return state.clears;
    },
    get draws() {
      return state.draws;
    },
    get queryBegins() {
      return state.queryBegins;
    },
    get queryEnds() {
      return state.queryEnds;
    },
  };
}
