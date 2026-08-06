/**
 * What the phase-11 golden gate measures, as a document.
 *
 * Shared by the harness that produces it, the Electron main that writes it out and
 * the vitest file that asserts on it — the phase-6 gate's arrangement, for the same
 * reason: the assertions belong somewhere a reader can see them all at once, and the
 * pixels belong somewhere there is a GPU.
 *
 * Architecture report §8, phase 11: *"Golden-frame test extended to annotations"*,
 * against §4.5's own definition of what that test is — *"renders a fixture project
 * at 24 fixed timestamps through both the preview path and the export path at the
 * same output size and asserts a per-pixel max delta of 0"*.
 *
 * Everything here beyond `maxDelta` exists because **a preview and an export that
 * both draw no annotation at all agree perfectly**. Equality is necessary and it is
 * nowhere near sufficient, so the report also carries, per timestamp, what the
 * annotations actually did to the picture — and the file records the controls that
 * prove each of those checks can fail.
 */

/** One kind's own reading at one timestamp. */
export interface KindProbe {
  /** Pixels inside this kind's own box that the annotation pass changed. */
  changed: number;
  /** Pixels in that box, so `changed` can be read as a fraction. */
  area: number;
}

export interface TimestampReport {
  t: number;
  /** `state.zoom.amount` at `t`. Timestamps at 1 carry the geometric probes. */
  zoomAmount: number;
  /**
   * §4.5's assertion: the largest per-channel difference between the frame the
   * preview loop composited and the frame the export loop composited. Must be 0.
   */
  maxDelta: number;
  /** Pixels that differ between annotations-on and annotations-off. */
  changedPixels: number;
  /**
   * Changed pixels that fall outside every annotation's own box, computed by the
   * harness's own arithmetic rather than by the production mapping. Must be 0.
   */
  outsideExpected: number;
  probes: Record<string, KindProbe>;
  /** The centre of the `mask` region, as RGBA, read out of the composited frame. */
  maskCentre: [number, number, number, number];
  /**
   * Variance of the blurred region over variance of the same region unblurred.
   *
   * The fixture's screen content is a high-frequency pattern, so a real blur drops
   * this by more than an order of magnitude and an absent one leaves it at 1.
   */
  blurVarianceRatio: number;
  /** Changed pixels inside the parked track's box. Must be 0 once its window ends. */
  parkedChanged: number;
  /** Whether the parked track's window covers `t` at all. */
  parkedActive: boolean;
  /**
   * Mean per-pixel difference inside the fading track's box, annotations on versus
   * off.
   *
   * The span is opaque white over a random pattern, so this is exactly
   * `weight × mean|255 − background|`: linear in §3.5's window weight, which makes
   * the weight itself readable out of the composited frame.
   */
  fadingMeanDiff: number;
  /** What that weight should be, from the fixture's own four-line arithmetic. */
  fadingWeight: number;
  /**
   * What the revealing stroke's `progress` should be at `t`, from the fixture's own
   * arithmetic (phase 12).
   *
   * The reveal is checked as *growth* rather than as an absolute count: how many
   * pixels a fraction of a zig-zag covers depends on the stroke width, the join
   * geometry and the coverage ramp, and an expectation that predicted the number
   * would be a second implementation of the thing it is judging. What the gate can
   * say without one is that at `progress = 0` the ink is absent, and that between
   * two unzoomed timestamps a longer stroke never covers fewer pixels — which a
   * truncation by point index or by nothing at all both fail.
   */
  revealProgress: number;
}

/** A control: something that must be true only because the check can see it fail. */
export interface Control {
  name: string;
  /** True when the control behaved as a *broken* build would — i.e. the check works. */
  detected: boolean;
  detail: string;
}

export interface GoldenReport {
  ok: boolean;
  error: string | null;
  contextLost: boolean;
  environment: {
    glRenderer: string;
    electron: string;
    chrome: string;
  };
  outputSize: [number, number];
  sourceSize: [number, number];
  timestamps: TimestampReport[];
  controls: Control[];
  /** Regions the compositor redacted solid because it could not blur them. */
  privacyFallbacks: number;
  /** Text spans truncated at the glyph cap. */
  textTruncations: number;
  /**
   * Text spans skipped because no atlas was supplied — the one condition on the
   * annotation surface that degrades rather than refusing. Only the control that
   * exercises it deliberately should ever raise this.
   */
  textSpansWithoutAtlas: number;
  /** Glyphs the atlas rasterised, so an empty atlas cannot pass as a text pass. */
  atlasGlyphs: number;
  logs: string[];
}
