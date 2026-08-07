/**
 * `RecorderSession` — the capture spine, main-process half. Architecture report
 * §1.1, §1.4, §7.1.
 *
 * Capture lives in a **hidden renderer that renders nothing**, because Electron
 * already reaches ScreenCaptureKit through `setDisplayMediaRequestHandler` +
 * `getDisplayMedia` and delivers native retina frames (§1.1). What that renderer
 * produces is *encoded chunks*; this class receives them and hands them to
 * `ProjectStore`, which owns every file descriptor in the application. That split
 * is the whole crash story: a capture renderer that dies takes no bytes with it,
 * because it never held any.
 *
 * ```
 *  capture window                    main (this file)                ProjectStore
 *  ─────────────────                 ────────────────                ────────────
 *  getDisplayMedia
 *    → MediaStreamTrackProcessor
 *    → VideoEncoder ── ChunkMsg ──►  validate, route  ──────────────► fragment + fsync
 *                                    (never a VideoFrame — §1.4)
 * ```
 *
 * ## The order of operations, and why each step is where it is
 *
 * 1. `project.json` with `state: "recording"` exists **before the capture window is
 *    told to start**, so a crash is detectable rather than inferred (§7.1).
 * 2. `recording.json` is written **before the first frame's bytes**, because it
 *    carries the facts only a live session knows — which display, which scale
 *    factor, which permissions — and recovery cannot invent them.
 * 3. Chunks are appended as they arrive and never batched here. Anything this
 *    process is still holding is what a `SIGKILL` costs.
 * 4. A stop finalizes the part, writes the real numbers into `recording.json`, and
 *    only then moves the state to `editable`.
 */

import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  CHANNEL,
  DEFAULT_CAPTURE_OPTIONS,
  DISK_COPY,
  REFERENCE_CAPTURE_RATE_BYTES_PER_SEC,
  classifyDisk,
  diskRefusesStart,
  requestedCaptureOptions,
  DISK_THRESHOLDS,
  type AudioPartEndMsg,
  type AudioTrackFacts,
  type AudioTrackReport,
  type AudioTrackSettings,
  type CameraState,
  type CaptureEndReport,
  type CaptureOptions,
  type CaptureRate,
  type ChunkMsg,
  type DiskReading,
  type DiskStopNotice,
  type MetaMsg,
  type PartEndMsg,
  type RecorderPhase,
  type RecorderStatus,
  type RecoveryReport,
  type RevocationNotice,
  type VideoPartReport,
  type VideoTrackFacts,
} from '@loom/ipc';
import {
  DiskMonitor,
  SingleFlightDiskRead,
  diskReadDeadlineMs,
  readSpaceBeforeDeadline,
  type DiskReader,
} from './disk-monitor.ts';
import {
  AUDIO_TRACK_KEYS,
  DEFAULT_RECORDING_NAME,
  TRACK_KEYS,
  VIDEO_TRACK_KEYS,
  alignAudioPart,
  driftSec,
  isAudioTrack,
  isVideoTrack,
  videoPartStartSec,
  type AudioCaptureSummary,
  type AudioTrackKey,
  type DisplayInfo,
  type PartEndReason,
  type PermissionState,
  type RecordingDoc,
  type RecordingEvents,
  type RecordingId,
  type VideoTrackKey,
} from '@loom/format';
import { performance } from 'node:perf_hooks';
import { AAC_ENCODER_DELAY_SAMPLES } from '@loom/mux';
import { PERMISSIONS, toRecordingState, type PermissionKind } from '@loom/permissions';
import { describeClickCapability, type InputSampler } from '@loom/sampler';
import {
  monotonicUs,
  readHelperClock,
  startInputSampler,
  type HelperClockReading,
} from '../input-sampler.ts';
import { LIBRARY_RATE_DEADLINE_MS, measureLibraryRate } from '../disk.ts';
import { readAxTrusted, readMediaStatus } from '../permissions.ts';
import type { FinalizedAudioPart, ProjectStore } from '../project-store.ts';
import type { WindowRegistry, WindowRole } from '../windows.ts';
import {
  finalizedRecordingDoc,
  provisionalRecordingDoc,
  withAudioTrack,
  withClosedVideoPart,
  withVideoPart,
  type FinalizedAudioFacts,
  type FinalizedVideoPartFacts,
  type FinalizedVideoTrackFacts,
} from './recording-doc.ts';

/**
 * The track the recording clock's origin comes from, and the one every other
 * track's `startTimeSec` is an offset from (§5.4 mechanism 2).
 */
const REFERENCE_TRACK = 'screen';

/**
 * The macOS grant each audio track needs, or `null` where there is none.
 *
 * The microphone has a TCC grant of its own and the system loopback does not: the
 * loopback rides on the display stream `getDisplayMedia` already handed over, so it
 * is covered by Screen Recording and there is no Microphone answer to re-check for
 * it. That distinction is the reason this is a table rather than an `if`: a loopback
 * track that stops has lost a device, and asking TCC about a microphone would answer
 * a question nobody asked.
 */
const AUDIO_TRACK_GRANT: Readonly<Record<AudioTrackKey, PermissionKind | null>> = {
  mic: 'microphone',
  system: null,
};

/** A chunk larger than this is not a frame; it is a bug or an attack. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Chunks held while the part they belong to is still being created.
 *
 * The capture page sends `meta` and the first chunk for the *same* frame in the
 * same tick, and opening a part is two awaits long, so the first chunk always
 * arrives before there is a file to write it to. That chunk is the initial
 * keyframe; discarding it would leave the part starting on a delta frame and
 * nothing before the next keyframe — a second of footage — decodable. So they are
 * held, in arrival order, and written the moment `beginMediaPart` resolves.
 *
 * The bound is what keeps a `meta` that never lands from turning into unbounded
 * memory, which is also exactly the memory a `SIGKILL` would cost. Overrunning it
 * ends the recording loudly rather than quietly dropping footage.
 */
const MAX_HELD_CHUNKS = 300;

/**
 * How far an audio part may start from the first screen frame before we say so.
 *
 * Two tracks of one capture start within a frame or two of each other — the
 * measured offsets in §2.3's example are 9 ms and 21 ms. A second is not a late
 * device; it is a sign that the audio and video capture clocks do not share an
 * origin, which is the one assumption `startTimeSec` cannot be measured without.
 */
const MAX_PLAUSIBLE_TRACK_OFFSET_SEC = 1;

/**
 * Gaps a renderer may report for one track.
 *
 * A real recording has a handful; an unbounded list is memory main allocates on a
 * renderer's say-so, and a `recording.json` nothing can read.
 */
const MAX_REPORTED_GAPS = 1024;

/**
 * Longest device id a renderer may name in a track's facts.
 *
 * A `deviceId` from `enumerateDevices` is a 64-character hash. The bound is here
 * because the value is written into `recording.json` as the device a part came from,
 * and an unbounded string from a renderer is a payload rather than a device. The
 * same bound guards the ids a renderer *asks* for; that copy lives beside
 * `requestedCaptureOptions` in `@loom/ipc`.
 */
const MAX_DEVICE_ID_LENGTH = 200;

/**
 * Windows that may drive a recording.
 *
 * The preload is shared by every window, so *which* window may use
 * `recorder.start`/`stop` is decided here, against the sender — the same rule the
 * capture channels get, for the same reason. The HUD is the control surface; the
 * library is where a recording is asked for.
 */
const RECORDER_ROLES: readonly WindowRole[] = ['library', 'recorder-hud'];

/**
 * The live drawing overlay's half of the recording lifecycle. Phase 12.
 *
 * Two calls, and both are allowed to fail without consequence — the constraint on
 * this whole surface is that the overlay is an **accessory**: if it breaks, the
 * recording continues. That is the opposite priority to blur and mask, where
 * failing closed protects the user; here failing closed would cost them their
 * footage to save their ink.
 *
 * `apps/main/src/overlay.ts` is the implementation, and the only one.
 */
export interface DrawingSink {
  /**
   * A recording has begun; ink from now until {@link finish} belongs to it.
   *
   * Never awaited and never allowed to throw into the recorder.
   */
  begin(id: RecordingId): void;
  /**
   * The recording is closing. Returns what belongs in `recording.json`'s
   * `events.drawing`, or `null` when nothing was drawn and no log was opened.
   */
  finish(): Promise<{ file: string; strokeCount: number } | null>;
}

export interface RecorderSessionOptions {
  store: ProjectStore;
  windows: WindowRegistry;
  appVersion: string;
  osVersion: string;
  /** How long a stop waits for the capture renderer before finalizing anyway. */
  stopTimeoutMs?: number;
  /** How often the recorder pushes status to the HUD. */
  statusIntervalMs?: number;
  /**
   * Where `loom-input-sampler` lives.
   *
   * Passed rather than left to `@loom/sampler`'s default because only `dist/` knows
   * its own layout, and in a packaged app the binary sits in `app.asar.unpacked/`
   * (`input-sampler.ts`). `undefined` falls back to that default, which is what a
   * test with no `dist/` gets — and a helper that is not there costs the event logs
   * and nothing else.
   */
  inputHelperPath?: string | undefined;
  /**
   * How §7.2's monitor asks about free space. Defaults to `store.diskSpace()`.
   *
   * Injected so it can be *driven*: §7.2's acceptance criterion is a recording that
   * stops cleanly with a playable file, and the only way to watch a threshold being
   * crossed is to move the measurement rather than to fill a real volume. The
   * default is the shipping path, so a test that does not care gets the real one.
   */
  disk?: DiskReader;
  /** §7.2's 2 s poll. Overridden only by tests. */
  diskIntervalMs?: number;
}

/**
 * Media seconds a recording must have written before its own byte rate is reported
 * as **measured**.
 *
 * Below it there is nothing to divide by that is not mostly the first keyframe, and
 * `CaptureRate.source` would be claiming a measurement this recording has not taken.
 * Two seconds is 60 frames at 30 fps and several keyframes at §7.1's one-per-second
 * cadence — enough that the number describes the content rather than the start.
 */
const MEASURED_RATE_FLOOR_SEC = 2;

/**
 * What a rate reads as when **nothing** has been measured — not this recording, and
 * not the user's library either.
 *
 * A first run, and only a first run. `source: 'reference'` is what stops it being
 * reported as a measurement, which is the whole reason the field exists.
 */
const REFERENCE_RATE: CaptureRate = {
  bytesPerSec: REFERENCE_CAPTURE_RATE_BYTES_PER_SEC,
  source: 'reference',
  sampleCount: 0,
};

/** One audio track's state while it is being recorded. */
interface ActiveAudio {
  part: number;
  /** Chunks that arrived before `beginAudioPart` resolved, in arrival order. */
  held: ChunkMsg[];
  open: boolean;
  facts: AudioTrackFacts;
  sampleRate: number;
  channels: number;
}

/**
 * One video part that has been written and closed, before it has been placed.
 *
 * `startTimeSec` is missing on purpose: it is a difference between two tracks'
 * clocks, and the reference track's half of that difference is not known until the
 * capture page stops. What is kept instead are the two numbers it is made of, so
 * every part of the recording can be placed in one pass at finalize.
 */
interface ClosedVideoPart extends Omit<FinalizedVideoPartFacts, 'startTimeSec'> {
  /** This part's first frame, on its own track's clock. `null` if it wrote none. */
  firstPtsUs: number | null;
  /** This track's epoch offset as measured when the part closed. */
  epochOffsetUs: number;
}

/**
 * One video track's state while it is being recorded.
 *
 * A track is a *list of parts* (§2.3), so this holds both: whatever part is open
 * right now, and everything already closed. The camera is what makes that real —
 * §7.4's unplug closes one part and opens another mid-recording, and both end up
 * in `recording.json` with a `startTimeSec` of their own.
 */
interface ActiveVideo {
  track: VideoTrackKey;
  /** The part index currently open, or `null` between parts and after the last. */
  part: number | null;
  /** Chunks that arrived before the open part was created, in arrival order. */
  held: ChunkMsg[];
  /** First and last chunk timestamps of the **open** part, on the track's clock. */
  firstPtsUs: number | null;
  lastEndUs: number;
  /**
   * `monotonicMs()` when the chunk that set {@link lastEndUs} arrived.
   *
   * Main's own monotonic clock, kept beside the media clock so that "what time is
   * it in this recording, right now" has an answer between frames. The live
   * drawing overlay is the caller: a stroke is timestamped when the pen comes up,
   * which is almost never the instant a frame arrived, and a screen track is
   * genuinely variable-rate — an idle desktop emits 1.4 fps (research §5.1), so
   * rounding to the last frame would put a stroke most of a second early.
   */
  lastArrivalMs: number;
  /** Parts already closed, in the order they were recorded. */
  parts: ClosedVideoPart[];
  /**
   * Part indices this track has ever opened.
   *
   * A renderer picks its own part numbers, so this is what stops a replayed or
   * malformed announcement from reopening a part whose file is already closed —
   * which `beginMediaPart`'s `wx` would refuse anyway, loudly, in the middle of a
   * recording that was going fine.
   */
  opened: Set<number>;
  /** The device this track is coming from, for `recording.json`. */
  facts: VideoTrackFacts | null;
  /**
   * This track's epoch offset, as the open part's announcement reported it.
   *
   * Kept because it is the only measure of this track's epoch main holds when the
   * capture page never gets to send an end report — a renderer that threw, or a
   * stop that timed out. Without it the fallback in {@link
   * RecorderSession.finalizeVideo} would subtract two clocks that do not share an
   * origin, and a camera stamped on this machine's uptime would be written into
   * `recording.json` as starting 2,678,930 seconds into the recording.
   */
  epochOffsetUs: number;
  /** Frames the encoder could not keep up with, across every part. */
  droppedFrames: number;
  /** Set when the track is finished for good, so a late announcement is refused. */
  done: boolean;
}

