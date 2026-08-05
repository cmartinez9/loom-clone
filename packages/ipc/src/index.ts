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
  AudioCaptureSummary,
  AudioTrackKey,
  EditDocument,
  EditOp,
  PartEndReason,
  RecordingDoc,
  RecordingId,
  RecordingSummary,
  TrackKey,
  VideoTrackKey,
} from '@loom/format';

export type {
  AudioCaptureSummary,
  AudioTrackKey,
  EditDocument,
  EditOp,
  PartEndReason,
  RecordingDoc,
  RecordingId,
  RecordingSummary,
  TrackKey,
  VideoTrackKey,
};

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
 * What to capture: screen video, the webcam, the microphone and the system's audio
 * output — fields on one options type rather than four, because they are options on
 * one capture, not four captures.
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
  /**
   * Record what comes out of the speakers, via `audio: 'loopback'`.
   *
   * The captain asked for this explicitly, with a pre-recording toggle
   * (`loom-clone-decisions.md`, "Additional requirement"). It needs no driver on
   * macOS 14+ (research report §5.2), which is why the floor is 14.
   */
  systemAudio: boolean;
  /**
   * Microphone device id, `'default'` for the system default, or `null` for no
   * microphone at all.
   */
  micDeviceId: string | null;
  /** AAC bitrate per audio track, bits per second. */
  audioBitrate: number;
  /**
   * Let macOS apply echo cancellation, noise suppression and gain control to the
   * **microphone**. Off by default, and off is not a neutral choice:
   *
   * - it is the same processing research trap 3 is about, applied to the other
   *   track, and it is irreversible — decision 5 deletes the sources after an
   *   export, so a mangled mic recording is mangled for good;
   * - this project's central rule is that nothing is baked in until export
   *   (trap 10). Voice processing is baking in;
   * - macOS's voice-processing IO unit reconfigures the whole audio session, and
   *   the system-audio loopback we capture alongside it is part of that session.
   *
   * System audio ignores this: it is always captured clean (see
   * {@link LOOPBACK_AUDIO_CONSTRAINTS}).
   */
  micVoiceProcessing: boolean;
  /**
   * Camera device id, `'default'` for the system default, or `null` for no camera.
   *
   * `null` by default, and that is a decision rather than an oversight. A camera
   * is the most visible privacy surface this app has — opening one lights the
   * hardware indicator — so it is opened because the user asked for it, never
   * because a default did. Phase 2 owns asking for the permission; the HUD owns
   * offering the toggle. Everything below this line works the same whether the
   * answer is a device or `null`.
   */
  webcamDeviceId: string | null;
  /**
   * Frame rate, longest edge and bitrate for the camera, separate from the screen's.
   *
   * A camera is a 720p-ish constant-rate source and the screen is a 4K
   * variable-rate one (§2.3); one set of numbers cannot serve both, and giving the
   * camera the screen's 12 Mbit/s would spend most of a recording's bytes on the
   * smallest picture in it.
   */
  webcamFps: number;
  webcamMaxDimension: number;
  webcamBitrate: number;
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  displayId: null,
  fps: 30,
  maxDimension: 3840,
  bitrate: 12_000_000,
  systemAudio: true,
  micDeviceId: 'default',
  audioBitrate: 128_000,
  micVoiceProcessing: false,
  webcamDeviceId: null,
  webcamFps: 30,
  webcamMaxDimension: 1280,
  webcamBitrate: 3_000_000,
};

/**
 * The constraints the system-audio track is captured with. **Research trap 3.**
 *
 * Left at their defaults, macOS hands back a *mono* loopback track with echo
 * cancellation, noise suppression and automatic gain control switched on, and
 * "every screen recording with music or a video in it will sound mangled". The
 * scout verified that constraining them explicitly is honoured; Loom's own
 * documentation admits the same trap in as many words ("system audio and noise
 * filter can't be used simultaneously").
 *
 * This is a constant rather than an option because there is no case for the other
 * value: a loopback capture has no echo to cancel, no noise to suppress and no
 * level to ride. {@link violatedLoopbackConstraints} asserts the track we actually
 * got matches.
 */
