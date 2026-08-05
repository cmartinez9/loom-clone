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
 * A live-drawing-overlay stroke event. Phase 12 owns the stroke payload; the format
 * fixes only the timestamp so the log stays sortable and replayable.
 */
export interface DrawingEvent {
  t: Seconds;
  [key: string]: unknown;
}
