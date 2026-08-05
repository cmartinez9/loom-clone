/**
 * `@loom/ipc` — the typed IPC boundary.
 *
 * Architecture report §1.4 defines what crosses `main ↔ renderer` and what must
 * never. This package is that definition as code, imported by all three sides —
 * main (which implements it), the preload (which bridges it) and the renderer
 * (which consumes it) — so the three cannot drift.
 *
 * The report's §1.3 package list does not name `ipc`; it names the packages that
 * "must not rot". A shared contract module is required by §1.4 regardless, and the
 * alternative — main's types reached across an app boundary by the renderer — is
 * worse. Phases 1 and 8 extend this file; they do not fork it.
 *
 * ## The contract, verbatim from §1.4
 *
 * ```ts
 * interface LoomApi {
 *   library:  { list(): Promise<RecordingSummary[]>; reveal(id: RecordingId): void;
 *               delete(id: RecordingId): Promise<void> };
 *   recorder: { devices(): Promise<Devices>;
 *               preflight(o: CaptureOptions): Promise<PermissionReport>;
 *               start(o: CaptureOptions): Promise<{ recordingId: RecordingId }>;
 *               pause(): Promise<void>; resume(): Promise<void>; stop(): Promise<void>;
 *               onStatus(cb: (s: RecorderStatus) => void): Unsubscribe };
 *   project:  { open(id: RecordingId): Promise<{ recording: RecordingDoc; edit: EditDocument }>;
 *               applyOps(id: RecordingId, ops: EditOp[], baseRevision: number)
 *                 : Promise<{ revision: number } | { conflict: EditDocument }>;
 *               mediaUrl(id: RecordingId, track: TrackKey, part: number): Promise<string> };
 *   export:   { start(id: RecordingId, s: ExportSettings): Promise<{ jobId: string }>;
 *               cancel(jobId: string): void;
 *               onProgress(cb: (p: ExportProgress) => void): Unsubscribe };
 * }
 * ```
 *
 * Phase 0 ships `library` and `project`. `recorder` (phase 1) and `export` (phase 8)
 * are deliberately absent rather than stubbed: their payload types — `Devices`,
 * `CaptureOptions`, `PermissionReport`, `RecorderStatus`, `ExportSettings`,
 * `ExportProgress` — are not specified anywhere in the architecture report, and a
 * guessed shape that thirteen workers compile against is worse than no shape.
 * Adding a namespace is three lines here, one handler in `apps/main/src/ipc`, and
 * one line in the preload.
 *
 * ## What must never cross
 *
 * Report §1.4 again: `VideoFrame`, `AudioData`, `ImageBitmap`, raw pixel buffers,
 * the cursor log as one blob, the compositor's framebuffer. A single 3456×2234 NV12
 * frame is 11.6 MB; at 30 fps that is 347 MB/s of structured-clone traffic to
 * accomplish nothing. `packages/ipc/test/ipc-boundary.test.ts` fails the
 * build if any of those type names appears in this contract or in the preload.
 */

import type {
  EditDocument,
  EditOp,
  RecordingDoc,
  RecordingId,
  RecordingSummary,
  TrackKey,
} from '@loom/format';

export type { EditDocument, EditOp, RecordingDoc, RecordingId, RecordingSummary, TrackKey };

/** Returned by every `on*` subscription; call it to stop listening. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------- library

export interface LibraryApi {
  list(): Promise<RecordingSummary[]>;
  /** Reveal the bundle in Finder. Fire-and-forget by design (§1.4). */
  reveal(id: RecordingId): void;
  /**
   * Move the bundle to the Trash.
   *
   * The Trash rather than `unlink`: this is the user's footage, deletion is the
   * one irreversible thing the library can do, and macOS already has a place for
   * "gone, but not yet gone".
   */
  delete(id: RecordingId): Promise<void>;
}

// ---------------------------------------------------------------- project

/**
 * The result of `applyOps`. A conflict carries the authoritative document, so the
 * editor reloads rather than guesses — it only happens when two windows have the
 * same project open (§2.7).
 */
export type ApplyOpsResult = { revision: number } | { conflict: EditDocument };

export function isConflict(result: ApplyOpsResult): result is { conflict: EditDocument } {
  return 'conflict' in result;
}