interface Active {
  id: RecordingId;
  options: CaptureOptions;
  /** Written before the first frame; replaced with real numbers at finalize. */
  provisional: RecordingDoc | null;
  /**
   * The screen and, when one was asked for and opened, the camera.
   *
   * Video parts open independently of each other and of the audio tracks — several
   * encoders, several first chunks, no guaranteed order — so each track keeps its
   * own held-chunk buffer rather than sharing one.
   */
  video: Map<VideoTrackKey, ActiveVideo>;
  /**
   * The recording clock's origin: the first screen frame, on the screen's own
   * clock. `null` until that frame arrives, which is also when there is nothing
   * for another track to be an offset from.
   */
  originUs: number | null;
  /**
   * When that frame arrived in this process, on {@link monotonicUs}'s clock.
   *
   * Stamped in {@link RecorderSession.onVideoChunk}, which is where every chunk
   * enters main, rather than where the origin is *used*: the very first screen chunk
   * is always held while its part is opened, and opening a part is an atomic
   * `recording.json` write plus a `beginMediaPart`. Reading the clock on the far side
   * of those would fold their latency into the origin and label every cursor sample
   * that much early. `null` until that first frame arrives, and written exactly once.
   */
  originAtUs: number | null;
  /**
   * The microphone and system tracks, once each has announced itself.
   *
   * Same reasoning as {@link Active.video}, and separate from it because an audio
   * part carries a sample rate and gaps where a video part carries a frame index.
   */
  audio: Map<AudioTrackKey, ActiveAudio>;
  /**
   * Why an audio track stopped, decided at the moment it stopped (§7.3).
   *
   * Kept here rather than worked out at finalize because the evidence is perishable:
   * the only thing that tells a revoked Microphone grant apart from an unplugged
   * interface is what TCC says, and what TCC says at the end of a twenty-minute
   * recording is not what it said at minute two. A grant that was withdrawn and then
   * given back would otherwise be written into `recording.json` as a device that
   * disconnected — which is the misreport this whole path exists to remove.
   */
  audioEnd: Map<AudioTrackKey, PartEndReason>;
  /**
   * A reading of the input helper's clock, taken while the capture page was still
   * opening its stream.
   *
   * Started in {@link RecorderSession.start} rather than when it is needed, because
   * it costs a process and the moment it is needed — the recording clock's origin —
   * is the one moment nothing may be waited on. Resolves to `null` when the helper
   * could not be run, which costs the event logs and nothing else.
   */
  inputClock: Promise<HelperClockReading | null>;
  /**
   * The cursor and click sampler, once the recording clock's origin was known.
   *
   * `null` before {@link Active.sampling} resolves, and after the sampler has been
   * stopped — the field is the *live* sampler, not the record of one.
   */
  sampler: InputSampler | null;
  /**
   * The in-flight start, so a stop cannot race one.
   *
   * Never rejects: a sampler that will not start is reported and the recording
   * carries on (§7.3's rule for the microphone, applied to a log that needs no
   * permission at all). `null` until the origin lands, which is also what says a
   * stop has nothing to wait for.
   */
  sampling: Promise<void> | null;
  /**
   * What the sampler wrote, read once, at the moment it stopped.
   *
   * Kept rather than re-derived because the sampler is dropped as soon as it stops
   * and `recording.json` is written after that — and because `available` is a claim
   * about the whole session that only the sampler that ran it can make.
   */
  events: RecordingEvents | null;
  /** The first write that failed. A recording that cannot be written is over. */
  writeError: Error | null;
  /** What the camera is doing, for the §7.4 banner. */
  camera: CameraState;
  /**
   * Encoded bytes handed to the store for this recording, across every track.
   *
   * Counted at the seam rather than measured off the bundle, because §7.2's monitor
   * runs while the recording does and a `du` of a growing directory every two
   * seconds is a walk this process has no reason to pay for. It is what the
   * *recording* has cost, which is exactly the number the capacity estimate needs;
   * the sidecars and `recording.json` are kilobytes beside it.
   */
  bytesWritten: number;
  /**
   * Why this recording is being stopped, when something other than the user stopped
   * it. Today only §7.2's monitor sets it.
   *
   * It has to be recorded at the moment the stop is *decided*, because by the time
   * `finalize` runs the capture page has reported a perfectly ordinary
   * `reason: 'stopped'` — it was told to stop, and it does not know why. Without
   * this the recording would finalize as a clean stop and `PartEndReason`'s
   * `disk-full` would stay the thing nothing produces.
   */
  stopReason: PartEndReason | null;
  end: CaptureEndReport | null;
}

/**
 * Raised when a recording is asked for while the app is quitting.
 *
 * `before-quit` deliberately keeps the IPC surface up until both producers have shut
 * down, so `recorder.start` still answers — and the HUD is still on screen with its
 * button live — for the length of the flush. {@link RecorderSession.shutdown} is
 * `await enqueue(stop)` and then `uninstall()`, so a start that lands during that stop
 * is chained *behind* it on the same queue and runs **after** the capture channels have
 * been removed: a bundle created, a `.lock` taken and `state: "recording"` written for a
 * capture whose `capture.ended` can never arrive. The next launch then reports a
 * recovered recording the user never made.
 *
 * A quit is not a state a recording can begin in, so it is refused and named — the
 * shape `ExportShuttingDownError` uses one producer over, for the same reason.
 */
export class RecorderShuttingDownError extends Error {
  constructor() {
    super('the app is shutting down; no new recording can be started');
    this.name = 'RecorderShuttingDownError';
  }
}

export class RecorderSession {
  private readonly options: Required<RecorderSessionOptions>;
  private phase: RecorderPhase = 'idle';
  /**
   * Whether {@link RecorderSession.shutdown} has begun. See
   * {@link RecorderShuttingDownError}. Never cleared: the process is going away.
   */
  private shuttingDown = false;
  private active: Active | null = null;
  private lastError: string | null = null;
  /**
   * A grant withdrawn mid-recording, and the recording it stopped (§7.3).
   *
   * On the session rather than on {@link Active} because it has to outlive the
   * recording it describes: the notice is the *only* thing that tells the user why
   * their recording stopped, and by the time they read it the recording has been
   * finalized and `active` is `null`. Cleared by {@link start}, so pressing record
   * is what dismisses it.
   */
  private revoked: RevocationNotice | null = null;
  /**
   * §7.2's monitor, and the two things it leaves behind.
   *
   * `lastDisk` is the most recent poll — republished on every status so the HUD's
   * banner and the recorder's own decision are the same reading. `diskStop` is the
   * notice a stop wrote, and it lives here rather than on {@link Active} for
   * {@link RecorderSession.revoked}'s reason: by the time the user reads it, the
   * recording it describes has been finalized and `active` is `null`.
   */
  private readonly diskMonitor: DiskMonitor;
  /**
   * The one reader both §7.2's poll and {@link start}'s preflight go through.
   *
   * Shared rather than one each, because the guard it carries is about how many `fs`
   * requests this feature can leave parked on libuv's threadpool at once, and two
   * instances would be two.
   */
  private readonly diskRead: SingleFlightDiskRead;
  private lastDisk: DiskReading | null = null;
  private diskStop: DiskStopNotice | null = null;
  /**
   * What a second has cost this user across their own library, measured **once per
   * recording** from {@link start} and reused by every poll below
   * {@link MEASURED_RATE_FLOOR_SEC}.
   *
   * Once, and never on a poll, because `measureLibraryRate` is a recursive walk of
   * every bundle on disk: §7.2's monitor runs every 2 s for the length of a
   * recording, and that walk on that path would sit in the store's queues beside the
   * media appends — and what is queued in memory is exactly what a crash costs.
   * `null` until a walk has answered, which is the only state {@link REFERENCE_RATE}
   * answers — and it is left holding the **last** measurement rather than being
   * cleared by a walk that could not answer, because an earlier reading of this same
   * library is still a measurement of it and the constant is still somebody else's
   * screen.
   */
  private libraryRate: CaptureRate | null = null;
  /**
   * What {@link RecorderSession.recoverOnLaunch} found, held for the life of the
   * process. See {@link RecorderSession.recoveryReports}.
   */
  private recovery: RecoveryReport[] = [];
  /** The live drawing overlay's log, when one is wired. See {@link attachDrawing}. */
  private drawing: DrawingSink | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private captureContentsId: number | null = null;
  /** Set only between telling the capture page to start and handing it a source. */
  private sourceWanted: CaptureOptions | null = null;
  private endWaiters: ((report: CaptureEndReport) => void)[] = [];
  /** Serializes start/stop so two clicks cannot interleave two lifecycles. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Serializes track announcements, which are a read-modify-write of one document. */
  private metaChain: Promise<unknown> = Promise.resolve();

  constructor(options: RecorderSessionOptions) {
    this.options = {
      stopTimeoutMs: 5_000,
      statusIntervalMs: 250,
      inputHelperPath: undefined,
      disk: () => options.store.diskSpace(),
      diskIntervalMs: DISK_THRESHOLDS.pollIntervalMs,
      ...options,
    };
    this.diskRead = new SingleFlightDiskRead(() => this.options.disk());
    this.diskMonitor = new DiskMonitor({
      read: () => this.diskRead.read(),
      rate: () => this.captureRate(),
      intervalMs: this.options.diskIntervalMs,
      onReading: (reading) => {
        this.lastDisk = reading;
        this.publish();
      },
      onExhausted: (reading) => {
        this.stopForFullDisk(reading);
      },
    });
  }

  // ------------------------------------------------------------------- wiring

