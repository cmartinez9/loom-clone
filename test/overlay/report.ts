/**
 * What the phase-12 gate measures, as a document.
 *
 * Architecture report §8, phase 12: *"Strokes appear live, are **absent** from the
 * raw capture, and are deletable in the editor."* The third is arithmetic over a
 * document and is answered in `packages/edl/test/drawing.test.ts`. The first two are
 * claims about pixels — one about the overlay's own canvas, one about what a screen
 * capture of that overlay actually contains — and neither can be made anywhere but
 * in a real Electron renderer in front of a real window server. That is what
 * `test/overlay/main.ts` produces and this file describes.
 *
 * Shared by the harness that produces it, the Electron main that writes it out and
 * the vitest file that asserts on it — the arrangement phases 6 and 11 use, for the
 * same reason: the assertions belong somewhere a reader can see them all at once,
 * and the pixels belong somewhere there is a screen.
 */

/** A rectangle in the reading's own space. `null` when nothing was inked. */
export interface InkBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One reading of the overlay's own canvas. */
export interface InkProbe {
  label: string;
  /** Whether the page believed the pen was down when the gestures were sent. */
  armed: boolean;
  /** Strokes the page is holding, from its own count. */
  strokeCount: number;
  /** Canvas pixels with any alpha at all. */
  inkedPixels: number;
  /** Canvas pixels total, so `inkedPixels` can be read as a fraction. */
  canvasPixels: number;
  /** The inked region, in **CSS** pixels of the window, or `null` if nothing inked. */
  bounds: InkBounds | null;
}

/** How much of one rectangle came back as the marker colour, out of a real capture. */
export interface MarkerReading {
  fraction: number;
  mean: [number, number, number];
  sampled: number;
}

export interface ContentProtectionReading {
  /**
   * `true` when `desktopCapturer` produced no picture at all.
   *
   * Kept apart from a reading of 0% on purpose. "We could not look" and "we looked
   * and the window was there" are different reports, and collapsing them is how a
   * blocked check gets read as a passing one — `apps/main/src/verify/checks.ts`
   * states the same rule for phase 2's harness.
   */
  captureUnavailable: boolean;
  /** What `systemPreferences.getMediaAccessStatus('screen')` said, independently. */
  screenAccess: string;
  /** The control: the same page, same size, same paint, protection **not** set. */
  control: MarkerReading;
  /** The shipping `drawing-overlay` role, with `setContentProtection(true)`. */
  protectedOverlay: MarkerReading;
  /**
   * A rectangle of bare desktop, the same size, with nothing of ours on it.
   *
   * The baseline, and it is context rather than the gate. `isMarker` matches a
   * *shape* of colour rather than an exact triple — a capture comes back in the
   * display's own colour space, which is what phase 2's first run discovered by
   * reporting 0% inside its own control — so whatever is already on this machine's
   * desktop contributes a small reading in any rectangle of this size, including
   * through a window that is correctly absent from the capture. Two things it buys:
   * a reader can tell a residue of ambient desktop from a leak, and the control's
   * reading is assertable as a **signal** rather than as a high number.
   */
  desktop: MarkerReading;
  /**
   * The **same** protected rectangle, captured again with the overlay destroyed.
   *
   * This is what turns "the reading was under the threshold" into "none of it was
   * ours". `isMarker` matches a shape of colour rather than a triple, so whatever is
   * already on the user's screen behind the overlay contributes to any rectangle
   * drawn over it — and a rectangle of *desktop* is exactly what a correctly absent
   * window leaves in a capture. Two readings of one rectangle, one with the window
   * on screen and one without, separate the two explanations with no interpretation
   * in between: if the overlay leaked a single pixel, taking it away lowers the
   * count.
   */
  protectedWithOverlayGone: MarkerReading;
  /**
   * The occlusion test, and the strongest statement of "absent" available.
   *
   * A marker-painted, **unprotected** window is placed exactly under the overlay's
   * rectangle and the overlay is repainted a colour that is *not* the marker. If the
   * overlay is genuinely absent from the capture, the rectangle comes back as the
   * window behind it — ~100% marker. If a single pixel of the overlay reaches the
   * capture, it covers a marker pixel and this reading falls.
   *
   * Why it is worth a third capture: the primary check is an **absence**, and every
   * absence is only as strong as the thing that would have been there. "Under 1%
   * marker" also passes when the capture is dim, the desktop is plain, or the
   * rectangle is slightly wrong. "Over 99% marker, from a window we put there" does
   * not, and it does not depend on what happens to be on the user's screen — which
   * is what the first reading's small non-zero residue turned out to be.
   */
  backdropThroughOverlay: MarkerReading;
  /**
   * Marker pixels anywhere in the **whole** capture, and the box they occupy.
   *
   * The guard against the failure mode that nearly shipped this gate broken: every
   * other reading here is a rectangle this file computed, and a rectangle computed
   * wrong reports an absence that is really a miss. Scanning the entire frame
   * removes the coordinates from the claim — if the overlay were in the capture
   * anywhere, at any position, this count exceeds the control's own rectangle.
   */
  frameMarkerPixels: number;
  frameMarkerBox: { x0: number; y0: number; x1: number; y1: number } | null;
  desktopBounds: { x: number; y: number; width: number; height: number } | null;
  controlBounds: { x: number; y: number; width: number; height: number };
  protectedBounds: { x: number; y: number; width: number; height: number };
  captureSize: [number, number];
}

export interface OverlayReport {
  ok: boolean;
  error: string;
  environment: { electron: string; chrome: string; scaleFactor: number };
  /** The window rect the gestures were sent into, in DIP. */
  windowSize: [number, number];
  probes: InkProbe[];
  contentProtection: ContentProtectionReading;
  /**
   * `events/drawing.ndjson` exactly as main wrote it during the live pass.
   *
   * The report carries the bytes rather than a parse of them so the gate can run the
   * shipping importer over the shipping log — real pen, real IPC, real file, real
   * track — instead of over a fixture that agrees with itself.
   */
  drawingLog: string;
  /** What `recording.json`'s `events.drawing` would say, from `OverlayController`. */
  drawingSummary: { file: string; strokeCount: number } | null;
  logs: string[];
}
