/**
 * Measuring an audio device while it is being recorded — `measuredSampleRate` and
 * `gaps`, from architecture report §2.3, §5.4.5 and §5.5.
 *
 * ## Why this is a class and not two lines at the end of capture
 *
 * Both numbers can only be read from the **raw** buffer stream, and only while it
 * is arriving:
 *
 * - **The rate** is `samples / elapsed`, and elapsed is measured with the
 *   timestamps Chromium assigned at capture. A device that reports 48000 Hz ran at
 *   48000.37 Hz on this project's machine; 50 ppm is 90 ms over 30 minutes, which
 *   is visible lip-sync error (§5.5). Nothing downstream can recover this number:
 *   an encoded stream carries the *nominal* rate, and its timestamps are the ones
 *   the encoder chose.
 * - **A gap** is time in which the device produced no samples at all. It is
 *   invisible in the encoded stream — an encoder is fed a sample stream and emits a
 *   sample stream; the hole closes silently — and closing it shortens the track and
 *   desynchronises everything after it (§5.4 mechanism 5).
 *
 * So the meter sits where the raw buffers are, which on this architecture is the
 * capture renderer, and its output crosses IPC as a handful of numbers. The class
 * itself is pure: it takes `{ timestampUs, frameCount }`, which is all an
 * `AudioData` is from a timing point of view, so every case below — drift, a
 * device glitch, a dropped buffer, a single-buffer recording — is a unit test in
 * Node rather than a device nobody can reproduce.
 *
 * ## Two decisions worth stating
 *
 * **Gaps are detected incrementally, against the previous buffer, never against a
 * running nominal expectation.** A cumulative expectation drifts by exactly the
 * amount §5.5 is about — 60 ms over 20 minutes at 50 ppm — and would report the
 * drift as a gap. Against the previous buffer, the same drift is 1 µs per buffer
 * and is absorbed into `measuredSampleRate`, which is where it belongs.
 *
 * **The rate excludes gaps from its denominator.** A two-second glitch in a
 * twenty-minute recording would otherwise read as a 0.17% rate error and drag every
 * sample in the file out of place. Gaps are time in which the device produced
 * nothing; they are not time in which it ran slowly.
 */

import type { AudioGap, AudioPart } from '../types/recording.ts';
import { CROSS_TRACK_SNAP_SEC, snapNearby, type AudioPartTiming } from './align.ts';

/** One captured audio buffer, reduced to the two facts that matter for timing. */
export interface AudioBufferFacts {
  /** Microseconds on the capture clock, verbatim from `AudioData.timestamp`. */
  timestampUs: number;
  /** `AudioData.numberOfFrames` — samples per channel. */
  frameCount: number;
}

/** A gap as the meter sees it, before it is placed on the recording clock. */
export interface CapturedGap {
  /** Microseconds on the capture clock at which the device stopped producing. */
  atUs: number;
  durationUs: number;
  /** `'device-glitch'` or `'encoder-backpressure'`. Free text in the format. */
  cause: string;
}

export interface AudioCaptureSummary {
  bufferCount: number;
  /** Samples per channel that reached the encoder. */
  sampleCount: number;
  firstTimestampUs: number | null;
  lastTimestampUs: number | null;
  /** Samples in the final buffer, so the part's end can be placed exactly. */
  lastFrameCount: number;
  gaps: CapturedGap[];
  /** Total gap time, microseconds. */
  gapUs: number;
  /** The device's own claim, from `AudioTrack.getSettings().sampleRate`. */
  nominalSampleRate: number;
  /**
   * What it actually ran at, measured against the capture clock (§5.5). Falls back
   * to the nominal rate when there is not yet enough of a span to measure one.
   */
  measuredSampleRate: number;
  /** True while the rate is still the nominal fallback rather than a measurement. */
  rateIsNominal: boolean;
}

export interface AudioCaptureMeterOptions {
  /** `AudioTrack.getSettings().sampleRate`, the rate the device claims. */
  nominalSampleRate: number;
  /**
   * How late a buffer has to be before it is a gap rather than jitter.
   *
   * One audio buffer by default — the same 1024/48000 the cross-track snap uses
   * (§5.4 mechanism 3), and for the same reason: below one buffer, an offset is
   * noise, and treating it as a gap would put a 5 ms hole in the timeline every
   * time the scheduler hiccuped.
   */
  gapThresholdSec?: number;
}

export class AudioCaptureMeter {
  private readonly nominalSampleRate: number;
  private readonly gapThresholdUs: number;
  private buffers = 0;
  private samples = 0;
  private firstUs: number | null = null;
  private lastUs: number | null = null;
  private lastFrames = 0;
  private gapsUs = 0;
  private readonly recordedGaps: CapturedGap[] = [];

