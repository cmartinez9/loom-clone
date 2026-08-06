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
 * asks for the HUD, and the HUD owns the recording (§1.2). Phase 2 adds
 * `recorder.preflight` under the name §1.4 gives it, plus two namespaces the sketch
 * has no name for — `permissions` and `setup` — because "ask for four grants up
 * front, explain each, and relaunch for Accessibility" is a conversation with the
 * user, not a property of a capture. Phase 8 adds `export`, with the sketch's three
 * members and two more the captain's decision requires: `defaults` (so a path is not
 * prompted for on every export) and `chooseOutputFolder` (so it can still be
 * changed). `devices` belongs to phase 3/4 and stays absent rather than stubbed,
 * because a guessed shape that thirteen workers compile against is worse than no
 * shape. Adding a namespace is three lines here, one handler in main, and one line
 * in the preload.
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
  AudioPart,
  AudioTrackKey,
  DrawingTool,
  EditDocument,
  EditOp,
  ExportVerification,
  PartEndReason,
  RecordingDoc,
  RecordingId,
  RecordingSummary,
  SetupState,
  TrackKey,
  VideoPart,
  VideoTrackKey,
} from '@loom/format';
import type { PermissionKind, PermissionReport } from '@loom/permissions';

export type {
  AudioCaptureSummary,
  AudioPart,
  AudioTrackKey,
  DrawingTool,
  EditDocument,
  EditOp,
  ExportVerification,
  PartEndReason,
  PermissionKind,
  PermissionReport,
  RecordingDoc,
  RecordingId,
  RecordingSummary,
  SetupState,
  TrackKey,
  VideoPart,
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
 * Longest microphone or camera device id a renderer may name.
 *
 * A `deviceId` from `enumerateDevices` is a 64-character hash. The bound is here
 * because the value is handed straight back to the capture page as a constraint,
 * and an unbounded string from a renderer is a payload rather than a device.
 */
const MAX_DEVICE_ID_LENGTH = 200;

/**
 * The shape check every `CaptureOptions` message from a renderer goes through.
 *
 * Our own code sends these, which is exactly why they are checked: the renderer is
 * the process most likely to be compromised, and it is the one that must never be
 * able to name a path, an unbounded allocation, or a track it is not recording.
 *
 * It lives beside {@link DEFAULT_CAPTURE_OPTIONS} rather than in whichever handler
 * happened to need it first, because there is more than one handler taking this
 * shape — `recorder.start` and `recorder.preflight` — and a second, laxer reading of
 * the same message is how a sanitizer gets quietly bypassed. Every field it does not
 * recognise falls through to the defaults, which is what decides the capture.
 */
export function requestedCaptureOptions(raw: unknown): Partial<CaptureOptions> {
  if (raw === null || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<CaptureOptions> = {};
  if (typeof input['displayId'] === 'number' && Number.isInteger(input['displayId'])) {
    out.displayId = input['displayId'];
  }
  if (typeof input['fps'] === 'number' && input['fps'] > 0 && input['fps'] <= 120) {
    out.fps = Math.round(input['fps']);
  }
  const max = input['maxDimension'];
  if (typeof max === 'number' && max >= 320 && max <= 7680) out.maxDimension = Math.round(max);
  const bitrate = input['bitrate'];
  if (typeof bitrate === 'number' && bitrate >= 100_000 && bitrate <= 200_000_000) {
    out.bitrate = Math.round(bitrate);
  }
  // Strict booleans, not truthiness: a renderer that sends `0` or `''` for
  // `systemAudio` is malformed, and reading it as "off" would answer a question it
  // did not ask. An absent or out-of-range field falls through to
  // `DEFAULT_CAPTURE_OPTIONS`, which is what decides whether a microphone opens.
  if (typeof input['systemAudio'] === 'boolean') out.systemAudio = input['systemAudio'];
  if (typeof input['micVoiceProcessing'] === 'boolean') {
    out.micVoiceProcessing = input['micVoiceProcessing'];
  }
  const mic = input['micDeviceId'];
  if (mic === null) out.micDeviceId = null;
  else if (typeof mic === 'string' && mic.length > 0 && mic.length <= MAX_DEVICE_ID_LENGTH) {
    out.micDeviceId = mic;
  }
  const audioBitrate = input['audioBitrate'];
  if (typeof audioBitrate === 'number' && audioBitrate >= 32_000 && audioBitrate <= 512_000) {
    out.audioBitrate = Math.round(audioBitrate);
  }
  const webcam = input['webcamDeviceId'];
  if (webcam === null) out.webcamDeviceId = null;
  else if (
    typeof webcam === 'string' &&
    webcam.length > 0 &&
    webcam.length <= MAX_DEVICE_ID_LENGTH
  ) {
    out.webcamDeviceId = webcam;
  }
  const webcamFps = input['webcamFps'];
  if (typeof webcamFps === 'number' && webcamFps > 0 && webcamFps <= 120) {
    out.webcamFps = Math.round(webcamFps);
  }
  const webcamMax = input['webcamMaxDimension'];
  if (typeof webcamMax === 'number' && webcamMax >= 160 && webcamMax <= 7680) {
    out.webcamMaxDimension = Math.round(webcamMax);
  }
  const webcamBitrate = input['webcamBitrate'];
  if (
    typeof webcamBitrate === 'number' &&
    webcamBitrate >= 100_000 &&
    webcamBitrate <= 200_000_000
  ) {
    out.webcamBitrate = Math.round(webcamBitrate);
  }
  return out;
}

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
  /**
   * Why this track stopped, when main worked it out. **Absent from anything the
   * capture page sends**, and that is the point of the field being optional here:
   * telling a withdrawn permission apart from a device that vanished takes a TCC
   * read, and reading TCC is main's alone (`apps/main/src/permissions.ts`'s header).
   * A renderer that filled this in would be guessing — which is exactly the bug
   * `decision-mic-revocation.md` was raised about.
   */
  endReason?: PartEndReason;
}

/**
 * An audio track that stopped **while the recording was still running**.
 *
 * The audio counterpart of {@link PartEndMsg}, and it exists for one reason: until
 * this message, main learned that the microphone had gone only from the end report,
 * which arrives when the recording is already over. A grant withdrawn at minute two
 * of a twenty-minute recording could therefore not stop anything, and by the time
 * anyone looked, the only distinguishing evidence — what TCC says *now* — was long
 * gone.
 *
 * The capture page reports the shape of the failure and nothing more. Whether that
 * shape is a revoked permission or a device that fell out is main's to decide, and
 * `RecorderSession.audioEndReasonFor` is where it is decided.
 */
export interface AudioPartEndMsg {
  track: AudioTrackKey;
  part: number;
  /**
   * What the renderer actually observed.
   *
   * - `track-ended` — the `MediaStreamTrack` fired `ended`. This is the shape both a
   *   revoked Microphone grant and an unplugged interface take, and the only cause
   *   for which a TCC re-check answers anything.
   * - `encoder-failed` — the `AudioEncoder` errored, or produced no decoder
   *   configuration. The device is fine and the permission is not in question.
   */
  cause: 'track-ended' | 'encoder-failed';
  /** One line for the log, from the renderer's point of view. */
  detail?: string;
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
 * the recording clock with `videoPartStartSec`; like the audio measurements, it
 * cannot recompute them, because the encoded stream no longer carries the evidence.
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

/**
 * A grant that was withdrawn while a recording was running (§7.3).
 *
 * Separate from {@link RecorderStatus.error} on purpose, and the separation is the
 * whole of the captain's decision in `decision-mic-revocation.md`: the recording
 * **stopped**, but it did not **fail**. It finalized to `editable` with everything
 * captured up to that moment in it, and a user who is shown a red error line will
 * reasonably assume it did not. So this is a notice about a permission, carrying the
 * recording it belongs to, and it outlives the recording — the HUD is still showing
 * it long after `phase` has gone back to `idle`, because that is when the user reads
 * it.
 *
 * `null` whenever the recorder is not carrying one; `start()` clears it, so pressing
 * record is what dismisses it.
 */
export interface RevocationNotice {
  /** Which grant went away. The copy comes from `PERMISSIONS[kind]`, never from here. */
  kind: PermissionKind;
  /** The recording it stopped — finalized, not discarded. */
  recordingId: RecordingId | null;
  /** How much of that recording survived, so the HUD can say so with a number. */
  recordedSec: number;
}

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
  /**
   * A permission withdrawn mid-recording, and the recording it ended (§7.3).
   *
   * Survives the recording it describes — see {@link RevocationNotice}.
   */
  revoked: RevocationNotice | null;
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

/**
 * What `recorder.preflight` answers: not "may I record" as a boolean, but the two
 * lists a person can act on.
 *
 * Returned as data rather than thrown, per this file's rule 3. A start that fails
 * with `Error: NotAllowedError` tells the user nothing; "Screen Recording was
 * refused, here is the pane that turns it on" tells them everything.
 */
export interface PreflightReport {
  report: PermissionReport;
  /** `true` when `recorder.start` would actually produce frames right now. */
  ready: boolean;
  /**
   * Required grants that are missing. Non-empty means `ready` is false.
   * Only ever `['screen']` — it is the one permission this app cannot work without.
   */
  blocking: PermissionKind[];
  /**
   * Optional grants that are missing: features this recording will not have.
   *
   * Surfaced so the recorder can say so *before* the recording rather than let the
   * user discover in the editor that auto-zoom had nothing to work from. The
   * captain's decision requires the app to keep working here, not to stay quiet.
   */
  degraded: PermissionKind[];
}

export interface RecorderApi {
  /** Show the recorder HUD. Fire-and-forget, like `library.reveal`. */
  open(): void;
  /**
   * Check the permissions a capture needs, without starting one.
   *
   * §1.4 names this. It takes the options because what a capture needs depends on
   * what it captures — phase 1 asks only for the screen; a capture with a camera
   * and a mic (phases 3 and 4) will need those grants too, and they belong in the
   * same answer rather than in three separate round trips.
   */
  preflight(options?: Partial<CaptureOptions>): Promise<PreflightReport>;
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

// ------------------------------------------------- the live drawing overlay

/**
 * One stroke, as the overlay reports it. Phase 12.
 *
 * **Times are ages, not timestamps.** `startedMsAgo` and `endedMsAgo` are measured
 * against the renderer's own `performance.now()` at the instant the message is sent,
 * and main subtracts them from its own clock. That is deliberate: the overlay and
 * main do not share a time origin — the renderer's `performance.now()` starts when
 * its document did — and a renderer that sent an absolute number would be sending
 * one only it can interpret. A *difference* survives the crossing; an origin does
 * not. `apps/main/src/overlay.ts` is where they land on the recording clock.
 *
 * Coordinates are normalized 0–1 against the overlay's own viewport, which is the
 * display it covers — §2.5's convention for `cursor.ndjson`, and the same space
 * `zoom.center` is in.
 */
export interface StrokeMsg {
  /** Unique within one recording; the overlay mints it. */
  id: string;
  startedMsAgo: number;
  endedMsAgo: number;
  tool: DrawingTool;
  /** `#rrggbb`. Main does not interpret it beyond writing it down. */
  color: string;
  /** Isotropic fraction of the display **width**, matching phase 11's `strokeWidth`. */
  width: number;
  /** Flat `[x0, y0, x1, y1, …]`, already simplified by the pen. */
  points: number[];
}

/** Strokes the user rubbed out, and when. Same clock convention as {@link StrokeMsg}. */
export interface EraseMsg {
  ids: string[];
  atMsAgo: number;
}

/** Everything on the overlay, gone. */
export interface ClearMsg {
  atMsAgo: number;
}

/** What the overlay is doing, pushed to the HUD so its Draw button can say so. */
export interface OverlayStatus {
  /** The window exists and is on screen. */
  open: boolean;
  /**
   * The pen is down-able: the overlay is taking mouse events instead of letting
   * them fall through to whatever is underneath.
   *
   * Separate from `open` because that separation *is* the feature. An overlay that
   * swallowed clicks whenever it was visible would make the app underneath
   * unusable for the length of the recording, and the recording is of that app.
   */
  armed: boolean;
  /** Strokes accepted for this recording. `0` when no recording is running. */
  strokeCount: number;
  /**
   * The overlay stopped working, in words, or `null`.
   *
   * A field rather than a thrown error because of the constraint that governs this
   * whole surface: **the overlay must never break the recording**. It is an
   * accessory. Every failure in it ends here, as something the HUD can say.
   */
  error: string | null;
}

export interface OverlayApi {
  /** Open or close the overlay. Idempotent; safe with no recording running. */
  setOpen(open: boolean): void;
  /**
   * Take mouse events, or let them through.
   *
   * Called by the overlay page itself as the pointer enters and leaves its palette,
   * and by the HUD when the user picks up or puts down the pen. Main is what calls
   * `setIgnoreMouseEvents`, because the window is main's — the same division
   * `recorder.noticeHeight` draws.
   */
  setArmed(armed: boolean): void;
  /** A finished stroke. Fire-and-forget: ink is never worth failing a recording for. */
  stroke(message: StrokeMsg): void;
  erase(message: EraseMsg): void;
  clear(message: ClearMsg): void;
  onStatus(callback: (status: OverlayStatus) => void): Unsubscribe;
}

// ------------------------------------------------------------- permissions

/**
 * The four macOS grants, driven from the first-run window. Phase 2.
 *
 * The model — what each is for, what breaks without it, which System Settings pane
 * turns it on — is `@loom/permissions`, which both sides import. What crosses here
 * is only the *answers*, so the copy cannot differ between the window that shows it
 * and the main process that logs it.
 */
export interface PermissionsApi {
  /** What macOS currently says, plus whether it is talking about us. */
  probe(): Promise<PermissionReport>;
  /**
   * Ask for one permission and return the report afterwards.
   *
   * "Ask" means three different things and the renderer does not need to know
   * which: Camera and Microphone get a real system prompt, Screen Recording has no
   * request API and prompts on first capture, and Accessibility has neither — the
   * best any app can do is open the pane. Main picks the right one from
   * `PERMISSIONS[kind].requestMode`; a caller just says which permission it wants.
   */
  request(kind: PermissionKind): Promise<PermissionReport>;
  /**
   * Open the System Settings pane for one permission.
   *
   * Takes a {@link PermissionKind}, never a URL. `shell.openExternal` hands whatever
   * it is given to the OS handler for that scheme, so the renderer names a
   * permission and main looks up the one string it is allowed to open.
   */
  openSettings(kind: PermissionKind): void;
  /**
   * Quit and come back.
   *
   * The only way an Accessibility grant reaches this app: the permission does not
   * apply to a running process. Send-only, because a call that never returns is not
   * a promise anyone should be awaiting.
   */
  relaunch(): void;
  /**
   * Fires when the app regains focus and a status has changed.
   *
   * macOS does not notify an app that a grant was given; the user switches to
   * System Settings, flips a switch, and comes back. Re-probing on focus is what
   * turns that into an event, and it is why the setup window updates itself instead
   * of needing a "check again" button.
   */
  onChange(callback: (report: PermissionReport) => void): Unsubscribe;
}

// ------------------------------------------------------------------- setup

export interface SetupApi {
  state(): Promise<SetupState>;
  /**
   * Reopen the first-run window. Send-only, like `recorder.open`.
   *
   * Setup is not only a first run. A user who pressed Continue with Screen Recording
   * refused has a recorder that cannot record, and the explanation and the System
   * Settings deep links they need are all on that window — so the library keeps a
   * route back to it rather than making a reinstall the only way there.
   */
  open(): void;
  /**
   * Mark first-run setup finished and hand over to the library.
   *
   * Finished, not satisfied: the captain's decision is explicit that declining the
   * three optional grants must still leave a working recorder, so this records that
   * the user was asked and answered — whatever they answered.
   */
  complete(): Promise<void>;
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
   * An audio track that stopped while the recording carried on (§7.3).
   *
   * Deliberately **not** {@link partEnded}. That message says "a device came and
   * went and the recording is fine", which is §7.4's story and is the wrong story
   * for a microphone: whether the recording is fine depends on why the track
   * stopped, and only main can find that out. So this reports the observation and
   * main decides the consequence — the two paths that were sharing one.
   */
  audioEnded(message: AudioPartEndMsg): void;
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

// ----------------------------------------------------------------- export

/**
 * What an export runs with.
 *
 * Captain decision 9 (`decision-share-target.md`): *"Pick a sensible default output
 * location and let the captain change it. **Do not prompt for a path on every
 * export.**"* So the destination is a directory plus a name, both defaulted by
 * {@link ExportApi.defaults} and both overridable — never a modal in the way of the
 * button.
 */
export interface ExportSettings {
  /** Output size in pixels. Defaults to `edit.json`'s `output.size`. */
  width: number;
  height: number;
  /**
   * Output frame rate. **CFR** — §5.3: *"QuickTime, Premiere and Final Cut all
   * handle CFR more predictably"*. §5.7 defaults to 30 even for a 60 fps capture.
   */
  fps: number;
  bitrate: number;
  audioBitrate: number;
  /** Absolute directory the finished file is written into. */
  outputDir: string;
  /** File name, without the `.mp4`. */
  name: string;
  /**
   * §7.5, obligation 4 — *"a cheap 'keep the source this time' escape hatch … Costs
   * one boolean and one branch. Build it."*
   *
   * Phase 9 owns the deletion; this is the boolean it reads, recorded on the export
   * as `sourcesKept`. Phase 8 never deletes anything.
   */
  keepSources: boolean;
}

/**
 * What a renderer may say about an export it is asking for.
 *
 * Everything except the destination. **Main owns where the file goes**: it is
 * `settings.exportRoot`, changed only through `export:chooseFolder`, which is a
 * native dialog main itself opens. A renderer that could name `outputDir` could make
 * main create directories anywhere on the volume and `rename(2)` over any `.mp4` on
 * it — §0 rule 1 read backwards, since a sandboxed renderer has no filesystem
 * precisely so that it cannot do that. Captain decision 9 is satisfied without it:
 * *"pick a sensible default output location and let the captain change it"*, and the
 * changing is the picker.
 */
export type ExportSettingsOverride = Omit<Partial<ExportSettings>, 'outputDir'>;

/**
 * How many CFR output frames a timeline of `durationSec` produces at `fps`.
 *
 * `round`, not `ceil`: a 10.000 s timeline at 30 fps is 300 frames covering [0, 10),
 * and a float that landed a microsecond over would otherwise buy a 301st frame that
 * duplicates the 300th.
 *
 * It lives in the contract rather than in either end because **both ends have to
 * agree about it and neither may derive it from the other's answer**. The export
 * window turns it into frames; main turns it into the duration §7.5's fourth check
 * compares the finished file against. Two copies of this arithmetic that drifted
 * would make that check compare the writer's tally with itself, which is precisely
 * the thing it must not do.
 */
export function exportFrameCount(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

/** How long the file those frames make is, in seconds. See {@link exportFrameCount}. */
export function exportDurationSec(durationSec: number, fps: number): number {
  return exportFrameCount(durationSec, fps) / fps;
}

/**
 * Which pipeline an export is on. §5.3: *"Show the user which path they are on
 * ('Instant' vs '≈4 min') because the difference is enormous"* — 235× realtime
 * against 2.1–2.5×.
 */
export type ExportMode = 'recompose' | 'stream-copy';

export type ExportPhase =
  'preparing' | 'audio' | 'video' | 'muxing' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface ExportProgress {
  jobId: string;
  recordingId: RecordingId;
  phase: ExportPhase;
  mode: ExportMode;
  /** `0..1` across the whole job, audio and video weighted by their real cost. */
  completed: number;
  /** Seconds of output produced so far, and how many there are in total. */
  renderedSec: number;
  totalSec: number;
  /** `null` until enough has been produced to extrapolate from. */
  etaSec: number | null;
  /** Present exactly when `phase === 'done'`. */
  result?: ExportResult;
  /** Present exactly when `phase === 'failed'`, and already phrased for a person. */
  error?: string;
}

/**
 * What a finished export is.
 *
 * Captain decision 9: *"Export success = a file on disk, on the clipboard, and
 * Finder revealed. That is the whole contract."* Each of the three is a field here
 * rather than an assumption, because phase 9 deletes the user's only copy of the
 * sources on the strength of this object and a signal that cannot be inspected is
 * not a signal.
 */
export interface ExportResult {
  path: string;
  bytes: number;
  durationSec: number;
  /** The five §7.5 checks, every one of which passed. */
  verified: ExportVerification;
  copiedToClipboard: boolean;
  revealed: boolean;
  sourcesKept: boolean;
  mode: ExportMode;
}

export interface ExportApi {
  /**
   * The settings this recording would export with if the user pressed the button
   * now — size and fps from `edit.json`, destination from `settings.json`.
   */
  defaults(id: RecordingId): Promise<ExportSettings>;
  /** A native folder picker, for changing the destination. `null` if cancelled. */
  chooseOutputFolder(): Promise<string | null>;
  start(id: RecordingId, settings?: Partial<ExportSettings>): Promise<{ jobId: string }>;
  /** Fire-and-forget, per §1.4's sketch. Cancellation is reported as progress. */
  cancel(jobId: string): void;
  onProgress(callback: (progress: ExportProgress) => void): Unsubscribe;
}

// ------------------------------------------- the hidden export window's half

/** One captured video part, as the export page is handed it. */
export interface ExportVideoSource {
  /** `loom://recording/<id>/media/screen.000.mp4`. */
  mediaUrl: string;
  /** `loom://recording/<id>/media/screen.000.index.json` — the §2.4 sidecar. */
  indexUrl: string;
  part: VideoPart;
}

/** One captured audio part. `gaps` and `measuredSampleRate` ride along on `part`. */
export interface ExportAudioSource {
  track: AudioTrackKey;
  mediaUrl: string;
  part: AudioPart;
}

/**
 * Everything the export page needs, and nothing it could get for itself.
 *
 * It fetches the frame index, the initialisation segments and the media bytes over
 * `loom://` with range requests, exactly as the editor does — so this message
 * carries URLs and timing, never bytes.
 */
export interface ExportJob {
  jobId: string;
  recordingId: RecordingId;
  settings: ExportSettings;
  edit: EditDocument;
  /** `compile()`'s context needs it for the source duration an empty clip list means. */
  recording: RecordingDoc | null;
  /** In `startTimeSec` order. The reference track (§5.4). */
  screen: ExportVideoSource[];
  audio: ExportAudioSource[];
  /** Timeline duration, seconds — what `compile()` reports for this document. */
  durationSec: number;
  /**
   * Which passes this window is responsible for.
   *
   * On §5.3's stream-copy path main copies the video samples itself and the window
   * is asked only for the mixed audio — the report's condition list is entirely
   * about pictures, and mixing two audio tracks is seconds of work against minutes
   * of compositing. A recording with no audio at all needs no window.
   */
  passes: { audio: boolean; video: boolean };
}

export type ExportCommand =
  | { kind: 'start'; job: ExportJob }
  | { kind: 'cancel'; jobId: string }
  /**
   * §7.5's fifth verification point: *"last frame actually decodes"*.
   *
   * Main re-reads the finished file, reconstructs the last GOP from the sample
   * table on disk, and sends the encoded chunks here — a decoder lives in a
   * renderer, and encoded chunks are exactly what may cross (§1.4). A verifier that
   * asked the writer whether it had written correctly would be asking the wrong
   * process.
   */
  | { kind: 'verify'; jobId: string; request: ExportDecodeRequest };

export interface ExportDecodeRequest {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** The `avcC`, read back out of the written file's `moov`. */
  description: Uint8Array;
  /** In decode order, starting at a sync sample. */
  chunks: { data: Uint8Array; isKey: boolean; timestampUs: number }[];
  /** Presentation timestamp the last chunk must come back out at, microseconds. */
  expectLastTimestampUs: number;
}

export interface ExportDecodeReport {
  jobId: string;
  ok: boolean;
  framesDecoded: number;
  /** The last decoded frame's timestamp, so a decoder that skipped it is visible. */
  lastTimestampUs: number | null;
  error?: string;
}

/** Which encoder a chunk came out of. */
export type ExportTrackKind = 'video' | 'audio';

/**
 * The encoder's own configuration, sent before its first chunk.
 *
 * Same rule as capture's `MetaMsg`: main writes what the encoder said, never what
 * the request asked for. The `moov` this becomes has to describe the bitstream that
 * is actually in the file.
 */
export interface ExportMetaMsg {
  jobId: string;
  kind: ExportTrackKind;
  decoderConfig: {
    codec: string;
    codedWidth?: number;
    codedHeight?: number;
    sampleRate?: number;
    numberOfChannels?: number;
    description?: Uint8Array;
  };
}

/** One encoded sample, on the same high-rate channel argument as `ChunkMsg`. */
export interface ExportChunkMsg {
  jobId: string;
  kind: ExportTrackKind;
  data: Uint8Array;
  isKey: boolean;
  timestampUs: number;
}

export interface ExportPassProgressMsg {
  jobId: string;
  phase: ExportPhase;
  renderedSec: number;
  totalSec: number;
}

/** A pass finished cleanly. `video` being the last one is what completes a job. */
export interface ExportPassDoneMsg {
  jobId: string;
  kind: ExportTrackKind;
  /** Samples the encoder emitted, so main can refuse a pass that produced none. */
  sampleCount: number;
}

export interface ExportFailedMsg {
  jobId: string;
  message: string;
}

export interface ExportRenderApi {
  onCommand(callback: (command: ExportCommand) => void): Unsubscribe;
  meta(message: ExportMetaMsg): void;
  chunk(message: ExportChunkMsg): void;
  passProgress(message: ExportPassProgressMsg): void;
  passDone(message: ExportPassDoneMsg): void;
  failed(message: ExportFailedMsg): void;
  decoded(report: ExportDecodeReport): void;
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
  permissions: PermissionsApi;
  project: ProjectApi;
  recorder: RecorderApi;
  setup: SetupApi;
  capture: CaptureApi;
  overlay: OverlayApi;
  export: ExportApi;
  /** The hidden export window's half, accepted by main only from that window. */
  exportRender: ExportRenderApi;
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

  permissionsProbe: 'loom.permissions.probe',
  permissionsRequest: 'loom.permissions.request',
  /** send-only */
  permissionsOpenSettings: 'loom.permissions.openSettings',
  /** send-only — a relaunch has no return trip */
  permissionsRelaunch: 'loom.permissions.relaunch',
  /** event: main -> renderer, on focus after a status changed */
  permissionsChanged: 'loom.permissions.changed',

  /** send-only */
  setupOpen: 'loom.setup.open',
  setupState: 'loom.setup.state',
  setupComplete: 'loom.setup.complete',

  /** send-only */
  recorderOpen: 'loom.recorder.open',
  recorderPreflight: 'loom.recorder.preflight',
  recorderStart: 'loom.recorder.start',
  recorderStop: 'loom.recorder.stop',
  /** send-only, the HUD -> main. How tall its notice shelf is right now. */
  recorderNoticeHeight: 'loom.recorder.noticeHeight',
  /** event: main -> renderer */
  recorderStatus: 'loom.recorder.status',

  /** send-only */
  overlaySetOpen: 'loom.overlay.setOpen',
  /** send-only */
  overlaySetArmed: 'loom.overlay.setArmed',
  /** send-only, the overlay -> main. One finished stroke. */
  overlayStroke: 'loom.overlay.stroke',
  /** send-only, the overlay -> main */
  overlayErase: 'loom.overlay.erase',
  /** send-only, the overlay -> main */
  overlayClear: 'loom.overlay.clear',
  /** event: main -> renderer */
  overlayStatus: 'loom.overlay.status',

  /** event: main -> the capture window */
  captureCommand: 'loom.capture.command',
  /** send-only, capture window -> main */
  captureMeta: 'loom.capture.meta',
  /** send-only, capture window -> main. The one high-rate channel. */
  captureChunk: 'loom.capture.chunk',
  /** send-only, capture window -> main. A part closed; the recording continues. */
  capturePartEnded: 'loom.capture.partEnded',
  /** send-only, capture window -> main. An audio track stopped; main decides why (§7.3). */
  captureAudioEnded: 'loom.capture.audioEnded',
  /** send-only, capture window -> main. No camera; the recording continues. */
  captureCameraUnavailable: 'loom.capture.cameraUnavailable',
  /** send-only, capture window -> main */
  captureEnded: 'loom.capture.ended',
  /** send-only, capture window -> main */
  captureFailed: 'loom.capture.failed',

  exportDefaults: 'loom.export.defaults',
  exportChooseFolder: 'loom.export.chooseFolder',
  exportStart: 'loom.export.start',
  /** send-only */
  exportCancel: 'loom.export.cancel',
  /** event: main -> every renderer */
  exportProgress: 'loom.export.progress',

  /** event: main -> the export window */
  exportCommand: 'loom.exportRender.command',
  /** send-only, export window -> main */
  exportMeta: 'loom.exportRender.meta',
  /** send-only, export window -> main. The other high-rate channel. */
  exportChunk: 'loom.exportRender.chunk',
  /** send-only, export window -> main */
  exportPassProgress: 'loom.exportRender.passProgress',
  /** send-only, export window -> main */
  exportPassDone: 'loom.exportRender.passDone',
  /** send-only, export window -> main */
  exportFailed: 'loom.exportRender.failed',
  /** send-only, export window -> main. The answer to a `verify` command. */
  exportDecoded: 'loom.exportRender.decoded',
} as const;

export type ChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

export const INVOKE_CHANNELS: readonly ChannelName[] = [
  CHANNEL.appInfo,
  CHANNEL.libraryList,
  CHANNEL.libraryDelete,
  CHANNEL.permissionsProbe,
  CHANNEL.permissionsRequest,
  CHANNEL.projectOpen,
  CHANNEL.projectApplyOps,
  CHANNEL.projectMediaUrl,
  CHANNEL.recorderPreflight,
  CHANNEL.recorderStart,
  CHANNEL.recorderStop,
  CHANNEL.setupState,
  CHANNEL.setupComplete,
  CHANNEL.exportDefaults,
  CHANNEL.exportChooseFolder,
  CHANNEL.exportStart,
];

export const SEND_CHANNELS: readonly ChannelName[] = [
  CHANNEL.appRevealRoot,
  CHANNEL.libraryReveal,
  CHANNEL.permissionsOpenSettings,
  CHANNEL.permissionsRelaunch,
  CHANNEL.setupOpen,
  CHANNEL.recorderOpen,
  CHANNEL.recorderNoticeHeight,
  CHANNEL.captureMeta,
  CHANNEL.captureChunk,
  CHANNEL.capturePartEnded,
  CHANNEL.captureAudioEnded,
  CHANNEL.captureCameraUnavailable,
  CHANNEL.captureEnded,
  CHANNEL.captureFailed,
  CHANNEL.overlaySetOpen,
  CHANNEL.overlaySetArmed,
  CHANNEL.overlayStroke,
  CHANNEL.overlayErase,
  CHANNEL.overlayClear,
  CHANNEL.exportCancel,
  CHANNEL.exportMeta,
  CHANNEL.exportChunk,
  CHANNEL.exportPassProgress,
  CHANNEL.exportPassDone,
  CHANNEL.exportFailed,
  CHANNEL.exportDecoded,
];

/** Main -> renderer pushes. A renderer subscribes; it never sends on these. */
export const EVENT_CHANNELS: readonly ChannelName[] = [
  CHANNEL.permissionsChanged,
  CHANNEL.recorderStatus,
  CHANNEL.captureCommand,
  CHANNEL.overlayStatus,
  CHANNEL.exportProgress,
  CHANNEL.exportCommand,
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