  /** Register the display-media handler and the recorder/capture channels. */
  install(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        this.provideSource(request.frame?.url ?? null, callback);
      },
      // No system picker: the HUD is the picker, and a second OS-level chooser
      // would make "which display am I recording" a question with two answers.
      { useSystemPicker: false },
    );

    ipcMain.on(CHANNEL.recorderOpen, () => {
      this.options.windows.show('recorder-hud');
    });

    ipcMain.handle(CHANNEL.recorderStart, async (event, raw: unknown) => {
      this.requireRecorderWindow(event);
      const id = await this.enqueue(() => this.start(requestedCaptureOptions(raw)));
      return { recordingId: id };
    });

    ipcMain.handle(CHANNEL.recorderStop, async (event) => {
      this.requireRecorderWindow(event);
      await this.enqueue(() => this.stop());
    });

    // Serialized, not just awaited. Each `onMeta` reads the provisional document,
    // adds a track and writes it back, and there is an `await` in the middle: two
    // tracks announcing themselves at once would both read the same document and
    // the second write would drop the first track. Three encoders start within
    // milliseconds of each other, so this is the common case, not the rare one.
    ipcMain.on(CHANNEL.captureMeta, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      this.metaChain = this.metaChain.then(
        () =>
          this.onMeta(raw).catch((error: unknown) => {
            this.failActive(error);
          }),
        () => undefined,
      );
    });

    ipcMain.on(CHANNEL.captureChunk, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      this.onChunk(raw);
    });

    // On `metaChain` with the announcements, because it is the other half of the
    // same conversation: closing a part and opening the next one are a
    // read-modify-write of one `recording.json`, and a camera that reconnects
    // quickly sends both within a millisecond of each other.
    ipcMain.on(CHANNEL.capturePartEnded, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      this.metaChain = this.metaChain.then(
        () =>
          this.onPartEnded(raw).catch((error: unknown) => {
            this.failActive(error);
          }),
        () => undefined,
      );
    });

    // Not on `metaChain`, for the same reason `cameraUnavailable` is not: it changes
    // no document and closes no file. Unlike that one it is *urgent* — the TCC read
    // it performs is only meaningful while it is fresh (§7.3), so queueing it behind
    // a `recording.json` write would be queueing the evidence behind the thing that
    // makes it stale.
    ipcMain.on(CHANNEL.captureAudioEnded, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      this.onAudioEnded(raw);
    });

    // Not on `metaChain`: it changes no document and closes no file, and a camera
    // that will not open is exactly the case where nothing else is coming to carry
    // the news. §7.4's banner is no use once the recording has stopped.
    ipcMain.on(CHANNEL.captureCameraUnavailable, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      this.onCameraUnavailable(shortString(raw, 500) ?? 'the camera could not be captured');
    });

    ipcMain.on(CHANNEL.captureEnded, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      this.onEnded(endReport(raw));
    });

    ipcMain.on(CHANNEL.captureFailed, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      this.onEnded({
        reason: 'error',
        endedAtUs: null,
        framesEncoded: 0,
        framesDropped: 0,
        message: typeof raw === 'string' ? raw : 'capture failed',
      });
    });
  }

  /**
   * Where the recording clock is *right now*, in source seconds, or `null` when
   * there is no recording or no frame has arrived to give the clock an origin.
   *
   * `elapsedSec()` answers the same question for the HUD's timer and deliberately
   * does not interpolate: a stalled capture should show a stalled timer, because a
   * timer that kept running would hide the stall. This one does interpolate,
   * because its caller is stamping an event that happened between frames — and on
   * an idle desktop ScreenCaptureKit emits 1.4 frames a second (research §5.1), so
   * "the last frame's time" would put a stroke most of a second early.
   *
   * Accurate to about the encode-and-deliver latency of one frame, which is what
   * separates the moment a frame was captured from the moment its chunk arrived
   * here. For ink that is invisible; nothing on this path is A/V sync.
   */
  sourceTimeNowSec(): number | null {
    if (this.phase !== 'recording') return null;
    const state = this.active?.video.get(REFERENCE_TRACK);
    if (state?.firstPtsUs == null) return null;
    const media = (state.lastEndUs - state.firstPtsUs) / 1_000_000;
    const since = Math.max(0, (monotonicMs() - state.lastArrivalMs) / 1000);
    return Math.max(0, media + since);
  }

  /** The recording being written to right now, or `null`. */
  activeRecordingId(): RecordingId | null {
    return this.phase === 'recording' ? (this.active?.id ?? null) : null;
  }

  /**
   * Wire the live drawing overlay's log into the recording lifecycle (phase 12).
   *
   * A setter rather than a constructor option because the two hold each other: the
   * overlay asks the session what time it is, and the session asks the overlay what
   * to write into `recording.json`. Optional, and absent in every test that is not
   * about drawing — a recorder with no overlay attached behaves exactly as it did
   * before phase 12, which is the first half of *"the overlay must never break the
   * recording"*.
   */
  attachDrawing(sink: DrawingSink | null): void {
    this.drawing = sink;
  }

  /** Remove every handler. Used on shutdown and by tests. */
  uninstall(): void {
    session.defaultSession.setDisplayMediaRequestHandler(null);
    for (const channel of [
      CHANNEL.recorderOpen,
      CHANNEL.recorderStart,
      CHANNEL.recorderStop,
      CHANNEL.captureMeta,
      CHANNEL.captureChunk,
      CHANNEL.capturePartEnded,
      CHANNEL.captureAudioEnded,
      CHANNEL.captureCameraUnavailable,
      CHANNEL.captureEnded,
      CHANNEL.captureFailed,
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
    this.stopStatusTimer();
    this.diskMonitor.stop();
  }

  // ----------------------------------------------------------------- lifecycle

  /**
   * Begin a recording.
   *
   * The bundle exists, is locked, and says `state: "recording"` before the capture
   * page is told anything. If this process dies one instruction later, the next
   * launch finds a recording that announced itself.
   *
   * Public because main has reasons of its own to start a recording — a menu item,
   * a global shortcut, `scripts/smoke-capture.mjs` — and every one of them should
   * go through this rather than around it. Callers outside `install()` should wrap
   * it in {@link enqueue} the way the IPC handler does if two could overlap.
   */
  async start(requested: Partial<CaptureOptions>): Promise<RecordingId> {
    // Before the phase check, because a shutdown that has already stopped what was in
    // flight leaves the phase `idle` — which is exactly when this is reachable.
    if (this.shuttingDown) throw new RecorderShuttingDownError();
    if (this.phase !== 'idle') throw new Error(`cannot start while ${this.phase}`);
    const options: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS, ...requested };
    this.phase = 'starting';
    this.lastError = null;
    // Pressing record is what dismisses the last recording's revocation notice. It is
    // cleared here rather than when the user re-grants, because macOS does not tell an
    // app that a grant came back and a notice that outlives its own truth is worse
    // than one the next recording clears.
    this.revoked = null;
    this.diskStop = null;
    this.publish();

    const { store } = this.options;

    // §7.2's preflight, enforced where the recording actually begins rather than
    // only where it is advised about. `recorder.preflight` answers the same
    // question for a surface that wants to warn *before* the button is pressed, but
    // a refusal that only lives there is a refusal any other caller — a menu item,
    // a global shortcut, `smoke-capture.mjs` — walks straight past. This runs
    // before `store.create`, so a refused start leaves no bundle behind.
    //
    // The library walk behind §7.2's capacity estimate is *started* here and
    // deliberately not awaited. This recording has written nothing yet, so its own
    // bytes cannot answer for another two seconds and the user's library is what can
    // — but `store.list()` is a recursive walk of every bundle on disk, and neither
    // its latency nor a `readdir` that hangs belongs between pressing Record and
    // `store.create`. Awaiting it would put back, one line above the deadline that
    // closed it, the exact wedge that deadline exists to prevent: a Record button
    // that never comes back, with no recording and nothing on screen saying why.
    // What a slow or wedged library costs instead is the *provenance* of a number —
    // `captureRate()` falls through to `REFERENCE_RATE` — and never the recording.
    void this.measureLibrary();
    const reading = await this.readDisk();
    this.lastDisk = reading;
    if (diskRefusesStart(reading)) {
      this.phase = 'idle';
      this.publish();
      throw new Error(DISK_COPY.refusal(reading));
    }

    const { id } = await store.create(DEFAULT_RECORDING_NAME);
    try {
      await store.openProject(id);
      await store.setState(id, 'recording');
      // `recording.json` before the capture page is told anything, carrying the
      // facts only a live session knows — which display, which scale factor, which
      // permissions. Tracks are added to it as their encoders announce themselves
      // (§2.3, and `recording-doc.ts` for why that is three writes and not one).
      const provisional = provisionalRecordingDoc({
        display: this.displayInfo(options.displayId),
        requestedFps: options.fps,
        capture: {
          app: this.options.appVersion,
          os: this.options.osVersion,
          permissions: this.permissions(),
          resolutionClamp: `${String(options.maxDimension)}px`,
        },
      });
      await store.writeRecordingDoc(id, provisional);
      this.active = {
        id,
        options,
        provisional,
        video: new Map(),
        originUs: null,
        originAtUs: null,
        audio: new Map(),
        audioEnd: new Map(),
        // Kicked off here and awaited at the origin, so the helper's start-up cost
        // is paid while `getDisplayMedia` is opening its stream rather than in the
        // frame handler. Never rejects — `probeInput` reports a helper it could not
        // run instead of throwing, and the `catch` covers everything else.
        inputClock: readHelperClock(this.options.inputHelperPath).catch((error: unknown) => {
          console.error('[recorder] the input helper clock could not be read:', error);
          return null;
        }),
        sampler: null,
        sampling: null,
        events: null,
        writeError: null,
        // A camera that was asked for is *starting*, not missing: `getUserMedia`
        // and the first frame take a moment, and calling that `unavailable` would
        // open every camera recording with the §7.4 banner already on screen.
        camera: options.webcamDeviceId === null ? 'off' : 'starting',
        bytesWritten: 0,
        stopReason: null,
        end: null,
      };

      // Ink is scoped to the recording it was drawn over, so the overlay is told
      // before the capture page is. Wrapped, like everything else on this path: an
      // overlay that cannot start is a recording without ink, never a failed one.
      try {
        this.drawing?.begin(id);
      } catch (error) {
        console.error('[recorder] the drawing overlay could not start:', error);
      }

      const window = await this.readyCaptureWindow();
      this.captureContentsId = window.webContents.id;
      this.sourceWanted = options;
      window.webContents.send(CHANNEL.captureCommand, { kind: 'start', options });

      this.phase = 'recording';
      this.startStatusTimer();
      // §7.2's 2 s poll, armed only while a recording is running. It polls once
      // straight away, so a recording started on a volume that is already inside the
      // banner band says so on the first status rather than on the third.
      this.diskMonitor.start();
      this.publish();
      return id;
    } catch (error) {
      this.sourceWanted = null;
      this.active = null;
      this.phase = 'failed';
      this.lastError = message(error);
      await store.setState(id, 'failed', this.lastError).catch(() => undefined);
      await store.close(id).catch(() => undefined);
      this.publish();
      throw error;
    }
  }

  /** Stop the capture page, then finalize whatever it produced. */
  async stop(): Promise<void> {
    if (this.phase !== 'recording') {
      if (this.phase === 'starting') throw new Error('the recording has not started yet');
      return;
    }
    this.phase = 'finalizing';
    // Nothing left to watch: the stop is what §7.2's monitor exists to cause, and a
    // poll arriving during a finalize is a reading about a recording that is over.
    this.diskMonitor.stop();
    this.publish();

    const window = this.options.windows.get('capture');
    if (window !== undefined && !window.isDestroyed()) {
      window.webContents.send(CHANNEL.captureCommand, { kind: 'stop' });
    }
    const report = await this.awaitEnd(this.options.stopTimeoutMs);
    await this.finalize(report);
  }

  /**
   * Close the books on the active recording.
   *
   * Runs for a clean stop, for a source that ended on its own (§7.3: the screen
   * track ending is not a normal stop and must not be treated as one), and for a
   * capture renderer that failed. In all three the bytes already written are kept
   * — the recording is finalized to whatever it actually contains, never discarded.
   */
  private async finalize(report: CaptureEndReport | null): Promise<void> {
    const active = this.active;
    this.active = null;
    this.sourceWanted = null;
    this.stopStatusTimer();
    this.diskMonitor.stop();
    if (active === null) {
      this.phase = 'idle';
      this.publish();
      return;
    }

    // §7.2's *"tell the user exactly what happened and how long was saved"*, taken
    // here because this is the last instant `active` exists and the elapsed time is
    // still readable. The recording is about to finalize with everything in it — so
    // the notice is written whether or not the finalize below succeeds, for the same
    // reason §7.3's is: a recording that stopped by itself and says nothing reads as
    // a recording that was lost.
    if (active.stopReason === 'disk-full') {
      this.diskStop = {
        recordingId: active.id,
        recordedSec: this.elapsedFor(active),
        freeBytes: this.lastDisk?.space?.freeBytes ?? 0,
      };
    }

    // Before anything else touches the bundle, and unconditionally: the sampler
    // writes from its own timers, and `ProjectStore`'s event-log calls refuse a
    // project that has been closed rather than reopening it. Stopping here rather
    // than in the `finally` beside `store.close` is the same "stop the producer,
    // then close the project" ordering the store's event-log section states from
    // the other side — and it also means the counts written below are final.
    await this.stopSampling(active);

    const { store } = this.options;
    // Closed *before* the bundle is, and outside the try, because closing the
    // drawing log is a write into a project that has to still be open —
    // `ProjectStore`'s event-log section states that contract from the other side.
    // Its failure is swallowed here rather than reported: the recording is what
    // matters, and this is the last thing that could take it down.
    let drawing: { file: string; strokeCount: number } | null = null;
    try {
      drawing = (await this.drawing?.finish()) ?? null;
    } catch (error) {
      console.error('[recorder] closing the drawing log failed:', error);
    }

    try {
      await store.setState(active.id, 'finalizing');
      // The end report closes whatever part of each video track was still open —
      // parts that closed earlier arrived as `partEnded` and are already finalized.
      // Every track closes even when another failed: a file descriptor into the
      // bundle outliving the recording is the thing `close` exists to prevent.
      await this.finalizeVideo(active, report);
      const audio = await this.finalizeAudio(active, report);
      const video = this.finalizedVideo(active);

      const provisional = active.provisional;
      const screenFrames = video.screen.parts.reduce((sum, part) => sum + part.frameCount, 0);
      if (provisional?.tracks.screen === undefined || screenFrames === 0) {
        const reason =
          active.writeError !== null
            ? `the recording could not be written: ${active.writeError.message}`
            : (report?.message ?? 'the capture produced no frames');
        this.lastError = reason;
        this.phase = 'failed';
        await store.setState(active.id, 'failed', reason);
        return;
      }

      const finalized = finalizedRecordingDoc(
        provisional,
        { video, audio, ...(active.events === null ? {} : { events: active.events }) },
        new Date().toISOString(),
      );
      await store.writeRecordingDoc(
        active.id,
        drawing === null ? finalized : { ...finalized, events: { ...finalized.events, drawing } },
      );
      await store.setState(active.id, 'editable');
      this.phase = 'idle';
    } catch (error) {
      this.lastError = message(error);
      this.phase = 'failed';
      await store.setState(active.id, 'failed', this.lastError).catch(() => undefined);
    } finally {
      await store.close(active.id).catch((error: unknown) => {
        console.error('[recorder] closing the bundle failed:', error);
      });
      this.publish();
    }
  }

  /**
   * Finish or abandon whatever is in flight, for `before-quit`.
   *
   * A quit is not a crash and should not cost the user a recovery pass, so an
   * active recording is stopped properly. If the capture page does not answer in
   * time the bundle is left saying `state: "recording"`, and the next launch
   * recovers it — which is the same path a real crash takes, and is therefore the
   * path that is actually tested.
   */
  async shutdown(): Promise<void> {
    // First, and before the stop is enqueued, so nothing can join the queue behind it.
    this.shuttingDown = true;
    try {
      // The ordinary stop, on the ordinary queue. `uninstall` comes *after*: it
      // removes the listener the capture page's "I have stopped" message arrives
      // on, and tearing that down first would guarantee the timeout it is meant to
      // avoid.
      await this.enqueue(() => this.stop());
    } catch (error) {
      console.error('[recorder] shutdown failed:', error);
    } finally {
      this.uninstall();
    }
  }

  // ------------------------------------------------------------------ sampling

  /**
   * Start sampling the pointer into this recording's `events/` logs.
   *
   * Called exactly once per recording, from the reference track's first frame —
   * because that frame *is* the recording clock's origin (§5.4 mechanism 2), and
   * §2.5 requires the log's `t` to share it. Starting at `start()` instead would put
   * `t = 0` wherever `getDisplayMedia` happened to be in opening its stream, which
   * is hundreds of milliseconds before the first frame and a constant lead on every
   * generated camera move.
   *
   * **Deliberately not awaited, and it cannot throw.** This is the frame handler:
   * spawning the helper is two awaits and blocking here would build the queue a
   * `SIGKILL` is charged for. The promise is kept so a stop has something to wait on
   * — see {@link RecorderSession.stopSampling} — and nothing on it reaches the
   * recording. Cursor position needs no permission and clicks are additive to the
   * video, so a sampler that will not start costs the logs and nothing else.
   */
  private beginSampling(active: Active, originAtUs: number): void {
    if (active.sampling !== null) return;
    active.sampling = this.startSampling(active, originAtUs).catch((error: unknown) => {
      console.error('[recorder] the input sampler could not be started:', error);
    });
  }

  /**
   * Put the origin on the helper's clock, then start.
   *
   * `t0Us` is on `CLOCK_UPTIME_RAW`, which nothing in Node can read (see
   * {@link HelperClockReading}). What this process *can* do is measure a duration:
   * `originAtUs` and the reading's `atUs` are both on one monotonic clock, and the
   * two clocks tick at the same rate, so the elapsed time between them carries over
   * unchanged. The origin on the helper's clock is therefore the reading plus that
   * elapsed time — with the reading taken *before* the origin, so the term is
   * positive and no extrapolation is involved.
   *
   * **What the residual is, and which way it points.** Two terms, and they point in
   * opposite directions, so they partially cancel rather than add. `originAtUs` is
   * when the first frame *arrived in this process*, not when the screen produced it;
   * the encode and the IPC hop in between are unmeasured here, and they make the
   * origin slightly late, which labels every cursor sample slightly early. The
   * reading's own `atUs` runs the other way: it is taken after the helper exited, at
   * or after the instant it stamped, which makes the origin slightly small and labels
   * samples late by at most `clock.uncertaintyUs` (see {@link HelperClockReading}).
   * Both are tens of milliseconds against a §6.5 pre-roll of 600 ms. Closing the
   * first properly means relating the capture renderer's `performance.now()` to this
   * clock, which is new IPC and new §5.4 arithmetic; it is recorded in AGENTS.md as
   * an open item rather than guessed at.
   */
  private async startSampling(active: Active, originAtUs: number): Promise<void> {
    const clock = await active.inputClock;
    if (clock === null) {
      console.error(
        '[recorder] the input helper did not report its clock, so this recording has no ' +
          'cursor log; the recording itself is unaffected',
      );
      return;
    }

    const sampler = await startInputSampler({
      store: this.options.store,
      id: active.id,
      t0Us: Math.round(clock.tUs + (originAtUs - clock.atUs)),
      // Electron's `Display.id` is the `CGDirectDisplayID` on macOS, and it is the
      // display `recording.json` says was recorded — so the positions in the log are
      // normalized against the same rectangle §2.5's reader will assume.
      ...(active.provisional === null ? {} : { displayId: active.provisional.display.id }),
      // Always asked for, never conditioned on `AXIsProcessTrusted()`. `false` means
      // "this caller opted out" and reads back as `not-requested`; the app never
      // opts out — it asked the user for Accessibility on the promise of this log.
      // A denied grant must therefore reach `recording.json` as the tap's own
      // `accessibility-denied`, which is a different thing to tell somebody, and
      // which only the helper is in a position to say.
      clicks: true,
      ...(this.options.inputHelperPath === undefined
        ? {}
        : { helperPath: this.options.inputHelperPath }),
    });
    active.sampler = sampler;

    // Declared in `recording.json` now rather than only at finalize, so a recording
    // that is `SIGKILL`ed has something pointing at the logs it already wrote — the
    // same reason a part is declared before its first byte. The counts are zero here
    // for the same reason a provisional part's `frameCount` is: nothing has been
    // measured yet, and a clean stop replaces them.
    //
    // On `metaChain` because it is a read-modify-write of the one document the track
    // announcements are also rewriting, and those are three encoders deep by now.
    this.metaChain = this.metaChain.then(
      () => this.declareEvents(active, sampler.recordingEvents()),
      () => undefined,
    );

    // The uncertainty is printed rather than assumed small. It is the full width of
    // the interval the helper's clock was read in, and under this estimator that is a
    // one-sided bound rather than a ± — the origin can only be early, so a sample can
    // only be labelled late. It is the one term in the origin that this process can
    // actually see, so a machine where the probe takes a second says so here rather
    // than producing a quietly misplaced log.
    console.log(
      `[recorder] sampling the pointer, origin early by at most ` +
        `${clock.uncertaintyUs.toFixed(0)} µs; ${describeClickCapability(sampler.capability)}`,
    );
  }

  /** Write the sampler's `events` fragment into the provisional document. */
  private async declareEvents(active: Active, events: RecordingEvents): Promise<void> {
    if (this.active !== active || active.provisional === null) return;
    const provisional = { ...active.provisional, events };
    try {
      await this.options.store.writeRecordingDoc(active.id, provisional);
      active.provisional = provisional;
    } catch (error) {
      // The logs are being written either way; what is lost is a crashed bundle
      // naming them. Not worth failing a recording for.
      console.error('[recorder] declaring the event logs in recording.json failed:', error);
    }
  }

  /**
   * Stop sampling and take the account of what was written.
   *
   * Awaits the start first. That wait is bounded by `@loom/sampler`'s own
   * `startTimeoutMs`, and in practice it has long since resolved — the origin is the
   * first frame and a stop is at least a recording later. What it rules out is the
   * one ordering that matters: a sampler that finishes starting *after* the bundle
   * has been closed, whose every later write is then a typed refusal.
   *
   * `available` is read from the sampler rather than inferred from the log: a tap
   * that was never live and a session in which nobody clicked produce the same empty
   * file, and `recording.json` must not conflate them (§7.3).
   */
  private async stopSampling(active: Active): Promise<void> {
    const sampling = active.sampling;
    if (sampling === null) return;
    active.sampling = null;
    try {
      await sampling;
      const sampler = active.sampler;
      if (sampler === null) return;
      active.sampler = null;
      try {
        await sampler.stop();
      } finally {
        // Whatever it managed to write is still worth describing, so this is taken
        // even when the stop reported an abandoned helper.
        active.events = sampler.recordingEvents();
      }
      const health = sampler.health;
      // `clicks` is `null` rather than `0` when the tap was never live, and it is
      // reported that way here too: "0 clicks" and "clicks unavailable" are the two
      // things this whole path exists to keep apart.
      const clicks =
        health.clicks === null ? 'clicks unavailable' : `${String(health.clicks)} clicks`;
      const dropped = health.dropped > 0 ? `, ${String(health.dropped)} lines dropped` : '';
      console.log(
        `[recorder] input sampler stopped: ${String(health.samples)} cursor samples, ` +
          `${clicks}${dropped}`,
      );
    } catch (error) {
      console.error('[recorder] stopping the input sampler failed:', error);
    }
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Recover every bundle that was mid-recording when we last died (§7.1).
   *
   * Runs at launch, before any window can ask for a recording. Returns what it
   * found so the app can tell the user plainly — *"Recovered 4:52"* — rather than
   * silently presenting a repaired recording as though nothing happened.
   *
   * What it returns is also **kept**, in {@link RecorderSession.recovery}, because
   * this runs before any window exists and there is therefore nobody to push it to.
   * §7.1 step 5 is *"Show the user"*, and until phase 13 the only thing that showed
   * anybody anything here was a `console.log`.
   */
  async recoverOnLaunch(): Promise<RecoveryReport[]> {
    this.recovery = [];
    const crashed = await this.options.store.listCrashed();
    const reports: RecoveryReport[] = [];
    for (const summary of crashed) {
      try {
        reports.push(await this.options.store.recoverBundle(summary.id));
      } catch (error) {
        reports.push({
          recordingId: summary.id,
          name: summary.name,
          recovered: false,
          recoveredSec: 0,
          frameCount: 0,
          truncatedBytes: 0,
          error: message(error),
        });
      }
    }
    for (const report of reports) {
      console.log(
        report.recovered
          ? `[recorder] recovered ${report.name}: ${report.frameCount} frames, ` +
              `${report.recoveredSec.toFixed(3)}s, ${report.truncatedBytes} bytes of a torn ` +
              `fragment discarded`
          : `[recorder] could not recover ${report.name}: ${report.error ?? 'unknown'}`,
      );
    }
    this.recovery = reports;
    return reports;
  }

  /**
   * What this launch's recovery pass found, for whoever asks (§7.1 step 5).
   *
   * A copy, because this outlives every window and a caller that mutated it would be
   * editing what the *next* window is told about a repair that already happened.
   */
  recoveryReports(): RecoveryReport[] {
    return [...this.recovery];
  }

  // ------------------------------------------------------- capture-page traffic

  /**
   * The first message of a part: the decoder configuration.
   *
   * `recording.json` is written here, before the part file is created, so a crash
   * can never leave media with no document describing it.
   */
  private async onMeta(raw: unknown): Promise<void> {
    const active = this.active;
    if (active === null) return;
    const meta = metaMessage(raw);
    if (isAudioTrack(meta.track)) {
      // An audio track that cannot be opened costs its own track and nothing else
      // (§7.3): the user pressed record to record their screen.
      try {
        await this.onAudioMeta(active, meta, meta.track);
      } catch (error) {
        // Scoped cleanup belongs to `onAudioMeta`, which is the only thing that
        // knows whether the state under this key is the one it created. A
        // duplicate announcement for a track that already has a healthy open part
        // fails here, and deleting that state would discard a live track.
        console.error(`[recorder] the ${meta.track} track could not be opened:`, error);
      }
      return;
    }
    if (meta.track === REFERENCE_TRACK) {
      // The screen is the recording. A part of it that cannot be opened fails the
      // capture rather than costing a track.
      await this.onVideoMeta(active, meta, meta.track);
      return;
    }
    // And the camera is not (§7.4). Same rule as the microphone's, for the same
    // reason: whatever went wrong with the camera, the screen is still recording.
    try {
      await this.onVideoMeta(active, meta, meta.track);
    } catch (error) {
      console.error(`[recorder] the ${meta.track} part could not be opened:`, error);
      this.giveUpOnCamera(active);
    }
  }

  /**
   * Stop expecting anything more from the camera, without touching what it wrote.
   *
   * The parts it already produced stay in `recording.json` — footage the capture
   * succeeded at is footage the user keeps. What changes is that a later
   * announcement under this track is refused rather than allowed to open a part
   * beside the one that just failed.
   */
  private giveUpOnCamera(active: Active): void {
    const state = active.video.get('webcam');
    if (state !== undefined) state.done = true;
    active.camera = 'unavailable';
  }

  /**
   * The first message of a video part — the screen's, or one of the camera's.
   *
   * The camera is the reason this is not "the first message of the recording": a
   * track may announce a part more than once, because §7.4's unplug closes
   * `webcam.000.mp4` and the reconnect opens `webcam.001.mp4` while the screen
   * carries on writing to its own file.
   *
   * A camera that cannot be opened costs its own track and nothing else, for
   * exactly the reason §7.3 gives for the microphone: the screen is what the user
   * pressed record for. A **screen** part that cannot be opened is the recording
   * failing, and is allowed to throw.
   */
  private async onVideoMeta(active: Active, meta: MetaMsg, track: VideoTrackKey): Promise<void> {
    const state = videoTrack(active, track);
    if (state.done) throw new Error(`the ${track} track is finished and cannot open a part`);
    if (state.part !== null) throw new Error(`${track} already has an open part`);
    if (state.opened.has(meta.part)) {
      throw new Error(`${track} part ${String(meta.part)} has already been recorded`);
    }

    const description = meta.decoderConfig.description;
    if (description === undefined || description.byteLength === 0) {
      throw new Error('the encoder produced no avcC record, so the part could not be described');
    }
    const width = meta.decoderConfig.codedWidth ?? 0;
    const height = meta.decoderConfig.codedHeight ?? 0;
    if (width <= 0 || height <= 0) throw new Error('the encoder reported no coded size');

    const { store } = this.options;
    const file = store.mediaRelativePath(track, meta.part);
    const nominalFps = track === REFERENCE_TRACK ? active.options.fps : active.options.webcamFps;
    if (meta.video !== undefined) {
      // The identity and the timing are kept apart: `facts` is what
      // `recording.json` names the device with, and the epoch offset is arithmetic
      // this track's parts are placed with.
      state.facts = { deviceId: meta.video.deviceId, deviceName: meta.video.deviceName };
      state.epochOffsetUs = meta.video.epochOffsetUs;
    }

    const provisional = withVideoPart(this.requireProvisional(active), {
      track,
      file,
      index: file.replace(/\.mp4$/, '.index.json'),
      codec: meta.decoderConfig.codec,
      size: [width, height],
      requestedFps: nominalFps,
      // The screen genuinely emits only when it changes; a camera delivers at its
      // nominal rate whether or not anything moves (§2.3).
      rateMode: track === REFERENCE_TRACK ? 'variable' : 'constant',
      // A real value rather than a placeholder, so a crash-recovered second part
      // does not claim to start where the first one did. The finalize below
      // replaces it with the measured one.
      startTimeSec: this.provisionalStartSec(active, track, meta),
      ...(state.facts === null ? {} : { facts: state.facts }),
    });
    await store.writeRecordingDoc(active.id, provisional);

    const opened = await store.beginMediaPart(active.id, {
      track,
      part: meta.part,
      width,
      height,
      avcC: description,
      nominalFps,
      colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
    });
    active.provisional = provisional;
    state.part = meta.part;
    state.opened.add(meta.part);
    state.firstPtsUs = null;
    state.lastEndUs = 0;
    if (track !== REFERENCE_TRACK) active.camera = 'live';
    if (opened.file !== file) throw new Error('the part path moved under the recording document');
    this.appendHeldChunks(active, state);
  }

  /**
   * Where a part starts, as well as it can be known before it has recorded
   * anything.
   *
   * The reference track defines the origin, so its parts start at zero by
   * construction. Everything else is placed against that origin with the same
   * §5.4 arithmetic the finalize uses — from the renderer's own first timestamp,
   * which the capture page sends with the announcement precisely so this number
   * exists before the part's first byte does.
   *
   * Zero when there is nothing to measure against yet: the camera can announce
   * itself before the first screen frame arrives, and a first part starting with
   * the recording is what the snap produces anyway.
   */
  private provisionalStartSec(active: Active, track: VideoTrackKey, meta: MetaMsg): number {
    if (track === REFERENCE_TRACK) return 0;
    const origin = active.originUs;
    if (origin === null || meta.video === undefined) return 0;
    return videoPartStartSec({
      firstTimestampUs: meta.video.firstTimestampUs,
      // The screen's own epoch offset is not measured until it reports one, so the
      // origin here is the raw first frame. Both halves are corrected at finalize.
      originUs: origin,
      epochOffsetUs: meta.video.epochOffsetUs,
      referenceStartSec: 0,
    });
  }

  /**
   * The first message of an audio part.
   *
   * Same order as the screen's, for the same reason: the document that describes
   * the part exists before the part does, so a crash can never leave media with
   * nothing describing it. The facts it carries — device, and the voice processing
   * macOS actually applied (research trap 3) — are knowable only here.
   *
   * An audio track that cannot be opened is **not** an error that ends the
   * recording. §7.3 is explicit that losing the microphone leaves screen and system
   * audio recording; the same holds for a track that never starts.
   */
  private async onAudioMeta(active: Active, meta: MetaMsg, track: AudioTrackKey): Promise<void> {
    if (active.audio.has(track)) throw new Error(`${track} already has an open part`);
    const facts = meta.audio;
    const description = meta.decoderConfig.description;
    const sampleRate = meta.decoderConfig.sampleRate ?? 0;
    const channels = meta.decoderConfig.numberOfChannels ?? 0;
    if (facts === undefined || description === undefined || description.byteLength === 0) {
      console.error(`[recorder] ${track} announced no decoder configuration; the track is dropped`);
      return;
    }
    if (sampleRate <= 0 || channels <= 0) {
      console.error(`[recorder] ${track} reported no sample rate or channel count; dropped`);
      return;
    }

    const state: ActiveAudio = {
      part: meta.part,
      held: [],
      open: false,
      facts,
      sampleRate,
      channels,
    };
    active.audio.set(track, state);

    const { store } = this.options;
    try {
      const provisional = withAudioTrack(this.requireProvisional(active), {
        track,
        file: store.mediaRelativePath(track, meta.part),
        codec: meta.decoderConfig.codec,
        sampleRate,
        channels,
        facts,
      });
      await store.writeRecordingDoc(active.id, provisional);
      active.provisional = provisional;

      await store.beginAudioPart(active.id, {
        track,
        part: meta.part,
        sampleRate,
        channels,
        audioSpecificConfig: description,
        bitrate: active.options.audioBitrate,
      });
    } catch (error) {
      if (active.audio.get(track) === state) active.audio.delete(track);
      throw error;
    }

    // The track can be given up on while the part is being created — the writer
    // is two awaits away and {@link onAudioChunk} drops the track if it overruns
    // its held-chunk budget in that window. A part nobody is going to write to is
    // closed rather than left holding a file descriptor into the bundle.
    if (active.audio.get(track) !== state) {
      await store.abortMediaPart(active.id, track).catch((error: unknown) => {
        console.error(`[recorder] closing the abandoned ${track} part failed:`, error);
      });
      return;
    }
    state.open = true;
    this.appendHeldAudio(active, track, state);

    if (facts.violations.length > 0) {
      // Research trap 3. The recording keeps the track — audio the user asked for
      // is worth having even when it is processed — and `recording.json` records
      // the settings that were really applied, so it is diagnosable rather than
      // mysterious. What must not happen is silence about it.
      console.error(
        `[recorder] the ${track} track kept ${facts.violations.join(', ')} despite explicit ` +
          'constraints; anything with music or video in it will sound processed',
      );
    }
  }

  /** The provisional document, which `start` writes before anything else exists. */
  private requireProvisional(active: Active): RecordingDoc {
    const provisional = active.provisional;
    if (provisional === null) throw new Error('the recording has no provisional document');
    return provisional;
  }

  /**
   * One encoded frame.
   *
   * Deliberately not `await`ed: the writer serializes its own appends, so ordering
   * holds, and blocking the IPC handler would build a queue in this process —
   * which is precisely the memory a `SIGKILL` takes. The rejection is not dropped;
   * the first failed write ends the recording.
   *
   * A chunk whose part is not open yet is held rather than discarded — see
   * {@link MAX_HELD_CHUNKS}. The very first chunk of a recording is always one of
   * these, and it is always the keyframe the part has to begin with.
   */
  private onChunk(raw: unknown): void {
    const active = this.active;
    if (active === null) return;
    let chunk: ChunkMsg;
    try {
      chunk = chunkMessage(raw);
    } catch (error) {
      this.failActive(error);
      return;
    }
    if (isAudioTrack(chunk.track)) {
      this.onAudioChunk(active, chunk, chunk.track);
      return;
    }
    this.onVideoChunk(active, chunk, chunk.track);
  }

  /**
   * One encoded video frame, for whichever video track sent it.
   *
   * A chunk whose part is not open yet is held rather than discarded — see
   * {@link MAX_HELD_CHUNKS}. The very first chunk of a part is always one of these,
   * and it is always the keyframe the part has to begin with.
   *
   * Overrunning that budget ends the recording when it is the screen, and costs
   * the camera when it is the camera — the same split §7.3 draws for audio, and
   * the whole of what §7.4 asks for.
   *
   * This is also the one place a chunk's *arrival* can be timed. Every chunk comes
   * through here; `appendHeldChunks` replays into {@link RecorderSession.appendChunk}
   * directly, on the far side of the part-open write, so a reading taken there would
   * be measuring the disk (see {@link Active.originAtUs}).
   */
  private onVideoChunk(active: Active, chunk: ChunkMsg, track: VideoTrackKey): void {
    const state = videoTrack(active, track);
    if (state.done) return;
    if (track === REFERENCE_TRACK && active.originAtUs === null) {
      active.originAtUs = monotonicUs();
    }

    if (state.part === null) {
      if (state.held.length >= MAX_HELD_CHUNKS) {
        const reason = new Error(
          `${String(MAX_HELD_CHUNKS)} ${track} frames arrived before the part could be opened; ` +
            'the capture page never produced a usable decoder configuration',
        );
        if (track === REFERENCE_TRACK) {
          this.failActive(reason);
          return;
        }
        console.error(`[recorder] ${reason.message}; the camera is dropped`);
        state.held = [];
        this.giveUpOnCamera(active);
        return;
      }
      state.held.push(chunk);
      return;
    }
    if (chunk.part !== state.part) return;
    this.appendChunk(active, state, chunk);
  }

  /**
   * A video part that closed while the recording carried on — §7.4's unplug.
   *
   * The part is finalized here rather than at the end of the recording, so the
   * frame index sidecar for everything already captured reaches the disk before the
   * next part opens. Nothing about the screen or the audio tracks changes; that is
   * the entire point.
   *
   * The close is written into `recording.json` in the same breath, because until it
   * is, the document on disk still describes this part as open and running. A crash
   * a minute later would then leave crash recovery unable to tell a camera that
   * ended when the cable moved from a track that lost its tail to the process death
   * — and it truncates the recording to the shortest track it cannot explain.
   */
  private async onPartEnded(raw: unknown): Promise<void> {
    const active = this.active;
    if (active === null) return;
    const message = partEndMessage(raw);
    const state = active.video.get(message.track);
    if (state?.part !== message.part) return;

    try {
      await this.closeVideoPart(active, state, message);
      await this.recordPartClose(active, message.track, state.parts.at(-1));
    } catch (error) {
      if (message.track === REFERENCE_TRACK) throw error;
      console.error('[recorder] closing the camera part failed:', error);
      this.giveUpOnCamera(active);
      return;
    }
    if (message.track !== REFERENCE_TRACK) {
      active.camera = message.endReason === 'device-lost' ? 'lost' : 'unavailable';
      console.log(
        `[recorder] the camera stopped after ${String(state.parts.length)} part(s): ` +
          `${message.endReason ?? 'unknown'}. The screen and audio are still recording.`,
      );
    }
    this.publish();
  }

  /**
   * Write a part's close into the provisional document, mid-recording.
   *
   * Only the facts the writer measured and the reason the part ended — never
   * `startTimeSec`, which is still a difference between two clocks whose second
   * half is not known until the capture page stops (see {@link closeVideoPart}).
   * What this buys is that the document on disk stops describing a finished part as
   * open: `endedEarly` and `endReason: 'device-lost'` are how crash recovery later
   * tells a camera that ended on purpose from a track the crash cut short, and they
   * are facts only the live session has.
   */
  private async recordPartClose(
    active: Active,
    track: VideoTrackKey,
    closed: ClosedVideoPart | undefined,
  ): Promise<void> {
    if (closed === undefined) return;
    const provisional = withClosedVideoPart(this.requireProvisional(active), {
      track,
      part: closed.part,
      durationSec: closed.durationSec,
      frameCount: closed.frameCount,
      observedFps: closed.observedFps,
      endedEarly: closed.endedEarly,
      ...(closed.endReason === undefined ? {} : { endReason: closed.endReason }),
    });
    await this.options.store.writeRecordingDoc(active.id, provisional);
    active.provisional = provisional;
  }

  /**
   * An audio track stopped while the recording was still running (§7.3).
   *
   * **This is where the two situations that used to share a path are separated**, and
   * the separation is the whole of `data/loom-scope/decision-mic-revocation.md`:
   *
   * - A **device that vanished** may come back and is worth waiting for. The
   *   recording carries on with the tracks it still has — §7.4's rule for the camera,
   *   applied to a microphone, which is what §7.3 already asks for.
   * - A **permission the user withdrew** will not come back without their action. The
   *   captain's answer, verbatim: *"stop recording and tell the user to re-grant"*.
   *   So the recording is stopped — through the ordinary {@link stop}, which flushes
   *   the capture page and finalizes the bundle, because everything captured up to
   *   this moment is footage the user keeps and decision 5 deletes raw sources after
   *   an export, so a partial recording discarded here is gone for good.
   *
   * This deliberately diverges from §7.3's own sentence for the microphone — *"keep
   * recording screen and system audio"* — on the captain's authority and on the
   * grounds §7.3 does not consider: the app was reporting the cause wrongly, and a
   * user told "microphone disconnected" about a switch they just flipped has been
   * told the wrong thing about what to do next.
   */
  private onAudioEnded(raw: unknown): void {
    const active = this.active;
    if (active === null) return;
    let message: AudioPartEndMsg;
    try {
      message = audioEndMessage(raw);
    } catch (error) {
      console.error('[recorder] an audio-track end report could not be read:', error);
      return;
    }
    // A track this recording never asked for cannot have lost anything. The renderer
    // chooses the track key, and this message is the only one from a renderer that can
    // end a recording, so a replayed or malformed one must not be able to stop a
    // capture that has no microphone in it. Not `active.audio.has(...)`: a grant
    // withdrawn before the encoder's first frame leaves no track state and is still a
    // revocation.
    if (message.track === 'mic' && active.options.micDeviceId === null) return;
    // The first report is the one taken — it is the one whose TCC read was fresh.
    if (active.audioEnd.has(message.track)) return;

    const grant = AUDIO_TRACK_GRANT[message.track];
    const reason = audioEndReasonFor(
      message.cause,
      grant === null ? true : this.stillGranted(grant),
    );
    active.audioEnd.set(message.track, reason);

    if (
      grant === null ||
      reason !== 'permission-revoked' ||
      !PERMISSIONS[grant].revocationStopsRecording
    ) {
      // §7.3's own rule, unchanged: an audio track that goes away costs its own track
      // and nothing else. The screen is what the user pressed record for.
      console.log(
        `[recorder] the ${message.track} track stopped (${reason}): ` +
          `${message.detail ?? 'no detail'}. The screen is still recording.`,
      );
      return;
    }

    this.revoked = {
      kind: grant,
      recordingId: active.id,
      recordedSec: this.elapsedSec(),
    };
    console.error(
      `[recorder] ${PERMISSIONS[grant].title} was revoked during the recording. ` +
        PERMISSIONS[grant].whenRevokedMidRecording,
    );
    this.publish();
    // The ordinary stop, on the ordinary queue: the capture page is told to stop,
    // every encoder flushes what it holds, and the bundle finalizes to `editable`
    // with the media it has. Nothing here discards anything.
    void this.enqueue(() => this.stop()).catch((error: unknown) => {
      console.error('[recorder] stopping after a revoked permission failed:', error);
    });
  }

  /**
   * Whether macOS still grants us one of the media permissions, **right now**.
   *
   * A method rather than a direct call so the one place that reads a grant mid-
   * recording is named, and so a test can drive both branches without a TCC database
   * — the same reason `endReasonFor` takes its answer as an argument.
   */
  private stillGranted(kind: PermissionKind): boolean {
    if (kind === 'accessibility') return readAxTrusted();
    return readMediaStatus(kind) === 'granted';
  }

  /**
   * The capture page could not capture the camera at all (§7.4).
   *
   * The one camera state main cannot derive from its own parts: a `getUserMedia`
   * that was refused, an encoder the machine does not have, a cable that flapped
   * past the capture page's part budget. None of them produce a part, so without
   * this the HUD would sit on `starting` for the rest of the recording and the
   * banner §7.4 step 3 exists for would never appear.
   *
   * The track is *not* marked done here: what a renderer says about a device is
   * news, not authority, and a part that does turn up afterwards is still footage
   * the user keeps.
   */
  private onCameraUnavailable(reason: string): void {
    const active = this.active;
    if (active === null || active.camera === 'off') return;
    console.error(`[recorder] ${reason}. The screen and audio are still recording.`);
    active.camera = 'unavailable';
    this.publish();
  }

  /**
   * Close one open video part, keeping the numbers its `startTimeSec` is made of.
   *
   * The start time itself is **not** computed here, and that is deliberate. It is a
   * difference between two clocks, and one of the two — the reference track's own
   * epoch offset — is not known until the capture page stops and reports it. A part
   * closed in the middle of a recording, which is exactly what §7.4's unplug
   * produces, would therefore be placed against half an origin. So the raw inputs
   * are kept and every part of the recording is placed at once, in
   * {@link finalizedVideo}, when both halves are in hand.
   *
   * Everything else comes from the writer, which counted the frames it actually
   * wrote and knows how long the last frame of a variable-rate track had to stand
   * for.
   */
  private async closeVideoPart(
    active: Active,
    state: ActiveVideo,
    report: VideoPartReport | null,
  ): Promise<void> {
    const part = state.part;
    if (part === null) return;
    state.part = null;

    const written = await this.options.store.finalizeMediaPart(
      active.id,
      state.track,
      report?.endedAtUs ?? undefined,
    );
    state.droppedFrames += report?.framesDropped ?? 0;
    if (report?.facts !== undefined) state.facts = report.facts;

    const endReason = report?.endReason;
    state.parts.push({
      part,
      // The renderer's own first timestamp when it sent one; otherwise the first
      // chunk main saw, which is the same frame observed one hop later.
      firstPtsUs: report?.firstTimestampUs ?? state.firstPtsUs,
      epochOffsetUs: report?.epochOffsetUs ?? 0,
      durationSec: written.durationSec,
      frameCount: written.frameCount,
      observedFps: written.observedFps,
      endedEarly: report?.endedEarly ?? true,
      ...(endReason === undefined ? {} : { endReason }),
    });
    state.firstPtsUs = null;
    state.lastEndUs = 0;
  }

  /**
   * Close whatever video part each track still has open when capture stops.
   *
   * The screen's end reason comes from how the capture ended — a source that ended
   * on its own is not a normal stop (§7.3). The camera's comes from its own entry
   * in the report, because a camera can have been unplugged while the screen went
   * on recording perfectly well, which is the whole of §7.4.
   *
   * A failure to close one track never stops the others from closing: an open file
   * descriptor into the bundle is worse than a part described from what the writer
   * managed to flush.
   */
  private async finalizeVideo(active: Active, report: CaptureEndReport | null): Promise<void> {
    // The grant is read *now*, not at start: §7.3's whole point is that it may have
    // gone away during the recording, and the answer is only meaningful at the moment
    // the source ended.
    const screenEnd = endReasonFor(
      report,
      readMediaStatus('screen') === 'granted',
      active.stopReason,
    );
    for (const track of VIDEO_TRACK_KEYS) {
      const state = active.video.get(track);
      if (state?.part == null) continue;
      const reported = report?.video?.find(
        (entry) => entry.track === track && entry.part === state.part,
      );
      const fallback: VideoPartReport = {
        track,
        part: state.part,
        firstTimestampUs: state.firstPtsUs,
        lastTimestampUs: state.lastEndUs > 0 ? state.lastEndUs : null,
        endedAtUs: track === REFERENCE_TRACK ? (report?.endedAtUs ?? null) : null,
        // The offset this track announced itself with, never zero: `firstPtsUs` is
        // on the track's own epoch, and a camera's is this machine's uptime.
        epochOffsetUs: state.epochOffsetUs,
        framesEncoded: 0,
        framesDropped: track === REFERENCE_TRACK ? (report?.framesDropped ?? 0) : 0,
        endedEarly: screenEnd !== null,
        ...(screenEnd === null ? {} : { endReason: screenEnd }),
      };
      // The reported entry carries the renderer's own timestamps and drop count;
      // the fallback is what a capture page that died before answering leaves us.
      const closing: VideoPartReport =
        reported === undefined
          ? fallback
          : {
              ...reported,
              // A camera that was still open when the user pressed stop ended for
              // the same reason the recording did, not for one of its own.
              endedEarly: reported.endedEarly || screenEnd !== null,
              ...(reported.endReason !== undefined
                ? { endReason: reported.endReason }
                : screenEnd === null
                  ? {}
                  : { endReason: screenEnd }),
            };
      try {
        await this.closeVideoPart(active, state, closing);
      } catch (error) {
        console.error(`[recorder] finalizing the ${track} part failed:`, error);
        state.part = null;
      }
    }
  }

  /**
   * Every video track's parts, placed on the recording clock (§5.4, §2.3).
   *
   * One moment, with everything known: the reference track's first frame and its
   * epoch offset make the origin, and each part's own first frame and offset make
   * its `startTimeSec`. The reference track's parts start at zero by construction —
   * the origin *is* its first frame.
   *
   * A camera part that starts within one audio buffer of the origin is snapped onto
   * it and one that starts two minutes later is not, which is what makes the gap a
   * camera unplug leaves survive into `recording.json` instead of being closed up.
   */
  private finalizedVideo(active: Active): {
    screen: FinalizedVideoTrackFacts;
    webcam?: FinalizedVideoTrackFacts;
  } {
    const originUs = (active.originUs ?? 0) + (active.end?.epochOffsetUs ?? 0);
    const out: Partial<Record<VideoTrackKey, FinalizedVideoTrackFacts>> = {};
    for (const track of VIDEO_TRACK_KEYS) {
      const state = active.video.get(track);
      if (state === undefined) continue;
      out[track] = {
        droppedFrames: state.droppedFrames,
        parts: state.parts.map((closed): FinalizedVideoPartFacts => {
          const { firstPtsUs, epochOffsetUs, ...rest } = closed;
          return {
            ...rest,
            startTimeSec:
              track === REFERENCE_TRACK || firstPtsUs === null || active.originUs === null
                ? 0
                : videoPartStartSec({
                    firstTimestampUs: firstPtsUs,
                    originUs,
                    epochOffsetUs,
                    referenceStartSec: 0,
                  }),
          };
        }),
      };
    }
    return {
      screen: out.screen ?? { parts: [], droppedFrames: 0 },
      ...(out.webcam === undefined ? {} : { webcam: out.webcam }),
    };
  }

  /**
   * One encoded AAC frame.
   *
   * The audio counterpart of {@link onChunk}, and separate from it in one way that
   * matters: a failed audio write does **not** end the recording. The screen is
   * what the user pressed record for, and a microphone that fills the disk or a
   * device that vanishes mid-write costs its own track and nothing else (§7.3).
   */
  private onAudioChunk(active: Active, chunk: ChunkMsg, track: AudioTrackKey): void {
    const state = active.audio.get(track);
    if (state === undefined) return;
    if (chunk.part !== state.part) return;

    if (!state.open) {
      if (state.held.length >= MAX_HELD_CHUNKS) {
        // The track is given up on rather than continued from here. The frames
        // that were held are counted by the meter in the capture renderer, which
        // is what produces `startTimeSec`, `durationSec` and `measuredSampleRate`
        // — so writing the rest would describe samples the `.m4a` does not
        // contain and shift everything in it earlier, with no gap to explain it.
        // §7.3: that costs this track and nothing else.
        console.error(
          `[recorder] ${track} produced ${MAX_HELD_CHUNKS} frames faster than its part could ` +
            'be opened; the track is dropped rather than written out of sync',
        );
        state.held = [];
        active.audio.delete(track);
        return;
      }
      state.held.push(chunk);
      return;
    }
    this.appendAudioChunk(active, track, chunk);
  }

  private appendAudioChunk(active: Active, track: AudioTrackKey, chunk: ChunkMsg): void {
    // The audio tracks are ~2 MB/min of §5.6's 76, but they are bytes on the same
    // volume and the estimate is about the volume. See {@link Active.bytesWritten}.
    active.bytesWritten += chunk.data.byteLength;
    void this.options.store
      .appendMediaChunk(active.id, track, {
        data: chunk.data,
        isKey: true,
        timestampUs: chunk.timestampUs,
        durationUs: chunk.durationUs,
      })
      .catch((error: unknown) => {
        console.error(`[recorder] writing the ${track} track failed:`, error);
      });
  }

  /** Write whatever arrived while `beginAudioPart` was resolving, in arrival order. */
  private appendHeldAudio(active: Active, track: AudioTrackKey, state: ActiveAudio): void {
    const held = state.held;
    state.held = [];
    for (const chunk of held) this.appendAudioChunk(active, track, chunk);
  }

  /**
   * Close every audio part and turn its measurements into `recording.json` fields.
   *
   * The measurements come from the capture page's report and are **not**
   * recomputed here: `measuredSampleRate` and `gaps` can only be read from the raw
   * buffer stream, and by the time bytes reach this process the encoder has
   * removed the evidence (§5.5, §5.4.5). What main does is place them on the
   * recording clock, whose origin is the first screen frame.
   */
  private async finalizeAudio(
    active: Active,
    report: CaptureEndReport | null,
  ): Promise<Partial<Record<AudioTrackKey, FinalizedAudioFacts>>> {
    const out: Partial<Record<AudioTrackKey, FinalizedAudioFacts>> = {};
    for (const track of AUDIO_TRACK_KEYS) {
      const state = active.audio.get(track);
      if (state?.open !== true) continue;
      let written: FinalizedAudioPart | null = null;
      try {
        written = await this.options.store.finalizeAudioPart(active.id, track);
      } catch (error) {
        console.error(`[recorder] finalizing the ${track} part failed:`, error);
      }

      const measured = report?.audio?.find((entry) => entry.track === track);
      if (measured !== undefined) {
        out[track] = this.alignedAudio(
          active,
          measured,
          report?.epochOffsetUs ?? 0,
          this.audioEndReason(active, track, measured.endedEarly),
        );
        continue;
      }
      const fromBytes = writtenAudio(state, written);
      if (fromBytes === null) {
        console.warn(`[recorder] ${track} produced no media and no measurements`);
        continue;
      }
      console.warn(
        `[recorder] ${track} produced media but no measurements; it is described from the ` +
          'bytes that were written, at the nominal rate and starting with the screen',
      );
      // A track classified while it was stopping keeps that answer on this branch
      // too: it came from a live TCC read at the moment the track ended, and a
      // missing end report says nothing about why the track went. `writtenAudio`'s
      // `crash` is for the tracks nobody has an answer for (see {@link Active.audioEnd}).
      const decided = active.audioEnd.get(track);
      out[track] = decided === undefined ? fromBytes : { ...fromBytes, endReason: decided };
    }
    return out;
  }

  /**
   * One track's measurements, placed on the recording clock (§5.4, §5.5).
   *
   * Both timestamps are moved onto the shared arrival clock first. They are not on
   * one clock to begin with: Chromium stamps captured audio and captured video
   * against different epochs, measured on this machine as video from zero and audio
   * from the system's uptime. `TrackEpochEstimator` is what relates them, and
   * without it `startTimeSec` is a subtraction of two unrelated numbers.
   */
  /**
   * Why one audio track ended early — the field the capture page deliberately does
   * not fill in.
   *
   * The answer decided while it was happening wins, because that is the only moment
   * TCC's answer was about the event (see {@link Active.audioEnd}). Failing that, a
   * track that ended early with no report is classified here on a fresh read — the
   * same arrangement `endReasonFor` uses for the screen, and for the same reason: a
   * grant withdrawn in the last seconds of a recording is a real case, and a stale
   * guess written into `recording.json` is worse than a late measurement.
   */
  private audioEndReason(
    active: Active,
    track: AudioTrackKey,
    endedEarly: boolean,
  ): PartEndReason | undefined {
    const decided = active.audioEnd.get(track);
    if (decided !== undefined) return decided;
    if (!endedEarly) return undefined;
    const grant = AUDIO_TRACK_GRANT[track];
    return audioEndReasonFor('track-ended', grant === null ? true : this.stillGranted(grant));
  }

  private alignedAudio(
    active: Active,
    measured: AudioTrackReport,
    videoEpochOffsetUs: number,
    endReason: PartEndReason | undefined,
  ): FinalizedAudioFacts {
    const timing = alignAudioPart(measured.summary, {
      // `clock.t0Us` is the first screen frame; every other track's start is an
      // offset from it. With no screen frame there is nothing to be offset from,
      // and the track starts the recording.
      originUs:
        active.originUs === null
          ? (measured.summary.firstTimestampUs ?? 0) + measured.epochOffsetUs
          : active.originUs + videoEpochOffsetUs,
      epochOffsetUs: measured.epochOffsetUs,
      referenceStartSec: 0,
    });
    this.reportAudioTiming(measured, timing.startTimeSec, timing.durationSec);
    return {
      timing,
      endedEarly: measured.endedEarly,
      ...(endReason === undefined ? {} : { endReason }),
    };
  }

  /**
   * Say what a track's clock did, in the log, every time.
   *
   * §10.1 asks for cumulative measured-vs-nominal drift to be logged during
   * capture "so we can see it in the field before a user reports it". This is that
   * line. The offset check beside it guards the one assumption underneath all of
   * this: that `VideoFrame.timestamp` and the audio timestamps share an origin. A
   * track that claims to start seconds away from the screen has not found a
   * genuinely late device; it has found that assumption to be wrong, and it says so
   * rather than quietly writing a number the exporter will act on.
   */
  private reportAudioTiming(
    measured: AudioTrackReport,
    startTimeSec: number,
    durationSec: number,
  ): void {
    const summary = measured.summary;
    const drift = driftSec(
      { sampleRate: summary.nominalSampleRate, measuredSampleRate: summary.measuredSampleRate },
      durationSec,
    );
    console.log(
      `[recorder] ${measured.track}: start ${startTimeSec.toFixed(4)}s, ` +
        `${durationSec.toFixed(3)}s, measured ${summary.measuredSampleRate.toFixed(2)} Hz ` +
        `against a nominal ${summary.nominalSampleRate} ` +
        `(${(drift * 1000).toFixed(1)} ms of drift over the recording), ` +
        `${summary.gaps.length} gap(s)`,
    );
    if (Math.abs(startTimeSec) > MAX_PLAUSIBLE_TRACK_OFFSET_SEC) {
      console.error(
        `[recorder] ${measured.track} claims to start ${startTimeSec.toFixed(3)}s from the first ` +
          'screen frame. Two capture tracks should start within a frame or two of each other, so ' +
          'this most likely means the audio and video capture clocks do not share an origin on ' +
          'this machine. The measured value is recorded rather than corrected; see the ' +
          'carried-forward obligations in AGENTS.md.',
      );
    }
  }

  /** Write, in arrival order, whatever came in while `beginMediaPart` was resolving. */
  private appendHeldChunks(active: Active, state: ActiveVideo): void {
    const held = state.held;
    state.held = [];
    for (const chunk of held) {
      if (chunk.part === state.part) this.appendChunk(active, state, chunk);
    }
  }

  /**
   * Write one encoded frame to the part its track has open.
   *
   * A failed write ends the recording when it is the screen's, and costs the camera
   * when it is the camera's (§7.4). Neither is awaited: the writer serializes its
   * own appends, and blocking the IPC handler would build a queue in this process,
   * which is precisely the memory a `SIGKILL` takes.
   */
  private appendChunk(active: Active, state: ActiveVideo, chunk: ChunkMsg): void {
    // Counted here, at the seam, because §7.2's capacity estimate wants what this
    // recording is costing per second and this is where that cost is handed over.
    // See {@link Active.bytesWritten}.
    active.bytesWritten += chunk.data.byteLength;
    state.firstPtsUs ??= chunk.timestampUs;
    state.lastEndUs = chunk.timestampUs + (chunk.durationUs ?? 0);
    state.lastArrivalMs = monotonicMs();
    // The recording clock's origin is the reference track's first frame, and this
    // is where it is learned (§5.4 mechanism 2). It is also the instant the cursor
    // log has to be measured from, so it is where sampling begins — see
    // {@link RecorderSession.beginSampling}. What that instant *was*, on this
    // process's clock, was stamped when the frame arrived rather than here: the
    // first screen chunk always reaches this line by way of `appendHeldChunks`,
    // which runs after the part-open write (see {@link Active.originAtUs}).
    if (state.track === REFERENCE_TRACK && active.originUs === null) {
      active.originUs = chunk.timestampUs;
      // Guarded, not merely careful. Everything below this line is the capture
      // spine, and sampling is an accessory to it: the recording is what the user
      // pressed record for, and no defect in the pointer log — not even a
      // synchronous throw before the first `await` — may reach it.
      try {
        this.beginSampling(active, active.originAtUs ?? monotonicUs());
      } catch (error) {
        console.error('[recorder] the input sampler could not be started:', error);
      }
    }

    void this.options.store
      .appendMediaChunk(active.id, state.track, {
        data: chunk.data,
        isKey: chunk.kind === 'key',
        timestampUs: chunk.timestampUs,
        durationUs: chunk.durationUs,
      })
      .catch((error: unknown) => {
        if (state.track === REFERENCE_TRACK) {
          this.failActive(error);
          return;
        }
        console.error('[recorder] writing the camera track failed:', error);
        this.giveUpOnCamera(active);
      });
  }

  private onEnded(report: CaptureEndReport): void {
    const active = this.active;
    // The drop counts are not applied here: `closeVideoPart` takes each track's
    // from the report entry that closes its part, and adding them in both places
    // would count every dropped frame twice.
    if (active !== null) active.end = report;
    const waiters = this.endWaiters;
    this.endWaiters = [];
    for (const waiter of waiters) waiter(report);

    // Nobody asked for this stop: the source ended on its own, or the renderer
    // failed. Finalize what exists rather than waiting for a stop that is not
    // coming (§7.3).
    if (this.phase === 'recording') {
      this.phase = 'finalizing';
      void this.enqueue(() => this.finalize(report)).catch((error: unknown) => {
        console.error('[recorder] finalizing after an unsolicited end failed:', error);
      });
    }
  }

  /**
   * Hand the capture page a screen source, or refuse.
   *
   * Refusing is the default. A `getDisplayMedia` call from any window other than
   * the one we just told to start recording gets nothing — the capture page is the
   * only window in this app that has any business holding a screen stream.
   */
  private provideSource(
    frameUrl: string | null,
    callback: (streams: Electron.Streams) => void,
  ): void {
    const wanted = this.sourceWanted;
    const capture = this.options.windows.get('capture');
    const expected = capture?.webContents.getURL();
    if (
      wanted === null ||
      frameUrl === null ||
      capture === undefined ||
      expected === undefined ||
      frameUrl !== expected
    ) {
      callback({});
      return;
    }
    this.sourceWanted = null;

    desktopCapturer
      .getSources({ types: ['screen'], fetchWindowIcons: false })
      .then((sources) => {
        const wantedId = wanted.displayId ?? screen.getPrimaryDisplay().id;
        const source = sources.find((s) => s.display_id === String(wantedId)) ?? sources[0] ?? null;
        if (source === null) {
          callback({});
          return;
        }
        // `'loopback'` is what makes system audio work with no driver, no
        // installer and no admin prompt — the reason the macOS floor is 14
        // (`decision-macos-floor.md`, research report §5.2). Not
        // `'loopbackWithMute'`: muting the speakers while recording them would
        // mean the user cannot hear what they are demonstrating.
        callback(wanted.systemAudio ? { video: source, audio: 'loopback' } : { video: source });
      })
      .catch((error: unknown) => {
        console.error('[recorder] enumerating screen sources failed:', error);
        callback({});
      });
  }

  // -------------------------------------------------------------------- status

  /**
   * What the HUD is seeing right now.
   *
   * Public because more than one thing needs to observe a recording without owning
   * a window: the phase 2 verification harness drives a real recording from inside
   * the packaged app and has no renderer to receive a push. It is the *same* object
   * {@link publish} sends, so an observer and the HUD cannot disagree.
   */
  status(): RecorderStatus {
    const active = this.active;
    const webcam = active?.video.get('webcam');
    return {
      phase: this.phase,
      recordingId: active?.id ?? null,
      elapsedSec: this.elapsedSec(),
      frameCount:
        active === null ? 0 : this.options.store.mediaFrameCount(active.id, REFERENCE_TRACK),
      droppedFrames: [...(active?.video.values() ?? [])].reduce(
        (sum, state) => sum + state.droppedFrames,
        0,
      ),
      error: this.lastError,
      camera: active?.camera ?? 'off',
      // Parts closed, plus the one open. The HUD shows this so a recording that
      // survived an unplug says so while it is still going.
      cameraParts: webcam === undefined ? 0 : webcam.parts.length + (webcam.part === null ? 0 : 1),
      // Not derived from `active`: the notice has to survive the recording it stopped,
      // because that is when the user reads it. See {@link RecorderSession.revoked}.
      revoked: this.revoked,
      // §7.2. The reading the monitor last took and the recorder itself acted on —
      // one number, so the banner cannot describe a different volume from the stop.
      disk: this.lastDisk,
      diskStop: this.diskStop,
    };
  }

  private publish(): void {
    const status = this.status();
    for (const window of this.options.windows.all()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNEL.recorderStatus, status);
    }
  }

  /**
   * Media time, not wall clock — a stalled capture shows a stalled timer.
   *
   * Measured on the reference track, whose first frame is the recording clock's
   * origin. A camera that comes and goes does not move the elapsed time.
   */
  private elapsedSec(): number {
    return this.active === null ? 0 : this.elapsedFor(this.active);
  }

  /**
   * The same number for a recording that is no longer {@link RecorderSession.active}.
   *
   * `finalize` clears `active` before it does anything else, and §7.2's stop notice
   * has to say how much was saved — which is a fact about the recording that just
   * ended, read from the recording that just ended.
   */
  private elapsedFor(active: Active): number {
    const state = active.video.get(REFERENCE_TRACK);
    if (state?.firstPtsUs == null) return 0;
    return Math.max(0, (state.lastEndUs - state.firstPtsUs) / 1_000_000);
  }

  // ---------------------------------------------------------------- disk (§7.2)

  /**
   * One reading, taken outside the monitor. Used by {@link start}'s refusal.
   *
   * Never throws, for the reason the monitor never does: a volume this process
   * could not measure must not be the thing that stops a user recording. It comes
   * back `unknown`, and every predicate over that answers "no".
   *
   * **And never waits for ever**, for the same reason and through the same function:
   * a `statfs` that does not return would otherwise wedge the Record button with no
   * recording, no message and nothing on screen that says why.
   */
  private async readDisk(): Promise<DiskReading> {
    try {
      const space = await readSpaceBeforeDeadline(
        () => this.diskRead.read(),
        diskReadDeadlineMs(this.options.diskIntervalMs),
      );
      return classifyDisk(space, this.captureRate());
    } catch (error) {
      console.error('[recorder] free space could not be read:', error);
      return classifyDisk(null, this.captureRate());
    }
  }

  /**
   * What a second of recording is costing right now, measured where it can be.
   *
   * The bytes are this recording's own — counted at the store seam as they are
   * handed over — against its own media seconds, so the estimate follows the content
   * rather than a figure from somebody else's screen. §5.6 measured a 35× spread
   * between an idle desktop and full-screen animation, which is the whole reason
   * this is measured at all rather than read from
   * {@link REFERENCE_CAPTURE_RATE_BYTES_PER_SEC}.
   *
   * Below {@link MEASURED_RATE_FLOOR_SEC} there is nothing honest to divide, and the
   * question falls to **the user's own library** — {@link libraryRate}, resolved once
   * at {@link start}. §5.6's 35× spread is the argument for that too: a machine whose
   * recordings have averaged 4 MB/min would otherwise be told about somebody else's
   * screen for the first two seconds of every recording, and then watch the estimate
   * jump by an order of magnitude. {@link REFERENCE_RATE} is reached only where
   * neither has anything to say — a first run — and `CaptureRate.source` is what
   * stops any of the three from being reported as the wrong one.
   */
  private captureRate(): CaptureRate {
    const active = this.active;
    const seconds = this.elapsedSec();
    if (active === null || seconds < MEASURED_RATE_FLOOR_SEC || active.bytesWritten <= 0) {
      return this.libraryRate ?? REFERENCE_RATE;
    }
    return { bytesPerSec: active.bytesWritten / seconds, source: 'measured', sampleCount: 1 };
  }

  /**
   * The library walk, off the start path. Never awaited, never able to throw.
   *
   * A walk that could not answer — because it errored, or because it hung and hit
   * {@link LIBRARY_RATE_DEADLINE_MS} — leaves whatever the last one measured, which
   * is still a reading of this user's own library. Only a process that has never had
   * one falls to {@link REFERENCE_RATE}.
   */
  private async measureLibrary(): Promise<void> {
    const rate = await measureLibraryRate(this.options.store, LIBRARY_RATE_DEADLINE_MS);
    if (rate !== null) this.libraryRate = rate;
  }

  /**
   * §7.2's clean stop: *"Stopping at 1 GB with a good file beats hitting `ENOSPC`
   * with a half-written fragment."*
   *
   * It is the **ordinary** `stop()`, and that is the whole design. The capture page
   * flushes, every open part is finalized from the end report, the frame index is
   * written and the bundle reaches `editable` with everything captured up to this
   * instant in it — which is what makes the resulting file playable, and is the
   * property §7.2's acceptance criterion is about. Anything more abrupt would be the
   * half-written fragment this exists to avoid, arrived at deliberately.
   *
   * `stopReason` is set **before** the stop rather than worked out during the
   * finalize, because the capture page reports a perfectly ordinary
   * `reason: 'stopped'` — it was told to stop and does not know why. This is the one
   * thing that tells `endReasonFor` the difference, and it is what finally produces
   * `PartEndReason`'s `disk-full`.
   *
   * Queued on `chain` like every other lifecycle transition, so a monitor tick that
   * lands while the user is already stopping cannot run two finalizes.
   */
  private stopForFullDisk(reading: DiskReading): void {
    const active = this.active;
    if (active === null || this.phase !== 'recording') return;
    this.lastDisk = reading;
    active.stopReason = 'disk-full';
    console.log(
      `[recorder] stopping: ${String(reading.space?.freeBytes ?? 0)} bytes free, below ` +
        String(DISK_THRESHOLDS.stopBytes),
    );
    void this.enqueue(() => this.stop()).catch((error: unknown) => {
      console.error('[recorder] the disk-full stop failed:', error);
    });
  }

  private startStatusTimer(): void {
    this.stopStatusTimer();
    this.statusTimer = setInterval(() => {
      this.publish();
    }, this.options.statusIntervalMs);
    this.statusTimer.unref?.();
  }

  private stopStatusTimer(): void {
    if (this.statusTimer === null) return;
    clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  // ------------------------------------------------------------------ plumbing

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private awaitEnd(timeoutMs: number): Promise<CaptureEndReport | null> {
    if (this.active?.end != null) return Promise.resolve(this.active.end);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.endWaiters = this.endWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const waiter = (report: CaptureEndReport): void => {
        clearTimeout(timer);
        resolve(report);
      };
      this.endWaiters.push(waiter);
    });
  }

  private async readyCaptureWindow(): Promise<BrowserWindow> {
    const window = this.options.windows.show('capture');
    const contents = window.webContents;
    if (!contents.isLoadingMainFrame()) return window;
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error): void => {
        contents.off('did-finish-load', onLoad);
        contents.off('did-fail-load', onFail);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onLoad = (): void => {
        settle();
      };
      const onFail = (_event: unknown, code: number, description: string): void => {
        settle(new Error(`the capture page failed to load: ${description} (${String(code)})`));
      };
      contents.on('did-finish-load', onLoad);
      contents.on('did-fail-load', onFail);
    });
    return window;
  }

  private fromCaptureWindow(event: IpcMainEvent): boolean {
    const sender: WebContents = event.sender;
    if (this.captureContentsId !== null && sender.id === this.captureContentsId) return true;
    const capture = this.options.windows.get('capture');
    return capture !== undefined && !capture.isDestroyed() && capture.webContents.id === sender.id;
  }

  /**
   * Refuse a recording command from a window that has no business driving one.
   *
   * Same rule as {@link fromCaptureWindow}, and for the same reason: the preload
   * hands `window.loom` to every window, so a capability is only ever as narrow as
   * main makes it against the sender.
   */
  private requireRecorderWindow(event: IpcMainInvokeEvent): void {
    const window = BrowserWindow.fromWebContents(event.sender);
    const role = window === null ? undefined : this.options.windows.roleOf(window);
    if (role === undefined || !RECORDER_ROLES.includes(role)) {
      throw new Error('this window may not drive a recording');
    }
  }

  /** The first write that fails ends the recording; later ones are already covered. */
  private failActive(error: unknown): void {
    const active = this.active;
    if (active?.writeError !== null) return;
    active.writeError = error instanceof Error ? error : new Error(message(error));
    console.error('[recorder] the capture path failed:', error);
    const screen = active.video.get(REFERENCE_TRACK);
    this.onEnded({
      reason: 'error',
      endedAtUs: screen !== undefined && screen.lastEndUs > 0 ? screen.lastEndUs : null,
      framesEncoded: 0,
      framesDropped: screen?.droppedFrames ?? 0,
      message: active.writeError.message,
    });
  }

  private displayInfo(displayId: number | null): DisplayInfo {
    const display =
      (displayId === null ? undefined : screen.getAllDisplays().find((d) => d.id === displayId)) ??
      screen.getPrimaryDisplay();
    return {
      id: display.id,
      name: display.label,
      logicalSize: [display.size.width, display.size.height],
      pixelSize: [
        Math.round(display.size.width * display.scaleFactor),
        Math.round(display.size.height * display.scaleFactor),
      ],
      scaleFactor: display.scaleFactor,
      colorSpace: display.colorSpace,
    };
  }

  /**
   * What TCC says right now.
   *
   * Recorded rather than assumed: a recording made without Screen Recording
   * granted is black frames, and "the permissions at capture time" is the first
   * thing anyone diagnosing that needs. Phase 2 owns requesting them.
   */
  private permissions(): {
    screen: PermissionState;
    camera: PermissionState;
    microphone: PermissionState;
    accessibility: boolean;
  } {
    return {
      // Read through `@loom/permissions` rather than cast: Electron can return
      // `unknown`, which `PermissionState` has no member for, and casting it wrote a
      // value into the user's recording that the type says cannot be there.
      screen: toRecordingState(readMediaStatus('screen')),
      camera: toRecordingState(readMediaStatus('camera')),
      microphone: toRecordingState(readMediaStatus('microphone')),
      accessibility: readAxTrusted(),
    };
  }
}

