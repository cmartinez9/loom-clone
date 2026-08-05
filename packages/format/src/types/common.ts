/**
 * Primitive vocabulary shared by every document in the format.
 *
 * Architecture report §2. One unit for time everywhere: **seconds, float**.
 * The report is explicit about this (§2.5) — Cap uses `time_ms` and pays for it
 * with an entire class of ×1000 bugs. The single exception is the frame index
 * sidecar, which stores integer PTS in its own `timescale` because that is what
 * the demuxer hands us.
 */

/** Seconds, float. The one time unit in this codebase. */
export type Seconds = number;

/** ULID identifying a recording bundle. Stable for the life of the bundle. */
export type RecordingId = string;

/** ISO-8601 timestamp with milliseconds, always UTC (`…Z`). */
export type IsoTimestamp = string;

/**
 * The four capture tracks (architecture report §2.3).
 *
 * A track is a *list of parts*, never a file — see {@link MediaPart}. Pause/resume,
 * a webcam unplug-and-replug, a display reconfiguration and crash recovery each
 * produce a new part. Single-part is a list of length one.
 */
export type TrackKey = 'screen' | 'webcam' | 'mic' | 'system';

export const TRACK_KEYS: readonly TrackKey[] = ['screen', 'webcam', 'mic', 'system'];

/** Zero-based index of a part within a track (`screen.000.mp4` is part 0). */
export type PartIndex = number;

/** `[x, y]`, normalized 0–1 against the *logical* display. */
export type Vec2 = [number, number];
