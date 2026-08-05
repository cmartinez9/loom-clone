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
 * Phase 0 shipped `library` and `project`. Phase 1 adds `recorder` — `start`,
 * `stop` and `onStatus`, with the `CaptureOptions` and `RecorderStatus` the screen
 * spine actually needs, plus an `open` the §1.4 sketch has no name for: the library
 * asks for the HUD, and the HUD owns the recording (§1.2). `devices` and `preflight`
 * belong to phase 2 (permissions and first run) and `export` to phase 8; both stay
 * absent rather than stubbed, because a guessed shape that thirteen workers compile
 * against is worse than no shape. Adding a namespace is three lines here, one handler
 * in main, and one line in the preload.
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

// ---------------------------------------------------------------- recorder

/**
 * What to capture. Phase 1 is **screen video only**; microphone and system audio
 * (phase 3) and the webcam (phase 4) add fields here rather than a second options
 * type, because they are options on one capture, not three captures.
 */
export interface CaptureOptions {
  /** Electron display id. `null` records the primary display. */
  displayId: number | null;
  /** Requested frame rate. The screen track is genuinely variable-rate (§2.3). */
  fps: number;
  /**
   * Longest edge, in pixels, the capture is clamped to.
   *
   * Research report trap 9: an unclamped 6K or 8K display overwhelms the encoder
   * and the disk. Loom clamps to 4K and so do we.
   */
  maxDimension: number;
  /** Target video bitrate, bits per second. */
  bitrate: number;
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  displayId: null,
  fps: 30,
  maxDimension: 3840,
  bitrate: 12_000_000,
};

/**
 * Where a recording is in its life. A subset of `project.json`'s `state` (§2.2)
 * plus `idle`, because "no recording in progress" is a state of the *recorder*
 * rather than of any recording.
 */
export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'finalizing' | 'failed';

export interface RecorderStatus {
  phase: RecorderPhase;
  recordingId: RecordingId | null;
  /** Seconds of media written so far — not wall clock, so a stall is visible. */
  elapsedSec: number;
  frameCount: number;
  droppedFrames: number;
  /** Present only in `failed`, and already phrased for a person to read. */
  error: string | null;
}

/** What a crash-recovery pass found, so the app can say it out loud (§7.1). */
export interface RecoveryReport {
  recordingId: RecordingId;
  name: string;
  /** `true` when the bundle came back as an editable recording. */
  recovered: boolean;
  /** Seconds of media that survived. */
  recoveredSec: number;
  frameCount: number;
  /** Bytes discarded from a fragment that was mid-write when the process died. */
  truncatedBytes: number;
  /** Set when the bundle could not be recovered at all. */
  error: string | null;
}

export interface RecorderApi {
  /** Show the recorder HUD. Fire-and-forget, like `library.reveal`. */
  open(): void;
  start(options?: Partial<CaptureOptions>): Promise<{ recordingId: RecordingId }>;
  stop(): Promise<void>;
  onStatus(callback: (status: RecorderStatus) => void): Unsubscribe;
}

// ---------------------------------------------------------------- capture

/**
 * The hidden capture page's half of the contract.
 *
 * Separate from {@link RecorderApi} because it is a different conversation with a
 * different window: the HUD asks for a recording, the capture page produces one.
 * Main accepts these channels **only** from the capture window; the preload is
 * shared by every window, so the authorisation is in main, where it can be checked
 * against the sender.
 */
export type CaptureCommand = { kind: 'start'; options: CaptureOptions } | { kind: 'stop' };

/** Why the renderer stopped producing frames. */
export type CaptureEndReason = 'stopped' | 'source-ended' | 'error';

export interface CaptureEndReport {
  reason: CaptureEndReason;
  /**
   * When capture stopped, on the same microsecond clock as the chunk timestamps.
   *
   * The screen track only produces a frame when the screen changes, so the last
   * frame of a recording that ends on a still screen has to stand for everything
   * after it. Without this, that time is simply not in the file: a four second
   * recording of a static screen reports as a fraction of a second. `null` when the
   * capture never produced a frame to measure against.
   */
  endedAtUs: number | null;
  framesEncoded: number;
  /**
   * Frames the encoder could not keep up with. Recorded in
   * `recording.json.capture.droppedFrames` rather than swallowed — a recording
   * that dropped frames is a recording the user may need to be told about.
   */
  framesDropped: number;
  message?: string;
}

