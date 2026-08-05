/**
 * The hidden capture page. Architecture report §1.1, §1.4, §10.2.
 *
 * ```
 * getDisplayMedia → MediaStreamTrackProcessor → VideoEncoder → encoded chunks → main
 * ```
 *
 * The audio half of this same page — the microphone and the system loopback — is
 * `./audio.ts`, which carries the two rules that belong only to audio.
 *
 * No UI, no framework, no DOM output. It exists because Electron already reaches
 * ScreenCaptureKit through `getDisplayMedia`, so a native helper would buy only
 * crash isolation — which a dedicated hidden window gives for free, with main
 * holding the file descriptors (§1.1).
 *
 * ## The three rules this file exists to keep
 *
 * 1. **`MediaStreamTrackProcessor` + `VideoEncoder`, never `MediaRecorder`.** The
 *    research scout measured `MediaRecorder` dropping 40–80% of frames on a screen
 *    track (§5.5). That is not a tuning problem; it is the wrong API.
 * 2. **Nothing raw crosses IPC.** What leaves this page is `EncodedVideoChunk` and
 *    `EncodedAudioChunk` bytes. A single 3456×2234 NV12 frame is 11.6 MB; at 30 fps
 *    that would be 347 MB/s of structured-clone traffic to accomplish nothing (§1.4).
 * 3. **Every frame is closed, in a `finally`.** WebCodecs frames are manually
 *    reference-counted, and a leaked one exhausts the pool and then simply stops
 *    producing frames — no error, no throw, just a capture that quietly stops
 *    (§10.2). The loop below closes in `finally` and asserts the live count on
 *    every iteration, so the *first* leak is loud rather than the hundredth.
 */

import {
  LOOPBACK_AUDIO_CONSTRAINTS,
  type CaptureEndReason,
  type CaptureOptions,
  type VideoPartReport,
} from '@loom/ipc';
import { TrackEpochEstimator } from '@loom/format';
import {
  loopbackFacts,
  micConstraints,
  micFacts,
  reportOf,
  startAudioCapture,
  stopAudioCapture,
  type AudioCapture,
  type AudioSink,
} from './audio.ts';
import { WebcamCapture, type WebcamSink } from './webcam.ts';

/**
 * Codec strings to try, highest level first.
 *
 * The level has to cover the display's pixel count; `isConfigSupported` is the
 * only honest way to find out which the machine's VideoToolbox will take. The
 * `avcC` that comes back from the encoder is what `recording.json` actually
 * records, so a downgrade here corrects itself downstream.
 */
const CODECS = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.42E028'];

/** Keyframe cadence during capture. Architecture report §7.1 fixes this at 1 s. */
const KEYFRAME_INTERVAL_US = 1_000_000;

/**
 * Frames the encoder may be behind before we start dropping.
 *
 * Dropping is better than queueing: a queue is memory this process holds, and
 * everything this process holds is what a crash costs. Drops are counted and end
 * up in `recording.json.capture.droppedFrames`, so they are visible rather than
 * silent.
 */
const MAX_ENCODE_QUEUE = 8;

interface Session {
  stream: MediaStream;
  track: MediaStreamTrack;
  reader: ReadableStreamDefaultReader<VideoFrame>;
  encoder: VideoEncoder;
  part: number;
  framesEncoded: number;
  framesDropped: number;
  metaSent: boolean;
  /**
   * The most recent frame's timestamp, and the `performance.now()` at which it
   * arrived — together they let a stop be placed on the encoder's clock.
   *
   * A screen track produces frames only when the screen changes, so a recording
   * that ends on a still screen can go seconds without one. The last frame has to
   * stand for that time, and it can only do so if main is told when capture
   * actually stopped.
   */
  lastFrameUs: number | null;
  lastFrameAtMs: number;
  /**
   * The first frame's timestamp, which is the recording clock's origin.
   *
   * Main learns it from the first chunk it is handed, so this is not the only
   * record of it — but the screen's part is described the same way every other
   * video part is (`alignVideoPart`), and that function takes a first and a last.
   */
  firstFrameUs: number | null;
  /**
   * Relates the video clock to the one the audio tracks are observed on.
   *
   * Chromium timestamps captured audio and captured video against different
   * epochs, so `startTimeSec` — an audio track's offset from the first screen
   * frame — cannot be a subtraction of the two without this. See
   * `TrackEpochEstimator`.
   */
  epoch: TrackEpochEstimator;
  /** Set once, by whichever of stop/track-end/error happens first. */
  ending: CaptureEndReason | null;
  endMessage: string | null;
  /**
   * The microphone and the system-audio loopback, when they were asked for and
   * could be started. A track that could not be captured is absent from this list
   * and named in `endMessage`; it never fails the recording (§7.3).
   */
  audio: AudioCapture[];
  /**
   * The camera, when one was asked for and could be opened. `null` covers both
   * "no camera was asked for" and "one was and it would not open", because §7.4
   * makes those the same thing as far as the rest of the recording is concerned.
   */
  webcam: WebcamCapture | null;
}

