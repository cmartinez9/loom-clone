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
  notes: string[];
}
