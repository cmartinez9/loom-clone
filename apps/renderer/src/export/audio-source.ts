/**
 * One captured audio track, readable at any instant on the recording clock.
 *
 * This is where §5.4's mechanisms 3 and 5 and all of §5.5 actually land, and they
 * land as one mechanism rather than three:
 *
 * ```
 * sampleIndex = run.firstSample + (t - run.startSec) * measuredSampleRate
 * ```
 *
 * `audioRuns()` (`@loom/format`) splits a part into the runs of contiguous samples
 * it holds, each with the instant on the recording clock at which it starts — so a
 * recorded **gap** is simply a `t` that falls between two runs, and the answer there
 * is silence of exactly the right length (§5.4 mechanism 5: *"Concatenating across a
 * gap shortens the audio track by the gap length and desynchronises everything after
 * it — permanently, and invisibly at first."*).
 *
 * And **drift** is the `measuredSampleRate` in that line. A device that reports
 * 48000 Hz is not running at 48000.000 Hz; reading the stream at the nominal rate
 * walks off the video by 13.9 ms over half an hour at the rate this project measured
 * and 90 ms at a plausible 50 ppm (§5.5, §10.1). Reading it at the *measured* rate
 * is the resample §5.5 asks for — there is no separate resampling stage, because a
 * separate stage would be a second opinion about the same arithmetic.
 *
 * ## Streaming, and the one case that is not
 *
 * A twenty-minute stereo track is 460 MB decoded, so nothing here holds a whole
 * track. Frames are decoded into a sliding window that follows the read head and is
 * trimmed behind it. A read that jumps *backwards* out of the window — which only a
 * reordered clip list can produce — resets the decoder and decodes forward again
 * from a couple of frames before the target. AAC-LC is a lapped transform, so those
 * preroll frames are not optional: without them the first samples after a seek are
 * wrong rather than missing.
 */

import { audioRuns, type AudioPart, type AudioRun, type Seconds } from '@loom/format';
import type { AudioPartMedia } from '../media/loom-media.ts';

/** Frames decoded before the target on a backwards seek. AAC-LC needs one; two is safe. */
const PREROLL_FRAMES = 2;

/** Frames fed per decode batch. Enough to keep the decoder busy, small enough to trim. */
const BATCH_FRAMES = 16;

/** Longest wait for a batch's outputs before the decoder is called dead. */
const DECODE_TIMEOUT_MS = 5000;

/** Seconds of decoded audio kept behind the read head. */
const RETAIN_BEHIND_SEC = 0.5;

/** What an `AudioDecoder` looks like to this file, so a test can supply one. */
export interface AudioDecoderLike {
  readonly state: 'unconfigured' | 'configured' | 'closed';
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunk): void;
  reset(): void;
  close(): void;
}

export interface AudioDecoderCallbacks {
  /** Planar f32 samples, one array per channel, plus where they start. */
  output: (block: DecodedBlock) => void;
  error: (error: Error) => void;
}

export type AudioDecoderFactory = (callbacks: AudioDecoderCallbacks) => AudioDecoderLike;

/** A run of decoded samples, planar f32, indexed in the part's *encoded* stream. */
export interface DecodedBlock {
  /** Index of `channels[*][0]` in the decoded stream, priming included. */
  firstSample: number;
  length: number;
  channels: Float32Array[];
}

/**
 * The platform decoder, wrapped so this file never touches an `AudioData`'s
 * lifetime rules in more than one place: every one is closed in a `finally`, on
 * every path, exactly as §10.2 requires of the video side.
 */
export function webCodecsAudioDecoderFactory(callbacks: AudioDecoderCallbacks): AudioDecoderLike {
  let nextSample = 0;
  return new AudioDecoder({
    output: (data) => {
      try {
        const channels: Float32Array[] = [];
        for (let channel = 0; channel < data.numberOfChannels; channel++) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
          channels.push(plane);
        }
        callbacks.output({ firstSample: nextSample, length: data.numberOfFrames, channels });
        nextSample += data.numberOfFrames;
      } finally {
        data.close();
      }
    },
    error: (error: DOMException) => {
      callbacks.error(error instanceof Error ? error : new Error(String(error)));
    },
  });
}

interface PartState {
  part: AudioPart;
  media: AudioPartMedia;
  runs: AudioRun[];
  /** Recording-clock extent, for choosing the part covering an instant. */
  startSec: Seconds;
  endSec: Seconds;
}