let session: Session | null = null;
let starting = false;

/**
 * Audio failures are reported, not thrown.
 *
 * The user pressed record to record their screen. A microphone that is not
 * permitted, a machine with no AAC encoder, a loopback track macOS declined to
 * hand over — each of those costs a track, and none of them is a reason to lose
 * the recording.
 */
const audioSink: AudioSink = {
  meta: (message) => {
    window.loom.capture.meta(message);
  },
  chunk: (message) => {
    window.loom.capture.chunk(message);
  },
  unavailable: (track, reason) => {
    console.error(`[capture] no ${track} track: ${reason}`);
    noteUnavailable(reason);
  },
};

/**
 * The camera's sink. Same shape and the same rule as the audio one: what it reports
 * is a track that is missing or a part that closed, never a recording that failed.
 *
 * `partEnded` is the §7.4 message — a camera unplugged mid-recording closes its part
 * and main finalizes that file while the screen carries on writing to its own.
 */
const webcamSink: WebcamSink = {
  meta: (message) => {
    window.loom.capture.meta(message);
  },
  chunk: (message) => {
    window.loom.capture.chunk(message);
  },
  partEnded: (message) => {
    window.loom.capture.partEnded(message);
  },
  unavailable: (reason) => {
    console.error(`[capture] no webcam track: ${reason}`);
    noteUnavailable(reason);
  },
  state: () => {
    // The recorder derives the camera's state from the parts main has actually
    // opened and closed, so there is nothing to forward from here: a banner driven
    // from the renderer could claim a camera was live while main held no part for
    // it. This hook exists so the capture page can log, not decide.
  },
};

/** Carry a missing track into the end report, so a stop says what it lost. */
function noteUnavailable(reason: string): void {
  if (session === null) return;
  session.endMessage = session.endMessage === null ? reason : `${session.endMessage}; ${reason}`;
}

window.loom.capture.onCommand((command) => {
  if (command.kind === 'start') {
    void begin(command.options);
  } else {
    void end('stopped');
  }
});