  constructor(options: AudioCaptureMeterOptions) {
    this.nominalSampleRate = options.nominalSampleRate > 0 ? options.nominalSampleRate : 48000;
    this.gapThresholdUs = (options.gapThresholdSec ?? CROSS_TRACK_SNAP_SEC) * 1_000_000;
  }

  /** Account for one buffer that reached the encoder. */
  push(facts: AudioBufferFacts): void {
    if (!Number.isFinite(facts.timestampUs) || facts.frameCount <= 0) return;
    this.note(facts, 'device-glitch');
    this.samples += facts.frameCount;
    this.buffers += 1;
    this.lastUs = facts.timestampUs;
    this.lastFrames = facts.frameCount;
  }

  /**
   * Account for one buffer that did **not** reach the encoder.
   *
   * A buffer dropped for backpressure is a hole in the recorded audio exactly like
   * a device glitch, and is recorded as one. Counting it as a drop and moving on
   * would close the hole and shift every later sample by its length.
   */
  drop(facts: AudioBufferFacts): void {
    if (!Number.isFinite(facts.timestampUs) || facts.frameCount <= 0) return;
    // Nothing has reached the encoder yet, so there is no part for this buffer to
    // be missing from: the part starts at the first buffer that lands.
    if (this.firstUs === null) return;
    this.note(facts, 'device-glitch');
    const durationUs = (facts.frameCount / this.nominalSampleRate) * 1_000_000;
    this.addGap({ atUs: facts.timestampUs, durationUs, cause: 'encoder-backpressure' });
    // The dropped buffer's own span is now a gap, so the next buffer is measured
    // from the end of that span rather than from a buffer that never arrived.
    this.lastUs = facts.timestampUs;
    this.lastFrames = facts.frameCount;
  }

  /** Where the device stopped producing between the last buffer and this one. */
  private note(facts: AudioBufferFacts, cause: string): void {
    if (this.firstUs === null) {
      this.firstUs = facts.timestampUs;
      return;
    }
    const expectedUs =
      (this.lastUs ?? facts.timestampUs) + (this.lastFrames / this.nominalSampleRate) * 1_000_000;
    const lateUs = facts.timestampUs - expectedUs;
    if (lateUs > this.gapThresholdUs) {
      this.addGap({ atUs: expectedUs, durationUs: lateUs, cause });
    }
  }

  private addGap(gap: CapturedGap): void {
    this.recordedGaps.push(gap);
    this.gapsUs += gap.durationUs;
  }

  get summary(): AudioCaptureSummary {
    const spanUs =
      this.firstUs === null || this.lastUs === null ? 0 : this.lastUs - this.firstUs - this.gapsUs;
    // The span from the first timestamp to the last covers every sample except the
    // ones in the final buffer, which has no successor to be measured against. The
    // report's §5.5 form divides the whole sample count by that span; over 56,000
    // buffers the difference is 0.002%, but it is free to be exact.
    const measurable = this.samples - this.lastFrames;
    const measured = spanUs > 0 && measurable > 0 ? measurable / (spanUs / 1_000_000) : null;
    return {
      bufferCount: this.buffers,
      sampleCount: this.samples,
      firstTimestampUs: this.firstUs,
      lastTimestampUs: this.lastUs,
      lastFrameCount: this.lastFrames,
      gaps: [...this.recordedGaps],
      gapUs: this.gapsUs,
      nominalSampleRate: this.nominalSampleRate,
      measuredSampleRate: measured ?? this.nominalSampleRate,
      rateIsNominal: measured === null,
    };
  }
}

/**
 * Put two tracks' timestamps on one clock — the missing piece of §5.4 mechanism 2.
 *
 * ## Why this exists
 *
 * `startTimeSec` is "the first sample's timestamp minus the session origin", which
 * assumes the two timestamps are on the same clock. **On this platform they are
 * not.** Measured by `scripts/smoke-capture.mjs`: a capture whose video frames were
 * timestamped from zero produced audio buffers timestamped at 2,678,930 s — the
 * machine's uptime. Subtracting one from the other gives a microphone that started
 * a month before the screen, and an exporter that would act on it.
 *
 * So the capture page relates the two, using the one clock both tracks are
 * observed on: the moment each sample **arrives**. For every sample, the difference
 * between its arrival and the instant it covers is that track's clock offset plus
 * however long the platform took to deliver it; latency is never negative, so the
 * **smallest** difference seen is the closest estimate of the offset alone.
 *
 * Arrival time is a wall clock, and §5.4 mechanism 1 forbids stamping *samples*
 * from one — for good reason: a screen track that emits 1.4 fps on an idle desktop
 * would be compressed into a fraction of its real duration. This does not do that.
 * Every sample keeps the timestamp its capture gave it; the wall clock is consulted
 * once per track, to relate two epochs that are otherwise unrelatable, and whatever
 * error remains is smaller than one audio buffer and is removed by the snap in
 * mechanism 3.
 */
export class TrackEpochEstimator {
  private smallestUs: number | null = null;

