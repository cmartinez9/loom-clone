/**
 * `project.json` — the manifest. Architecture report §2.2.
 *
 * Mutable and tiny. Written by `ProjectStore` in the main process and by nothing
 * else. `state` is the lifecycle enum and it is load-bearing:
 *
 * ```
 * recording ──stop──► finalizing ──► editable ──export+verify──► exported
 *     │                   │              │
 *     └─crash─────────────┴──────────────┴──► needs-recovery ──recover──► editable
 *                                         └──► failed { error }
 * ```
 */

import type { IsoTimestamp, RecordingId } from './common.ts';
import type { SchemaId } from '../schema.ts';

/**
 * `state: "exported"` means **sources are gone and this recording can no longer be
 * edited** (captain decision 5). `state: "recording"` found at app launch means we
 * crashed — architecture report §7.1.
 */
export type ProjectState =
  'recording' | 'finalizing' | 'editable' | 'exported' | 'needs-recovery' | 'failed';

export const PROJECT_STATES: readonly ProjectState[] = [
  'recording',
  'finalizing',
  'editable',
  'exported',
  'needs-recovery',
  'failed',
];

/** Settings an export ran with. Phase 8 owns the encoder side of these. */
export interface ExportSettingsRecord {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

/**
 * The five verification points from architecture report §7.5, obligation 1.
 * Sources are deleted only when every one of these passed.
 */
export interface ExportVerification {
  exists: boolean;
  bytes: number;
  durationSec: number;
  lastFrameDecodable: boolean;
  sha256: string;
}

/**
 * A record of an export. The exported MP4 itself lives *outside* the bundle
 * (§2.1) because captain decision 9 is "save to disk, reveal in Finder", and
 * revealing a file buried inside a `.loomrec` directory is hostile.
 */
export interface ExportRecord {
  id: string;
  path: string;
  completedAt: IsoTimestamp;
  settings: ExportSettingsRecord;
  /** Absent while the export is in flight; present and complete once verified. */
  verified?: ExportVerification;
  /** The escape hatch from §7.5, obligation 4. */
  sourcesKept: boolean;
  /** Set when the export failed; `verified` then records which checks did pass. */
  error?: string;
}

/**
 * Retention bookkeeping. Architecture report §7.5: write `sourcesDeletedAt`
 * **first**, then unlink `media/` and `events/`, then set `state: "exported"`, so
 * a crash mid-delete resumes the deletion instead of leaving a recording that
 * looks editable with half its media.
 */
export interface RetentionRecord {
  sourcesDeletedAt: IsoTimestamp;
  reason: 'export-verified';
}

export interface ProjectDoc {
  schema: SchemaId;
  /** App version that last wrote this file. */
  appVersion: string;
  id: RecordingId;
  name: string;
  createdAt: IsoTimestamp;
  modifiedAt: IsoTimestamp;
  state: ProjectState;
  /** Mirrors `edit.json`'s `revision`, so the library need not read `edit.json`. */
  editRevision: number;
  /** Total bytes on disk for the bundle, refreshed on write. */
  sizeBytes: number;
  exports: ExportRecord[];
  retention?: RetentionRecord;
  /** Populated when `state === 'failed'`. */
  error?: string;
}
