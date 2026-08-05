/**
 * Camera capture, and surviving the camera going away. Architecture report §7.4.
 *
 * ```
 * getUserMedia({ video: … }) → MediaStreamTrackProcessor → VideoEncoder → main
 * ```
 *
 * The same three rules as the screen half in `main.ts` — encoded bytes only, every
 * `VideoFrame` closed in a `finally`, nothing raw across IPC — and one rule that
 * belongs only to the camera, which is the whole reason this file is separate from
 * that one:
 *
 * > **Losing the camera costs the camera.** Not the screen, not the microphone, not
 * > the recording. §7.4 step 1 is "camera track `ended` fires — screen and audio
 * > keep recording", and it is the most likely hardware failure this app will meet.
 *
 * Nothing in here throws into the session. Every failure — a camera that will not
 * open, a machine that cannot encode it, a device that vanishes — is reported
 * through {@link WebcamSink.unavailable} and the recording carries on without it.
 *
 * ## Parts, and why the camera is what the multi-part model is for
 *
 * A track is a *list of parts* from v1 of the format (§2.3), and this is the track
 * that exercises it. One acquisition of the device is one part:
 *
 * 1. the camera is unplugged and the track fires `ended`;
 * 2. the current part is closed, flushed, and announced with
 *    `endedEarly: true, endReason: 'device-lost'` — a real file, complete, with its
 *    own frame index;
 * 3. `navigator.mediaDevices` `devicechange` is watched, and on the reappearance of
 *    the **same** `deviceId` the camera is reopened as `webcam.001.mp4`, with a
 *    `startTimeSec` of its own;
 * 4. the hole between them lives in `recording.json` — in the gap between part 0's
 *    end and part 1's start — where the editor can see it, fade across it, and the
 *    user can edit it. Nothing is baked into pixels.
 *
 * The alternative, one file with the gap concatenated out of it, would shorten the
 * camera track by the length of the unplug and desynchronise everything after it,
 * permanently and invisibly at first. That is §5.4 mechanism 5 applied to pictures.
 */

import { TrackEpochEstimator } from '@loom/format';
import type { CaptureOptions, VideoPartReport, VideoTrackFacts } from '@loom/ipc';

/**
 * Codec strings to try, highest level first.
 *
 * Shorter than the screen's list and starting lower: a camera is 720p-ish, so the
 * levels a 4K display needs are levels no camera will ever exercise. Main writes
 * whatever `avcC` the encoder actually hands back, so a downgrade corrects itself.
 */
const CODECS = ['avc1.4d402a', 'avc1.42E02A', 'avc1.4d401f', 'avc1.42E01F'];

/** Keyframe cadence during capture. Architecture report §7.1 fixes this at 1 s. */
const KEYFRAME_INTERVAL_US = 1_000_000;

/**
 * Frames the encoder may be behind before we start dropping.
 *
 * Same reasoning as the screen's: a queue is memory this process holds, and
 * everything it holds is what a crash costs. Drops are counted into
 * `recording.json.capture.droppedFrames.webcam` rather than swallowed.
 */
const MAX_ENCODE_QUEUE = 8;

/**
 * Parts one camera may produce in a recording.
 *
 * A cable with a bad contact can produce `devicechange` indefinitely, and each
 * reacquire costs a file, a sidecar and an entry in `recording.json`. At the
 * ceiling the camera is given up on for the rest of the recording and says so —
 * which is a camera that stopped coming back, not a recording that failed. The
 * part index is bounded by main at 999 regardless; this stops well short of it.
 */
const MAX_PARTS = 16;

/** One acquisition of the camera: an open device, its encoder, and its part. */
interface Acquisition {
  part: number;
  stream: MediaStream;
  mediaTrack: MediaStreamTrack;
  reader: ReadableStreamDefaultReader<VideoFrame>;
  encoder: VideoEncoder;
  metaSent: boolean;
  firstTimestampUs: number | null;
  lastTimestampUs: number | null;
  lastFrameAtMs: number;
  framesEncoded: number;
  framesDropped: number;
  /** Set by whichever of a stop, a device loss or an encoder error happens first. */
  closing: boolean;
  pump: Promise<void> | null;
}

