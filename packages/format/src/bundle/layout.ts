/**
 * The `.loomrec` bundle layout. Architecture report §2.1, reproduced exactly:
 *
 * ```
 * ~/Movies/Loom Clone/                                  (configurable root)
 * └── 2026-08-04 14-32-11 Untitled.loomrec/             one recording = one directory
 *     ├── project.json              manifest + lifecycle state          (mutable, tiny)
 *     ├── recording.json            what was captured                   (immutable after finalize)
 *     ├── edit.json                 the edit-decision document          (mutable)
 *     ├── edit.journal.ndjson       ops applied since the last edit.json snapshot
 *     ├── .lock                     { pid, startedAt } while a process is writing
 *     ├── media/
 *     │   ├── screen.000.mp4        fragmented during capture, finalized in place
 *     │   ├── screen.000.index.json frame index — PTS, keyframes, byte ranges
 *     │   ├── webcam.000.mp4
 *     │   ├── webcam.000.index.json
 *     │   ├── mic.000.m4a
 *     │   └── system.000.m4a
 *     ├── events/
 *     │   ├── cursor.ndjson         append-only, 120 Hz
 *     │   ├── clicks.ndjson         append-only, only if Accessibility granted
 *     │   └── drawing.ndjson        append-only, live-overlay strokes
 *     ├── cursors/
 *     │   ├── index.json            id -> { file, hotspot, shape }
 *     │   └── <sha256>.png          content-addressed cursor bitmaps
 *     └── thumbs/
 *         ├── poster.jpg
 *         └── strip/00000.jpg …     timeline scrubber filmstrip
 * ```
 *
 * Every path in this module is **bundle-relative and POSIX**. Joining to an
 * absolute location is the filesystem layer's job (`../fs/bundle.ts`), which keeps
 * this module free of `node:path` and therefore importable from a renderer.
 */

import type { PartIndex, TrackKey } from '../types/common.ts';

export const BUNDLE_EXTENSION = '.loomrec';

/** Files and directories that make up a bundle. */
export const BUNDLE = {
  project: 'project.json',
  recording: 'recording.json',
  edit: 'edit.json',
  journal: 'edit.journal.ndjson',
  lock: '.lock',
  mediaDir: 'media',
  eventsDir: 'events',
  cursorsDir: 'cursors',
  thumbsDir: 'thumbs',
  cursorIndex: 'cursors/index.json',
  cursorLog: 'events/cursor.ndjson',
  clickLog: 'events/clicks.ndjson',
  drawingLog: 'events/drawing.ndjson',
  poster: 'thumbs/poster.jpg',
  stripDir: 'thumbs/strip',
} as const;

/**
 * The three append-only NDJSON logs under `events/` (§2.5).
 *
 * `clicks` is separate from `cursor` on purpose and it is the reason phase 5 exists:
 * clicks need the Accessibility permission and position does not, so "we have
 * positions but not clicks" is a first-class, representable state rather than
 * something a reader has to infer.
 */
export type EventLogKind = 'cursor' | 'clicks' | 'drawing';

export const EVENT_LOG_KINDS: readonly EventLogKind[] = ['cursor', 'clicks', 'drawing'];

export const EVENT_LOG_PATH = {
  cursor: BUNDLE.cursorLog,
  clicks: BUNDLE.clickLog,
  drawing: BUNDLE.drawingLog,
} as const satisfies Record<EventLogKind, string>;

/** Directories created when a bundle is created, in creation order. */
export const BUNDLE_DIRECTORIES: readonly string[] = [
  BUNDLE.mediaDir,
  BUNDLE.eventsDir,
  BUNDLE.cursorsDir,
  BUNDLE.thumbsDir,
  BUNDLE.stripDir,
];

/**
 * Container extension per track. Video tracks are MP4 (fragmented during capture,
 * finalized in place); audio tracks are M4A.
 */
const TRACK_EXTENSION: Record<TrackKey, string> = {
  screen: 'mp4',
  webcam: 'mp4',
  mic: 'm4a',
  system: 'm4a',
};

