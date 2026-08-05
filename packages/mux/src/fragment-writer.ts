/**
 * The capture-side MP4 writer: encoded samples in, fragments out.
 *
 * It produces bytes and never touches a file — the process that owns the file
 * descriptor is `@loom/mux/fs`, and through it `ProjectStore`, which is the only
 * writer in the application (architecture report §0, rule 2). Keeping the byte
 * layout in a pure class is what lets the fragment format be tested without a
 * disk, and what lets the crash test drive the real writer.
 *
 * ## The one-sample lookahead, and why it is worth a frame
 *
 * A screen-capture track is genuinely variable-rate: ScreenCaptureKit emits frames
 * only when the screen changes, measured at 1.4 fps idle and 29.4 fps under load
 * (research report §5.1). So a sample's duration is not known until the *next*
 * sample arrives. This class holds exactly one sample for that reason, and writes
 * fragments carrying exact durations rather than a nominal guess that every
 * downstream consumer would then have to distrust.
 *
 * The cost is bounded and stated: a `SIGKILL` loses the held sample as well as any
 * write in flight — two frames, 67 ms at 30 fps — instead of one. Against a gate
 * of 95% that is a rounding error, and against a timeline that has to be
 * frame-accurate a guessed duration is not.
 */

import { currentSchemaId, type FrameIndexDoc } from '@loom/format';
import { fragment, initSegment, type InitSegmentSpec } from './boxes.ts';

/** One encoded frame, as it arrives from `VideoEncoder`. */
export interface EncodedSample {
  /** AVCC-framed encoded bytes. Never a decoded frame — §1.4. */
  data: Uint8Array;
  isKey: boolean;
  /** Microseconds on the capture clock, verbatim from the encoder. */
  timestampUs: number;
  /** Microseconds. `null` whenever the encoder does not know, which is usual for VFR. */
  durationUs: number | null;
}

/** One row of the frame index sidecar (§2.4), as the writer learns it. */
export interface IndexedFrame {
  /** Presentation timestamp in media timescale units, relative to the part start. */
  ptsUnits: number;
  durationUnits: number;
  sizeBytes: number;
  /** Byte offset of the sample data within the media file. */
  offsetBytes: number;
  isKey: boolean;
}

export interface EmittedFragment {
  /** `moof` + `mdat`, ready to be appended to the file. */
  bytes: Uint8Array;
  frame: IndexedFrame;
}

export interface FragmentWriterOptions {
  /** Units per second. Capture uses microseconds so encoder timestamps map 1:1. */
  timescale?: number;
  /**
   * Duration given to the final sample, which by definition has no successor to
   * measure against. The requested capture rate, not the observed one.
   */
  nominalFps?: number;
}

export class FragmentWriter {
  private readonly timescale: number;
  private readonly nominalFps: number;
  private sequence = 0;
  private fileBytes = 0;
  private started = false;
  private originUs: number | null = null;
  private held: EncodedSample | null = null;

  constructor(options: FragmentWriterOptions = {}) {
    this.timescale = options.timescale ?? 1_000_000;
    this.nominalFps = options.nominalFps ?? 30;
  }

  /** Bytes emitted so far, which is also the file's length if every one was written. */
  get byteLength(): number {
    return this.fileBytes;
  }

  /** Media timescale, for the frame index sidecar. */
  get timescaleUnits(): number {
    return this.timescale;
  }

  /**
   * The initialisation segment: `ftyp` + an empty `moov`.
   *
   * Written before the first frame, so the file is a readable MP4 from the moment
   * it exists rather than only once a `moov` is written at the end — which is the
   * difference between recovering most of a recording and recovering none of it
   * (§12.2).
   */
  begin(spec: InitSegmentSpec): Uint8Array {
    if (this.started) throw new Error('FragmentWriter.begin called twice');
    this.started = true;
    const bytes = initSegment({ ...spec, timescale: this.timescale });
    this.fileBytes = bytes.byteLength;
    return bytes;
  }