async function begin(options: CaptureOptions): Promise<void> {
  if (session !== null || starting) return;
  starting = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: options.fps,
        // Research trap 9: an unclamped 6K or 8K display overwhelms the encoder
        // and the disk. Clamping the *track* rather than scaling afterwards keeps
        // the pixels we never wanted from being produced at all.
        width: { max: options.maxDimension },
        height: { max: options.maxDimension },
      },
      // Research trap 3, and the whole of why this object is a constant: the
      // default loopback track is mono with echo cancellation, noise suppression
      // and gain control switched on. Main answers the request with
      // `audio: 'loopback'`; these are the constraints that track is held to.
      audio: options.systemAudio ? { ...LOOPBACK_AUDIO_CONSTRAINTS } : false,
    });

    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error('the screen stream carried no video track');

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        onEncoded(chunk, metadata);
      },
      error: (error: DOMException) => {
        void end('error', error.message);
      },
    });

    const current: Session = {
      stream,
      track,
      reader: new MediaStreamTrackProcessor({ track }).readable.getReader(),
      encoder,
      part: 0,
      framesEncoded: 0,
      framesDropped: 0,
      metaSent: false,
      lastFrameUs: null,
      lastFrameAtMs: 0,
      firstFrameUs: null,
      epoch: new TrackEpochEstimator(),
      ending: null,
      endMessage: null,
      audio: [],
      webcam: null,
    };
    session = current;

    // The screen source ending on its own is not a normal stop — a revoked Screen
    // Recording permission and the macOS "Stop sharing" control both arrive this
    // way (§7.3). Main is told which it was so it can finalize rather than wait.
    track.addEventListener('ended', () => {
      void end('source-ended', 'the screen source stopped');
    });

    // Audio and the camera are started before the video pump, so every track
    // begins as close together as the platform allows; whatever offset remains is
    // measured and recorded as `startTimeSec` rather than assumed away (§5.4
    // mechanism 2).
    const captures = await startAudio(stream, options);
    current.audio = captures;
    // The camera cannot fail the recording, so its failure is not caught here —
    // `WebcamCapture.start` reports it and answers `null`.
    const webcam = await WebcamCapture.start(options, webcamSink);
    current.webcam = webcam;
    starting = false;

    // A stop, a screen track that ended and an encoder error are all reachable
    // across those awaits, and `getUserMedia` holds them open for as long as macOS
    // takes to answer the microphone or camera prompt. A device opened after the
    // session is over is stopped here: a microphone or camera left running would
    // keep its indicator lit and keep posting chunks under the same track and part
    // key, which the *next* recording would accept as its own.
    if (session !== current || current.ending !== null) {
      await Promise.all(captures.map((capture) => stopAudioCapture(capture)));
      await webcam?.stop();
      return;
    }

    await pump(current, options);
  } catch (error) {
    starting = false;
    const started = session;
    session = null;
    if (started !== null) await release(started);
    window.loom.capture.failed(describe(error));
  }
}

/**
 * Start whichever audio tracks were asked for, and lose none of the recording if
 * one of them cannot start.
 *
 * The system track rides on the display stream — it is the same `getDisplayMedia`
 * call, answered by main with `audio: 'loopback'` — so it is not stopped
 * separately. The microphone is its own stream and its own device permission, and
 * is the one most likely to be refused.
 */
async function startAudio(display: MediaStream, options: CaptureOptions): Promise<AudioCapture[]> {
  const captures: AudioCapture[] = [];

  if (options.systemAudio) {
    const loopback = display.getAudioTracks()[0];
    if (loopback === undefined) {
      audioSink.unavailable('system', 'macOS handed back no system-audio track');
    } else {
      try {
        const capture = await startAudioCapture(
          'system',
          loopback,
          loopbackFacts(loopback),
          null,
          options,
          audioSink,
        );
        if (capture !== null) captures.push(capture);
      } catch (error) {
        audioSink.unavailable('system', `system audio could not be captured: ${describe(error)}`);
      }
    }
  }

  if (options.micDeviceId !== null) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(options) });
      const mic = stream.getAudioTracks()[0];
      if (mic === undefined) throw new Error('the microphone stream carried no audio track');
      const capture = await startAudioCapture(
        'mic',
        mic,
        micFacts(mic),
        stream,
        options,
        audioSink,
      );
      if (capture === null) for (const track of stream.getTracks()) track.stop();
      else captures.push(capture);
    } catch (error) {
      // Microphone permission is phase 2's to ask for. Until it has been granted
      // this is the ordinary case, and it costs a track, not a recording.
      audioSink.unavailable('mic', `the microphone could not be opened: ${describe(error)}`);
    }
  }

  return captures;
}

/**
 * The frame loop.
 *
 * One `VideoFrame` is alive at a time, and it is closed in a `finally` so that an
 * encoder that throws, a configure that fails, or a drop decision all release it.
 * `live` is the assertion that this is actually true — it trips on the first leak,
 * not the hundredth (§10.2).
 */
