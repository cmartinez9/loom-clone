/**
 * What the phase-15 harness measures, and the test half reads.
 *
 * One shape, in one file, so the Electron process that takes the readings and the
 * vitest process that judges them cannot drift — the same arrangement
 * `test/editor/report.ts` uses for phase 14.
 */

/** A composited picture, reduced to what can cross a process boundary. */
export interface Picture {
  /** FNV-1a over every RGB triple. A fingerprint of one instant of `testsrc2`. */
  hash: string;
  /** Distinct colours, capped. A flat field has one; a decoded frame has hundreds. */
  distinct: number;
  /** Fraction of pixels that are not the background. */
  coverage: number;
  /**
   * Mean of every channel over a box, `0..1` of the canvas — `[x0, y0, x1, y1]`.
   *
   * Present because "the picture changed" is not the same claim as "it changed
   * **here**", and an annotation's whole job is to change one region.
   */
  boxes: { label: string; mean: [number, number, number]; variance: number }[];
}

/**
 * What the standing *Zoom* panel is saying, read off the DOM.
 *
 * Off the DOM and not off the probe, deliberately: the probe reports what the model
 * computed and this reports what a person can **see**, and the defect this exists for
 * lived entirely in the gap between them — the picture was right, `resolve` was right,
 * and the panel beside them was describing a moment that had passed, with the one
 * button the captain asked for withheld because its presence was computed from the
 * same stale instant.
 */
export interface ZoomPanel {
  /** The *At playhead* value, verbatim. */
  atPlayhead: string;
  /** The *Centre* value, verbatim. */
  centre: string;
  /** The *Yours* value — whether a zoom of the user's own covers this instant. */
  yours: string;
  /** Every button the panel offers, by its visible text. */
  buttons: string[];
}

/** One reading taken inside the editor window. */
export interface Reading {
  label: string;
  timelineSec: number;
  sourceSec: number;
  durationSec: number;
  /** `resolve(...).zoom` at the playhead — §3.5's answer, measured. */
  zoom: { amount: number; center: [number, number] };
  tracks: {
    id: string;
    target: string;
    origin: string;
    generated: boolean;
    baked: boolean;
    activeRanges: [number, number][];
    keyCount: number;
    spanCount: number;
  }[];
  regions: { index: number; startSec: number; endSec: number; amount: number }[];
  annotations: { id: string; kind: string; startSec: number; endSec: number }[];
  picture: Picture;
  /** The standing Zoom panel at this instant, as rendered. */
  panel: ZoomPanel;
  trouble: string;
}

/** `edit.json` as a store that has never seen this bundle reads it back. */
export interface OnDisk {
  label: string;
  revision: number;
  /** Track ids in **array order**, which is stacking order (§3.5). */
  trackIds: string[];
  tracks: {
    id: string;
    origin: string;
    /** Carries a live `generator` block. */
    generated: boolean;
    /** Baked: `origin: 'manual'` and a `generatedFrom` with no `generator`. */
    baked: boolean;
    activeRanges: [number, number][];
    keyTimes: Record<string, number[]>;
    spanIds: string[];
  }[];
}

/** One finished export, and the frames decoded back out of it. */
export interface ExportReading {
  label: string;
  ok: boolean;
  error: string;
  path: string;
  bytes: number;
  durationSec: number;
  /** §7.5's five checks, as `verify.ts` answered them. */
  verified: boolean;
  sourcesDeleted: boolean;
  /** Decoded frames, keyed by the label the harness asked for. */
  frames: { label: string; timelineSec: number; hash: string; mean: [number, number, number] }[];
}

/**
 * The Amount slider, driven as a real two-phase gesture.
 *
 * A slider is the one control in the inspector whose interaction outlives a single
 * event, and both things measured here are things a single synthetic `input` cannot
 * see: that the element the gesture is holding is still the one in the document when
 * the gesture ends, and that the whole gesture cost the document **one** revision —
 * one undo step — rather than one per step of the thumb.
 */
export interface SliderGesture {
  name: string;
  /** How many `input` events went in before the `change` that committed. */
  moves: number;
  /** The node the gesture started on was still the document's when it finished. */
  survivedTheDrag: boolean;
  /** What the whole drag cost the document, in revisions. */
  revisions: number;
  /**
   * What **one** step and one `change` on the same control cost, measured beside it.
   *
   * The control, and the reason nothing here is a magic number: a revision counts
   * *ops*, and `updateZoomOps` is `track.remove` + `track.add`, so "one edit" is not
   * "one revision" and writing either number down would pin the batch's shape instead
   * of the property. What is asserted is that a six-step drag costs what a single
   * change costs — and that a single change costs something, or the comparison is
   * satisfied by a control that does not work either.
   */
  controlRevisions: number;
  /** What the gesture asked for last, and what the region reads back as. */
  asked: number;
  amount: number;
}

/**
 * A gesture that ends on the value it started from.
 *
 * The one shape that reaches the "this changes nothing" branch of every two-phase
 * callback, and the only way to see whether a provisional document was left behind:
 * nothing commits, so the editor must be *showing* what it committed rather than the
 * last value the drag passed through on its way back.
 */
export interface SettledGesture {
  /** `project.document`'s magnification — provisional while a drag is live. */
  shownAmount: number;
  /** What the previous gesture actually committed, measured rather than assumed. */
  committedAmount: number;
  /** Revisions the whole return trip cost. It changed nothing, so it is not an edit. */
  revisions: number;
}

/** Mean absolute difference between two decoded export frames, per channel averaged. */
export interface FrameDelta {
  label: string;
  /** `0..255`. */
  meanAbs: number;
}

export interface ControlsReport {
  ok: boolean;
  error: string;
  recording: { id: string; durationSec: number; frameCount: number; size: [number, number] };
  /** Cursor samples and click events the harness wrote into `events/`. */
  logs: { cursorSamples: number; clickDowns: number };
  openedFromLibrary: boolean;
  lanes: string[];
  /** Every tool the rail offered, by `data-tool`. */
  tools: string[];
  readings: Reading[];
  disk: OnDisk[];
  exports: ExportReading[];
  deltas: FrameDelta[];
  /** `null` until the gesture has been driven, so a run that died before it says so. */
  slider: SliderGesture | null;
  settled: SettledGesture | null;
  notes: string[];
}
