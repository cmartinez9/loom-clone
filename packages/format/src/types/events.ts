/**
 * The append-only NDJSON event logs. Architecture report §2.5.
 *
 * One event per line, appended every 100 ms and `fsync`'d every second, so a crash
 * costs at most one second of cursor data. This is a deliberate, load-bearing
 * divergence from Cap, which stores `{ "clicks": [...], "moves": [...] }` as one
 * JSON object — a structure that **cannot be appended to** and must be serialized
 * when the recording ends, which is precisely the moment a crash denies you.
 *
 * Field names are short on purpose: the log has tens of thousands of lines.
 */

import type { Seconds } from './common.ts';

/**
 * Modifier bitfield: 1 shift, 2 ctrl, 4 opt, 8 cmd, 16 fn.
 *
 * Cap uses a `Vec<String>` of modifier names, which roughly doubles the size of a
 * 37,492-line log for no gain.
 */
export const MODIFIER = {
  shift: 1,
  ctrl: 2,
  opt: 4,
  cmd: 8,
  fn: 16,
} as const;

export type ModifierMask = number;

/** A cursor position sample. `t` shares its origin with `VideoFrame.timestamp`. */
export interface CursorSample {
  t: Seconds;
  /** Normalized 0–1 against the *logical* display, so a resolution change survives. */
  x: number;
  y: number;
  /** Cursor-image id, resolved through `cursors/index.json`. */
  c: string;
  m: ModifierMask;
}

/** A non-position event on the cursor log — e.g. a display reconfiguration. */
export interface CursorMetaEvent {
  t: Seconds;
  e: string;
  [key: string]: unknown;
}

export type CursorLogLine = CursorSample | CursorMetaEvent;

export function isCursorSample(line: CursorLogLine): line is CursorSample {
  return !('e' in line);
}

/**
 * A mouse button event. Written **only** when Accessibility is granted *and*
 * `tapIsEnabled` is true — an empty file and a missing file mean different things
 * (§7.3, research trap 2).
 */
export interface ClickEvent {
  t: Seconds;
  e: 'down' | 'up';
  /** Button: 0 left, 1 right, 2 middle. */
  b: number;
  x: number;
  y: number;
  m: ModifierMask;
}

/**
 * `events/drawing.ndjson` — the live drawing overlay's log. Phase 12.
 *
 * The same §2.5 stream the cursor and click logs are: NDJSON, one event per line,
 * append-only, `t` in seconds sharing its origin with `VideoFrame.timestamp`,
 * positions normalized 0–1 against the logical display. Every line carries `e`,
 * because unlike `cursor.ndjson` there is no majority event shape for a bare line
 * to mean.
 *
 * **One line per stroke, written when the stroke ends** — not one line per point.
 * A point log would be truer to §2.5's 100 ms cadence, and it is the wrong unit
 * here: the consumer of this file is the importer, which wants strokes, and the
 * atom the user drew is the stroke. What that costs is bounded and stated: a
 * `SIGKILL` loses the stroke that is still under the pen, which is at most a second
 * or two of ink on a recording that has just lost its own tail.
 *
 * The reason strokes are logged at all rather than burned into the capture is
 * §8's phase 12 gate: the overlay is `setContentProtection(true)`, so it is
 * **absent** from the recorded pixels, and the editor re-composites it from here at
 * full resolution over whatever zoom and trim the user ends up with.
 */
export interface DrawingStrokeEvent {
  e: 'stroke';
  /** When the pen went down. */
  t: Seconds;
  /** When it came up. `t1 >= t`. */
  t1: Seconds;
  /** Unique within one recording; `erase` refers to it. */
  id: string;
  tool: DrawingTool;
  /** `#rrggbb` or `#rrggbbaa`, in the display's own encoding — no linearisation. */
  color: string;
  /**
   * Stroke width as an isotropic fraction of the display **width**, matching
   * phase 11's `strokeWidth` (`packages/edl/src/annotations.ts`). Normalized
   * coordinates are anisotropic, so a per-axis width would be thicker vertically.
   */
  w: number;
  /** Flat `[x0, y0, x1, y1, …]`, normalized 0–1 against the logical display. */
  p: number[];
}

/** Strokes the user rubbed out, by id. What was on screen until now stays until now. */
export interface DrawingEraseEvent {
  e: 'erase';
  t: Seconds;
  ids: string[];
}

/** Everything currently on the overlay, gone. */
export interface DrawingClearEvent {
  e: 'clear';
  t: Seconds;
}

/** The two pens the overlay offers. A highlighter is a wide translucent pen. */
export type DrawingTool = 'pen' | 'highlighter';

export type DrawingEvent = DrawingStrokeEvent | DrawingEraseEvent | DrawingClearEvent;

export function isDrawingStroke(event: DrawingEvent): event is DrawingStrokeEvent {
  return event.e === 'stroke';
}
