/**
 * **Phase 3 gate: an automated flash/tone sync test at 1 minute AND at 20 minutes,
 * with |offset| < 20 ms at both.** Architecture report §8 row 3, §5.5, §10.1.
 *
 * §5.5 specifies the shape of this test in as many words: *"render a fixture with a
 * 1 kHz burst synchronized to a white-flash frame, export it, cross-correlate the
 * audio envelope against the luma envelope, and assert |offset| < 20 ms. Run it at
 * 1 minute and at 20 minutes. The 20-minute case is the one that catches drift, and
 * it is the one everyone skips."*
 *
 * ## What is real here, and what is simulated
 *
 * Simulated: the *devices*. A screen that flashes and a speaker that beeps at the
 * same instant, and a sound card that runs 50 ppm fast — the report's own plausible
 * worst case (§5.5) — with a half-second glitch in the middle.
 *
 * Real: everything the devices feed. The tone is encoded to AAC by AudioToolbox
 * (`afconvert`, which is what Chromium's `AudioEncoder` uses underneath) and decoded
 * back by AVFoundation. The flashes are H.264 from a real encoder. Both go through
 * the production `ProjectStore`, the production fragment writers, and the production
 * `alignAudioPart` / `finalizedRecordingDoc`, and land in a real bundle. Both are
 * read back out of the files that were written — the tone by decoding it, the
 * flashes by matching the bytes in the media file against the palette they came
 * from — and placed on the timeline by the production `audioRuns` and the frame
 * index sidecar. Nothing in the measurement path takes the test's word for
 * anything.
 *
 * What this does *not* cover is the leg above the IPC boundary — `getDisplayMedia`,
 * `getUserMedia`, the encoders in the capture renderer — for the same reason phase 1
 * stops there: it needs a display, a microphone and a TCC grant that CI does not
 * have. `scripts/smoke-capture.mjs` drives that leg on a developer's machine.
 *
 * ## Why simulating the clock is not cheating
 *
 * §5.4 mechanism 1 is that the timebase is taken at capture and never derived from
 * a wall clock. A pipeline that obeys it cannot tell a fast feed from a slow one:
 * twenty minutes of media with correct timestamps is twenty minutes of media. That
 * property is what lets this run in a couple of minutes, and a build that broke it —
 * by stamping from `Date.now()`, say — would fail this test rather than pass it
 * quickly.
 *
 * ## Three controls, because a gate that cannot fail proves nothing
 *
 * `packages/format/test/kill-mid-write.test.ts` set the precedent: a control that
 * must fail, or the passing case means nothing. There are three here, each breaking
 * exactly one mechanism this phase exists to build, and each measured with the same
 * envelopes the gate itself uses:
 *
 * 1. **the nominal rate** — ignore `measuredSampleRate` (§5.5). Passes at one
 *    minute, fails at twenty. This is the failure the whole phase is about, and it
 *    is why one minute alone is not a gate.
 * 2. **closed gaps** — concatenate across the device glitch (§5.4 mechanism 5).
 * 3. **a misaligned track** — falsify `startTimeSec` by 60 ms (§5.4 mechanism 2).
 *    Fails at both lengths, which is what proves the measurement would catch a
 *    deliberately misaligned track at all.
 * 4. **one clock assumed** — subtract the audio timestamps from the video ones
 *    directly, as though they shared an epoch. They do not, on this platform, and
 *    `scripts/smoke-capture.mjs` is what found that out: a capture whose video began
 *    at zero produced audio timestamped at the machine's uptime. The simulated
 *    device here reproduces that, so the correction is exercised by the gate rather
 *    than trusted.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AudioCaptureMeter,
  CROSS_TRACK_SNAP_SEC,
  TrackEpochEstimator,
  alignAudioPart,
  type AudioCaptureSummary,
  audioRuns,
  audioSampleTimeSec,
  totalGapSec,
  validateFrameIndexDoc,
  validateRecordingDoc,
  type AudioPart,
  type FrameIndexDoc,
  type RecordingDoc,
  type VideoPart,
} from '@loom/format';
import type { AudioTrackFacts } from '@loom/ipc';
import { ProjectStore } from '../src/project-store.ts';
import {
  finalizedRecordingDoc,
  provisionalRecordingDoc,
  withAudioTrack,
  withScreenTrack,
} from '../src/recorder/recording-doc.ts';
import {
  decodeToWav,
  encodeAac,
  haveAfconvert,
  wavEnvelope,
  writeWav,
} from '../../../packages/mux/test/helpers/aac.ts';
import { loadFlashFixture } from '../../../packages/mux/test/helpers/flash.ts';

// ------------------------------------------------------------------ the fixture

/** The gate, per architecture report §8. Not a target — a ceiling. */
const BUDGET_MS = 20;