/**
 * This track's state, created on first mention and **registered immediately**.
 *
 * Registered before any caller can await, and that is the whole point of the
 * function. Opening a part is two awaits long, and frames keep arriving across
 * them — that is precisely why {@link MAX_HELD_CHUNKS} exists. If the announcement
 * and the chunk path could each create their own state, the announcement would
 * finish by publishing a state whose held-chunk buffer is empty, silently
 * discarding every frame that arrived while the file was being created. That is a
 * second of footage per part, gone with no error anywhere: the recording just
 * begins late.
 */
function videoTrack(active: Active, track: VideoTrackKey): ActiveVideo {
  const existing = active.video.get(track);
  if (existing !== undefined) return existing;
  const state: ActiveVideo = {
    track,
    part: null,
    held: [],
    firstPtsUs: null,
    lastEndUs: 0,
    lastArrivalMs: 0,
    parts: [],
    opened: new Set(),
    facts: null,
    epochOffsetUs: 0,
    droppedFrames: 0,
    done: false,
  };
  active.video.set(track, state);
  return state;
}

// ------------------------------------------------------- untrusted-input checks

/**
 * Everything below shape-checks a message from a renderer.
 *
 * Our own code sends these, which is exactly why they are checked: the renderer is
 * the process most likely to be compromised, and it is the one that must never be
 * able to name a path, an unbounded allocation, or a track it is not recording.
 *
 * `CaptureOptions` is checked by `requestedCaptureOptions` in `@loom/ipc` rather than
 * here: `recorder.start` is not the only handler taking that shape —
 * `recorder.preflight` takes it too — and one sanitizer beside the contract is the
 * only arrangement in which a second handler cannot quietly read the message laxly.
 */