export const LOOPBACK_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
} as const;

/** What an audio track reported after its constraints were applied. */
export interface AudioTrackSettings {
  sampleRate: number;
  channelCount: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/**
 * Which of trap 3's constraints the platform did not honour, named.
 *
 * Returning the list rather than throwing is deliberate: audio the user asked for
 * is worth having even when it is processed, and `recording.json` records what was
 * actually applied so a bad recording is diagnosable rather than mysterious. The
 * capture page says so loudly; the format keeps the evidence.
 */
export function violatedLoopbackConstraints(settings: AudioTrackSettings): string[] {
  const violations: string[] = [];
  if (settings.echoCancellation) violations.push('echoCancellation');
  if (settings.noiseSuppression) violations.push('noiseSuppression');
  if (settings.autoGainControl) violations.push('autoGainControl');
  if (settings.channelCount < LOOPBACK_AUDIO_CONSTRAINTS.channelCount) {
    violations.push(`channelCount=${settings.channelCount}`);
  }
  return violations;
}

/** What only the live capture knows about an audio track, sent before its first frame. */
export interface AudioTrackFacts {
  deviceId: string | null;
  deviceName: string | null;
  /** `'getdisplaymedia-loopback'` for the system track (research report §5.2). */
  source: string | null;
  settings: AudioTrackSettings;
  /** Empty unless the platform ignored a constraint. See trap 3, above. */
  violations: string[];
}

/**
 * One audio track's measurements, sent when capture ends.
 *
 * `summary` is what `AudioCaptureMeter` measured while the buffers were arriving —
 * the *only* place `measuredSampleRate` and `gaps` can be read (§5.5). Main turns
 * it into `recording.json` fields with `alignAudioPart`; it does not re-derive it,
 * because the encoded stream no longer contains the evidence.
 */
export interface AudioTrackReport {
  track: AudioTrackKey;
  part: number;
  facts: AudioTrackFacts;
  summary: AudioCaptureSummary;
  /**
   * Microseconds to add to this track's timestamps to put them on the same clock
   * as every other track's.
   *
   * Not a refinement — the thing that makes `startTimeSec` mean anything.
   * Chromium timestamps a captured audio buffer against a different epoch than a
   * captured video frame: measured on this machine, video from zero and audio
   * from 2,678,930 s, which is the machine's uptime. Subtracting one from the
   * other without this gives a microphone that started a month before the screen.
   * `TrackEpochEstimator` explains how it is measured.
   */
  epochOffsetUs: number;
  endedEarly: boolean;
  endReason?: PartEndReason;
}

/**
 * What only the live capture knows about a video track, sent before its first frame.
 *
 * The camera's counterpart of {@link AudioTrackFacts}, and smaller: a camera has no
 * trap 3 to record, because nothing is applied to the picture on the way out. What
 * it does have is an identity, and that identity is load-bearing — §7.4 reacquires
 * on "reappearance of the *same* `deviceId*`", so a camera that comes back is only
 * the same camera if this says so.
 */
export interface VideoTrackFacts {
  deviceId: string | null;
  deviceName: string | null;
}

/**
 * One video part's timing and identity, sent when the part closes.
 *
 * Every part of a video track needs its own `startTimeSec` (§2.3), and the numbers
 * that produce it — the first frame, the last one, when capture actually stopped,
 * and the track's epoch offset — are only ever in the renderer. Main places them on
 * the recording clock with `alignVideoPart`; like the audio measurements, it cannot
 * recompute them, because the encoded stream no longer carries the evidence.
 */
export interface VideoPartReport {
  track: VideoTrackKey;
  part: number;
  /** Absent for the screen, whose identity is the display in `recording.json`. */
  facts?: VideoTrackFacts;
  /** First and last encoded frame of this part, on the track's own clock. */
  firstTimestampUs: number | null;
  lastTimestampUs: number | null;
  /**
   * When this part stopped producing, on the same clock.
   *
   * A video track emits a frame only when its picture changes, so the last frame
   * has to stand for the still stretch after it — see
   * {@link CaptureEndReport.endedAtUs}, which is this field for the screen.
   */
  endedAtUs: number | null;
  /** See {@link AudioTrackReport.epochOffsetUs}. */
  epochOffsetUs: number;
  framesEncoded: number;
  framesDropped: number;
  endedEarly: boolean;
  endReason?: PartEndReason;
}

/**
 * A part that closed while the recording carried on — the message §7.4 is about.
 *
 * The camera is unplugged, its part closes, and the screen and the microphone do
 * not notice. Main finalizes that part the moment this arrives rather than at the
 * end of the recording, so the frame index sidecar for everything already recorded
 * is on disk before the next part opens; a crash after the unplug then costs the
 * part that was open, not both of them.
 *
 * The last part of each track is **not** closed this way — it is still open when
 * capture stops, and {@link CaptureEndReport.video} closes it. `ChunkMsg.part` is
 * chosen by the renderer for the same reason this message exists: a new part on a
 * device loss is something the capture page announces, never something it has to
 * ask permission for.
 */
export type PartEndMsg = VideoPartReport;

/**
 * Where a recording is in its life. A subset of `project.json`'s `state` (§2.2)
 * plus `idle`, because "no recording in progress" is a state of the *recorder*
 * rather than of any recording.
 */
export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'finalizing' | 'failed';

/**
 * What the camera is doing, for the §7.4 banner.
 *
 * `lost` is the one that earns its keep: *"Camera disconnected — still recording
 * screen and audio."* A recording that quietly loses its camera and says nothing is
 * a recording the user finds out about in the editor, which is too late to redo it.
 * `unavailable` is a camera that was asked for and could not be captured — the
 * capture page says so through {@link CaptureApi.cameraUnavailable}, or main finds
 * out by failing to open a part for it.
 *
 * `starting` is the interval between asking for a camera and its first encoded
 * frame reaching main: `getUserMedia` plus one frame, which on macOS is several
 * hundred milliseconds. It is a state of its own because the alternative — opening
 * every camera recording in `unavailable` — puts a banner about a broken camera on
 * screen while the camera is opening perfectly well, and a banner that cries wolf
 * at the start of every recording is a banner nobody reads when it matters.
 */
export type CameraState = 'off' | 'starting' | 'live' | 'lost' | 'unavailable';

export interface RecorderStatus {
  phase: RecorderPhase;
  recordingId: RecordingId | null;
  /** Seconds of media written so far — not wall clock, so a stall is visible. */
  elapsedSec: number;
  frameCount: number;
  droppedFrames: number;
  /** Present only in `failed`, and already phrased for a person to read. */
  error: string | null;
  /** What the camera is doing right now (§7.4). `off` when none was asked for. */
  camera: CameraState;
  /** Parts the camera has produced so far — 2 after one unplug and reconnect. */
  cameraParts: number;
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
  /**
   * How many pixels of notice the HUD has below its bar — §7.4's camera banner,
   * the error line, or `0` for neither.
   *
   * The HUD window ships at 420x92 with `overflow: hidden`, so a banner appended
   * below the bar renders at y=92 and no part of it is ever on screen. Main grows
   * the window by exactly this many pixels while there is something to read and
   * shrinks it straight back to 420x92 when there is not, so the bar never carries
   * empty paper for a notice that is not there.
   *
   * The renderer measures because only the renderer can: how tall an error line is
   * depends on the length of the message and on fonts main cannot see. Main sizes,
   * because the window is main's. A number, not a boolean, for the same reason.
   */
  noticeHeight(px: number): void;
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
  /**
   * One entry per audio track that produced anything. Absent when the capture
   * recorded no audio, which is not the same as an entry with no samples in it.
   */
  audio?: AudioTrackReport[];
  /**
   * The video track's own epoch offset, in microseconds. See
   * {@link AudioTrackReport.epochOffsetUs} — the recording clock's origin is the
   * first screen frame *on the shared clock*, so it needs this one too.
   */
  epochOffsetUs?: number;
  /**
   * One entry per video part that was **still open** when capture stopped.
   *
   * Parts that closed earlier arrived as {@link PartEndMsg} and are already
   * finalized; these are the last one of each track. The screen's entry says the
   * same thing as `endedAtUs` and `framesDropped` above, which are kept because
   * phase 1 and phase 3 send them and neither should have to change to add a
   * camera.
   */
  video?: VideoPartReport[];
}

export interface CaptureApi {
  onCommand(callback: (command: CaptureCommand) => void): Unsubscribe;
  /** The decoder configuration for a part, sent before its first chunk. */
  meta(message: MetaMsg): void;
  chunk(message: ChunkMsg): void;
  /** A video part that closed while the recording carried on (§7.4). */
  partEnded(message: PartEndMsg): void;
  /**
   * The camera could not be captured, and the recording is carrying on without it.
   *
   * The one camera fact main cannot derive from the parts it has opened: a
   * `getUserMedia` that was refused, a machine with no encoder for the camera, a
   * cable that has flapped past its part budget. None of them produce a part, so
   * without this main would have nothing to move {@link CameraState} off `starting`
   * with and the §7.4 banner would stay hidden for the failure it exists to report.
   * `live` and `lost` stay derived from the parts, which is what stops a renderer
   * from claiming a camera is recording when main holds no file for it.
   */
  cameraUnavailable(reason: string): void;
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
  /** send-only, the HUD -> main. How tall its notice shelf is right now. */
  recorderNoticeHeight: 'loom.recorder.noticeHeight',
  /** event: main -> renderer */
  recorderStatus: 'loom.recorder.status',

