/**
 * What the phase-12 gate measures, as a document.
 *
 * Architecture report §8, phase 12: *"Strokes appear live, are **absent** from the
 * raw capture, and are deletable in the editor."* The third is arithmetic over a
 * document and is answered in `packages/edl/test/drawing.test.ts`. The first is a
 * claim about pixels — the overlay's own canvas, inked by a real hand — and cannot be
 * made anywhere but in a real Electron renderer in front of a real window server.
 * That is what `test/overlay/main.ts` produces and this file describes.
 *
 * The **second** is also a claim about pixels, and it is not here: measuring it means
 * capturing the screen, which needs the Screen Recording grant, so it lives in
 * `apps/main/src/verify/permissions-harness.ts` alongside phase 2's identical
 * measurement of the recorder HUD — where a check that cannot run reports `blocked`
 * and says why, and never a pass. `npm test` must not depend on a grant, and must not
 * grow a skip-on-missing-grant branch either.
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

export interface OverlayReport {
  ok: boolean;
  error: string;
  environment: { electron: string; chrome: string; scaleFactor: number };
  /** The window rect the gestures were sent into, in DIP. */
  windowSize: [number, number];
  probes: InkProbe[];
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
  /**
   * Whether the shipping overlay window was gone after `OverlayController.finish()`.
   *
   * The recording ending is the third way out of the overlay — the palette's Done
   * button and the HUD's Draw toggle are the other two — and it is the only one no
   * user action can substitute for. A full-screen always-on-top window still taking
   * the display's clicks after Stop is the intrusive-accessory failure the brief's
   * fourth constraint names, so the gate reads it from the **registry** rather than
   * from a call log: the question is whether the window is there.
   */
  overlayClosedByFinish: boolean;
  logs: string[];
}