async function pump(current: Session, options: CaptureOptions): Promise<void> {
  let configured = false;
  let lastKeyframeUs = Number.NEGATIVE_INFINITY;
  let live = 0;

  for (;;) {
    const { value, done } = await current.reader.read();
    if (done || value === undefined) break;
    live += 1;
    try {
      if (live > 1) {
        throw new Error(`${String(live)} VideoFrames are live at once; one of them leaked`);
      }
      if (current.ending !== null) break;

      if (!configured) {
        await configure(current.encoder, value, options);
        configured = true;
      }

      // Backpressure before the encode, so the frame we decline is closed by the
      // `finally` below rather than handed to a queue we already know is behind.
      if (current.encoder.encodeQueueSize >= MAX_ENCODE_QUEUE) {
        current.framesDropped += 1;
        continue;
      }

      // A frame carries no duration of its own, so its end is its timestamp: it
      // exists the instant it is captured.
      current.epoch.observe(value.timestamp, performance.now() * 1000);

      const keyFrame = value.timestamp - lastKeyframeUs >= KEYFRAME_INTERVAL_US;
      if (keyFrame) lastKeyframeUs = value.timestamp;
      current.encoder.encode(value, { keyFrame });
      current.framesEncoded += 1;
      current.firstFrameUs ??= value.timestamp;
      current.lastFrameUs = value.timestamp;
      current.lastFrameAtMs = performance.now();
    } finally {
      value.close();
      live -= 1;
    }
  }

  await end(current.ending ?? 'source-ended', current.endMessage);
}

/**
 * Configure the encoder from the first frame.
 *
 * Lazily, because the frame is the only honest source of the coded size: the
 * constraints handed to `getDisplayMedia` are a request, and what ScreenCaptureKit
 * delivers on a retina display is its own business.
 */
async function configure(
  encoder: VideoEncoder,
  frame: VideoFrame,
  options: CaptureOptions,
): Promise<void> {
  // H.264 wants even dimensions; a 4:2:0 chroma plane has no half pixels.
  const width = Math.max(2, frame.displayWidth - (frame.displayWidth % 2));
  const height = Math.max(2, frame.displayHeight - (frame.displayHeight % 2));

  for (const codec of CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: options.bitrate,
      framerate: options.fps,
      // `realtime` is what keeps B-frames out of the stream, which is what lets
      // the frame index treat presentation and decode order as the same thing
      // (§2.4) and lets a fragment carry its exact time in `tfdt`.
      latencyMode: 'realtime',
      // AVCC framing, so chunks arrive length-prefixed with the parameter sets in
      // `decoderConfig.description` — exactly what an MP4 sample entry wants.
      avc: { format: 'avc' },
      hardwareAcceleration: 'prefer-hardware',
    };
    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported === true) {
      encoder.configure(config);
      return;
    }
  }
  throw new Error(`no supported H.264 configuration for ${String(width)}x${String(height)}`);
}

function onEncoded(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
  const current = session;
  if (current === null) return;

  if (!current.metaSent) {
    const config = metadata?.decoderConfig;
    const description = config?.description;
    if (config === undefined || description === undefined) {
      void end('error', 'the encoder produced no decoder configuration');
      return;
    }
    current.metaSent = true;
    window.loom.capture.meta({
      track: 'screen',
      part: current.part,
      decoderConfig: {
        codec: config.codec,
        ...(config.codedWidth === undefined ? {} : { codedWidth: config.codedWidth }),
        ...(config.codedHeight === undefined ? {} : { codedHeight: config.codedHeight }),
        description: toBytes(description),
      },
    });
  }

  // `copyTo` into a fresh buffer: what crosses IPC is a copy of the encoded bytes
  // and nothing else. The chunk itself is not transferable and must not be kept.
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  window.loom.capture.chunk({
    track: 'screen',
    part: current.part,
    kind: chunk.type === 'key' ? 'key' : 'delta',
    timestampUs: chunk.timestamp,
    durationUs: chunk.duration ?? null,
    data,
  });
}

/**
 * Stop producing frames and tell main what we produced.
 *
 * `encoder.flush()` before `close()`: the encoder may be holding frames it has
 * not emitted, and those frames are already on the user's screen-recording clock.
 * Dropping them to stop a few milliseconds sooner would be losing footage the
 * capture already succeeded at.
 *
 * `current.ending` is what makes this idempotent — a stop, a track that ended and
 * an encoder error can all arrive at once, and only the first gets past it. The
 * module-level `session` is cleared *after* the flush, because {@link onEncoded}
 * routes on it: clearing it first would discard exactly the frames the flush
 * exists to collect.
 */