export interface CaptureApi {
  onCommand(callback: (command: CaptureCommand) => void): Unsubscribe;
  /** The decoder configuration for a part, sent before its first chunk. */
  meta(message: MetaMsg): void;
  chunk(message: ChunkMsg): void;
  ended(report: CaptureEndReport): void;
  failed(message: string): void;
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

/**
 * The object the preload exposes as `window.loom`.
 *
 * Every window gets all of it, because there is one preload. Which window may
 * actually *use* a namespace is decided in main against the sender: `capture` is
 * accepted only from the hidden capture window, and `recorder.start`/`stop` only
 * from a window that is allowed to drive a recording. A capability the preload
 * hands out is not the same as a capability main honours.
 */
export interface LoomApi {
  app: AppApi;
  library: LibraryApi;
  project: ProjectApi;
  recorder: RecorderApi;
  capture: CaptureApi;
}

// ---------------------------------------------------------------- channels

/**
 * Channel names, in three disjoint kinds:
 *
 * - **invoke** — renderer asks, main answers;
 * - **send** — renderer tells main, no answer;
 * - **event** — main pushes to a renderer; the preload only ever `on`s these.
 *
 * Strings are namespaced so a typo is a missing handler rather than a collision
 * with a future channel. `packages/ipc/test/ipc-boundary.test.ts` asserts the
 * three sets partition this table exactly, and that an event channel is never
 * `send` or `invoke`d from a renderer.
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

  /** send-only */
  recorderOpen: 'loom.recorder.open',
  recorderStart: 'loom.recorder.start',
  recorderStop: 'loom.recorder.stop',
  /** event: main -> renderer */
  recorderStatus: 'loom.recorder.status',

  /** event: main -> the capture window */
  captureCommand: 'loom.capture.command',
  /** send-only, capture window -> main */
  captureMeta: 'loom.capture.meta',
  /** send-only, capture window -> main. The one high-rate channel. */
  captureChunk: 'loom.capture.chunk',
  /** send-only, capture window -> main */
  captureEnded: 'loom.capture.ended',
  /** send-only, capture window -> main */
  captureFailed: 'loom.capture.failed',
} as const;

export type ChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

export const INVOKE_CHANNELS: readonly ChannelName[] = [
  CHANNEL.appInfo,
  CHANNEL.libraryList,
  CHANNEL.libraryDelete,
  CHANNEL.projectOpen,
  CHANNEL.projectApplyOps,
  CHANNEL.projectMediaUrl,
  CHANNEL.recorderStart,
  CHANNEL.recorderStop,
];

export const SEND_CHANNELS: readonly ChannelName[] = [
  CHANNEL.appRevealRoot,
  CHANNEL.libraryReveal,
  CHANNEL.recorderOpen,
  CHANNEL.captureMeta,
  CHANNEL.captureChunk,
  CHANNEL.captureEnded,
  CHANNEL.captureFailed,
];

/** Main -> renderer pushes. A renderer subscribes; it never sends on these. */
export const EVENT_CHANNELS: readonly ChannelName[] = [
  CHANNEL.recorderStatus,
  CHANNEL.captureCommand,
];

/** The key the preload binds the API to on `window`. */
export const LOOM_API_KEY = 'loom';

// ------------------------------------------------- the high-rate capture channel

/**
 * Capture and export renderers push **encoded** chunks to main, which is the only
 * process that writes them (§1.4). Measured ceiling 289 MB/s against a ~2 MB/s
 * requirement — about 190× headroom — *because* what crosses is already encoded.
 *
 * Declared in phase 0, carried unchanged into phase 1, which registers the
 * handler. `part` is chosen by the renderer, which is what makes a new part on a
 * device loss (phase 4) a message rather than a round trip; main refuses a part
 * index it has already opened.
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