/** A `PartEndReason`, or `undefined` when the value is not one. */
function partEndReason(value: unknown): PartEndReason | undefined {
  return value === 'device-lost' ||
    value === 'permission-revoked' ||
    value === 'disk-full' ||
    value === 'crash'
    ? value
    : undefined;
}

function videoTrackKey(value: unknown): VideoTrackKey {
  if (typeof value !== 'string' || !isVideoTrack(value as never)) {
    throw new Error(`track must be one of ${VIDEO_TRACK_KEYS.join(' | ')}`);
  }
  return value as VideoTrackKey;
}

function videoFacts(raw: unknown): VideoTrackFacts | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  return {
    deviceId: shortString(input['deviceId'], MAX_DEVICE_ID_LENGTH),
    deviceName: shortString(input['deviceName']),
  };
}

/**
 * One video part's timing, shape-checked like every other renderer message.
 *
 * These numbers decide where a part sits on the recording clock, so a malformed
 * one is refused rather than written: a `startTimeSec` derived from `NaN` is a
 * camera track no later phase can place against the screen.
 */
function partEndMessage(raw: unknown): PartEndMsg {
  if (raw === null || typeof raw !== 'object') throw new Error('partEnded must be an object');
  const input = raw as Record<string, unknown>;
  const facts = videoFacts(input['facts']);
  const reason = partEndReason(input['endReason']);
  return {
    track: videoTrackKey(input['track']),
    part: requirePart(input['part']),
    ...(facts === undefined ? {} : { facts }),
    firstTimestampUs: stamp(input['firstTimestampUs']),
    lastTimestampUs: stamp(input['lastTimestampUs']),
    endedAtUs: stamp(input['endedAtUs']),
    epochOffsetUs: finite(input['epochOffsetUs']),
    framesEncoded: Math.max(0, finite(input['framesEncoded'])),
    framesDropped: Math.max(0, finite(input['framesDropped'])),
    endedEarly: input['endedEarly'] === true,
    ...(reason === undefined ? {} : { endReason: reason }),
  };
}

