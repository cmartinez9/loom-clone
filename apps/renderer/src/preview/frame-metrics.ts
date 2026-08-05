/**
 * Per-frame timing for the preview loop.
 *
 * Phase 6's gate is a number: *"Scrub and play a 4K fixture with no frame over
 * 16 ms at a 1440p viewport"* (architecture report §8). This is where that number
 * comes from, so it is worth being exact about what it measures.
 *
 * **It measures the work, not the cadence.** The interval between two
 * `requestAnimationFrame` callbacks on a 60 Hz display is ~16.7 ms whether the
 * frame did anything or not; budgeting against that would be a display-refresh
 * assertion wearing a performance assertion's clothes. What decides whether the
 * preview stutters is how long the frame *body* takes — resolve, `frameAt`,
 * `render`, `present` — because anything over the refresh interval drops a frame.
 * That is what is recorded here, and it is the same quantity §12.4 reported as
 * "worst frame 6.9 ms".
 *
 * Fixed-size and allocation-free, per §4.3's first anti-stutter rule.
 */

/** One 60 Hz refresh. Frames longer than this drop. */
export const FRAME_BUDGET_MS = 1000 / 60;

export class FrameMetrics {
  readonly budgetMs: number;
  readonly #samples: Float64Array;
  #next = 0;
  #count = 0;
  #max = 0;
  #sum = 0;
  #overBudget = 0;
  /** Index of the worst frame, so a failure can name when it happened. */
  #maxAt = -1;

  constructor(capacity = 4096, budgetMs: number = FRAME_BUDGET_MS) {
    this.#samples = new Float64Array(capacity);
    this.budgetMs = budgetMs;
  }

  /** Frames recorded, including ones that have scrolled out of the sample window. */
  get count(): number {
    return this.#count;
  }
  get maxMs(): number {
    return this.#max;
  }
  /** Frame number of the worst frame, or `-1` when nothing has been recorded. */
  get maxAt(): number {
    return this.#maxAt;
  }
  get meanMs(): number {
    return this.#count === 0 ? 0 : this.#sum / this.#count;
  }
  get overBudget(): number {
    return this.#overBudget;
  }

  record(ms: number): void {
    this.#samples[this.#next] = ms;
    this.#next = (this.#next + 1) % this.#samples.length;
    if (ms > this.#max) {
      this.#max = ms;
      this.#maxAt = this.#count;
    }
    this.#count += 1;
    this.#sum += ms;
    if (ms > this.budgetMs) this.#overBudget += 1;
  }

  /**
   * The `p`-th percentile of the retained window, `p` in `[0..1]`.
   *
   * Allocates — a sort needs a copy. For reporting after a run, not for the loop.
   */
  percentileMs(p: number): number {
    const retained = Math.min(this.#count, this.#samples.length);
    if (retained === 0) return 0;
    const sorted = Array.from(this.#samples.subarray(0, retained)).sort((a, b) => a - b);
    const rank = Math.min(retained - 1, Math.max(0, Math.round(p * (retained - 1))));
    return sorted[rank] ?? 0;
  }

  reset(): void {
    this.#samples.fill(0);
    this.#next = 0;
    this.#count = 0;
    this.#max = 0;
    this.#sum = 0;
    this.#overBudget = 0;
    this.#maxAt = -1;
  }
}