/** `000`, `001`, … — three digits, matching §2.1. */
export function partSuffix(part: PartIndex): string {
  if (!Number.isInteger(part) || part < 0 || part > 999) {
    throw new RangeError(`part index out of range: ${String(part)}`);
  }
  return String(part).padStart(3, '0');
}

/**
 * `media/screen.000.mp4`.
 *
 * Note the `.000` on every media file **from day one**. A media track is a *list of
 * parts*, not a file: pause/resume, a webcam unplug-and-replug, a display
 * reconfiguration and crash recovery all produce a new part. Cap retrofitted this
 * as `SingleSegment | MultipleSegments` and pays for it with an untagged enum and
 * two code paths forever. Single-part is just a list of length one.
 */
export function mediaPartPath(track: TrackKey, part: PartIndex): string {
  return `${BUNDLE.mediaDir}/${track}.${partSuffix(part)}.${TRACK_EXTENSION[track]}`;
}

/** `media/screen.000.index.json`. Video tracks only. */
export function mediaIndexPath(track: 'screen' | 'webcam', part: PartIndex): string {
  return `${BUNDLE.mediaDir}/${track}.${partSuffix(part)}.index.json`;
}

/** `cursors/<sha256>.png`. Content-addressed, so identical cursors are stored once. */
export function cursorImagePath(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError(`cursor image id must be a lowercase hex sha256: ${sha256}`);
  }
  return `${BUNDLE.cursorsDir}/${sha256}.png`;
}

/** `thumbs/strip/00000.jpg`. */
export function filmstripPath(frame: number): string {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`filmstrip frame out of range: ${String(frame)}`);
  }
  return `${BUNDLE.stripDir}/${String(frame).padStart(5, '0')}.jpg`;
}

/** The `.bak` a migration leaves behind: `edit.json.v1.bak` (§2.7). */
export function backupPath(file: string, fromVersion: number): string {
  return `${file}.v${String(fromVersion)}.bak`;
}

/**
 * Characters that must not reach a directory name: path separators, the HFS/APFS
 * colon, and control characters. Everything else the user typed is kept, because
 * the directory name is also the name the user reads in Finder.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[/\\:\u0000-\u001F\u007F]/g;

const MAX_NAME_CHARS = 80;

/** `Untitled` — what an unnamed recording is called. */
export const DEFAULT_RECORDING_NAME = 'Untitled';

/** Make a user-supplied recording name safe to use as part of a directory name. */
export function sanitizeRecordingName(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return DEFAULT_RECORDING_NAME;
  // Leading dots would hide the bundle in Finder; trailing dots break on some
  // filesystems. Neither is worth a special case elsewhere.
  const trimmed = cleaned.slice(0, MAX_NAME_CHARS).replace(/^\.+/, '').replace(/\.+$/, '').trim();
  return trimmed.length === 0 ? DEFAULT_RECORDING_NAME : trimmed;
}

/**
 * `2026-08-04 14-32-11 Untitled.loomrec` — the directory name for a bundle.
 *
 * The timestamp is **local time**, because the user reads this in Finder and
 * expects it to match when they hit record. Uniqueness comes from the caller
 * (`ProjectStore` retries with a numeric suffix), not from the name.
 */
export function bundleDirName(createdAt: Date, name: string): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${String(createdAt.getFullYear())}-${p2(createdAt.getMonth() + 1)}-${p2(createdAt.getDate())}` +
    ` ${p2(createdAt.getHours())}-${p2(createdAt.getMinutes())}-${p2(createdAt.getSeconds())}`;
  return `${stamp} ${sanitizeRecordingName(name)}${BUNDLE_EXTENSION}`;
}

export function isBundleDirName(dirName: string): boolean {
  return dirName.endsWith(BUNDLE_EXTENSION) && dirName.length > BUNDLE_EXTENSION.length;
}

/**
 * Reject a bundle-relative path that could escape the bundle.
 *
 * Used by the `loom://` protocol handler before it touches the disk. Rejects
 * absolute paths, `..` segments, Windows drive letters, backslashes and NUL.
 */
export function isSafeBundleRelativePath(relative: string): boolean {
  if (relative.length === 0) return false;
  if (relative.includes('\0')) return false;
  if (relative.includes('\\')) return false;
  if (relative.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(relative)) return false;
  const segments = relative.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}