export interface AudioSourceTrackOptions {
  parts: { part: AudioPart; media: AudioPartMedia }[];
  decoderFactory?: AudioDecoderFactory;
}

export class AudioSourceTrack {
  readonly channels: number;
  readonly #parts: PartState[];
  readonly #decoderFactory: AudioDecoderFactory;

  #decoder: AudioDecoderLike | null = null;
  /** The part the decoder is currently positioned in. */
  #openPart: PartState | null = null;
  /** Decoded blocks in ascending order, covering the read head. */
  #window: DecodedBlock[] = [];
  /** Next encoded frame to feed, as an index into `#openPart.media.samples`. */
  #nextFrame = 0;
  #outputs = 0;
  #error: Error | null = null;
  #closed = false;

  constructor(options: AudioSourceTrackOptions) {
    this.#parts = options.parts
      .map(({ part, media }) => ({
        part,
        media,
        runs: audioRuns(part),
        startSec: part.startTimeSec,
        endSec: part.startTimeSec + part.durationSec,
      }))
      .sort((a, b) => a.startSec - b.startSec);
    this.channels = Math.max(1, this.#parts[0]?.media.channels ?? 1);
    this.#decoderFactory = options.decoderFactory ?? webCodecsAudioDecoderFactory;
  }

  get durationSec(): Seconds {
    return this.#parts.at(-1)?.endSec ?? 0;
  }

  /**
   * Fill `out` with `count` samples starting at recording-clock time `startSec`,
   * advancing `1 / outRate` per sample.
   *
   * `out` is planar and is **added to**, not overwritten: two tracks mix into the
   * same buffers, which is what makes the mic and the system track one line each
   * rather than a mixing stage of their own.
   */
  async mixInto(
    out: Float32Array[],
    startSec: Seconds,
    count: number,
    outRate: number,
    gain: number,
  ): Promise<void> {
    if (this.#closed || gain === 0) return;
    const endSec = startSec + count / outRate;
    const part = this.#partCovering(startSec, endSec);
    if (part === null) return;

    // One `ensure` for the whole block rather than one per sample: the window has to
    // cover the block's span before any of it is read, or the read would decode
    // inside the interpolation loop and the loop would be doing I/O per sample.
    // A block may begin or end inside a recorded gap, where there is no position at
    // all. The window still has to cover whatever part of the block *is* audio, so
    // the span is taken over the positions that exist — and if neither end does, the
    // whole block is silence and there is nothing to decode.
    const ends = [this.#positionAt(part, startSec), this.#positionAt(part, endSec)].filter(
      (p): p is number => p !== null,
    );
    if (ends.length === 0) return;
    const from = Math.floor(Math.min(...ends)) - 1;
    const to = Math.ceil(Math.max(...ends)) + 2;
    await this.#ensure(part, from, to);

    for (let i = 0; i < count; i++) {
      const t = startSec + i / outRate;
      const position = this.#positionAt(part, t);
      if (position === null) continue;
      for (let channel = 0; channel < out.length; channel++) {
        const plane = out[channel];
        if (plane === undefined) continue;
        // A mono source feeds every output channel; a stereo one feeds its own.
        const source = Math.min(channel, this.channels - 1);
        plane[i] = (plane[i] ?? 0) + this.#sampleAt(position, source) * gain;
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#tearDownDecoder();
    this.#window = [];
  }

  // ------------------------------------------------------------------ internals

  #partCovering(fromSec: Seconds, toSec: Seconds): PartState | null {
    for (const part of this.#parts) {
      if (fromSec < part.endSec && toSec > part.startSec) return part;
    }
    return null;
  }

  /**
   * Position of recording-clock time `t` in the part's decoded stream, priming
   * included — or `null` when `t` falls in a recorded gap, which is silence.
   */
  #positionAt(part: PartState, t: Seconds): number | null {
    const rate = part.part.measuredSampleRate > 0 ? part.part.measuredSampleRate : 0;
    if (rate <= 0) return null;
    for (const run of part.runs) {
      const runEndSec = run.startSec + run.sampleCount / rate;
      if (t < run.startSec) return null;
      if (t < runEndSec) {
        return part.media.encoderDelaySamples + run.firstSample + (t - run.startSec) * rate;
      }
    }
    return null;
  }

  /** Linear interpolation between the two decoded samples around `position`. */
  #sampleAt(position: number, channel: number): number {
    const low = Math.floor(position);
    const fraction = position - low;
    const a = this.#rawSample(low, channel);
    const b = fraction === 0 ? a : this.#rawSample(low + 1, channel);
    return a + (b - a) * fraction;
  }

  #rawSample(index: number, channel: number): number {
    for (const block of this.#window) {
      if (index < block.firstSample) return 0;
      if (index < block.firstSample + block.length) {
        return block.channels[channel]?.[index - block.firstSample] ?? 0;
      }
    }
    return 0;
  }