const NOMINAL_RATE = 48000;
/**
 * The device's real rate: 50 ppm fast.
 *
 * The report's plausible worst case (§5.5, §10.1), and the number that makes this
 * gate mean something: 50 ppm is 3 ms over a minute — invisible, inside the budget,
 * and passed by a build that ignores it entirely — and 60 ms over twenty minutes,
 * which is three times the budget.
 */
const TRUE_RATE = NOMINAL_RATE * (1 + 50e-6);
const CHANNELS = 2;
const FPS = 30;
const AUDIO_BUFFER = 1024;

/** A 1 kHz burst, Hann-windowed so its energy envelope has an exact centre. */
const BURST_SEC = 0.25;
/** A triangular luma ramp, wide enough that 30 fps samples it several times. */
const FLASH_SEC = 0.4;
/** A device glitch, long enough to be a gap rather than jitter (§5.4.5). */
const GAP_SEC = 0.5;

/**
 * The epoch the simulated sound card timestamps against.
 *
 * A real one, taken from `scripts/smoke-capture.mjs` on this machine: Chromium
 * stamps captured audio against the system's uptime while the video track began at
 * zero. Building it into the fixture is what makes the epoch correction a thing the
 * gate measures rather than a thing the code claims.
 */
const AUDIO_EPOCH_US = 2_678_930_000_000;

/** How long each pipeline takes to hand over a sample it has already captured. */
const VIDEO_LATENCY_US = 5_000;
const AUDIO_LATENCY_US = 12_000;

/** Envelope resolution for the cross-correlation, and its search range. */
const GRID_SEC = 0.001;
const SEARCH_SEC = 0.5;
const WINDOW_SEC = 1.5;

const fixture = loadFlashFixture();
const enabled = haveAfconvert();
const test = enabled ? it : it.skip;

const scratch = await mkdtemp(join(tmpdir(), 'loom-av-sync-'));
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ------------------------------------------------------------- the fake devices

/**
 * Where the flashes and tones are, in capture-clock seconds.
 *
 * One near the start, one near the end, and a few in between: the first proves the
 * tracks start together, the last proves they are still together after the whole
 * recording, and drift is the difference between them.
 */
function markers(durationSec: number): number[] {
  const last = durationSec - 3;
  const count = durationSec > 120 ? 5 : 4;
  return Array.from({ length: count }, (_, i) => 2 + ((last - 2) * i) / (count - 1));
}

/** Deterministic delivery jitter, so the epoch estimators have a minimum to find. */
function jitterUs(index: number): number {
  return (index * 7919) % 9_000;
}

/** When the device stops producing samples, on the capture clock. */
function gapAtSec(durationSec: number): number {
  return Math.round(durationSec * 0.62);
}

/**
 * The sample-index/capture-time mapping of a device with a gap in it.
 *
 * The gap is time in which no samples exist, so it is a discontinuity in this
 * mapping and not in the sample stream: sample `n` and sample `n + 1` are adjacent
 * in the file and half a second apart in the world. Reproducing that is what
 * `audioRuns` is for, and closing it is control 2.
 */
