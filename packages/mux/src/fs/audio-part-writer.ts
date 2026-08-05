/**
 * The file descriptor an audio capture part is written through.
 *
 * One instance owns one `media/<track>.<part>.m4a`. Constructed only by
 * `ProjectStore`, like {@link ./media-part-writer.ts | MediaPartWriter}, and for
 * the same reason: main is the only writer (architecture report §0, rule 2) and
 * `eslint.config.mjs` makes that structural.
 *
 * It keeps the three properties that make a killed recording recoverable —
 * initialisation segment before the first frame, every fragment to `write(2)` as
 * soon as it exists, `fsync` on a cadence of about a second of media — and adds
 * nothing else. There is no sidecar: an audio part's samples are fixed-length and
 * contiguous, so "where is sample n" is arithmetic, not an index. The frame index
 * exists for video because a VFR track cannot answer that question without one
 * (§2.4).
 *
 * What this writer does **not** know is where the samples belong on the recording
 * clock. That is `recording.json`'s job — `startTimeSec`, `measuredSampleRate` and
 * `gaps` (§2.3) — and it is deliberately not duplicated in the container, because
 * two answers to "when does this sample play" is exactly how A/V sync rots.
 */

import { open, type FileHandle } from 'node:fs/promises';
import { AudioFragmentWriter, type EncodedSample } from '../index.ts';
import { writeAllBytes } from './io.ts';

export interface AudioPartWriterOptions {
  /** Absolute path of `media/<track>.<part>.m4a`. */
  mediaPath: string;
  /** The rate the device reported. Also the media timescale. */
  sampleRate: number;
  channels: number;
  /** `AudioDecoderConfig.description` — the AudioSpecificConfig. */
  audioSpecificConfig: Uint8Array;
  /** Target bitrate, written into `esds`. Advisory. */
  bitrate?: number;
  /**
   * Priming samples the edit list tells a reader to skip. Defaults to
   * {@link AAC_ENCODER_DELAY_SAMPLES}, which is what every AAC encoder on this
   * platform produces.
   */
  encoderDelaySamples?: number;
  /** Seconds of media between `fsync`s. Architecture report §7.1 says ~1. */
  syncIntervalSec?: number;
}

export interface FinalizedAudioPart {
  /** Encoded AAC frames written. */
  frameCount: number;
  /** Samples per channel in the file, encoder priming included. */
  sampleCount: number;
  /** Duration of the media in the file, at the nominal rate. */
  mediaDurationSec: number;
  byteLength: number;
}

export class AudioPartWriter {
  private readonly options: AudioPartWriterOptions;
  private readonly writer: AudioFragmentWriter;
  private handle: FileHandle | null = null;
  private syncedThroughUnits = 0;
  /** Serializes appends, so bytes reach the file in the order they were produced. */
  private chain: Promise<void> = Promise.resolve();

  private constructor(options: AudioPartWriterOptions, handle: FileHandle) {
    this.options = options;
    this.writer = new AudioFragmentWriter(options.sampleRate);
    this.handle = handle;
  }

  /**
   * Create the part file and write its initialisation segment.
   *
   * `wx`, like the video writer: a part index that has already been used is an
   * error, not a silent truncation of somebody's audio.
   */
  static async create(options: AudioPartWriterOptions): Promise<AudioPartWriter> {
    const handle = await open(options.mediaPath, 'wx', 0o644);
    const part = new AudioPartWriter(options, handle);
    try {
      const init = part.writer.begin({
        channels: options.channels,
        audioSpecificConfig: options.audioSpecificConfig,
        ...(options.bitrate === undefined ? {} : { bitrate: options.bitrate }),
        ...(options.encoderDelaySamples === undefined
          ? {}
          : { encoderDelaySamples: options.encoderDelaySamples }),
      });
      await writeAllBytes(handle, init, options.mediaPath);
      // Everything after the header is recoverable only if the header is on disk,
      // so this is the one write that does not wait for a cadence.
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    return part;
  }

  /** Encoded frames written so far, for the recorder's status. */
  get frameCount(): number {
    return this.writer.frameCount;
  }

  /** Nothing is ever held back, so a crash costs the write in flight and no more. */
  readonly pendingFrames = 0;

  /** Append one encoded AAC frame. Resolves once its bytes are with the kernel. */
  append(sample: EncodedSample): Promise<void> {
    return this.enqueue(async (handle) => {
      const emitted = this.writer.push(sample);
      await writeAllBytes(handle, emitted.bytes, this.options.mediaPath);
      await this.syncIfDue(handle, emitted.mediaTimeUnits);
    });
  }

  /** `fsync` and close. There is no held sample and no sidecar to write. */
  async finalize(): Promise<FinalizedAudioPart> {
    try {
      return await this.enqueue(async (handle) => {
        await handle.sync();
        return this.summary();
      });
    } finally {
      await this.close();
    }
  }

  /**
   * Give up on this part without losing what it already holds.
   *
   * An abort that throws would mask the failure that caused it, so the summary is
   * returned either way; the bytes that reached the kernel stay on disk and
   * {@link recoverAudioPart} rebuilds the facts from them.
   */
  async abort(): Promise<FinalizedAudioPart> {
    const summary = await this.enqueue(async (handle) => {
      await handle.sync().catch(() => undefined);
      return this.summary();
    }).catch(() => this.summary());
    await this.close();
    return summary;
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) await handle.close().catch(() => undefined);
  }

  private summary(): FinalizedAudioPart {
    return {
      frameCount: this.writer.frameCount,
      sampleCount: this.writer.sampleCount,
      mediaDurationSec: this.writer.mediaDurationSec,
      byteLength: this.writer.byteLength,
    };
  }

  private async syncIfDue(handle: FileHandle, mediaTimeUnits: number): Promise<void> {
    const interval = (this.options.syncIntervalSec ?? 1) * this.writer.timescaleUnits;
    if (mediaTimeUnits - this.syncedThroughUnits < interval) return;
    this.syncedThroughUnits = mediaTimeUnits;
    await handle.sync();
  }

  private enqueue<T>(work: (handle: FileHandle) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const handle = this.handle;
      if (handle === null) throw new Error(`${this.options.mediaPath} is closed`);
      return work(handle);
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
