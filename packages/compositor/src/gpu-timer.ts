/**
 * A GPU timer query, when the driver offers one.
 *
 * Architecture report §12.4 measured the composite with
 * `EXT_disjoint_timer_query_webgl2` and `disjoint=false`, and §4.4 closes with the
 * reason it stays in the shipping code rather than in a spike: *"Compositing has
 * ~120× headroom at preview size. If a future effect ever changes that, the timer
 * query is already in the code."*
 *
 * One query in flight at a time. Results arrive a frame or two later, so
 * {@link GpuTimer.lastMs} is the most recent *completed* measurement, not this
 * frame's — which is what you want for a rolling budget readout and is useless for
 * a per-frame stall, so the preview loop budgets on CPU wall time and reads this to
 * explain a number, never to gate on it.
 *
 * A `disjoint` reading invalidates the result: the GPU was preempted mid-query and
 * the elapsed time includes somebody else's work. Those are dropped rather than
 * reported, because a spurious 40 ms is worse than no number at all.
 */

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  readonly available: boolean;

  readonly #gl: WebGL2RenderingContext;
  readonly #ext: TimerExtension | null;
  #query: WebGLQuery | null = null;
  /** A `beginQuery` is open and its `endQuery` is still owed. */
  #open = false;
  /** A query has been ended and its result not yet collected. */
  #inFlight = false;
  #lastMs: number | null = null;
  #disjointDrops = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
    this.#ext = ext;
    this.available = ext !== null;
  }

  /** Milliseconds of GPU time for the most recent completed measurement. */
  get lastMs(): number | null {
    return this.#lastMs;
  }

  /** Measurements thrown away because the GPU was preempted mid-query. */
  get disjointDrops(): number {
    return this.#disjointDrops;
  }

  /** Open a query, unless the previous one is still waiting for its result. */
  begin(): void {
    const ext = this.#ext;
    if (ext === null || this.#inFlight) return;
    const gl = this.#gl;
    this.#query ??= gl.createQuery();
    const query = this.#query;
    if (query === null) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.#open = true;
    this.#inFlight = true;
  }

  /**
   * Close the query {@link begin} opened, and nothing otherwise.
   *
   * The pairing is with `beginQuery`, not with the measurement: a result takes a
   * frame or two to arrive, so most frames skip `begin` and must skip `end` too.
   * `endQuery` with no query bound to the target is an `INVALID_OPERATION` — once
   * per frame, forever, on the ordinary path.
   */
  end(): void {
    const ext = this.#ext;
    if (ext === null || !this.#open) return;
    this.#open = false;
    this.#gl.endQuery(ext.TIME_ELAPSED_EXT);
  }

  /**
   * Collect a finished measurement if one is ready. Never blocks.
   *
   * Call once per frame after `end()`; the result belongs to an earlier frame.
   */
  poll(): void {
    const ext = this.#ext;
    const query = this.#query;
    if (ext === null || query === null || !this.#inFlight) return;
    const gl = this.#gl;
    if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) return;

    const disjoint: unknown = gl.getParameter(ext.GPU_DISJOINT_EXT);
    this.#inFlight = false;
    if (disjoint === true) {
      this.#disjointDrops += 1;
      return;
    }
    const nanoseconds: unknown = gl.getQueryParameter(query, gl.QUERY_RESULT);
    if (typeof nanoseconds === 'number') this.#lastMs = nanoseconds / 1_000_000;
  }

  dispose(): void {
    const ext = this.#ext;
    if (this.#open && ext !== null) {
      this.#open = false;
      this.#gl.endQuery(ext.TIME_ELAPSED_EXT);
    }
    if (this.#query !== null) {
      this.#gl.deleteQuery(this.#query);
      this.#query = null;
    }
    this.#inFlight = false;
  }
}