interface Device {
  gapSample: number;
  gapAtSec: number;
  /** Capture-clock time of a sample index. */
  timeOf(sample: number): number;
  /** Sample index at a capture-clock time. */
  sampleAt(timeSec: number): number;
  totalSamples: number;
}

function device(durationSec: number): Device {
  const at = gapAtSec(durationSec);
  // On a buffer boundary, because a device delivers whole buffers.
  const gapSample = Math.round((at * TRUE_RATE) / AUDIO_BUFFER) * AUDIO_BUFFER;
  const gapStartSec = gapSample / TRUE_RATE;
  return {
    gapSample,
    gapAtSec: gapStartSec,
    timeOf: (sample) => sample / TRUE_RATE + (sample >= gapSample ? GAP_SEC : 0),
    sampleAt: (timeSec) =>
      Math.round((timeSec - (timeSec >= gapStartSec + GAP_SEC ? GAP_SEC : 0)) * TRUE_RATE),
    totalSamples: Math.round((durationSec - GAP_SEC) * TRUE_RATE),
  };
}

/** The tone the speaker played, as the sound card's samples. */
function writeTone(path: string, durationSec: number, dev: Device): void {
  const bursts = markers(durationSec).map((at) => ({
    from: dev.sampleAt(at) - Math.round((BURST_SEC * TRUE_RATE) / 2),
    length: Math.round(BURST_SEC * TRUE_RATE),
  }));
  writeWav(path, {
    sampleRate: NOMINAL_RATE,
    channels: CHANNELS,
    sampleCount: dev.totalSamples,
    sampleAt: (i) => {
      for (const burst of bursts) {
        const u = i - burst.from;
        if (u < 0 || u >= burst.length) continue;
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * u) / (burst.length - 1)));
        return 0.8 * hann * Math.sin((2 * Math.PI * 1000 * i) / NOMINAL_RATE);
      }
      return 0;
    },
  });
}

/** How bright the screen was at a given instant. */
function lumaAt(timeSec: number, marks: readonly number[]): number {
  let brightest = 0;
  for (const at of marks) {
    const distance = Math.abs(timeSec - at);
    if (distance < FLASH_SEC / 2) {
      brightest = Math.max(brightest, 255 * (1 - distance / (FLASH_SEC / 2)));
    }
  }
  return brightest;
}

// ------------------------------------------------------------- the recording

interface Recorded {
  dir: string;
  /** What the device meter measured, before it was placed on the recording clock. */
  summary: AudioCaptureSummary;
  /** What the epoch estimators measured, so a control can throw them away. */
  audioEpochUs: number;
  videoEpochUs: number;
  recording: RecordingDoc;
  audioPart: AudioPart;
  videoPart: VideoPart;
  index: FrameIndexDoc;
  /** Decoded PCM of the audio part, as AVFoundation gives it back. */
  decodedWav: string;
  durationSec: number;
  device: Device;
  marks: number[];
}