  /** Decode until the window covers `[from, to)`, seeking backwards if it must. */
  async #ensure(part: PartState, from: number, to: number): Promise<void> {
    if (this.#openPart !== part) this.#seek(part, from);
    else if (from < (this.#window[0]?.firstSample ?? Number.POSITIVE_INFINITY)) {
      this.#seek(part, from);
    }

    for (;;) {
      this.#raiseIfFailed();
      const covered = this.#coveredThrough();
      if (covered >= to) break;
      if (this.#nextFrame >= part.media.samples.length) break;
      await this.#decodeBatch(part);
    }
    this.#trimBefore(from - Math.round(RETAIN_BEHIND_SEC * part.media.sampleRate));
  }

  #coveredThrough(): number {
    const last = this.#window.at(-1);
    return last === undefined ? Number.NEGATIVE_INFINITY : last.firstSample + last.length;
  }

  /**
   * Point the decoder at the frame containing `position`, minus the preroll AAC-LC
   * needs to produce correct samples rather than merely some samples.
   */
  #seek(part: PartState, position: number): void {
    this.#tearDownDecoder();
    this.#window = [];
    this.#openPart = part;
    const target = Math.max(0, position);
    let frame = part.media.samples.findIndex(
      (sample) => target < sample.firstSample + sample.sampleCount,
    );
    if (frame < 0) frame = Math.max(0, part.media.samples.length - 1);
    this.#nextFrame = Math.max(0, frame - PREROLL_FRAMES);
  }

  async #decodeBatch(part: PartState): Promise<void> {
    const decoder = this.#configured(part);
    const start = this.#outputs;
    let fed = 0;
    while (fed < BATCH_FRAMES && this.#nextFrame < part.media.samples.length) {
      const sample = part.media.samples[this.#nextFrame];
      if (sample === undefined) break;
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          // The decoder's timestamps are not read back — position comes from the
          // sample counter in the output callback, which is exact where a
          // microsecond timestamp would round. They are still filled in truthfully,
          // because a decoder is entitled to reject a chunk without one.
          timestamp: Math.round((sample.firstSample / part.media.sampleRate) * 1e6),
          data: sample.data,
        }),
      );
      this.#nextFrame += 1;
      fed += 1;
    }
    if (fed === 0) return;

    const deadline = Date.now() + DECODE_TIMEOUT_MS;
    while (this.#outputs < start + fed) {
      this.#raiseIfFailed();
      if (Date.now() > deadline) {
        throw new Error(
          `the audio decoder produced ${this.#outputs - start} of ${fed} expected frames ` +
            'before giving up (architecture report §10.2)',
        );
      }
      await new Promise((done) => setTimeout(done, 4));
    }
  }

  #configured(part: PartState): AudioDecoderLike {
    let decoder = this.#decoder;
    if (decoder === null || decoder.state === 'closed') {
      const base = part.media.samples[this.#nextFrame]?.firstSample ?? 0;
      decoder = this.#decoderFactory({
        output: (block) => {
          // The factory counts from zero per decoder, so the first block of a seek
          // is rebased onto the frame it was actually fed from.
          this.#window.push({ ...block, firstSample: block.firstSample + base });
          this.#outputs += 1;
        },
        error: (error) => {
          this.#error = error;
        },
      });
      this.#decoder = decoder;
    }
    if (decoder.state !== 'configured') decoder.configure(part.media.config);
    return decoder;
  }

  #trimBefore(sample: number): void {
    while (this.#window.length > 1) {
      const first = this.#window[0];
      if (first === undefined || first.firstSample + first.length >= sample) break;
      this.#window.shift();
    }
  }

  #raiseIfFailed(): void {
    const error = this.#error;
    if (error === null) return;
    this.#error = null;
    throw error;
  }

  #tearDownDecoder(): void {
    const decoder = this.#decoder;
    this.#decoder = null;
    this.#outputs = 0;
    if (decoder === null) return;
    try {
      decoder.close();
    } catch {
      // Already closed by an error callback; the window is what matters.
    }
  }
}
