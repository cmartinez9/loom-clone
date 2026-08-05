/**
 * The A/V sync arithmetic, on its own.
 *
 * `apps/main/test/av-sync.test.ts` is the phase gate: it records twenty minutes of
 * real AAC and real H.264 and cross-correlates a tone against a flash. This file
 * is the layer under it, where every case can be stated exactly — a device running
 * 50 ppm fast, a two-second glitch, a buffer dropped for backpressure — and where
 * a regression names itself instead of showing up as eleven milliseconds of offset.
 *
 * The numbers are the report's own: 48000.37 Hz measured (§5.5), 50 ppm as the
 * plausible worst case, 20 ms as the budget, and 20 minutes as the length at which
 * any of it is visible.
 */

import { describe, expect, it } from 'vitest';
import {
  AudioCaptureMeter,
  CROSS_TRACK_SNAP_SEC,
  TrackEpochEstimator,
  alignAudioPart,
  audioRuns,
  audioSampleIndexAt,
  audioSampleTimeSec,
  driftSec,
  resampleRatio,
  snapNearby,
  trackSourceTimeSec,
  type AudioBufferFacts,
} from '../src/index.ts';

const NOMINAL = 48000;
const BUFFER = 1024;
/** The report's plausible worst case: 50 ppm, which is 60 ms over 20 minutes. */
const FAST_RATE = NOMINAL * (1 + 50e-6);

/**
 * A device producing `bufferCount` buffers at `trueRate`, timestamped by the
 * capture clock the way Chromium timestamps `AudioData`.
 */
function device(trueRate: number, bufferCount: number, startUs = 0): AudioBufferFacts[] {
  return Array.from({ length: bufferCount }, (_, i) => ({
    timestampUs: startUs + Math.round((i * BUFFER * 1_000_000) / trueRate),
    frameCount: BUFFER,
  }));
}

function meterOf(buffers: readonly AudioBufferFacts[]): AudioCaptureMeter {
  const meter = new AudioCaptureMeter({ nominalSampleRate: NOMINAL });
  for (const buffer of buffers) meter.push(buffer);
  return meter;
}

describe('snapping sub-buffer offsets (§5.4 mechanism 3)', () => {
  it('is one audio buffer, the threshold the report and Cap both use', () => {
    expect(CROSS_TRACK_SNAP_SEC).toBeCloseTo(1024 / 48000, 12);
  });

  it('snaps an offset smaller than one buffer onto the reference', () => {
    expect(snapNearby(0.01, 0)).toBe(0);
    expect(snapNearby(-0.02, 0)).toBe(0);
  });

  it('leaves an offset larger than one buffer alone', () => {
    expect(snapNearby(0.05, 0)).toBe(0.05);
    // A real offset the size of a video frame is not noise, and honouring it is
    // the whole point of per-track startTimeSec.
    expect(snapNearby(0.0417, 0)).toBe(0.0417);
  });

  it('has nothing to snap to when there is no reference track', () => {
    expect(snapNearby(0.004, null)).toBe(0.004);
  });

  it('maps a time in one track onto another (§5.4 mechanism 2)', () => {
    // The mic started 100 ms after the screen, so 5 s of screen is 4.9 s of mic.
    expect(trackSourceTimeSec(5, 0.1, 0)).toBeCloseTo(4.9, 12);
  });
});