const FACTS: AudioTrackFacts = {
  deviceId: 'loopback',
  deviceName: 'System audio',
  source: 'getdisplaymedia-loopback',
  settings: {
    sampleRate: NOMINAL_RATE,
    channelCount: CHANNELS,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  violations: [],
};

/**
 * Record `durationSec` of flashes and tones through the production pipeline.
 *
 * Everything below the IPC boundary is the shipped path: `ProjectStore` opens the
 * bundle, `MediaPartWriter` and `AudioPartWriter` write the fragments,
 * `AudioCaptureMeter` measures the device, `alignAudioPart` places it on the
 * recording clock and `finalizedRecordingDoc` writes it down.
 */
async function record(durationSec: number): Promise<Recorded> {
  const root = await mkdtemp(join(scratch, 'root-'));
  const store = new ProjectStore({
    recordingsRoot: join(root, 'recordings'),
    settingsPath: join(root, 'settings.json'),
    appVersion: '0.1.0-sync-gate',
    trash: () => Promise.resolve(),
  });
  await store.loadSettings();

  const dev = device(durationSec);
  const marks = markers(durationSec);
  const wav = join(root, 'tone.wav');
  writeTone(wav, durationSec, dev);
  const source = encodeAac(wav, join(root, 'tone.aac'));
  // The PCM the encoder consumed is 230 MB at twenty minutes and is not needed
  // again; the AAC frames are what the recording is made of.
  await rm(wav, { force: true });
  expect(source.sampleRate).toBe(NOMINAL_RATE);
  expect(source.channels).toBe(CHANNELS);

  const { id } = await store.create('Sync gate');
  await store.openProject(id);
  await store.setState(id, 'recording');

  const screenFile = store.mediaRelativePath('screen', 0);
  const audioFile = store.mediaRelativePath('system', 0);
  let doc = withAudioTrack(
    withScreenTrack(
      provisionalRecordingDoc({
        display: {
          id: 1,
          name: 'Sync Gate Display',
          logicalSize: [fixture.width, fixture.height],
          pixelSize: [fixture.width, fixture.height],
          scaleFactor: 1,
          colorSpace: 'srgb',
        },
        requestedFps: FPS,
        capture: {
          app: '0.1.0-sync-gate',
          os: process.platform,
          permissions: {
            screen: 'granted',
            camera: 'not-determined',
            microphone: 'granted',
            accessibility: false,
          },
          resolutionClamp: '3840px',
        },
      }),
      {
        file: screenFile,
        index: screenFile.replace(/\.mp4$/, '.index.json'),
        codec: 'avc1.42c015',
        size: [fixture.width, fixture.height],
        requestedFps: FPS,
      },
    ),
    {
      track: 'system',
      file: audioFile,
      codec: 'mp4a.40.2',
      sampleRate: NOMINAL_RATE,
      channels: CHANNELS,
      facts: FACTS,
    },
  );
  await store.writeRecordingDoc(id, doc);

  await store.beginMediaPart(id, {
    track: 'screen',
    part: 0,
    width: fixture.width,
    height: fixture.height,
    avcC: fixture.avcC,
    nominalFps: FPS,
    colour: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
  });
  await store.beginAudioPart(id, {
    track: 'system',
    part: 0,
    sampleRate: NOMINAL_RATE,
    channels: CHANNELS,
    audioSpecificConfig: source.audioSpecificConfig,
    bitrate: 128_000,
  });

  // The screen: one flat frame per 1/30 s, at the brightness the flash envelope
  // calls for, stamped on the capture clock. Each frame is also observed arriving,
  // which is how the two tracks' clocks are related at all (§5.4 mechanism 2).
  const videoEpoch = new TrackEpochEstimator();
  const frameCount = Math.floor(durationSec * FPS);
  for (let i = 0; i < frameCount; i++) {
    const timeSec = i / FPS;
    const frameUs = Math.round(timeSec * 1_000_000);
    videoEpoch.observe(frameUs, frameUs + VIDEO_LATENCY_US + jitterUs(i));
    const level = fixture.levels[fixture.nearest(lumaAt(timeSec, marks))];
    if (level === undefined) throw new Error('the flash palette is empty');
    await store.appendMediaChunk(id, 'screen', {
      data: level.data,
      isKey: true,
      timestampUs: Math.round(timeSec * 1_000_000),
      durationUs: null,
    });
  }

  // The sound card: buffers of 1024 samples, timestamped by the capture clock,
  // measured on the way past, and encoded frames to the file.
  const meter = new AudioCaptureMeter({ nominalSampleRate: NOMINAL_RATE });
  const audioEpoch = new TrackEpochEstimator();
  const buffers = Math.floor(dev.totalSamples / AUDIO_BUFFER);
  const stampOf = (buffer: number): number =>
    AUDIO_EPOCH_US + Math.round(dev.timeOf(buffer * AUDIO_BUFFER) * 1_000_000);
  for (let j = 0; j < buffers; j++) {
    meter.push({ timestampUs: stampOf(j), frameCount: AUDIO_BUFFER });
    // A buffer is in hand once its last sample has been captured, so its end is
    // what the estimator is given — and its arrival is on the shared clock, which
    // is where the epoch difference shows up.
    audioEpoch.observe(
      stampOf(j) + Math.round((AUDIO_BUFFER / NOMINAL_RATE) * 1_000_000),
      Math.round(dev.timeOf((j + 1) * AUDIO_BUFFER) * 1_000_000) + AUDIO_LATENCY_US + jitterUs(j),
    );
  }
  for (const [k, frame] of source.frames.entries()) {
    await store.appendMediaChunk(id, 'system', {
      data: frame.data,
      isKey: true,
      timestampUs: stampOf(Math.min(k, buffers - 1)),
      durationUs: frame.durationUs,
    });
  }

  await store.setState(id, 'finalizing');
  const screenPart = await store.finalizeMediaPart(
    id,
    'screen',
    Math.round(durationSec * 1_000_000),
  );
  await store.finalizeAudioPart(id, 'system');

  const summary = meter.summary;
  expect(summary.gaps, 'the simulated device glitch must be measured as a gap').toHaveLength(1);
  // The recording clock's origin is the first screen frame — on the *shared*
  // clock, which is where the two tracks' epochs are reconciled (§5.4 mechanism 2).
  const timing = alignAudioPart(summary, {
    originUs: videoEpoch.offsetUs,
    epochOffsetUs: audioEpoch.offsetUs,
    referenceStartSec: 0,
  });
  doc = finalizedRecordingDoc(
    doc,
    {
      screen: {
        durationSec: screenPart.durationSec,
        frameCount: screenPart.frameCount,
        observedFps: screenPart.observedFps,
        endedEarly: false,
      },
      audio: { system: { timing, endedEarly: false } },
    },
    0,
    '2026-08-05T00:00:00.000Z',
  );
  await store.writeRecordingDoc(id, doc);
  await store.setState(id, 'editable');
  await store.close(id);

  const dir = await store.directoryFor(id);
  const written = validateRecordingDoc(
    JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8')),
  );
  expect(
    written.ok ? null : written.issues,
    'the gate must write a valid recording.json',
  ).toBeNull();
  if (!written.ok) throw new Error('unreachable');

  const audioPart = written.value.tracks.system?.parts[0];
  const videoPart = written.value.tracks.screen?.parts[0];
  if (audioPart === undefined || videoPart === undefined) {
    throw new Error('the recording is missing a track');
  }
  const indexResult = validateFrameIndexDoc(
    JSON.parse(await readFile(join(dir, videoPart.index), 'utf8')),
  );
  if (!indexResult.ok) throw new Error('the frame index sidecar is invalid');

  // Decode the audio part with AVFoundation — not with anything of ours.
  const decodedWav = join(root, 'decoded.wav');
  decodeToWav(join(dir, audioPart.file), decodedWav);

  return {
    dir,
    summary,
    audioEpochUs: audioEpoch.offsetUs,
    videoEpochUs: videoEpoch.offsetUs,
    recording: written.value,
    audioPart,
    videoPart,
    index: indexResult.value,
    decodedWav,
    durationSec,
    device: dev,
    marks,
  };
}

// ------------------------------------------------------------- the measurement

/**
 * A sample-index to recording-clock mapping. The gate uses the production one;
 * each control replaces exactly one part of it.
 */
type TimeOfSample = (sample: number) => number;

function productionMapping(part: AudioPart): TimeOfSample {
  const runs = audioRuns(part);
  return (sample) => audioSampleTimeSec(runs, sample, part.measuredSampleRate);
}

/** Control 1: the nominal rate instead of the measured one (§5.5). */
function nominalRateMapping(part: AudioPart): TimeOfSample {
  const runs = audioRuns({ ...part, measuredSampleRate: part.sampleRate });
  return (sample) => audioSampleTimeSec(runs, sample, part.sampleRate);
}

/** Control 2: the gap closed instead of reproduced (§5.4 mechanism 5). */
function closedGapMapping(part: AudioPart): TimeOfSample {
  const runs = audioRuns({
    ...part,
    durationSec: part.durationSec - totalGapSec(part.gaps),
    gaps: [],
  });
  return (sample) => audioSampleTimeSec(runs, sample, part.measuredSampleRate);
}

/** Control 3: a track whose recorded start is 60 ms out (§5.4 mechanism 2). */
function misalignedMapping(part: AudioPart, bySec: number): TimeOfSample {
  const shifted = productionMapping(part);
  return (sample) => shifted(sample) + bySec;
}

interface Envelope {
  /** Time of each sample, in recording-clock seconds. */
  timeOf: (index: number) => number;
  values: Float64Array;
  count: number;
}

/** The audio energy envelope, in 10 ms windows, placed by `mapping`. */
function audioEnvelope(recorded: Recorded, mapping: TimeOfSample): Envelope {
  const windowSamples = Math.round(0.01 * NOMINAL_RATE);
  const { envelope } = wavEnvelope(recorded.decodedWav, windowSamples);
  return {
    values: envelope,
    count: envelope.length,
    timeOf: (index) => mapping(index * windowSamples + windowSamples / 2),
  };
}

/**
 * The luma envelope, read back out of the media file.
 *
 * Every frame's bytes are looked up in the palette they were written from, so the
 * brightness comes from a real decode (done once, when the fixture was built) and
 * the *time* comes from the frame index sidecar phase 6 will seek with. A writer
 * that placed frames wrongly shows up here as a flash in the wrong place.
 */
async function lumaEnvelope(recorded: Recorded): Promise<Envelope> {
  const bytes = await readFile(join(recorded.dir, recorded.videoPart.file));
  const palette = new Map<string, number>();
  fixture.levels.forEach((level, i) => palette.set(Buffer.from(level.data).toString('base64'), i));

  const index = recorded.index;
  const values = new Float64Array(index.pts.length);
  for (let i = 0; i < index.pts.length; i++) {
    const at = index.offsets[i] ?? 0;
    const size = index.sizes[i] ?? 0;
    const key = bytes.subarray(at, at + size).toString('base64');
    const level = palette.get(key);
    if (level === undefined) throw new Error(`frame ${i} in the media file is not a palette frame`);
    values[i] = fixture.levels[level]?.luma ?? 0;
  }
  return {
    values,
    count: values.length,
    timeOf: (i) => recorded.videoPart.startTimeSec + (index.pts[i] ?? 0) / index.timescale,
  };
}

/** Resample an envelope onto a uniform grid around `centreSec`. */
function onGrid(envelope: Envelope, centreSec: number): Float64Array {
  const steps = Math.round((2 * WINDOW_SEC) / GRID_SEC) + 1;
  const grid = new Float64Array(steps);
  let at = 0;
  for (let s = 0; s < steps; s++) {
    const want = centreSec - WINDOW_SEC + s * GRID_SEC;
    while (at + 1 < envelope.count && envelope.timeOf(at + 1) <= want) at += 1;
    const t0 = envelope.timeOf(at);
    const t1 = envelope.timeOf(Math.min(at + 1, envelope.count - 1));
    const v0 = envelope.values[at] ?? 0;
    const v1 = envelope.values[Math.min(at + 1, envelope.count - 1)] ?? 0;
    grid[s] = t1 > t0 ? v0 + ((v1 - v0) * (want - t0)) / (t1 - t0) : v0;
  }
  return grid;
}

/**
 * Cross-correlate two envelopes and return the lag of the peak, in seconds.
 *
 * Positive means the audio is late. The peak is refined by fitting a parabola to
 * its neighbours, so the answer is not quantised to the 1 ms grid — which matters
 * when the budget is 20 ms and the controls have to be distinguishable from it.
 */
function offsetSec(audio: Float64Array, video: Float64Array): number {
  const a = normalize(audio);
  const v = normalize(video);
  const maxLag = Math.round(SEARCH_SEC / GRID_SEC);
  let bestLag = 0;
  let best = Number.NEGATIVE_INFINITY;
  const at = (lag: number): number => {
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= a.length) continue;
      sum += (a[j] ?? 0) * (v[i] ?? 0);
    }
    return sum;
  };
  const scores = new Map<number, number>();
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const score = at(lag);
    scores.set(lag, score);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  const left = scores.get(bestLag - 1) ?? best;
  const right = scores.get(bestLag + 1) ?? best;
  const denominator = left - 2 * best + right;
  const refined = denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
  return (bestLag + refined) * GRID_SEC;
}