export interface WebcamSink {
  meta(message: {
    track: 'webcam';
    part: number;
    decoderConfig: {
      codec: string;
      codedWidth?: number;
      codedHeight?: number;
      description?: Uint8Array;
    };
    video: VideoTrackFacts & { firstTimestampUs: number; epochOffsetUs: number };
  }): void;
  chunk(message: {
    track: 'webcam';
    part: number;
    kind: 'key' | 'delta';
    timestampUs: number;
    durationUs: number | null;
    data: Uint8Array;
  }): void;
  /** A part that closed while the recording carried on (§7.4 step 2). */
  partEnded(message: VideoPartReport): void;
  /** The camera could not be captured at all. The recording continues without it. */
  unavailable(reason: string): void;
  /** The camera's state changed, for the §7.4 step 3 banner. */
  state(state: 'live' | 'lost' | 'unavailable'): void;
}

/**
 * The camera, across however many acquisitions one recording takes.
 *
 * Created by {@link WebcamCapture.start} and owned by the capture session, which
 * stops it in the same breath as the screen and the audio tracks.
 */
export class WebcamCapture {
  private current: Acquisition | null = null;
  private nextPart = 0;
  private stopped = false;
  /** Set while the device is gone and we are waiting for it to come back. */
  private awaitingDevice = false;
  private deviceListener: (() => void) | null = null;
  /** Resolves when a reacquire attempt is not in flight, so a stop can await it. */
  private reacquiring: Promise<void> | null = null;
  private readonly epoch = new TrackEpochEstimator();

  private constructor(
    private readonly options: CaptureOptions,
    private readonly sink: WebcamSink,
    private facts: VideoTrackFacts,
  ) {}

  /**
   * Open the camera and start encoding, or report why not.
   *
   * Returns `null` rather than throwing for every failure a camera can have. The
   * user pressed record to record their screen; a camera that will not open is a
   * track the recording does without.
   */
  static async start(options: CaptureOptions, sink: WebcamSink): Promise<WebcamCapture | null> {
    if (options.webcamDeviceId === null) return null;
    let opened: { stream: MediaStream; mediaTrack: MediaStreamTrack };
    try {
      opened = await openCamera(options);
    } catch (error) {
      // Camera permission is phase 2's to ask for. Until it has been granted this
      // is the ordinary case, and it costs a track, not a recording.
      sink.unavailable(`the camera could not be opened: ${describe(error)}`);
      sink.state('unavailable');
      return null;
    }

    const capture = new WebcamCapture(options, sink, factsOf(opened.mediaTrack));
    if (!capture.beginPart(opened)) {
      for (const track of opened.stream.getTracks()) track.stop();
      sink.state('unavailable');
      return null;
    }
    sink.state('live');
    return capture;
  }

  /**
   * Stop the camera for good and close whatever part is open.
   *
   * The device watcher is removed **first**: a `devicechange` that lands while the
   * final part is being flushed would otherwise open a camera the session has no
   * use for, and a camera opened after its session keeps the hardware indicator lit
   * and posts chunks under a `{track, part}` key the *next* recording would accept
   * as its own.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unwatchDevices();
    await this.reacquiring?.catch(() => undefined);
    const current = this.current;
    if (current === null) return;
    await this.closePart(current, null);
  }

  /**
   * What main needs to close the part that is still open when capture stops.
   *
   * `null` once every part has already been closed and announced — a camera that
   * was unplugged and never came back has nothing left open, and reporting a part
   * that main already finalized would be a second close of the same file.
   */
  get openPartReport(): VideoPartReport | null {
    const current = this.current;
    if (current === null) return null;
    return this.reportFor(current, false);
  }