/**
 * An audio track's mid-recording end, shape-checked like every other renderer
 * message.
 *
 * A malformed one is refused rather than acted on: this message can stop a
 * recording, which makes it the only capture-page message with that power, and a
 * `cause` nobody sent must never be read as `track-ended`.
 */
function audioEndMessage(raw: unknown): AudioPartEndMsg {
  if (raw === null || typeof raw !== 'object') throw new Error('audioEnded must be an object');
  const input = raw as Record<string, unknown>;
  const track = input['track'];
  if (track !== 'mic' && track !== 'system') {
    throw new Error(`track must be one of ${AUDIO_TRACK_KEYS.join(' | ')}`);
  }
  const cause = input['cause'];
  if (cause !== 'track-ended' && cause !== 'encoder-failed') {
    throw new Error("cause must be 'track-ended' or 'encoder-failed'");
  }
  const detail = shortString(input['detail'], 500);
  return {
    track,
    part: requirePart(input['part']),
    cause,
    ...(detail === null ? {} : { detail }),
  };
}

/** Every video part still open when capture stopped, shape-checked. */
function videoReports(raw: unknown): VideoPartReport[] {
  if (!Array.isArray(raw)) return [];
  const reports: VideoPartReport[] = [];
  for (const entry of raw.slice(0, VIDEO_TRACK_KEYS.length)) {
    try {
      reports.push(partEndMessage(entry));
    } catch {
      // One malformed entry costs that entry. The part it would have closed is
      // closed from what main itself saw instead — see `finalizeVideo`'s fallback.
    }
  }
  return reports;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A part index, or `null` when the value is not one. */
function partIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999
    ? value
    : null;
}

