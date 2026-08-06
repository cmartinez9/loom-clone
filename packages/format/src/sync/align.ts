/**
 * A/V alignment — the arithmetic that makes §2.3's timing fields mean something.
 *
 * Architecture report §5.4 lists five mechanisms that keep separately-captured
 * tracks together. Three of them are arithmetic and live here; the other two are
 * policy the capture and playback paths have to keep:
 *
 * | # | Mechanism (§5.4)                          | Where it lives                           |
 * |---|-------------------------------------------|------------------------------------------|
 * | 1 | one timebase, taken at capture            | the capture page — never a wall clock    |
 * | 2 | per-track `startTimeSec`, recorded once    | {@link trackSourceTimeSec}, here         |
 * | 3 | snap sub-buffer offsets to zero            | {@link snapNearby}, here                 |
 * | 4 | audio is the master clock                  | **nowhere — not implemented**            |
 * | 5 | gaps are reproduced, never closed          | {@link audioRuns}, here                  |
 *
 * **Row 4 said "the preview loop (phase 6)" until phase 14, and phase 6 did not
 * deliver it.** `PreviewLoop` advances its playhead by accumulating
 * `requestAnimationFrame` deltas, which is the one thing §5.4 mechanism 4 names and
 * forbids: *"Playback time comes from the audio output's played-sample count, never
 * from `requestAnimationFrame` accumulation."* Nothing is wrong on any path today,
 * because nothing plays audio alongside the preview — phase 14's editor is
 * deliberately silent and says so on its own surface — so the stale row cost nobody
 * anything except the next person to read it. **It belongs to whoever adds audio
 * playback**, and it is not optional when they do: video on the host's frame clock
 * and audio on the DAC's walk apart at the device's own error, the same 50 ppm §5.5
 * measures as 90 ms over thirty minutes, which is a scrub bar disagreeing with the
 * sound and a user who cannot explain either. The seam is `PreviewLoop`'s time
 * source; `options.now` is a *measurement* clock and not that seam.
 *
 * It lives in `@loom/format` rather than in a package of its own because every
 * function here is a *reading* of a `recording.json` field: `startTimeSec`,
 * `measuredSampleRate` and `gaps` are meaningless without them, and a consumer that
 * can reach the declaration should not have to hunt for the interpretation. Pure,
 * like the rest of this entry point: no node, no DOM, no I/O.
 *
 * ## The one thing to understand before using any of this
 *
 * An audio part's media is **contiguous**: the file holds sample after sample with
 * no holes, because a gap is a stretch of time in which the device produced no
 * samples, and a container cannot store samples that do not exist. The gap is
 * therefore recorded in `recording.json` (§5.4 mechanism 5) and reproduced by the
 * consumer as silence of exactly that length. {@link audioRuns} is that
 * reproduction: it turns one part into the runs of contiguous samples it actually
 * contains, each with the instant on the recording clock at which it starts.
 * Everything downstream — preview, export, drift correction — reads that, never
 * `sampleIndex / sampleRate`.
 */

import type { AudioGap, AudioPart } from '../types/recording.ts';
import type { Seconds } from '../types/common.ts';

/**
 * Offsets smaller than one audio buffer are noise; honouring them forces a
 * pointless resample. Architecture report §5.4 mechanism 3, and Cap's own
 * threshold (`studio_recording.rs:905-916, 929`): 1024 samples at 48 kHz.
 */
export const CROSS_TRACK_SNAP_SEC = 1024 / 48000;

/**
 * Snap `raw` onto `reference` when the two are within `threshold`.
 *
 * Verbatim from architecture report §5.4, including the signature — this is the
 * function the report specifies, not an equivalent of it.
 */
export function snapNearby(
  raw: number,
  reference: number | null,
  threshold: number = CROSS_TRACK_SNAP_SEC,
): number {
  return reference !== null && Math.abs(raw - reference) <= threshold ? reference : raw;
}

/**
 * Source time in one track for a given time in another (§5.4 mechanism 2).
 *
 * `sourceTime` is measured inside `reference`'s media; the answer is measured
 * inside the track whose part starts at `partStartSec`. Both `startTimeSec` values
 * are offsets on the one recording clock, which is what makes this a subtraction
 * rather than a correlation.
 */