  /** Parts this camera has produced, open one included. */
  get partCount(): number {
    return this.nextPart;
  }

  // ------------------------------------------------------------------- parts

  /**
   * Configure an encoder for one acquisition and start pumping frames into it.
   *
   * The part index comes from `nextPart` rather than from main: `ChunkMsg.part` is
   * the renderer's to choose, which is what makes a new part on a device loss a
   * message rather than a round trip.
   */
  private beginPart(opened: { stream: MediaStream; mediaTrack: MediaStreamTrack }): boolean {
    const part = this.nextPart;
    let encoder: VideoEncoder;
    let reader: ReadableStreamDefaultReader<VideoFrame>;
    try {
      ({ encoder, reader } = this.openEncoder(part, opened.mediaTrack));
    } catch (error) {
      // WebCodecs is missing, or this machine will not give us a processor for the
      // track. Either way the camera is a track the recording does without.
      this.sink.unavailable(`the webcam could not be encoded: ${describe(error)}`);
      return false;
    }

    const acquisition: Acquisition = {
      part,
      stream: opened.stream,
      mediaTrack: opened.mediaTrack,
      reader,
      encoder,
      metaSent: false,
      firstTimestampUs: null,
      lastTimestampUs: null,
      lastFrameAtMs: 0,
      framesEncoded: 0,
      framesDropped: 0,
      closing: false,
      pump: null,
    };

    // §7.4 step 1. This is the event a physical unplug arrives as, and the only
    // thing between it and a lost recording is that it is handled here rather
    // than allowed to reach the session.
    opened.mediaTrack.addEventListener('ended', () => {
      void this.loseCurrentPart('device-lost', { reacquire: true });
    });

    this.nextPart = part + 1;
    this.current = acquisition;
    acquisition.pump = this.pump(acquisition);
    return true;
  }