function requirePart(value: unknown): number {
  const part = partIndex(value);
  if (part === null) throw new Error('part must be an integer between 0 and 999');
  return part;
}

function requireTrack(value: unknown): ChunkMsg['track'] {
  if (typeof value !== 'string' || !(TRACK_KEYS as readonly string[]).includes(value)) {
    throw new Error(`track must be one of ${TRACK_KEYS.join(' | ')}`);
  }
  return value as ChunkMsg['track'];
}

function metaMessage(raw: unknown): MetaMsg {
  if (raw === null || typeof raw !== 'object') throw new Error('meta must be an object');
  const input = raw as Record<string, unknown>;
  const config = input['decoderConfig'];
  if (config === null || typeof config !== 'object') {
    throw new Error('meta.decoderConfig must be an object');
  }
  const decoder = config as Record<string, unknown>;
  if (typeof decoder['codec'] !== 'string' || decoder['codec'].length > 64) {
    throw new Error('meta.decoderConfig.codec must be a short string');
  }
  const description = decoder['description'];
  const audio = audioFacts(input['audio']);
  const video = videoMeta(input['video']);
  return {
    track: requireTrack(input['track']),
    part: requirePart(input['part']),
    decoderConfig: {
      codec: decoder['codec'],
      ...(typeof decoder['codedWidth'] === 'number' ? { codedWidth: decoder['codedWidth'] } : {}),
      ...(typeof decoder['codedHeight'] === 'number'
        ? { codedHeight: decoder['codedHeight'] }
        : {}),
      ...(isRate(decoder['sampleRate']) ? { sampleRate: decoder['sampleRate'] } : {}),
      ...(isChannelCount(decoder['numberOfChannels'])
        ? { numberOfChannels: decoder['numberOfChannels'] }
        : {}),
      ...(description instanceof Uint8Array ? { description } : {}),
    },
    ...(audio === null ? {} : { audio }),
    ...(video === null ? {} : { video }),
  };
}