async function end(reason: CaptureEndReason, detail?: string | null): Promise<void> {
  const current = session;
  if (current === null) return;
  if (current.ending !== null) return;
  current.ending = reason;
  current.endMessage = detail ?? null;

  try {
    await current.reader.cancel().catch(() => undefined);
    current.track.stop();
    if (current.encoder.state === 'configured') await current.encoder.flush();
    // Audio and the camera flush alongside, not after: each encoder holds buffers
    // of its own, and they are footage the capture already succeeded at.
    await Promise.all([
      ...current.audio.map((capture) => stopAudioCapture(capture)),
      current.webcam?.stop() ?? Promise.resolve(),
    ]);
  } catch (error) {
    current.endMessage ??= describe(error);
  } finally {
    if (session === current) session = null;
    await release(current);
  }

  const endedAtUs = stoppedAtUs(current);
  window.loom.capture.ended({
    reason,
    endedAtUs,
    framesEncoded: current.framesEncoded,
    framesDropped: current.framesDropped,
    epochOffsetUs: current.epoch.offsetUs,
    ...(current.endMessage === null ? {} : { message: current.endMessage }),
    // One entry per audio track that produced anything — the measurements only
    // this process ever had (§5.5). Main writes them; it cannot recompute them.
    ...(current.audio.length === 0 ? {} : { audio: current.audio.map(reportOf) }),
    // And one per video part that was still open. Parts that closed earlier — a
    // camera unplugged mid-recording — arrived as `partEnded` and main has already
    // finalized them; sending them again would close the same file twice.
    video: videoReports(current, reason, endedAtUs),
  });
}

/**
 * The video parts still open when capture stopped.
 *
 * The screen's entry says the same thing as the report's own `endedAtUs`,
 * `framesEncoded` and `framesDropped` — it is here so that main has one uniform way
 * to close the last part of every video track, and the flat fields stay because
 * phase 1 and phase 3 send them and neither should have to change to add a camera.
 */
function videoReports(
  current: Session,
  reason: CaptureEndReason,
  endedAtUs: number | null,
): VideoPartReport[] {
  const reports: VideoPartReport[] = [
    {
      track: 'screen',
      part: current.part,
      firstTimestampUs: current.firstFrameUs,
      lastTimestampUs: current.lastFrameUs,
      endedAtUs,
      epochOffsetUs: current.epoch.offsetUs,
      framesEncoded: current.framesEncoded,
      framesDropped: current.framesDropped,
      endedEarly: reason !== 'stopped',
    },
  ];
  const webcam = current.webcam?.openPartReport ?? null;
  if (webcam !== null) reports.push(webcam);
  return reports;
}

async function release(current: Session): Promise<void> {
  try {
    if (current.encoder.state !== 'closed') current.encoder.close();
  } catch {
    // A closed encoder is the goal; a failure to close one is not worth reporting
    // over whatever caused us to be here.
  }
  await Promise.all([
    ...current.audio.map((capture) => stopAudioCapture(capture)),
    current.webcam?.stop() ?? Promise.resolve(),
  ]).catch(() => undefined);
  for (const track of current.stream.getTracks()) track.stop();
  await current.reader.cancel().catch(() => undefined);
}

/**
 * When capture stopped, on the encoder's clock.
 *
 * There is no clock reading available for "now" in `VideoFrame.timestamp` units —
 * the only samples of that clock are the frames themselves. So: the last frame's
 * timestamp, plus the wall time elapsed since it arrived. Both clocks run at the
 * same rate over the sub-second gap this covers, and being a millisecond out at the
 * end of a recording is not a thing anyone can see. Being three seconds short,
 * which is what happens without this, is.
 */
function stoppedAtUs(current: Session): number | null {
  if (current.lastFrameUs === null) return null;
  const elapsedUs = Math.max(0, (performance.now() - current.lastFrameAtMs) * 1000);
  return Math.round(current.lastFrameUs + elapsedUs);
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