  private openEncoder(
    part: number,
    mediaTrack: MediaStreamTrack,
  ): { encoder: VideoEncoder; reader: ReadableStreamDefaultReader<VideoFrame> } {
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        this.onEncoded(part, chunk, metadata);
      },
      error: (error: DOMException) => {
        // An encoder that fails takes its part with it and nothing else. The
        // camera is not reacquired: whatever the machine could not encode a
        // moment ago it will not encode on the next frame either.
        console.error('[capture] the webcam encoder failed:', error.message);
        this.sink.unavailable(`the webcam encoder failed: ${error.message}`);
        void this.loseCurrentPart('crash', { reacquire: false });
      },
    });
    const reader = new MediaStreamTrackProcessor<VideoFrame>({
      track: mediaTrack,
    }).readable.getReader();
    return { encoder, reader };
  }

  /**
   * The frame loop.
   *
   * One `VideoFrame` is alive at a time and closed in a `finally`, so an encoder
   * that throws, a configure that fails and a drop decision all release it. The
   * `live` counter trips on the first leak rather than the hundredth (§10.2) — a
   * leak here does not throw on its own, it just quietly stops producing frames.
   */
  private async pump(acquisition: Acquisition): Promise<void> {
    let configured = false;
    let lastKeyframeUs = Number.NEGATIVE_INFINITY;
    let live = 0;

    for (;;) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await acquisition.reader.read();
      } catch {
        break;
      }
      const value = result.value;
      if (result.done || value === undefined) break;
      live += 1;
      try {
        if (live > 1) {
          throw new Error(
            `${String(live)} webcam VideoFrames are live at once; one of them leaked`,
          );
        }
        if (acquisition.closing || this.stopped) break;

        if (!configured) {
          await this.configure(acquisition.encoder, value);
          configured = true;
        }
        if (acquisition.encoder.state !== 'configured') break;

        // Backpressure before the encode, so the frame we decline is closed by
        // the `finally` rather than handed to a queue we know is behind.
        if (acquisition.encoder.encodeQueueSize >= MAX_ENCODE_QUEUE) {
          acquisition.framesDropped += 1;
          continue;
        }

        // A frame exists the instant it is captured, so its end is its timestamp.
        this.epoch.observe(value.timestamp, performance.now() * 1000);

        const keyFrame = value.timestamp - lastKeyframeUs >= KEYFRAME_INTERVAL_US;
        if (keyFrame) lastKeyframeUs = value.timestamp;
        acquisition.encoder.encode(value, { keyFrame });
        acquisition.framesEncoded += 1;
        acquisition.firstTimestampUs ??= value.timestamp;
        acquisition.lastTimestampUs = value.timestamp;
        acquisition.lastFrameAtMs = performance.now();
      } catch (error) {
        console.error('[capture] the webcam frame loop failed:', describe(error));
        this.sink.unavailable(`the webcam frame loop failed: ${describe(error)}`);
        void this.loseCurrentPart('crash', { reacquire: false });
        break;
      } finally {
        value.close();
        live -= 1;
      }
    }
  }

  /**
   * Configure the encoder from the first frame.
   *
   * Lazily, and from the frame rather than from the constraints, for the same
   * reason the screen does it: the constraints are a request, and what the device
   * hands over is its own business.
   */
  private async configure(encoder: VideoEncoder, frame: VideoFrame): Promise<void> {
    // H.264 wants even dimensions; a 4:2:0 chroma plane has no half pixels.
    const width = Math.max(2, frame.displayWidth - (frame.displayWidth % 2));
    const height = Math.max(2, frame.displayHeight - (frame.displayHeight % 2));

    for (const codec of CODECS) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate: this.options.webcamBitrate,
        framerate: this.options.webcamFps,
        // `realtime` keeps B-frames out, which is what lets the frame index treat
        // presentation and decode order as the same thing (§2.4).
        latencyMode: 'realtime',
        avc: { format: 'avc' },
        hardwareAcceleration: 'prefer-hardware',
      };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported === true) {
        encoder.configure(config);
        return;
      }
    }
    throw new Error(
      `no supported H.264 configuration for a ${String(width)}x${String(height)} camera`,
    );
  }

  private onEncoded(
    part: number,
    chunk: EncodedVideoChunk,
    metadata: EncodedVideoChunkMetadata | undefined,
  ): void {
    const current = this.current;
    // Routed on the part the encoder was created for, not on whichever part is
    // current: a flush at the end of part 0 emits its last frames while part 1 may
    // already be opening, and those frames belong to the file they were encoded for.
    if (current?.part !== part) return;

    if (!current.metaSent) {
      const config = metadata?.decoderConfig;
      const description = config?.description;
      if (config === undefined || description === undefined) {
        console.error('[capture] the webcam encoder produced no decoder configuration');
        this.sink.unavailable('the webcam encoder produced no decoder configuration');
        void this.loseCurrentPart('crash', { reacquire: false });
        return;
      }
      current.metaSent = true;
      this.sink.meta({
        track: 'webcam',
        part,
        decoderConfig: {
          codec: config.codec,
          ...(config.codedWidth === undefined ? {} : { codedWidth: config.codedWidth }),
          ...(config.codedHeight === undefined ? {} : { codedHeight: config.codedHeight }),
          description: toBytes(description),
        },
        // What main needs to write a real `startTimeSec` for this part *before*
        // its first byte reaches the disk, so a crash cannot leave part 1 claiming
        // to start where part 0 did.
        video: {
          ...this.facts,
          firstTimestampUs: chunk.timestamp,
          epochOffsetUs: this.epoch.offsetUs,
        },
      });
    }

    // `copyTo` into a fresh buffer: what crosses IPC is a copy of the encoded
    // bytes and nothing else.
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.sink.chunk({
      track: 'webcam',
      part,
      kind: chunk.type === 'key' ? 'key' : 'delta',
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? null,
      data,
    });
  }

  /**
   * Close the open part because something took it, and decide whether to wait for
   * the device to come back.
   *
   * Idempotent through `closing`: an unplug can arrive as a track `ended` and an
   * encoder error in the same turn, and only the first gets past it.
   */
  private async loseCurrentPart(
    reason: 'device-lost' | 'crash',
    options: { reacquire: boolean },
  ): Promise<void> {
    const current = this.current;
    if (current === null || current.closing) return;
    await this.closePart(current, reason);
    this.current = null;

    if (this.stopped) return;
    if (!options.reacquire) {
      this.sink.state('unavailable');
      return;
    }
    // §7.4 step 3: the banner says the camera is gone *and* that the recording is
    // still going, which is the half a user actually needs.
    console.error('[capture] the camera disconnected; still recording screen and audio');
    this.sink.state('lost');
    this.watchDevices();
  }

  /**
   * Flush the part's encoder, tell main it is closed, and release the device.
   *
   * `flush()` before `close()`, exactly as the screen and audio paths do it: the
   * encoder may be holding frames it has not emitted, and those are footage the
   * capture already succeeded at. The flush runs *before* `partEnded` is sent, so
   * main has every chunk of the part in hand before it finalizes the file.
   */
  private async closePart(
    acquisition: Acquisition,
    reason: 'device-lost' | 'crash' | null,
  ): Promise<void> {
    if (acquisition.closing) return;
    acquisition.closing = true;

    await acquisition.reader.cancel().catch(() => undefined);
    await acquisition.pump?.catch(() => undefined);
    try {
      acquisition.mediaTrack.stop();
      if (acquisition.encoder.state === 'configured') await acquisition.encoder.flush();
    } catch (error) {
      console.error('[capture] flushing the webcam encoder failed:', describe(error));
    }
    try {
      if (acquisition.encoder.state !== 'closed') acquisition.encoder.close();
    } catch {
      // A closed encoder is the goal; failing to close one is not worth reporting.
    }
    for (const track of acquisition.stream.getTracks()) track.stop();

    // A part that ended with the recording is closed by the end report instead —
    // see `openPartReport`. Announcing it here as well would ask main to finalize
    // the same file twice.
    if (reason === null) return;
    this.current = null;
    this.sink.partEnded(this.reportFor(acquisition, true, reason));
  }

  private reportFor(
    acquisition: Acquisition,
    endedEarly: boolean,
    reason?: 'device-lost' | 'crash',
  ): VideoPartReport {
    return {
      track: 'webcam',
      part: acquisition.part,
      facts: this.facts,
      firstTimestampUs: acquisition.firstTimestampUs,
      lastTimestampUs: acquisition.lastTimestampUs,
      endedAtUs: stoppedAtUs(acquisition),
      epochOffsetUs: this.epoch.offsetUs,
      framesEncoded: acquisition.framesEncoded,
      framesDropped: acquisition.framesDropped,
      endedEarly,
      ...(reason === undefined ? {} : { endReason: reason }),
    };
  }

  // ------------------------------------------------------------- reacquisition

  /**
   * Watch for the camera coming back (§7.4 step 4).
   *
   * `devicechange` rather than polling: macOS fires it when a camera is plugged
   * in, and a timer that reopened a camera the user physically removed would be
   * the app deciding to turn a camera on by itself.
   */
  private watchDevices(): void {
    if (this.deviceListener !== null || this.stopped) return;
    if (this.nextPart >= MAX_PARTS) {
      this.sink.unavailable(
        `the camera has reconnected ${String(MAX_PARTS)} times in one recording; it is ` +
          'left off for the rest of it rather than filling the bundle with fragments',
      );
      this.sink.state('unavailable');
      return;
    }
    this.awaitingDevice = true;
    const listener = (): void => {
      if (!this.awaitingDevice || this.stopped) return;
      this.reacquiring = this.reacquire().catch(() => undefined);
    };
    this.deviceListener = listener;
    navigator.mediaDevices.addEventListener('devicechange', listener);
  }

  private unwatchDevices(): void {
    this.awaitingDevice = false;
    const listener = this.deviceListener;
    if (listener === null) return;
    this.deviceListener = null;
    navigator.mediaDevices.removeEventListener('devicechange', listener);
  }

  /**
   * Reopen the camera as the next part, if the device that came back is ours.
   *
   * §7.4 is specific: *"on reappearance of the same `deviceId`"*. A different
   * camera appearing is not this one returning, and silently switching to it would
   * put a stranger's picture in the second half of the recording under a track that
   * names the first device.
   */
  private async reacquire(): Promise<void> {
    if (!this.awaitingDevice || this.stopped || this.current !== null) return;
    const wanted = this.facts.deviceId;
    if (wanted !== null && !(await this.deviceIsBack(wanted))) return;

    // Claimed before the await so that two `devicechange` events in the same turn
    // cannot both open a camera.
    this.awaitingDevice = false;
    let opened: { stream: MediaStream; mediaTrack: MediaStreamTrack };
    try {
      opened = await openCamera(this.options, wanted);
    } catch (error) {
      // The device is listed but not yet ready to open — a USB camera enumerates
      // before it will stream. Keep waiting; the next `devicechange` tries again.
      this.awaitingDevice = !this.stopped;
      console.warn('[capture] the camera reappeared but would not open yet:', describe(error));
      return;
    }
    if (this.stopped) {
      for (const track of opened.stream.getTracks()) track.stop();
      return;
    }

    this.unwatchDevices();
    this.facts = factsOf(opened.mediaTrack);
    if (!this.beginPart(opened)) {
      for (const track of opened.stream.getTracks()) track.stop();
      this.sink.state('unavailable');
      return;
    }
    this.sink.state('live');
  }

  private async deviceIsBack(deviceId: string): Promise<boolean> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((device) => device.kind === 'videoinput' && device.deviceId === deviceId);
    } catch {
      // Without an enumeration there is nothing to match against, so the
      // constraint below is what decides: `getUserMedia` with an exact device id
      // fails if that device is not there.
      return true;
    }
  }
}