  /**
   * Note that a sample ending at `sampleEndUs` on its own clock was in hand at
   * `arrivalUs` on the shared one.
   *
   * The sample's **end**, not its start: an audio buffer cannot be delivered
   * before its last sample has been captured, so measuring from the start would
   * charge audio one buffer of latency that video does not pay, and bias every
   * comparison between them by that much.
   */
  observe(sampleEndUs: number, arrivalUs: number): void {
    if (!Number.isFinite(sampleEndUs) || !Number.isFinite(arrivalUs)) return;
    const latency = arrivalUs - sampleEndUs;
    if (this.smallestUs === null || latency < this.smallestUs) this.smallestUs = latency;
  }

  /** Microseconds to add to this track's timestamps to reach the shared clock. */
  get offsetUs(): number {
    return this.smallestUs ?? 0;
  }

  /** False while nothing has been observed, so a caller can say so rather than guess. */
  get measured(): boolean {
    return this.smallestUs !== null;
  }
}

export interface AlignAudioPartOptions {
  /**
   * The recording clock's origin — the first screen frame — **on the shared
   * arrival clock**, which is the video track's first timestamp plus its own
   * epoch offset. See {@link TrackEpochEstimator} for why that is not simply the
   * video timestamp.
   */
  originUs: number;
  /**
   * Microseconds to add to this track's timestamps to reach the shared clock.
   *
   * Zero means "these two tracks are already on one clock", which is what a
   * platform that shares an epoch produces and what every test that does not care
   * about epochs passes.
   */
  epochOffsetUs?: number;
  /**
   * The track every other track is aligned against — the screen's `startTimeSec`,
   * which is 0 by construction. `null` disables snapping.
   */
  referenceStartSec: number | null;
  /** §5.4 mechanism 3. Defaults to {@link CROSS_TRACK_SNAP_SEC}. */
  snapThresholdSec?: number;
}

/**
 * Turn one track's measurements into the `recording.json` fields that describe it
 * — §5.4 mechanisms 2, 3 and 5 in one function.
 *
 * `startTimeSec` is the first captured sample's timestamp minus the session origin,
 * exactly as §5.4 mechanism 2 states, and it is also the instant of the part's
 * first *decoded* sample: the encoder's priming is trimmed by the edit list the
 * container carries (`AAC_ENCODER_DELAY_SAMPLES`), so the two are the same sample.
 * A reader that pulls raw chunks out of the file rather than handing it to a
 * demuxer has to apply that trim itself.
 *
 * `durationSec` is the part's **extent on the recording clock**, gaps included, so
 * `startTimeSec + durationSec` is when the part ended for every kind of track
 * alike; the media in the file is `durationSec - Σ gaps` long, because a gap is
 * time in which no samples exist. {@link audioRuns} is the other half of that
 * contract and the only supported way to read it.
 */
export function alignAudioPart(
  summary: AudioCaptureSummary,
  options: AlignAudioPartOptions,
): AudioPartTiming {
  const rate = summary.measuredSampleRate > 0 ? summary.measuredSampleRate : 48000;
  if (summary.firstTimestampUs === null || summary.lastTimestampUs === null) {
    return { startTimeSec: 0, durationSec: 0, measuredSampleRate: rate, gaps: [] };
  }

  const epochUs = options.epochOffsetUs ?? 0;
  const firstSec = (summary.firstTimestampUs + epochUs - options.originUs) / 1_000_000;
  const lastSec = (summary.lastTimestampUs + epochUs - options.originUs) / 1_000_000;
  const startTimeSec = snapNearby(
    firstSec,
    options.referenceStartSec,
    options.snapThresholdSec ?? CROSS_TRACK_SNAP_SEC,
  );
  const endSec = lastSec + summary.lastFrameCount / rate;

  return {
    startTimeSec,
    durationSec: Math.max(0, endSec - startTimeSec),
    measuredSampleRate: rate,
    gaps: summary.gaps.map((gap): AudioGap => ({
      atSec: (gap.atUs + epochUs - options.originUs) / 1_000_000,
      durationSec: gap.durationUs / 1_000_000,
      cause: gap.cause,
    })),
  };
}

/** The audio half of a finalized `recording.json` part, ready to be written. */
export function audioPartDoc(
  base: Pick<AudioPart, 'file' | 'codec' | 'sampleRate' | 'channels' | 'endedEarly' | 'endReason'>,
  timing: AudioPartTiming,
): AudioPart {
  return {
    file: base.file,
    codec: base.codec,
    sampleRate: base.sampleRate,
    channels: base.channels,
    startTimeSec: timing.startTimeSec,
    durationSec: timing.durationSec,
    measuredSampleRate: timing.measuredSampleRate,
    gaps: timing.gaps,
    endedEarly: base.endedEarly,
    ...(base.endReason === undefined ? {} : { endReason: base.endReason }),
  };
}
