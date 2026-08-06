/**
 * What the editor gate's Electron half writes out, and its test half asserts on.
 *
 * Shared so the two cannot drift, in the shape `test/hud/report.ts` already uses.
 */

/** One reading of the composited picture. */
export interface Picture {
  /** FNV-1a over the RGBA bytes. Two identical composites hash identically. */
  hash: string;
  /** Distinct 4-byte pixel values across the frame. `1` is a flat field. */
  distinct: number;
  /** Fraction of pixels that are not the letterbox background. */
  coverage: number;
}

/** A probe of the editor at one moment. */
export interface Reading {
  label: string;
  timelineSec: number;
  sourceSec: number;
  durationSec: number;
  playing: boolean;
  /** What the timeline is drawing, as the two handles' source seconds. */
  trim: { startSec: number; endSec: number };
  /** `edit.json`'s clip list as the *editor* holds it. */
  clips: { id: string; sourceStart: number; sourceEnd: number; speed: number }[];
  picture: Picture;
  /** The trouble line, if the editor is showing one. */
  trouble: string;
  /** The timecode the transport is showing. */
  timecode: string;
}

/** `edit.json` as it is on disk, read back through a fresh `ProjectStore`. */
export interface OnDisk {
  label: string;
  revision: number;
  clips: { id: string; sourceStart: number; sourceEnd: number; speed: number }[];
}

export interface EditorReport {
  ok: boolean;
  error: string;
  /** The recording the gate built and edited. */
  recording: { id: string; durationSec: number; frameCount: number; size: [number, number] };
  /** True when clicking Open in the real library window produced an editor. */
  openedFromLibrary: boolean;
  /** Lane headings the timeline built from `recording.json`. */
  lanes: string[];
  readings: Reading[];
  disk: OnDisk[];
  logs: string[];
}