function normalize(values: Float64Array): Float64Array {
  let mean = 0;
  for (const value of values) mean += value;
  mean /= values.length || 1;
  const out = new Float64Array(values.length);
  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    const centred = (values[i] ?? 0) - mean;
    out[i] = centred;
    norm += centred * centred;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

/** The offset at every flash, in milliseconds, under one mapping. */
async function offsetsMs(recorded: Recorded, mapping: TimeOfSample): Promise<number[]> {
  const audio = audioEnvelope(recorded, mapping);
  const luma = await lumaEnvelope(recorded);
  return recorded.marks.map((at) => offsetSec(onGrid(audio, at), onGrid(luma, at)) * 1000);
}

// ---------------------------------------------------------------------- the gate

const recordings = new Map<number, Promise<Recorded>>();

function recordingOf(durationSec: number): Promise<Recorded> {
  const existing = recordings.get(durationSec);
  if (existing !== undefined) return existing;
  const started = record(durationSec);
  recordings.set(durationSec, started);
  return started;
}

const ONE_MINUTE = 60;
const TWENTY_MINUTES = 20 * 60;

describe('flash/tone A/V sync', () => {
  for (const durationSec of [ONE_MINUTE, TWENTY_MINUTES]) {
    const label = `${durationSec / 60} minute${durationSec === ONE_MINUTE ? '' : 's'}`;

    test(`|offset| < ${BUDGET_MS} ms at ${label}`, async () => {
      const recorded = await recordingOf(durationSec);
      const offsets = await offsetsMs(recorded, productionMapping(recorded.audioPart));

      console.log(
        `[gate] ${label}: offsets ${offsets.map((ms) => ms.toFixed(1)).join(', ')} ms ` +
          `(budget ±${BUDGET_MS}); measured ${recorded.audioPart.measuredSampleRate.toFixed(3)} Hz ` +
          `against a nominal ${recorded.audioPart.sampleRate}, ` +
          `${recorded.audioPart.gaps.length} gap(s), ` +
          `start ${recorded.audioPart.startTimeSec.toFixed(4)}s`,
      );

      offsets.forEach((ms, i) => {
        expect(
          Math.abs(ms),
          `the flash at ${recorded.marks[i]?.toFixed(1) ?? '?'}s is ${ms.toFixed(1)} ms from its tone`,
        ).toBeLessThan(BUDGET_MS);
      });

      // The measurement the offsets rest on: a device that really did run fast,
      // read back off the recording rather than assumed.
      expect(recorded.audioPart.measuredSampleRate).toBeGreaterThan(NOMINAL_RATE);
      expect(recorded.audioPart.measuredSampleRate).toBeCloseTo(TRUE_RATE, 0);
    }, 900_000);
  }

  test('CONTROL: the nominal rate passes at one minute and fails at twenty', async () => {
    const short = await recordingOf(ONE_MINUTE);
    const long = await recordingOf(TWENTY_MINUTES);
    const shortOffsets = await offsetsMs(short, nominalRateMapping(short.audioPart));
    const longOffsets = await offsetsMs(long, nominalRateMapping(long.audioPart));

    const worst = (offsets: number[]): number => Math.max(...offsets.map(Math.abs));
    console.log(
      `[control] nominal rate: worst ${worst(shortOffsets).toFixed(1)} ms at one minute, ` +
        `${worst(longOffsets).toFixed(1)} ms at twenty`,
    );

    // This is the whole argument for the twenty-minute case, as a number. A build
    // that ignores `measuredSampleRate` is inside the budget at one minute and
    // three times outside it at twenty; a gate that ran only the short case would
    // ship it.
    expect(
      worst(shortOffsets),
      'a one-minute test cannot see drift — that is why it is not the gate',
    ).toBeLessThan(BUDGET_MS);
    expect(
      worst(longOffsets),
      'ignoring measuredSampleRate must fail the twenty-minute gate, or the gate is ' +
        'not measuring drift at all',
    ).toBeGreaterThan(BUDGET_MS);
  }, 900_000);

  test('CONTROL: closing the gap desynchronises everything after it', async () => {
    const recorded = await recordingOf(ONE_MINUTE);
    const closed = await offsetsMs(recorded, closedGapMapping(recorded.audioPart));
    const after = recorded.marks
      .map((at, i) => ({ at, ms: closed[i] ?? 0 }))
      .filter((entry) => entry.at > recorded.device.gapAtSec);

    console.log(
      `[control] closed gap: ${after.map((e) => `${e.ms.toFixed(1)} ms`).join(', ')} after the gap`,
    );
    expect(after.length, 'the fixture must place a flash after the gap').toBeGreaterThan(0);
    for (const entry of after) {
      expect(
        Math.abs(entry.ms),
        `closing a ${GAP_SEC * 1000} ms gap must move everything after it out of budget`,
      ).toBeGreaterThan(BUDGET_MS);
    }
  }, 900_000);

  test('CONTROL: assuming the two tracks share a clock puts audio a month out', async () => {
    const recorded = await recordingOf(ONE_MINUTE);

    // What the epoch estimators actually found: the audio clock runs ahead of the
    // video one by the machine's uptime, and the correction is that number.
    expect(Math.abs(recorded.audioEpochUs)).toBeGreaterThan(1e9);
    expect(Math.abs(recorded.videoEpochUs)).toBeLessThan(1e6);

    const assumed = alignAudioPart(recorded.summary, { originUs: 0, referenceStartSec: 0 });
    console.log(
      `[control] one clock assumed: startTimeSec ${assumed.startTimeSec.toFixed(0)}s ` +
        `instead of ${recorded.audioPart.startTimeSec.toFixed(4)}s`,
    );

    // Not "out of budget" — out of the recording. This is the failure
    // `scripts/smoke-capture.mjs` found on a real machine, and the cross-correlation
    // above cannot even measure it: both envelopes leave the window entirely.
    expect(
      Math.abs(assumed.startTimeSec),
      'without the epoch correction the audio track lands a month from the video',
    ).toBeGreaterThan(1000);
    expect(Math.abs(recorded.audioPart.startTimeSec)).toBeLessThan(CROSS_TRACK_SNAP_SEC);
  }, 900_000);

  test('CONTROL: a deliberately misaligned track fails at both lengths', async () => {
    const shift = 0.06;
    for (const durationSec of [ONE_MINUTE, TWENTY_MINUTES]) {
      const recorded = await recordingOf(durationSec);
      const offsets = await offsetsMs(recorded, misalignedMapping(recorded.audioPart, shift));
      const worst = Math.max(...offsets.map(Math.abs));
      console.log(`[control] +${shift * 1000} ms on startTimeSec: worst ${worst.toFixed(1)} ms`);
      expect(
        worst,
        'a track offset by 60 ms must be caught, or this test would pass a build with no ' +
          'per-track startTimeSec at all',
      ).toBeGreaterThan(BUDGET_MS);
      // And it is caught as the *shift*, not as noise: the measurement is accurate
      // to a millisecond or two, which is what makes a 20 ms budget meaningful.
      expect(Math.abs(worst - shift * 1000)).toBeLessThan(5);
    }
  }, 900_000);
});