export function trackSourceTimeSec(
  sourceTime: Seconds,
  partStartSec: Seconds,
  referenceStartSec: Seconds,
): Seconds {
  return sourceTime + (referenceStartSec - partStartSec);
}

export interface VideoPartStartOptions {
  /** This part's first encoded frame, on its own track's clock. */
  firstTimestampUs: number;
  /**
   * The recording clock's origin — the first screen frame — **on the shared
   * arrival clock**, which is the screen's first timestamp plus its own epoch
   * offset. See `TrackEpochEstimator` for why that is not simply the timestamp.
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
 * Where one video part starts on the recording clock — §5.4 mechanisms 2 and 3,
 * for a track made of pictures rather than samples.
 *
 * Deliberately the same arithmetic as `alignAudioPart`'s first two lines and not a
 * second mechanism: this part's first frame minus the session origin, both moved
 * onto the shared arrival clock by their own epoch offsets, then snapped onto the
 * reference when what remains is smaller than one audio buffer.
 *
 * Only the start. A part's `durationSec` is measured from the samples that were
 * actually written — the writer counts them, and it is the only thing that knows
 * how long the last frame of a variable-rate track had to stand for.
 *
 * ## The snap is what makes this safe for a second part
 *
 * A camera that is unplugged and plugged back in produces `webcam.001.mp4` with a
 * `startTimeSec` of its own — 149.204 s in §2.3's example — and that number is the
 * only record of the hole in the middle of the track. Snapping is threshold-based,
 * so one call serves both: part 0 begins within a frame or two of the screen and
 * snaps onto it, part 1 begins two minutes later and is left exactly where it was
 * measured. A snap that ignored the threshold would close the gap and slide the
 * whole second part on top of the first — §5.4 mechanism 5's mistake, made with
 * pictures instead of samples.
 */
export function videoPartStartSec(options: VideoPartStartOptions): Seconds {
  const raw =
    (options.firstTimestampUs + (options.epochOffsetUs ?? 0) - options.originUs) / 1_000_000;
  return snapNearby(
    raw,
    options.referenceStartSec,
    options.snapThresholdSec ?? CROSS_TRACK_SNAP_SEC,
  );
}

/**
 * `measuredSampleRate / nominal` — the factor audio must be resampled by before
 * mixing, so its duration matches the video timebase (§5.5).
 *
 * A device that reports 48000 Hz is not running at 48000.000 Hz. At the 48000.37
 * this project measured, 30 minutes drifts 13.9 ms; a plausible 50 ppm device is
 * 90 ms, which is clearly-visible lip-sync error that no 30-second test will show.
 */
export function resampleRatio(part: Pick<AudioPart, 'sampleRate' | 'measuredSampleRate'>): number {
  if (part.sampleRate <= 0 || !Number.isFinite(part.measuredSampleRate)) return 1;
  return part.measuredSampleRate / part.sampleRate;
}

/**
 * How far audio walks off video over `elapsedSec` if its measured rate is ignored.
 *
 * Positive means the audio runs long: more samples were captured per second than
 * the nominal rate claims, so playing them back at the nominal rate takes longer
 * than the video it belongs to. §10.1 asks for this to be logged during capture,
 * so drift is visible in the field before a user reports it.
 */
export function driftSec(
  part: Pick<AudioPart, 'sampleRate' | 'measuredSampleRate'>,
  elapsedSec: Seconds,
): Seconds {
  return elapsedSec * (resampleRatio(part) - 1);
}

/** A run of contiguous samples, and where it lands on the recording clock. */
export interface AudioRun {
  /** Index of this run's first sample in the part's decoded stream. */
  firstSample: number;
  /** How many samples the run holds. */
  sampleCount: number;
  /** Recording-clock instant of `firstSample`. */
  startSec: Seconds;
}

/** The part fields {@link audioRuns} reads. Named so callers can pass a subset. */
export type AudioPartTiming = Pick<
  AudioPart,
  'startTimeSec' | 'durationSec' | 'measuredSampleRate' | 'gaps'
>;

/**
 * Split one audio part into the runs of contiguous samples it holds (§5.4.5).
 *
 * The part's media is contiguous; its *time* is not. Each recorded gap ends one
 * run and starts the next, `gap.durationSec` later on the recording clock. A
 * consumer that concatenates across a gap shortens the track by the gap length and
 * desynchronises everything after it — permanently, and invisibly at first.
 *
 * Sample counts come from `measuredSampleRate`, never the nominal one: the whole
 * point of measuring the rate is that this is where it is used.
 */
export function audioRuns(part: AudioPartTiming): AudioRun[] {
  const rate = part.measuredSampleRate > 0 ? part.measuredSampleRate : 0;
  const gaps = [...part.gaps].sort((a, b) => a.atSec - b.atSec);
  const gapSec = gaps.reduce((sum, gap) => sum + Math.max(0, gap.durationSec), 0);
  const totalSamples = Math.max(0, Math.round((part.durationSec - gapSec) * rate));

  const runs: AudioRun[] = [];
  let firstSample = 0;
  let startSec = part.startTimeSec;
  for (const gap of gaps) {
    // A gap outside the part, or one that arrives before the run it would end, is
    // a document we cannot honour; it is skipped rather than allowed to produce a
    // negative-length run, which would silently shift everything after it.
    const runSamples = Math.round((gap.atSec - startSec) * rate);
    if (runSamples <= 0 || firstSample + runSamples > totalSamples) continue;
    runs.push({ firstSample, sampleCount: runSamples, startSec });
    firstSample += runSamples;
    startSec = gap.atSec + Math.max(0, gap.durationSec);
  }
  runs.push({ firstSample, sampleCount: Math.max(0, totalSamples - firstSample), startSec });
  return runs;
}

/**
 * Recording-clock instant of one decoded sample.
 *
 * Sample indices are into the part's **decoded** stream, which begins with the
 * encoder's priming samples — `startTimeSec` already accounts for them (see
 * `AudioPart.startTimeSec`), so index 0 is `startTimeSec` and no caller has to
 * know the codec's delay.
 */
export function audioSampleTimeSec(
  runs: readonly AudioRun[],
  sampleIndex: number,
  measuredSampleRate: number,
): Seconds {
  const first = runs[0];
  if (first === undefined || measuredSampleRate <= 0) return 0;
  let run = first;
  for (const candidate of runs) {
    if (candidate.firstSample > sampleIndex) break;
    run = candidate;
  }
  return run.startSec + (sampleIndex - run.firstSample) / measuredSampleRate;
}

/**
 * Which decoded sample plays at `timeSec`, or `null` when nothing does.
 *
 * `null` is silence and is the answer inside a gap, before the part starts and
 * after it ends. An exporter turns it into exactly that many silent samples;
 * anything else closes the gap.
 */
export function audioSampleIndexAt(
  runs: readonly AudioRun[],
  timeSec: Seconds,
  measuredSampleRate: number,
): number | null {
  if (measuredSampleRate <= 0) return null;
  for (const run of runs) {
    const endSec = run.startSec + run.sampleCount / measuredSampleRate;
    if (timeSec < run.startSec) return null;
    if (timeSec < endSec) {
      // The epsilon is float repair, not a fudge: `sampleTime` then `sampleIndex`
      // must round-trip, and `(n / rate) * rate` lands a few parts in 10^16 below
      // `n`, which a bare floor turns into `n - 1`. A microsecond of a sample —
      // 20 picoseconds — is far below anything either function can mean.
      const offset = Math.floor((timeSec - run.startSec) * measuredSampleRate + 1e-6);
      return run.firstSample + Math.min(offset, Math.max(0, run.sampleCount - 1));
    }
  }
  return null;
}

/** Total silence a part's gaps stand for, in seconds. */
export function totalGapSec(gaps: readonly AudioGap[]): Seconds {
  return gaps.reduce((sum, gap) => sum + Math.max(0, gap.durationSec), 0);
}
