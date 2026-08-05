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
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  CHANNEL,
  DEFAULT_CAPTURE_OPTIONS,
  type AudioTrackFacts,
  type AudioTrackReport,
  type AudioTrackSettings,
  type CaptureEndReport,
  type CaptureOptions,
  type ChunkMsg,
  type MetaMsg,
  type RecorderPhase,
  type RecorderStatus,
  type RecoveryReport,
} from '@loom/ipc';
import {
  AUDIO_TRACK_KEYS,
  DEFAULT_RECORDING_NAME,
  TRACK_KEYS,
  alignAudioPart,
  driftSec,
  isAudioTrack,
  type AudioCaptureSummary,
  type AudioTrackKey,
  type DisplayInfo,
  type PermissionState,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import { AAC_ENCODER_DELAY_SAMPLES } from '@loom/mux';
import type { FinalizedAudioPart, ProjectStore } from '../project-store.ts';
import type { WindowRegistry, WindowRole } from '../windows.ts';
import {
  finalizedRecordingDoc,
  provisionalRecordingDoc,
  withAudioTrack,
  withScreenTrack,
  type FinalizedAudioFacts,
} from './recording-doc.ts';

/** The video track phase 1 records. Phase 4 adds `webcam` beside it. */
const TRACK = 'screen';

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
 * Longest microphone device id a renderer may name.
 *
 * A `deviceId` from `enumerateDevices` is a 64-character hash. The bound is here
 * because the value is handed straight back to the capture page as a constraint,
 * and an unbounded string from a renderer is a payload rather than a device.
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

export interface RecorderSessionOptions {
  store: ProjectStore;
  windows: WindowRegistry;
  appVersion: string;
  osVersion: string;
  /** How long a stop waits for the capture renderer before finalizing anyway. */
  stopTimeoutMs?: number;
  /** How often the recorder pushes status to the HUD. */
  statusIntervalMs?: number;
}

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

interface Active {
  id: RecordingId;
  options: CaptureOptions;
  /** Written before the first frame; replaced with real numbers at finalize. */
  provisional: RecordingDoc | null;
  part: number | null;
  /** Chunks that arrived before the part was open, in the order they arrived. */
  held: ChunkMsg[];
  firstPtsUs: number | null;
  lastEndUs: number;
  droppedFrames: number;
  /**
   * The microphone and system tracks, once each has announced itself.
   *
   * Audio parts open independently of the screen's and of each other — three
   * encoders, three first chunks, no guaranteed order — so each keeps its own
   * held-chunk buffer rather than sharing the screen's.
   */
  audio: Map<AudioTrackKey, ActiveAudio>;
  /** The first write that failed. A recording that cannot be written is over. */
  writeError: Error | null;
  end: CaptureEndReport | null;
}

export class RecorderSession {
  private readonly options: Required<RecorderSessionOptions>;
  private phase: RecorderPhase = 'idle';
  private active: Active | null = null;
  private lastError: string | null = null;
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
    this.options = { stopTimeoutMs: 5_000, statusIntervalMs: 250, ...options };
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
      const id = await this.enqueue(() => this.start(captureOptions(raw)));
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

  /** Remove every handler. Used on shutdown and by tests. */
  uninstall(): void {
    session.defaultSession.setDisplayMediaRequestHandler(null);
    for (const channel of [
      CHANNEL.recorderOpen,
      CHANNEL.recorderStart,
      CHANNEL.recorderStop,
      CHANNEL.captureMeta,
      CHANNEL.captureChunk,
      CHANNEL.captureEnded,
      CHANNEL.captureFailed,
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
    this.stopStatusTimer();
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
    if (this.phase !== 'idle') throw new Error(`cannot start while ${this.phase}`);
    const options: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS, ...requested };
    this.phase = 'starting';
    this.lastError = null;
    this.publish();

    const { store } = this.options;
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
        part: null,
        held: [],
        firstPtsUs: null,
        lastEndUs: 0,
        droppedFrames: 0,
        audio: new Map(),
        writeError: null,
        end: null,
      };

      const window = await this.readyCaptureWindow();
      this.captureContentsId = window.webContents.id;
      this.sourceWanted = options;
      window.webContents.send(CHANNEL.captureCommand, { kind: 'start', options });

      this.phase = 'recording';
      this.startStatusTimer();
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
    if (active === null) {
      this.phase = 'idle';
      this.publish();
      return;
    }

    const { store } = this.options;
    try {
      await store.setState(active.id, 'finalizing');
      const finalizedPart =
        active.part === null
          ? null
          : await store.finalizeMediaPart(active.id, TRACK, report?.endedAtUs ?? undefined);
      // Audio closes even when the screen failed: a file descriptor into the
      // bundle outliving the recording is the thing `close` exists to prevent.
      const audio = await this.finalizeAudio(active, report);

      const provisional = active.provisional;
      const screenTrack = provisional?.tracks.screen;
      if (
        provisional === null ||
        screenTrack === undefined ||
        finalizedPart === null ||
        finalizedPart.frameCount === 0
      ) {
        const reason =
          active.writeError !== null
            ? `the recording could not be written: ${active.writeError.message}`
            : (report?.message ?? 'the capture produced no frames');
        this.lastError = reason;
        this.phase = 'failed';
        await store.setState(active.id, 'failed', reason);
        return;
      }

      // A capture that ended by itself still produced footage, and that footage is
      // kept. What changes is that the part says so, rather than passing itself off
      // as a recording the user chose to end.
      const endReason = endReasonFor(report);
      await store.writeRecordingDoc(
        active.id,
        finalizedRecordingDoc(
          provisional,
          {
            screen: {
              durationSec: finalizedPart.durationSec,
              frameCount: finalizedPart.frameCount,
              observedFps: finalizedPart.observedFps,
              endedEarly: endReason !== null,
              ...(endReason === null ? {} : { endReason }),
            },
            audio,
          },
          // The capture page is the only thing that counts drops, so its report is
          // the number. `active.droppedFrames` is the last one it sent, and stands
          // in only when no end report arrived at all.
          report?.framesDropped ?? active.droppedFrames,
          new Date().toISOString(),
        ),
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

  // ------------------------------------------------------------------ recovery

  /**
   * Recover every bundle that was mid-recording when we last died (§7.1).
   *
   * Runs at launch, before any window can ask for a recording. Returns what it
   * found so the app can tell the user plainly — *"Recovered 4:52"* — rather than
   * silently presenting a repaired recording as though nothing happened.
   */
  async recoverOnLaunch(): Promise<RecoveryReport[]> {
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
    return reports;
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
    if (meta.track !== TRACK) throw new Error(`phase 1 records ${TRACK} and audio only`);
    if (active.part !== null) throw new Error('the screen track already has an open part');

    const description = meta.decoderConfig.description;
    if (description === undefined || description.byteLength === 0) {
      throw new Error('the encoder produced no avcC record, so the part could not be described');
    }
    const width = meta.decoderConfig.codedWidth ?? 0;
    const height = meta.decoderConfig.codedHeight ?? 0;
    if (width <= 0 || height <= 0) throw new Error('the encoder reported no coded size');

    const { store } = this.options;
    const file = store.mediaRelativePath(TRACK, meta.part);
    const provisional = withScreenTrack(this.requireProvisional(active), {
      file,
      index: file.replace(/\.mp4$/, '.index.json'),
      codec: meta.decoderConfig.codec,
      size: [width, height],
      requestedFps: active.options.fps,
    });
    await store.writeRecordingDoc(active.id, provisional);

    const opened = await store.beginMediaPart(active.id, {
      track: TRACK,
      part: meta.part,
      width,
      height,
      avcC: description,
      nominalFps: active.options.fps,
      colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
    });
    active.provisional = provisional;
    active.part = meta.part;
    if (opened.file !== file) throw new Error('the part path moved under the recording document');
    this.appendHeldChunks(active);
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
    if (chunk.track !== TRACK) return;

    if (active.part === null) {
      if (active.held.length >= MAX_HELD_CHUNKS) {
        this.failActive(
          new Error(
            `${String(MAX_HELD_CHUNKS)} frames arrived before the part could be opened; ` +
              'the capture page never produced a usable decoder configuration',
          ),
        );
        return;
      }
      active.held.push(chunk);
      return;
    }
    if (chunk.part !== active.part) return;
    this.appendChunk(active, chunk);
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
        out[track] = this.alignedAudio(active, measured, report?.epochOffsetUs ?? 0);
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
      out[track] = fromBytes;
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
  private alignedAudio(
    active: Active,
    measured: AudioTrackReport,
    videoEpochOffsetUs: number,
  ): FinalizedAudioFacts {
    const timing = alignAudioPart(measured.summary, {
      // `clock.t0Us` is the first screen frame; every other track's start is an
      // offset from it. With no screen frame there is nothing to be offset from,
      // and the track starts the recording.
      originUs:
        active.firstPtsUs === null
          ? (measured.summary.firstTimestampUs ?? 0) + measured.epochOffsetUs
          : active.firstPtsUs + videoEpochOffsetUs,
      epochOffsetUs: measured.epochOffsetUs,
      referenceStartSec: 0,
    });
    this.reportAudioTiming(measured, timing.startTimeSec, timing.durationSec);
    return {
      timing,
      endedEarly: measured.endedEarly,
      ...(measured.endReason === undefined ? {} : { endReason: measured.endReason }),
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
  private appendHeldChunks(active: Active): void {
    const held = active.held;
    active.held = [];
    for (const chunk of held) {
      if (chunk.part === active.part) this.appendChunk(active, chunk);
    }
  }

  private appendChunk(active: Active, chunk: ChunkMsg): void {
    active.firstPtsUs ??= chunk.timestampUs;
    active.lastEndUs = chunk.timestampUs + (chunk.durationUs ?? 0);

    void this.options.store
      .appendMediaChunk(active.id, TRACK, {
        data: chunk.data,
        isKey: chunk.kind === 'key',
        timestampUs: chunk.timestampUs,
        durationUs: chunk.durationUs,
      })
      .catch((error: unknown) => {
        this.failActive(error);
      });
  }

  private onEnded(report: CaptureEndReport): void {
    const active = this.active;
    if (active !== null) {
      active.end = report;
      active.droppedFrames = report.framesDropped;
    }
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

  private publish(): void {
    const status: RecorderStatus = {
      phase: this.phase,
      recordingId: this.active?.id ?? null,
      elapsedSec: this.elapsedSec(),
      frameCount:
        this.active === null ? 0 : this.options.store.mediaFrameCount(this.active.id, TRACK),
      droppedFrames: this.active?.droppedFrames ?? 0,
      error: this.lastError,
    };
    for (const window of this.options.windows.all()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNEL.recorderStatus, status);
    }
  }

  /** Media time, not wall clock — a stalled capture shows a stalled timer. */
  private elapsedSec(): number {
    const active = this.active;
    if (active?.firstPtsUs == null) return 0;
    return Math.max(0, (active.lastEndUs - active.firstPtsUs) / 1_000_000);
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
    this.onEnded({
      reason: 'error',
      endedAtUs: active.lastEndUs > 0 ? active.lastEndUs : null,
      framesEncoded: 0,
      framesDropped: active.droppedFrames,
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
      screen: systemPreferences.getMediaAccessStatus('screen') as PermissionState,
      camera: systemPreferences.getMediaAccessStatus('camera') as PermissionState,
      microphone: systemPreferences.getMediaAccessStatus('microphone') as PermissionState,
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    };
  }
}

// ------------------------------------------------------- untrusted-input checks

/**
 * Everything below shape-checks a message from a renderer.
 *
 * Our own code sends these, which is exactly why they are checked: the renderer is
 * the process most likely to be compromised, and it is the one that must never be
 * able to name a path, an unbounded allocation, or a track it is not recording.
 */
function captureOptions(raw: unknown): Partial<CaptureOptions> {
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
  return out;
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
    const endReason = input['endReason'];
    reports.push({
      track,
      part,
      facts,
      summary,
      epochOffsetUs:
        typeof input['epochOffsetUs'] === 'number' && Number.isFinite(input['epochOffsetUs'])
          ? input['epochOffsetUs']
          : 0,
      endedEarly: input['endedEarly'] === true,
      ...(endReason === 'device-lost' ||
      endReason === 'permission-revoked' ||
      endReason === 'disk-full' ||
      endReason === 'crash'
        ? { endReason }
        : {}),
    });
  }
  return reports;
}

function audioSummary(raw: unknown): AudioCaptureSummary | null {
  if (raw === null || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (!isRate(input['nominalSampleRate']) || !isRate(input['measuredSampleRate'])) return null;
  const finite = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const stamp = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
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
 * - **`source-ended` → `permission-revoked`.** The screen track ending on its own is
 *   the shape a revoked Screen Recording grant takes, and §7.3 is explicit that it
 *   must not be treated as a normal stop. It is also the shape macOS's own "Stop
 *   sharing" control takes; phase 2 re-checks TCC to tell the two apart, and until
 *   then this is the more useful of the two guesses.
 * - **`error` → `crash`.** `PartEndReason` has no "the writer failed" member, and
 *   `crash` is what it means: this part ended because the thing writing it stopped.
 *   `disk-full` would be a guess at a cause we have not measured, and §7.2's disk
 *   monitor — which would know — is not built yet.
 * - **A missing report → `crash`.** The capture page never answered; whatever
 *   happened to it, the recording did not end the way the user asked.
 */
function endReasonFor(report: CaptureEndReport | null): 'permission-revoked' | 'crash' | null {
  if (report === null) return 'crash';
  if (report.reason === 'stopped') return null;
  return report.reason === 'source-ended' ? 'permission-revoked' : 'crash';
}