describe('measuring a device while it records (§5.5)', () => {
  it('reads back the rate a device actually ran at, not the one it claims', () => {
    const summary = meterOf(device(FAST_RATE, 2000)).summary;
    expect(summary.nominalSampleRate).toBe(NOMINAL);
    expect(summary.measuredSampleRate).toBeCloseTo(FAST_RATE, 1);
    expect(summary.rateIsNominal).toBe(false);
    expect(summary.gaps).toEqual([]);
  });

  it('reads the report’s own measurement back to within a part per million', () => {
    const summary = meterOf(device(48000.37, 4000)).summary;
    expect(Math.abs(summary.measuredSampleRate - 48000.37) / 48000.37).toBeLessThan(1e-6);
  });

  it('does not mistake twenty minutes of drift for a gap', () => {
    // The trap this is guarding: an expectation accumulated from the *nominal*
    // rate diverges by exactly the drift — 60 ms over 20 minutes — and would be
    // reported as a gap, and then subtracted out of the very measurement it is.
    const summary = meterOf(device(FAST_RATE, Math.round((1200 * NOMINAL) / BUFFER))).summary;
    expect(summary.gaps).toEqual([]);
    expect(summary.measuredSampleRate).toBeCloseTo(FAST_RATE, 1);
  });

  it('absorbs jitter smaller than one buffer instead of punching a hole in the timeline', () => {
    const buffers = device(NOMINAL, 200).map((buffer, i) =>
      i === 100 ? { ...buffer, timestampUs: buffer.timestampUs + 8_000 } : buffer,
    );
    expect(meterOf(buffers).summary.gaps).toEqual([]);
  });

  it('records a device glitch as a gap, and keeps it out of the rate', () => {
    const glitchUs = 2_000_000;
    const buffers = device(NOMINAL, 4000).map((buffer, i) =>
      i >= 2000 ? { ...buffer, timestampUs: buffer.timestampUs + glitchUs } : buffer,
    );
    const summary = meterOf(buffers).summary;

    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0]?.durationUs).toBeCloseTo(glitchUs, -1);
    expect(summary.gaps[0]?.cause).toBe('device-glitch');
    expect(summary.sampleCount).toBe(4000 * BUFFER);
    // Two seconds of nothing is not two seconds of running slowly. Counting it
    // would read as a 0.17% rate error and drag every sample out of place.
    expect(summary.measuredSampleRate).toBeCloseTo(NOMINAL, 0);
  });

  it('records a buffer dropped for backpressure as the gap it is', () => {
    const meter = new AudioCaptureMeter({ nominalSampleRate: NOMINAL });
    const buffers = device(NOMINAL, 10);
    buffers.forEach((buffer, i) => {
      if (i === 5) meter.drop(buffer);
      else meter.push(buffer);
    });
    const summary = meter.summary;

    expect(summary.sampleCount).toBe(9 * BUFFER);
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0]?.cause).toBe('encoder-backpressure');
    expect(summary.gaps[0]?.durationUs).toBeCloseTo((BUFFER / NOMINAL) * 1_000_000, 0);
  });

  it('falls back to the nominal rate rather than inventing one from a single buffer', () => {
    const summary = meterOf(device(NOMINAL, 1)).summary;
    expect(summary.rateIsNominal).toBe(true);
    expect(summary.measuredSampleRate).toBe(NOMINAL);
  });

  it('has nothing to say about a track that never produced a buffer', () => {
    const summary = new AudioCaptureMeter({ nominalSampleRate: NOMINAL }).summary;
    expect(summary.firstTimestampUs).toBeNull();
    expect(summary.sampleCount).toBe(0);
  });
});

describe('relating two capture clocks (§5.4 mechanism 2)', () => {
  /**
   * The epoch this project measured on a real machine: Chromium stamped captured
   * video from zero and captured audio from the system's uptime, 2,678,930 s apart.
   */
  const AUDIO_EPOCH_US = 2_678_930_000_000;

  it('finds the offset between two clocks through the latency on top of it', () => {
    const epoch = new TrackEpochEstimator();
    for (let i = 0; i < 500; i++) {
      const trueTimeUs = i * 10_000;
      // Delivery is never instant and never early: the minimum observed latency is
      // the closest thing to the epoch difference that exists.
      const latency = 12_000 + ((i * 7919) % 9_000);
      epoch.observe(AUDIO_EPOCH_US + trueTimeUs, trueTimeUs + latency);
    }
    expect(epoch.measured).toBe(true);
    expect(epoch.offsetUs).toBeCloseTo(-AUDIO_EPOCH_US + 12_000, -1);
  });

  it('has no opinion until it has seen a sample', () => {
    const epoch = new TrackEpochEstimator();
    expect(epoch.measured).toBe(false);
    expect(epoch.offsetUs).toBe(0);
  });

  it('turns two clocks into one track that starts where the other does', () => {
    // The audio device's own timestamps are a month ahead; both pipelines take a
    // few milliseconds to hand a sample over. What comes out is a track that starts
    // with the video, which is the only true statement about it.
    const video = new TrackEpochEstimator();
    const audio = new TrackEpochEstimator();
    const buffers: AudioBufferFacts[] = [];
    for (let i = 0; i < 300; i++) {
      const frameUs = Math.round((i * 1_000_000) / 30);
      video.observe(frameUs, frameUs + 5_000);
      const bufferUs = Math.round((i * BUFFER * 1_000_000) / NOMINAL);
      buffers.push({ timestampUs: AUDIO_EPOCH_US + bufferUs, frameCount: BUFFER });
      audio.observe(
        AUDIO_EPOCH_US + bufferUs + Math.round((BUFFER / NOMINAL) * 1_000_000),
        bufferUs + Math.round((BUFFER / NOMINAL) * 1_000_000) + 12_000,
      );
    }

    const timing = alignAudioPart(meterOf(buffers).summary, {
      originUs: video.offsetUs,
      epochOffsetUs: audio.offsetUs,
      referenceStartSec: 0,
    });
    expect(timing.startTimeSec).toBe(0);

    // And without it, the same recording says the microphone started a month early.
    const assumed = alignAudioPart(meterOf(buffers).summary, {
      originUs: 0,
      referenceStartSec: 0,
    });
    expect(assumed.startTimeSec).toBeGreaterThan(1000);
  });
});

