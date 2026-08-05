/**
 * The frame index sidecar and the cursor image index.
 *
 * Architecture report §2.4 and §2.5.
 */

import type { SchemaId } from '../schema.ts';

/**
 * `media/<track>.<part>.index.json`. VFR makes this mandatory, not an optimisation.
 * Written by main as chunks arrive, so it also survives a crash.
 *
 * Parallel arrays, not objects: 6,104 frames costs ~150 KB as arrays and ~700 KB as
 * objects, and the arrays deserialize into typed arrays in one pass. `offsets` lets
 * the editor seek to a keyframe with a single range request and decode forward,
 * without parsing the MP4 sample tables at all.
 */
export interface FrameIndexDoc {
  schema: SchemaId;
  /** Units per second for `pts`. `1000000` = microseconds. */
  timescale: number;
  /** Frame numbers that are keyframes. */
  keyframes: number[];
  /** Presentation timestamp per frame, in `timescale` units. */
  pts: number[];
  /** Byte size per frame. */
  sizes: number[];
  /** Byte offset of each frame within the media file. */
  offsets: number[];
}

/** Hotspot in pixels within the cursor bitmap. */
export interface CursorImage {
  /** Bundle-relative path, e.g. `cursors/<sha256>.png`. */
  file: string;
  hotspot: [number, number];
  /** macOS cursor shape name, e.g. `arrow`, `ibeam`. */
  shape: string;
}

/**
 * `cursors/index.json` — content-addressed cursor bitmaps, so "change cursor size
 * after the fact" is possible at all (§2.5).
 */
export interface CursorIndexDoc {
  schema: SchemaId;
  /** Cursor-image id (the `c` field of a cursor event) → bitmap. */
  images: Record<string, CursorImage>;
}
