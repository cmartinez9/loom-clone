/**
 * The capture-side MP4 writer for an audio track: encoded AAC frames in,
 * fragments out.
 *
 * The same shape as {@link ./fragment-writer.ts | FragmentWriter} — pure, no file
 * descriptor, one sample per fragment — and different from it in exactly two ways,
 * both of which come from audio being audio:
 *
 * 1. **No one-sample lookahead.** A video sample's duration is only knowable when
 *    the next one arrives, because a screen track is genuinely variable-rate. An
 *    AAC frame is 1024 samples, always, and the encoder says so; there is nothing
 *    to wait for. So this writer holds nothing, and a `SIGKILL` costs the fragment
 *    being written rather than that one plus a held frame.
 * 2. **The media timeline is contiguous.** `tfdt` counts samples, not capture-clock
 *    microseconds. A container cannot hold samples the device never produced, so a
 *    gap is not representable here; it is recorded in `recording.json` and
 *    reproduced as silence by whoever reads it (architecture report §5.4
 *    mechanism 5, and `AudioPart.gaps`). Writing capture timestamps into `tfdt`
 *    instead would put fractional-sample jitter into every fragment — the device's
 *    real rate is not its nominal one (§5.5) — and would still not describe the
 *    gap, because the samples on either side of it are adjacent in the file.
 *
 * One sample per fragment costs ~110 bytes against a ~340-byte AAC frame at
 * 128 kbps, which sounds like a lot until it is measured against the recording it
 * is part of: audio is ~1% of a 12 Mbps capture, so the whole overhead is ~0.3% of
 * the file. The crash budget bought with it is 21 ms.
 *
 * The encoder's priming is handled by the initialisation segment's edit list
 * ({@link AAC_ENCODER_DELAY_SAMPLES}), not here: it is a property of the stream,
 * not of any one fragment.
 */

import {
  AAC_ENCODER_DELAY_SAMPLES,
  audioInitSegment,
  fragment,
  type AudioInitSegmentSpec,
} from './boxes.ts';
import type { EncodedSample } from './fragment-writer.ts';

export { AAC_ENCODER_DELAY_SAMPLES };

/** Samples in one AAC-LC frame. Fixed by the codec, not a configuration. */
export const AAC_FRAME_SAMPLES = 1024;

export interface EmittedAudioFragment {
  /** `moof` + `mdat`, ready to be appended to the file. */
  bytes: Uint8Array;
  /** Where this frame starts on the media timeline, in samples. */
  mediaTimeUnits: number;
  /** How many samples it carries. */
  durationUnits: number;
}

export class AudioFragmentWriter {
  private readonly sampleRate: number;
  private sequence = 0;
  private fileBytes = 0;
  private samples = 0;
  private frames = 0;
  private started = false;

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError(`audio sample rate out of range: ${String(sampleRate)}`);
    }
    this.sampleRate = Math.round(sampleRate);
  }

  /** `ftyp` + an empty `moov`, written before the first frame. */
  begin(spec: Omit<AudioInitSegmentSpec, 'sampleRate'>): Uint8Array {
    if (this.started) throw new Error('AudioFragmentWriter.begin called twice');
    this.started = true;
    const bytes = audioInitSegment({ ...spec, sampleRate: this.sampleRate });
    this.fileBytes = bytes.byteLength;
    return bytes;
  }

  /**
   * Turn one encoded frame into a fragment.
   *
   * Never returns `null`: unlike the video writer there is nothing held back, so
   * every frame handed in is a fragment handed out.
   */
  push(sample: EncodedSample): EmittedAudioFragment {
    if (!this.started) throw new Error('AudioFragmentWriter.push before begin');
    const durationUnits = this.durationUnits(sample.durationUs);
    const mediaTimeUnits = this.samples;
    const bytes = fragment({
      sequenceNumber: (this.sequence += 1),
      baseMediaDecodeTime: mediaTimeUnits,
      durationUnits,
      // Every AAC frame is a sync sample. A demuxer that believed otherwise would
      // refuse to seek anywhere in the track.
      isKey: true,
      data: sample.data,
    });
    this.samples += durationUnits;
    this.frames += 1;
    this.fileBytes += bytes.byteLength;
    return { bytes, mediaTimeUnits, durationUnits };
  }

  /** Encoded frames written so far. */
  get frameCount(): number {
    return this.frames;
  }

  /** Samples per channel written so far, priming included. */
  get sampleCount(): number {
    return this.samples;
  }

  /** Media duration of the file, in seconds at the nominal rate. */
  get mediaDurationSec(): number {
    return this.samples / this.sampleRate;
  }

  get byteLength(): number {
    return this.fileBytes;
  }

  get timescaleUnits(): number {
    return this.sampleRate;
  }

  /**
   * An encoder that reports a duration is believed; one that does not gets the
   * codec's fixed frame length, which for AAC-LC is not a guess.
   */
  private durationUnits(durationUs: number | null): number {
    if (durationUs === null || !Number.isFinite(durationUs) || durationUs <= 0) {
      return AAC_FRAME_SAMPLES;
    }
    const units = Math.round((durationUs * this.sampleRate) / 1_000_000);
    return units > 0 ? units : AAC_FRAME_SAMPLES;
  }
}
