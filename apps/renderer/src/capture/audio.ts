/**
 * Audio capture: the microphone and what comes out of the speakers.
 *
 * ```
 * getDisplayMedia({ audio: … })  ─┐
 * getUserMedia({ audio: … })     ─┴► MediaStreamTrackProcessor → AudioEncoder → main
 * ```
 *
 * Same shape as the video half in `main.ts`, same three rules (encoded bytes only,
 * every frame closed in a `finally`, nothing raw across IPC), plus two that belong
 * only to audio.
 *
 * ## Research trap 3, which is the reason this file has constants in it
 *
 * > *"The system-audio track defaults to mono with AEC + NS + AGC enabled and will
 * > wreck any recording containing music or video. Always pass explicit
 * > constraints. Loom's own docs admit this trap."*
 *
 * The default loopback track really is `channelCount: 1` with
 * `echoCancellation/noiseSuppression/autoGainControl: true` (research §5.2). None
 * of the three has anything to do on a loopback capture — there is no echo, no
 * room noise and no level to ride — and all three are irreversible by the time
 * anyone notices, because they are applied before we ever see a sample. So the
 * constraints are stated explicitly, and then **read back and checked**: a
 * constraint that was ignored is recorded in `recording.json` and said out loud,
 * rather than becoming a recording that sounds slightly wrong for reasons nobody
 * can reconstruct.
 *
 * ## Why the meter is here and not in main
 *
 * `measuredSampleRate` and `gaps` (§5.5, §5.4.5) can only be read from the raw
 * buffer stream: a "48 kHz" device does not run at 48000.000 Hz, and an encoder
 * that is handed a stream with a hole in it emits a stream with no hole in it. By
 * the time bytes reach main the evidence is gone. `AudioCaptureMeter` is pure and
 * lives in `@loom/format` beside the fields it fills in, so what crosses IPC is a
 * handful of numbers rather than a decision.
 */

import { AudioCaptureMeter, TrackEpochEstimator } from '@loom/format';
import {
  violatedLoopbackConstraints,
  type AudioPartEndMsg,
  type AudioTrackFacts,
  type AudioTrackKey,
  type AudioTrackReport,
  type AudioTrackSettings,
  type CaptureOptions,
} from '@loom/ipc';

/** AAC-LC. The only audio codec an `.m4a` in this format carries (§2.1). */
const AUDIO_CODEC = 'mp4a.40.2';

/**
 * Buffers the encoder may be behind before we start dropping.
 *
 * Higher than the video budget because an audio buffer is 10 ms and a dropped one
 * is a hole in the recording rather than a repeated frame — but bounded, because a
 * queue is memory this process holds and everything it holds is what a crash
 * costs. A drop is recorded as the gap it is, never silently absorbed.
 */
const MAX_AUDIO_ENCODE_QUEUE = 32;

export interface AudioCapture {
  track: AudioTrackKey;
  part: number;
  facts: AudioTrackFacts;
  meter: AudioCaptureMeter;
  /** Relates this track's clock to the one every other track is observed on. */
  epoch: TrackEpochEstimator;
  mediaTrack: MediaStreamTrack;
  reader: ReadableStreamDefaultReader<AudioData>;
  encoder: AudioEncoder;
  /** Set to the stream we own, so it is stopped with us. `null` for the loopback. */
  stream: MediaStream | null;
  metaSent: boolean;
  endedEarly: boolean;
  /** Resolves when the pump has stopped reading. */
  pump: Promise<void> | null;
}

export interface AudioSink {
  meta(message: {
    track: AudioTrackKey;
    part: number;
    decoderConfig: {
      codec: string;
      sampleRate?: number;
      numberOfChannels?: number;
      description?: Uint8Array;
    };
    audio: AudioTrackFacts;
  }): void;
  chunk(message: {
    track: AudioTrackKey;
    part: number;
    kind: 'key' | 'delta';
    timestampUs: number;
    durationUs: number | null;
    data: Uint8Array;
  }): void;
  /** A track that could not be captured at all. The recording continues without it. */
  unavailable(track: AudioTrackKey, reason: string): void;
  /**
   * A track that had started and then stopped, while the recording was still going.
   *
   * Reported the moment it happens rather than only in the end report, because the
   * one fact that tells a revoked Microphone grant apart from an unplugged interface
   * — what TCC says — is only true *now*, and by the end of a twenty-minute
   * recording it says nothing about minute two (§7.3).
   *
   * What is reported is the observation, never the conclusion: this file cannot read
   * TCC, and a renderer that named a cause would be guessing.
   */
  ended(message: AudioPartEndMsg): void;
}

/** `getSettings()`, reduced to the five fields trap 3 is about. */
export function settingsOf(mediaTrack: MediaStreamTrack): AudioTrackSettings {
  const settings = mediaTrack.getSettings();
  return {
    sampleRate: settings.sampleRate ?? 48000,
    channelCount: settings.channelCount ?? 1,
    echoCancellation: settings.echoCancellation ?? false,
    noiseSuppression: settings.noiseSuppression ?? false,
    autoGainControl: settings.autoGainControl ?? false,
  };
}