describe('placing a part on the recording clock', () => {
  it('starts a part where its first sample was captured, snapped to the reference', () => {
    // 8 ms after the first screen frame — less than one buffer, so it snaps.
    const snapped = alignAudioPart(meterOf(device(NOMINAL, 100, 8_000)).summary, {
      originUs: 0,
      referenceStartSec: 0,
    });
    expect(snapped.startTimeSec).toBe(0);

    // 40 ms is a real offset and is kept.
    const kept = alignAudioPart(meterOf(device(NOMINAL, 100, 40_000)).summary, {
      originUs: 0,
      referenceStartSec: 0,
    });
    expect(kept.startTimeSec).toBeCloseTo(0.04, 6);
  });

  it('measures the part from the recording clock origin, not from zero', () => {
    const timing = alignAudioPart(meterOf(device(NOMINAL, 100, 5_000_000)).summary, {
      originUs: 4_000_000,
      referenceStartSec: 0,
    });
    expect(timing.startTimeSec).toBeCloseTo(1, 6);
  });

  it("gives durationSec the part's extent on the clock, gaps included", () => {
    const glitchUs = 500_000;
    const buffers = device(NOMINAL, 1000).map((buffer, i) =>
      i >= 500 ? { ...buffer, timestampUs: buffer.timestampUs + glitchUs } : buffer,
    );
    const timing = alignAudioPart(meterOf(buffers).summary, {
      originUs: 0,
      referenceStartSec: 0,
    });

    const mediaSec = (1000 * BUFFER) / NOMINAL;
    expect(timing.durationSec).toBeCloseTo(mediaSec + 0.5, 2);
    expect(timing.gaps).toHaveLength(1);
    expect(timing.gaps[0]?.atSec).toBeCloseTo((500 * BUFFER) / NOMINAL, 2);
    expect(timing.gaps[0]?.durationSec).toBeCloseTo(0.5, 3);
  });
});

describe('reading a part back (§5.4 mechanism 5)', () => {
  const part = {
    startTimeSec: 0.25,
    durationSec: 10 + 0.5,
    measuredSampleRate: NOMINAL,
    gaps: [{ atSec: 5.25, durationSec: 0.5, cause: 'device-glitch' }],
  };

  it('splits a part into the runs of samples it actually holds', () => {
    const runs = audioRuns(part);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ firstSample: 0, sampleCount: 5 * NOMINAL, startSec: 0.25 });
    expect(runs[1]?.startSec).toBeCloseTo(5.75, 9);
    expect(runs[0]!.sampleCount + runs[1]!.sampleCount).toBe(10 * NOMINAL);
  });

  it('places every sample after a gap later by exactly the gap', () => {
    const runs = audioRuns(part);
    const rate = part.measuredSampleRate;
    // The last sample before the gap, and the first after it.
    expect(audioSampleTimeSec(runs, 5 * NOMINAL - 1, rate)).toBeCloseTo(5.25 - 1 / rate, 9);
    expect(audioSampleTimeSec(runs, 5 * NOMINAL, rate)).toBeCloseTo(5.75, 9);
  });

  it('answers "nothing plays here" inside a gap rather than closing it', () => {
    const runs = audioRuns(part);
    expect(audioSampleIndexAt(runs, 5.5, NOMINAL)).toBeNull();
    expect(audioSampleIndexAt(runs, 0.1, NOMINAL)).toBeNull();
    expect(audioSampleIndexAt(runs, 5.24, NOMINAL)).toBe(Math.floor(4.99 * NOMINAL));
  });

  it('round-trips sample -> time -> sample', () => {
    const runs = audioRuns(part);
    for (const sample of [0, 1, 5 * NOMINAL - 1, 5 * NOMINAL, 10 * NOMINAL - 1]) {
      const at = audioSampleTimeSec(runs, sample, NOMINAL);
      expect(audioSampleIndexAt(runs, at, NOMINAL)).toBe(sample);
    }
  });
});

describe('drift, stated as the number it is', () => {
  const part = { sampleRate: NOMINAL, measuredSampleRate: FAST_RATE };

  it('is invisible at one minute and obvious at twenty', () => {
    expect(Math.abs(driftSec(part, 60)) * 1000).toBeLessThan(20);
    expect(Math.abs(driftSec(part, 1200)) * 1000).toBeGreaterThan(20);
    // The report's own arithmetic: 50 ppm over 30 minutes is 90 ms.
    expect(Math.abs(driftSec(part, 1800)) * 1000).toBeCloseTo(90, 0);
  });

  it('is what resampling by the measured rate removes', () => {
    expect(resampleRatio(part)).toBeCloseTo(1 + 50e-6, 12);

    // The gate's claim, at the arithmetic level: with the measured rate, the last
    // sample of a twenty-minute recording lands where it was captured. With the
    // nominal one it is 60 ms out — three times the budget, and invisible at any
    // length a person would naturally test.
    const sample = Math.round(1200 * FAST_RATE);
    const correct = audioSampleTimeSec(
      audioRuns({ startTimeSec: 0, durationSec: 1200, measuredSampleRate: FAST_RATE, gaps: [] }),
      sample,
      FAST_RATE,
    );
    const naive = sample / NOMINAL;
    expect(Math.abs(correct - 1200) * 1000).toBeLessThan(1);
    expect(Math.abs(naive - 1200) * 1000).toBeCloseTo(60, 0);
  });
});
