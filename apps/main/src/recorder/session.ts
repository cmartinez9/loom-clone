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
  desktopCapturer,
  ipcMain,
  screen,
  session,
  systemPreferences,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents,
} from 'electron';
import {
  CHANNEL,
  DEFAULT_CAPTURE_OPTIONS,
  type CaptureEndReport,
  type CaptureOptions,
  type ChunkMsg,
  type MetaMsg,
  type RecorderPhase,
  type RecorderStatus,
  type RecoveryReport,
} from '@loom/ipc';
import {
  DEFAULT_RECORDING_NAME,
  TRACK_KEYS,
  type DisplayInfo,
  type PermissionState,
  type RecordingDoc,
  type RecordingId,
} from '@loom/format';
import type { ProjectStore } from '../project-store.ts';
import type { WindowRegistry } from '../windows.ts';
import { finalizedRecordingDoc, provisionalRecordingDoc } from './recording-doc.ts';

/** Phase 1 captures the screen and nothing else. */
const TRACK = 'screen';

/** A chunk larger than this is not a frame; it is a bug or an attack. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

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

interface Active {
  id: RecordingId;
  options: CaptureOptions;
  /** Written before the first frame; replaced with real numbers at finalize. */
  provisional: RecordingDoc | null;
  part: number | null;
  firstPtsUs: number | null;
  lastEndUs: number;
  droppedFrames: number;
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

    ipcMain.handle(CHANNEL.recorderStart, async (_event, raw: unknown) => {
      const id = await this.enqueue(() => this.start(captureOptions(raw)));
      return { recordingId: id };
    });

    ipcMain.handle(CHANNEL.recorderStop, async () => {
      await this.enqueue(() => this.stop());
    });

    ipcMain.on(CHANNEL.captureMeta, (event, raw: unknown) => {
      if (!this.fromCaptureWindow(event)) return;
      void this.onMeta(raw).catch((error: unknown) => {
        this.failActive(error);
      });
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
      this.active = {
        id,
        options,
        provisional: null,
        part: null,
        firstPtsUs: null,
        lastEndUs: 0,
        droppedFrames: 0,
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

      const provisional = active.provisional;
      if (provisional === null || finalizedPart === null || finalizedPart.frameCount === 0) {
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
            durationSec: finalizedPart.durationSec,
            frameCount: finalizedPart.frameCount,
            observedFps: finalizedPart.observedFps,
            endedEarly: endReason !== null,
            ...(endReason === null ? {} : { endReason }),
          },
          active.droppedFrames + (report?.framesDropped ?? 0),
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
    if (meta.track !== TRACK) throw new Error(`phase 1 records ${TRACK} only`);
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
    const provisional = provisionalRecordingDoc({
      display: this.displayInfo(active.options.displayId),
      file,
      index: file.replace(/\.mp4$/, '.index.json'),
      codec: meta.decoderConfig.codec,
      size: [width, height],
      requestedFps: active.options.fps,
      capture: {
        app: this.options.appVersion,
        os: this.options.osVersion,
        permissions: this.permissions(),
        resolutionClamp: `${String(active.options.maxDimension)}px`,
      },
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
    active.provisional = { ...provisional };
    active.part = meta.part;
    if (opened.file !== file) throw new Error('the part path moved under the recording document');
  }

  /**
   * One encoded frame.
   *
   * Deliberately not `await`ed: the writer serializes its own appends, so ordering
   * holds, and blocking the IPC handler would build a queue in this process —
   * which is precisely the memory a `SIGKILL` takes. The rejection is not dropped;
   * the first failed write ends the recording.
   */
  private onChunk(raw: unknown): void {
    const active = this.active;
    if (active?.part == null) return;
    let chunk: ChunkMsg;
    try {
      chunk = chunkMessage(raw);
    } catch (error) {
      this.failActive(error);
      return;
    }
    if (chunk.track !== TRACK || chunk.part !== active.part) return;

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
        callback({ video: source });
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
  return out;
}

function requirePart(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 999) {
    throw new Error('part must be an integer between 0 and 999');
  }
  return value;
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
  return {
    track: requireTrack(input['track']),
    part: requirePart(input['part']),
    decoderConfig: {
      codec: decoder['codec'],
      ...(typeof decoder['codedWidth'] === 'number' ? { codedWidth: decoder['codedWidth'] } : {}),
      ...(typeof decoder['codedHeight'] === 'number'
        ? { codedHeight: decoder['codedHeight'] }
        : {}),
      ...(description instanceof Uint8Array ? { description } : {}),
    },
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
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