/**
 * Constraints for the microphone.
 *
 * Voice processing is off unless the user asked for it — see
 * `CaptureOptions.micVoiceProcessing` for why the default is the conservative one.
 * Mono: a built-in microphone is one capsule, and a stereo track of the same
 * signal twice is bytes for nothing.
 */
export function micConstraints(options: CaptureOptions): MediaTrackConstraints {
  const processing = options.micVoiceProcessing;
  return {
    ...(options.micDeviceId === null || options.micDeviceId === 'default'
      ? {}
      : { deviceId: { exact: options.micDeviceId } }),
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    channelCount: 1,
    sampleRate: 48000,
  };
}

/**
 * Take the system-audio track off the display stream, checking trap 3's
 * constraints against what we actually got.
 *
 * A platform that ignores a constraint gets a violation recorded rather than a
 * refusal: the user asked for system audio, and processed system audio still beats
 * none. What must not happen is silence about it — `recording.json` carries the
 * settings that were really applied, so a recording that sounds wrong is
 * diagnosable a month later.
 */
export function loopbackFacts(mediaTrack: MediaStreamTrack): AudioTrackFacts {
  const settings = settingsOf(mediaTrack);
  const violations = violatedLoopbackConstraints(settings);
  if (violations.length > 0) {
    console.error(
      `[capture] the system-audio track kept ${violations.join(', ')} despite being asked ` +
        'not to. Research trap 3: this is voice processing applied to a loopback ' +
        'capture, and any music or video in the recording will sound mangled. The ' +
        'settings actually applied are recorded in recording.json.',
    );
  }
  return {
    deviceId: mediaTrack.getSettings().deviceId ?? 'loopback',
    deviceName: mediaTrack.label.length > 0 ? mediaTrack.label : 'System audio',
    source: 'getdisplaymedia-loopback',
    settings,
    violations,
  };
}

export function micFacts(mediaTrack: MediaStreamTrack): AudioTrackFacts {
  return {
    deviceId: mediaTrack.getSettings().deviceId ?? null,
    deviceName: mediaTrack.label.length > 0 ? mediaTrack.label : null,
    source: 'getusermedia',
    settings: settingsOf(mediaTrack),
    violations: [],
  };
}

/**
 * Configure an encoder for one audio track and start pumping buffers into it.
 *
 * Returns `null` when this machine cannot encode the track, which is a track the
 * recording does without — never a recording that fails. The screen is what the
 * user pressed record for.
 */
export async function startAudioCapture(
  track: AudioTrackKey,
  mediaTrack: MediaStreamTrack,
  facts: AudioTrackFacts,
  stream: MediaStream | null,
  options: CaptureOptions,
  sink: AudioSink,
): Promise<AudioCapture | null> {
  const config: AudioEncoderConfig = {
    codec: AUDIO_CODEC,
    sampleRate: facts.settings.sampleRate,
    numberOfChannels: facts.settings.channelCount,
    bitrate: options.audioBitrate,
    // Raw AAC frames plus an AudioSpecificConfig, which is what an MP4 sample
    // entry wants. ADTS would mean stripping a header off every frame.
    aac: { format: 'aac' },
  };
  const support = await AudioEncoder.isConfigSupported(config);
  if (support.supported !== true) {
    sink.unavailable(
      track,
      `this machine cannot encode ${String(facts.settings.channelCount)}ch ` +
        `${String(facts.settings.sampleRate)} Hz AAC`,
    );
    return null;
  }

  const capture: AudioCapture = {
    track,
    part: 0,
    facts,
    meter: new AudioCaptureMeter({ nominalSampleRate: facts.settings.sampleRate }),
    epoch: new TrackEpochEstimator(),
    mediaTrack,
    reader: new MediaStreamTrackProcessor<AudioData>({ track: mediaTrack }).readable.getReader(),
    encoder: new AudioEncoder({
      output: (chunk, metadata) => {
        onEncoded(capture, chunk, metadata, sink);
      },
      error: (error: DOMException) => {
        console.error(`[capture] the ${track} encoder failed:`, error.message);
        endTrack(capture, sink, 'encoder-failed', error.message);
      },
    }),
    stream,
    metaSent: false,
    endedEarly: false,
    pump: null,
  };
  capture.encoder.configure(config);

  // §7.3, and the one event this whole path turns on: an audio track that stops on
  // its own. That is the shape a revoked Microphone grant takes *and* the shape an
  // unplugged interface takes, and this file has no way to tell them apart — reading
  // TCC is main's alone. So the observation is reported and main decides which it
  // was; see {@link AudioSink.ended}, and `audioEndReasonFor` in
  // `apps/main/src/recorder/session.ts` for what is done with it.
  mediaTrack.addEventListener('ended', () => {
    endTrack(capture, sink, 'track-ended', `the ${track} track ended`);
  });

  capture.pump = pumpAudio(capture);
  return capture;
}

/**
 * The buffer loop.
 *
 * One `AudioData` is alive at a time and it is closed in a `finally`, for the same
 * reason the video loop does it: WebCodecs buffers are manually reference-counted,
 * and a leaked one exhausts the pool and then simply stops producing — no error,
 * no throw, just a track that quietly goes silent (§10.2).
 */