  /** event: main -> the capture window */
  captureCommand: 'loom.capture.command',
  /** send-only, capture window -> main */
  captureMeta: 'loom.capture.meta',
  /** send-only, capture window -> main. The one high-rate channel. */
  captureChunk: 'loom.capture.chunk',
  /** send-only, capture window -> main. A part closed; the recording continues. */
  capturePartEnded: 'loom.capture.partEnded',
  /** send-only, capture window -> main. No camera; the recording continues. */
  captureCameraUnavailable: 'loom.capture.cameraUnavailable',
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
  CHANNEL.recorderNoticeHeight,
  CHANNEL.captureMeta,
  CHANNEL.captureChunk,
  CHANNEL.capturePartEnded,
  CHANNEL.captureCameraUnavailable,
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
  /**
   * The decoder configuration from the WebCodecs encoder, structured-cloneable.
   *
   * Video fills in `codedWidth`/`codedHeight` and carries an `avcC` record as
   * `description`; audio fills in `sampleRate`/`numberOfChannels` and carries an
   * AudioSpecificConfig. Both are the same field the encoder handed over, which is
   * the point: main writes what the encoder said, never what the request asked for.
   */
  decoderConfig: {
    codec: string;
    codedWidth?: number;
    codedHeight?: number;
    sampleRate?: number;
    numberOfChannels?: number;
    description?: Uint8Array;
  };
  /**
   * Audio tracks only: the device and constraint facts `recording.json` records
   * **before the first frame**, because they are knowable only while the session
   * is live and recovery cannot invent them (§2.3).
   */
  audio?: AudioTrackFacts;
  /**
   * Video tracks only, and only where there is a device to name: the camera's
   * identity, plus where this part's first frame lands.
   *
   * The timestamps are here rather than only in {@link VideoPartReport} so that the
   * `recording.json` written *before* the part's first byte already carries a real
   * `startTimeSec` for it. A clean stop overwrites it with the measured value; a
   * crash does not get to, and `webcam.001.mp4` recovered claiming to start at zero
   * would sit on top of `webcam.000.mp4` for the length of the recording.
   */
  video?: VideoTrackFacts & { firstTimestampUs: number; epochOffsetUs: number };
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