  /**
   * Offer a sample. Returns the fragment for the *previous* sample, whose duration
   * this one has just established, or `null` if there is not one yet.
   */
  push(sample: EncodedSample): EmittedFragment | null {
    if (!this.started) throw new Error('FragmentWriter.push before begin');
    this.originUs ??= sample.timestampUs;
    const previous = this.held;
    this.held = sample;
    if (previous === null) return null;

    // A duration measured against the next sample's timestamp. Encoders are not
    // required to be monotonic under load; a non-positive gap becomes one tick
    // rather than a zero-length or negative sample, which no demuxer handles well.
    const measured = this.units(sample.timestampUs) - this.units(previous.timestampUs);
    return this.emit(previous, measured > 0 ? measured : 1);
  }

  /**
   * Emit the held sample and finish.
   *
   * `endTimestampUs` is when capture actually stopped, on the encoder's clock, and
   * it is the difference between a correct duration and a badly wrong one. A screen
   * track only produces a frame when the screen changes — 1.4 fps on an idle
   * desktop (research §5.1) — so a recording that ends on a still screen has its
   * *last* frame standing for everything after it. Without an end time, a four
   * second recording of a static screen reports as a fraction of a second, because
   * the last frame would be given a nominal 1/30 s and the rest of the recording
   * would simply not be there.
   *
   * Failing that, the encoder's own duration if it offered one, and the requested
   * frame rate as the last resort.
   */
  flush(endTimestampUs?: number): EmittedFragment | null {
    const last = this.held;
    this.held = null;
    if (last === null) return null;
    const nominal = Math.max(1, Math.round(this.timescale / this.nominalFps));
    const measured =
      endTimestampUs === undefined
        ? null
        : this.units(endTimestampUs) - this.units(last.timestampUs);
    if (measured !== null && measured > 0) return this.emit(last, measured);
    const declared = last.durationUs === null ? null : this.durationUnits(last.durationUs);
    return this.emit(last, declared !== null && declared > 0 ? declared : nominal);
  }

  /** Number of samples still held in memory — what a `SIGKILL` would cost. */
  get pending(): number {
    return this.held === null ? 0 : 1;
  }

  private emit(sample: EncodedSample, durationUnits: number): EmittedFragment {
    this.sequence += 1;
    const ptsUnits = this.units(sample.timestampUs);
    const bytes = fragment({
      sequenceNumber: this.sequence,
      baseMediaDecodeTime: ptsUnits,
      durationUnits,
      isKey: sample.isKey,
      data: sample.data,
    });
    const frame: IndexedFrame = {
      ptsUnits,
      durationUnits,
      sizeBytes: sample.data.byteLength,
      offsetBytes: this.fileBytes + (bytes.byteLength - sample.data.byteLength),
      isKey: sample.isKey,
    };
    this.fileBytes += bytes.byteLength;
    return { bytes, frame };
  }

  /** Encoder microseconds → media timescale units, relative to the first sample. */
  private units(timestampUs: number): number {
    const relative = timestampUs - (this.originUs ?? timestampUs);
    return Math.max(0, Math.round((relative * this.timescale) / 1_000_000));
  }

  private durationUnits(durationUs: number): number {
    return Math.round((durationUs * this.timescale) / 1_000_000);
  }
}

/**
 * The frame index sidecar (§2.4), built from the frames a part actually contains.
 *
 * Parallel arrays, not objects: 6,104 frames costs ~150 KB as arrays and ~700 KB
 * as objects, and the arrays deserialize into typed arrays in one pass.
 */
export function frameIndexDoc(frames: readonly IndexedFrame[], timescale: number): FrameIndexDoc {
  const keyframes: number[] = [];
  const pts: number[] = [];
  const sizes: number[] = [];
  const offsets: number[] = [];
  frames.forEach((frame, i) => {
    if (frame.isKey) keyframes.push(i);
    pts.push(frame.ptsUnits);
    sizes.push(frame.sizeBytes);
    offsets.push(frame.offsetBytes);
  });
  return { schema: currentSchemaId('loom.index'), timescale, keyframes, pts, sizes, offsets };
}

/** Total media duration of a part, in seconds, from its frames. */
export function partDurationSec(frames: readonly IndexedFrame[], timescale: number): number {
  const last = frames.at(-1);
  if (last === undefined) return 0;
  return (last.ptsUnits + last.durationUnits) / timescale;
}