/**
 * Open the camera the options name, or the one that came back.
 *
 * `exact` when a device is named, so a camera that is genuinely gone fails here
 * rather than silently handing back a different one.
 */
async function openCamera(
  options: CaptureOptions,
  deviceId: string | null = options.webcamDeviceId,
): Promise<{ stream: MediaStream; mediaTrack: MediaStreamTrack }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId === null || deviceId === 'default' ? {} : { deviceId: { exact: deviceId } }),
      frameRate: options.webcamFps,
      width: { max: options.webcamMaxDimension },
      height: { max: options.webcamMaxDimension },
    },
  });
  const mediaTrack = stream.getVideoTracks()[0];
  if (mediaTrack === undefined) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('the camera stream carried no video track');
  }
  return { stream, mediaTrack };
}

function factsOf(mediaTrack: MediaStreamTrack): VideoTrackFacts {
  return {
    deviceId: mediaTrack.getSettings().deviceId ?? null,
    deviceName: mediaTrack.label.length > 0 ? mediaTrack.label : null,
  };
}

/**
 * When this part stopped producing, on the encoder's clock.
 *
 * The last frame's timestamp plus the wall time since it arrived — the same
 * reasoning as the screen's `stoppedAtUs`, and it matters here for a different
 * reason: the instant a camera is unplugged is the instant its part ends, and
 * without this the gap in `recording.json` would start one frame early and the part
 * would claim to be shorter than it was.
 */
function stoppedAtUs(acquisition: Acquisition): number | null {
  if (acquisition.lastTimestampUs === null) return null;
  const elapsedUs = Math.max(0, (performance.now() - acquisition.lastFrameAtMs) * 1000);
  return Math.round(acquisition.lastTimestampUs + elapsedUs);
}

function toBytes(description: AllowSharedBufferSource): Uint8Array {
  if (description instanceof ArrayBuffer) return new Uint8Array(description.slice(0));
  const view = description as ArrayBufferView;
  return new Uint8Array(
    view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