/**
 * A video track's identity and where its part begins.
 *
 * `null` unless both timestamps are real numbers: a part announced with a `NaN`
 * first frame would be written into `recording.json` as a `startTimeSec` nothing
 * downstream can place, and a camera with no timing is better described by the
 * measurement that arrives when the part closes.
 */
function videoMeta(raw: unknown): NonNullable<MetaMsg['video']> | null {
  if (raw === null || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const first = stamp(input['firstTimestampUs']);
  if (first === null) return null;
  return {
    deviceId: shortString(input['deviceId'], MAX_DEVICE_ID_LENGTH),
    deviceName: shortString(input['deviceName']),
    firstTimestampUs: first,
    epochOffsetUs: finite(input['epochOffsetUs']),
  };
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 384_000;
}

function isChannelCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 32;
}

/** A short string from a renderer, bounded so a device name cannot be a payload. */
function shortString(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function audioSettings(raw: unknown): AudioTrackSettings | null {
  if (raw === null || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (!isRate(input['sampleRate']) || !isChannelCount(input['channelCount'])) return null;
  return {
    sampleRate: input['sampleRate'],
    channelCount: input['channelCount'],
    echoCancellation: input['echoCancellation'] === true,
    noiseSuppression: input['noiseSuppression'] === true,
    autoGainControl: input['autoGainControl'] === true,
  };
}

function audioFacts(raw: unknown): AudioTrackFacts | null {
  if (raw === null || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const settings = audioSettings(input['settings']);
  if (settings === null) return null;
  const violations = Array.isArray(input['violations'])
    ? input['violations'].map((v) => shortString(v, 64)).filter((v): v is string => v !== null)
    : [];
  return {
    deviceId: shortString(input['deviceId']),
    deviceName: shortString(input['deviceName']),
    source: shortString(input['source'], 64),
    settings,
    violations: violations.slice(0, 8),
  };
}

/**
 * One audio track's measurements, shape-checked like every other renderer message.
 *
 * These numbers decide where every audio sample in the recording is placed, so a
 * malformed one is refused rather than written: a `measuredSampleRate` of zero or
 * a gap of `NaN` in `recording.json` is a recording no later phase can read.
 */
function audioReports(raw: unknown): AudioTrackReport[] {
  if (!Array.isArray(raw)) return [];
  const reports: AudioTrackReport[] = [];
  for (const entry of raw.slice(0, AUDIO_TRACK_KEYS.length)) {
    if (entry === null || typeof entry !== 'object') continue;
    const input = entry as Record<string, unknown>;
    const track = input['track'];
    if (track !== 'mic' && track !== 'system') continue;
    const facts = audioFacts(input['facts']);
    const summary = audioSummary(input['summary']);
    const part = partIndex(input['part']);
    if (facts === null || summary === null || part === null) continue;
    const endReason = partEndReason(input['endReason']);
    reports.push({
      track,
      part,
      facts,
      summary,
      epochOffsetUs: finite(input['epochOffsetUs']),
      endedEarly: input['endedEarly'] === true,
      ...(endReason === undefined ? {} : { endReason }),
    });
  }
  return reports;
}

function audioSummary(raw: unknown): AudioCaptureSummary | null {
  if (raw === null || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (!isRate(input['nominalSampleRate']) || !isRate(input['measuredSampleRate'])) return null;
  const gaps = Array.isArray(input['gaps']) ? input['gaps'] : [];
  return {
    bufferCount: finite(input['bufferCount']),
    sampleCount: finite(input['sampleCount']),
    firstTimestampUs: stamp(input['firstTimestampUs']),
    lastTimestampUs: stamp(input['lastTimestampUs']),
    lastFrameCount: finite(input['lastFrameCount']),
    gaps: gaps
      .slice(0, MAX_REPORTED_GAPS)
      .map((gap) => {
        const g = (gap ?? {}) as Record<string, unknown>;
        return {
          atUs: finite(g['atUs']),
          durationUs: Math.max(0, finite(g['durationUs'])),
          cause: shortString(g['cause'], 64) ?? 'unknown',
        };
      })
      .filter((gap) => gap.durationUs > 0),
    gapUs: Math.max(0, finite(input['gapUs'])),
    nominalSampleRate: input['nominalSampleRate'],
    measuredSampleRate: input['measuredSampleRate'],
    rateIsNominal: input['rateIsNominal'] === true,
  };
}

function chunkMessage(raw: unknown): ChunkMsg {
  if (raw === null || typeof raw !== 'object') throw new Error('chunk must be an object');
  const input = raw as Record<string, unknown>;
  const data = input['data'];
  if (!(data instanceof Uint8Array)) throw new Error('chunk.data must be a Uint8Array');
  if (data.byteLength === 0 || data.byteLength > MAX_CHUNK_BYTES) {
    throw new Error(`chunk.data is ${String(data.byteLength)} bytes, which is not a frame`);
  }
  const timestampUs = input['timestampUs'];
  if (typeof timestampUs !== 'number' || !Number.isFinite(timestampUs)) {
    throw new Error('chunk.timestampUs must be a finite number');
  }
  const durationUs = input['durationUs'];
  if (durationUs !== null && (typeof durationUs !== 'number' || !Number.isFinite(durationUs))) {
    throw new Error('chunk.durationUs must be a finite number or null');
  }
  if (input['kind'] !== 'key' && input['kind'] !== 'delta') {
    throw new Error("chunk.kind must be 'key' or 'delta'");
  }
  return {
    track: requireTrack(input['track']),
    part: requirePart(input['part']),
    kind: input['kind'],
    timestampUs,
    durationUs: durationUs,
    data,
  };
}

function endReport(raw: unknown): CaptureEndReport {
  const input = (raw ?? {}) as Record<string, unknown>;
  const reason = input['reason'];
  const endedAtUs = input['endedAtUs'];
  return {
    reason:
      reason === 'stopped' || reason === 'source-ended' || reason === 'error' ? reason : 'error',
    endedAtUs: typeof endedAtUs === 'number' && Number.isFinite(endedAtUs) ? endedAtUs : null,
    framesEncoded: typeof input['framesEncoded'] === 'number' ? input['framesEncoded'] : 0,
    framesDropped: typeof input['framesDropped'] === 'number' ? input['framesDropped'] : 0,
    ...(typeof input['message'] === 'string' ? { message: input['message'].slice(0, 500) } : {}),
    ...(input['audio'] === undefined ? {} : { audio: audioReports(input['audio']) }),
    ...(input['video'] === undefined ? {} : { video: videoReports(input['video']) }),
    ...(typeof input['epochOffsetUs'] === 'number' && Number.isFinite(input['epochOffsetUs'])
      ? { epochOffsetUs: input['epochOffsetUs'] }
      : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One audio track described from the bytes on disk, when no measurement arrived.
 *
 * The capture page owns `measuredSampleRate` and `gaps` — they can only be read
 * from the raw buffer stream (§5.5) — so a renderer that died, or a stop that
 * timed out, leaves main with a finished `.m4a` and nothing to describe it with.
 * Leaving it out of `recording.json` loses the audio outright: the bundle
 * finalizes to `editable`, which no crash-recovery pass ever looks at again.
 *
 * So the part is written from what the writer counted, and every number in it is
 * the honest one: the nominal rate rather than a measured one, no gaps rather
 * than invented ones, and `startTimeSec: 0` — the value the snap in §5.4
 * mechanism 3 produces for an ordinary recording anyway. The track is marked
 * `endedEarly` with `endReason: 'crash'`, because whatever happened, the capture
 * did not end the way it was asked to.
 *
 * `sampleCount` counts the encoder's priming, which the part's edit list tells a
 * reader to skip; `durationSec` is the extent of the *decoded* media, so the
 * priming comes back off (see `AudioPart.startTimeSec`).
 */
function writtenAudio(
  state: ActiveAudio,
  written: FinalizedAudioPart | null,
): FinalizedAudioFacts | null {
  if (written === null || written.frameCount === 0 || state.sampleRate <= 0) return null;
  const decodedSamples = Math.max(0, written.sampleCount - AAC_ENCODER_DELAY_SAMPLES);
  if (decodedSamples === 0) return null;
  return {
    timing: {
      startTimeSec: 0,
      durationSec: decodedSamples / state.sampleRate,
      measuredSampleRate: state.sampleRate,
      gaps: [],
    },
    endedEarly: true,
    endReason: 'crash',
  };
}

/**
 * Why a part stopped before the user asked it to, or `null` for a clean stop.
 *
 * - **`source-ended` → `permission-revoked` *or* `device-lost`.** The screen track
 *   ending on its own is the shape a revoked Screen Recording grant takes, and §7.3
 *   is explicit that it must not be treated as a normal stop. It is *also* the shape
 *   macOS's own "Stop sharing" control and a disconnected display take. §7.3 gives
 *   the way to tell them apart — *"distinguish revocation from a normal stop by
 *   re-checking `getMediaAccessStatus('screen')`"* — and phase 2 does the re-check
 *   that phase 1 left as the more useful of two guesses. If the grant is still
 *   there, the source went away and the permission did not: that is `device-lost`.
 * - **`error` → `crash`.** `PartEndReason` has no "the writer failed" member, and
 *   `crash` is what it means: this part ended because the thing writing it stopped.
 *   It is deliberately *not* `disk-full` even now that §7.2's monitor exists: a write
 *   that failed is a guess at a cause, and the one case where the disk really was the
 *   cause is the case the monitor got to first.
 * - **A missing report → `crash`.** The capture page never answered; whatever
 *   happened to it, the recording did not end the way the user asked.
 * - **`stopped`, with a `stoppedBecause` → that reason.** This is the branch that
 *   finally produces `PartEndReason`'s `disk-full`, and it has to come before the
 *   clean-stop answer rather than after it. §7.2's monitor stops the recording
 *   through the ordinary `stop()` — that is what makes the file good — so what the
 *   capture page reports is an ordinary `reason: 'stopped'`, indistinguishable from
 *   the user pressing the button. Only main knows the difference, and
 *   {@link Active.stopReason} is where it wrote it down at the moment it decided.
 *
 * `screenStillGranted` and `stoppedBecause` are passed rather than read here so this
 * stays a pure function over the facts it decides between, and so the test can
 * exercise every branch without a TCC database or a full volume.
 */
function endReasonFor(
  report: CaptureEndReport | null,
  screenStillGranted: boolean,
  stoppedBecause: PartEndReason | null,
): PartEndReason | null {
  if (report === null) return 'crash';
  if (report.reason === 'stopped') return stoppedBecause;
  if (report.reason !== 'source-ended') return 'crash';
  return screenStillGranted ? 'device-lost' : 'permission-revoked';
}

/**
 * Why an audio track that stopped on its own stopped — {@link endReasonFor}'s
 * counterpart, and the piece phase 2 left out.
 *
 * The screen has had this re-check since phase 2; the microphone did not, so a
 * withdrawn Microphone grant reached `recording.json` as `device-lost` — the same
 * word an unplugged camera gets. `data/loom-scope/decision-mic-revocation.md` is the
 * captain's answer to that, and this function is the only place the distinction is
 * drawn.
 *
 * - **`track-ended` → `permission-revoked` *or* `device-lost`.** The
 *   `MediaStreamTrack` firing `ended` is the shape both take, exactly as it is for
 *   the screen. TCC is what separates them, and only if the track *has* a grant of
 *   its own — a loopback track that ends has lost a device, whatever the Microphone
 *   pane says.
 * - **`encoder-failed` → `crash`.** The device is fine and the permission is not in
 *   question; the thing writing the track stopped, which is what `crash` means here
 *   (see {@link endReasonFor}).
 *
 * `stillGranted` is passed rather than read so this stays a pure function over the
 * two facts it decides between, and so the test can drive both branches without a TCC
 * database.
 */
function audioEndReasonFor(
  cause: AudioPartEndMsg['cause'],
  stillGranted: boolean,
): 'permission-revoked' | 'device-lost' | 'crash' {
  if (cause !== 'track-ended') return 'crash';
  return stillGranted ? 'device-lost' : 'permission-revoked';
}

/**
 * A monotonic millisecond reading, from `node:perf_hooks` rather than the global.
 *
 * The import is not fussiness. `test/phase4/fake-capture-platform.ts` installs a
 * **driven** `globalThis.performance` so the capture page can be replayed on a
 * synthetic clock, and deletes it again afterwards — so a main-process read of the
 * global would either take the capture page's fake clock or throw `performance is
 * not defined`, depending on which test ran. Main's clock is main's.
 */
function monotonicMs(): number {
  return performance.now();
}