export interface ProjectApi {
  open(id: RecordingId): Promise<{ recording: RecordingDoc | null; edit: EditDocument }>;
  applyOps(id: RecordingId, ops: EditOp[], baseRevision: number): Promise<ApplyOpsResult>;
  /**
   * A `loom://` URL for one media part, served by `protocol.handle()` in main with
   * byte-range support. No `file://`, no `nodeIntegration`, nothing in the renderer
   * that can read the user's disk.
   */
  mediaUrl(id: RecordingId, track: TrackKey, part: number): Promise<string>;
}

// ---------------------------------------------------------------- app

/** Ambient facts about the running app, for the window chrome and the About box. */
export interface AppInfo {
  version: string;
  bundleId: string;
  recordingsRoot: string;
  platform: string;
}

export interface AppApi {
  info(): Promise<AppInfo>;
  /** Open the recordings root in Finder. */
  revealRecordingsRoot(): void;
}

// ---------------------------------------------------------------- LoomApi

/** The object the preload exposes as `window.loom`. */
export interface LoomApi {
  app: AppApi;
  library: LibraryApi;
  project: ProjectApi;
}

// ---------------------------------------------------------------- channels

/**
 * Channel names. Every one is `invoke`/`handle` except the two `send`-only ones,
 * which are marked. Strings are namespaced so a typo is a missing handler rather
 * than a collision with a future channel.
 */
export const CHANNEL = {
  appInfo: 'loom.app.info',
  /** send-only */
  appRevealRoot: 'loom.app.revealRoot',

  libraryList: 'loom.library.list',
  /** send-only */
  libraryReveal: 'loom.library.reveal',
  libraryDelete: 'loom.library.delete',

  projectOpen: 'loom.project.open',
  projectApplyOps: 'loom.project.applyOps',
  projectMediaUrl: 'loom.project.mediaUrl',
} as const;

export type ChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

export const INVOKE_CHANNELS: readonly ChannelName[] = [
  CHANNEL.appInfo,
  CHANNEL.libraryList,
  CHANNEL.libraryDelete,
  CHANNEL.projectOpen,
  CHANNEL.projectApplyOps,
  CHANNEL.projectMediaUrl,
];

export const SEND_CHANNELS: readonly ChannelName[] = [CHANNEL.appRevealRoot, CHANNEL.libraryReveal];

/** The key the preload binds the API to on `window`. */
export const LOOM_API_KEY = 'loom';

// ------------------------------------------------- the high-rate capture channel

/**
 * Capture and export renderers push **encoded** chunks to main, which is the only
 * process that writes them (§1.4). Measured ceiling 289 MB/s against a ~2 MB/s
 * requirement — about 190× headroom — *because* what crosses is already encoded.
 *
 * Declared in phase 0 so that phase 1 inherits the shape rather than inventing it;
 * no handler is registered for it yet.
 */
export interface ChunkMsg {
  track: TrackKey;
  part: number;
  kind: 'key' | 'delta';
  timestampUs: number;
  durationUs: number | null;
  data: Uint8Array;
}

export interface MetaMsg {
  track: TrackKey;
  part: number;
  /** `VideoDecoderConfig` from the WebCodecs encoder, structured-cloneable. */
  decoderConfig: {
    codec: string;
    codedWidth?: number;
    codedHeight?: number;
    description?: Uint8Array;
  };
}

export const CAPTURE_CHANNEL = {
  chunk: 'loom.capture.chunk',
  meta: 'loom.capture.meta',
} as const;

// ---------------------------------------------------------------- loom://

/** The custom protocol scheme. Registered privileged before `app.whenReady()`. */
export const LOOM_SCHEME = 'loom';

/**
 * `loom://` hosts. Two, and no more without a reason:
 *
 * - `app` serves the renderer bundle, so windows have a real origin and a strict
 *   CSP instead of `file://`;
 * - `recording` serves read-only bytes from inside one `.loomrec`, with byte-range
 *   support, confined to the recordings root.
 */
export const LOOM_HOST = {
  app: 'app',
  recording: 'recording',
} as const;

/** `loom://recording/<id>/<bundle-relative path>` */
export function recordingUrl(id: RecordingId, relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${LOOM_SCHEME}://${LOOM_HOST.recording}/${encodeURIComponent(id)}/${encoded}`;
}

/** `loom://app/library.html` */
export function appUrl(file: string): string {
  return `${LOOM_SCHEME}://${LOOM_HOST.app}/${file}`;
}