async function pumpAudio(capture: AudioCapture): Promise<void> {
  for (;;) {
    let result: ReadableStreamReadResult<AudioData>;
    try {
      result = await capture.reader.read();
    } catch {
      break;
    }
    const value = result.value;
    if (result.done || value === undefined) break;
    try {
      if (capture.encoder.state !== 'configured') break;
      const facts = { timestampUs: value.timestamp, frameCount: value.numberOfFrames };
      // The buffer's *end*, because a buffer cannot be delivered before its last
      // sample was captured. See `TrackEpochEstimator`.
      capture.epoch.observe(
        facts.timestampUs + (facts.frameCount / capture.facts.settings.sampleRate) * 1_000_000,
        performance.now() * 1000,
      );
      // Backpressure before the meter, so a dropped buffer is measured as the gap
      // it is rather than counted as audio that reached the file.
      if (capture.encoder.encodeQueueSize >= MAX_AUDIO_ENCODE_QUEUE) {
        capture.meter.drop(facts);
        continue;
      }
      capture.meter.push(facts);
      capture.encoder.encode(value);
    } finally {
      value.close();
    }
  }
}

function onEncoded(
  capture: AudioCapture,
  chunk: EncodedAudioChunk,
  metadata: EncodedAudioChunkMetadata | undefined,
  sink: AudioSink,
): void {
  if (!capture.metaSent) {
    const config = metadata?.decoderConfig;
    const description = config?.description;
    if (config === undefined || description === undefined) {
      // Without an AudioSpecificConfig there is no `esds`, and a part with no
      // `esds` is a file no decoder will open. Better no track than that.
      console.error(`[capture] the ${capture.track} encoder produced no decoder configuration`);
      endTrack(capture, sink, 'encoder-failed', 'the encoder produced no decoder configuration');
      return;
    }
    capture.metaSent = true;
    sink.meta({
      track: capture.track,
      part: capture.part,
      decoderConfig: {
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
        description: toBytes(description),
      },
      audio: capture.facts,
    });
  }

  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  sink.chunk({
    track: capture.track,
    part: capture.part,
    // Every AAC frame stands alone; a demuxer that believed otherwise could not
    // seek anywhere in the track.
    kind: 'key',
    timestampUs: chunk.timestamp,
    durationUs: chunk.duration ?? null,
    data,
  });
}

/**
 * This track has stopped on its own. Mark it, tell main, and wind it down.
 *
 * Idempotent on `endedEarly`, because the three ways a track can stop can arrive
 * together — `ended` on the media track, an encoder error, and the flush that
 * follows either — and main must be told once. The stop is not awaited: main is
 * being told a fact, and a report that waits for an encoder to flush is a report
 * that arrives after the thing it is about mattered.
 */
function endTrack(
  capture: AudioCapture,
  sink: AudioSink,
  cause: AudioPartEndMsg['cause'],
  detail: string,
): void {
  if (capture.endedEarly) return;
  capture.endedEarly = true;
  sink.ended({ track: capture.track, part: capture.part, cause, detail });
  void stopAudioCapture(capture);
}

/**
 * Stop one audio track and flush what its encoder still holds.
 *
 * `flush()` before `close()`, exactly as the video path does it: the encoder may be
 * holding buffers it has not emitted, and those are audio the capture already
 * succeeded at.
 */
export async function stopAudioCapture(capture: AudioCapture): Promise<void> {
  await capture.reader.cancel().catch(() => undefined);
  await capture.pump?.catch(() => undefined);
  try {
    capture.mediaTrack.stop();
    if (capture.encoder.state === 'configured') await capture.encoder.flush();
  } catch (error) {
    console.error(`[capture] flushing the ${capture.track} encoder failed:`, error);
  }
  try {
    if (capture.encoder.state !== 'closed') capture.encoder.close();
  } catch {
    // A closed encoder is the goal; failing to close one is not worth reporting.
  }
  if (capture.stream !== null) for (const track of capture.stream.getTracks()) track.stop();
}

/** What main needs to write this track into `recording.json`. */
export function reportOf(capture: AudioCapture): AudioTrackReport {
  return {
    track: capture.track,
    part: capture.part,
    facts: capture.facts,
    summary: capture.meter.summary,
    epochOffsetUs: capture.epoch.offsetUs,
    endedEarly: capture.endedEarly,
    // **No `endReason`, deliberately.** This used to say `device-lost` for every
    // track that ended on its own, which is how a Microphone grant the user had just
    // withdrawn was written into `recording.json` as a disconnected device —
    // `decision-mic-revocation.md` is the captain's answer to that. Telling the two
    // apart takes a TCC read and reading TCC is main's alone, so the reason is main's
    // to fill in: `audioEndReasonFor` in `apps/main/src/recorder/session.ts`, from the
    // {@link AudioSink.ended} report this file sends when it happens.
  };
}

function toBytes(description: AllowSharedBufferSource): Uint8Array {
  if (description instanceof ArrayBuffer) return new Uint8Array(description.slice(0));
  const view = description as ArrayBufferView;
  return new Uint8Array(
    view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
  );
}
