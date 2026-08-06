/**
 * §5.3's stream-copy fast path: when it applies, and what it copies.
 *
 * The eligibility half is what the UI asks so it can say *"Instant"* or *"≈4 min,
 * because the bubble is on"* — §5.3: *"they can often get it by turning the bubble
 * off"* — so every reason has to come back, not just the first.
 *
 * The planning half is where a mistake is expensive rather than annoying: a copied
 * P-frame carried across a cut references a picture the copy left behind, and the
 * result is a file that plays and shows garbage. That case is refused here, with a
 * control proving the refusal is not vacuous.
 */

import { describe, expect, it } from 'vitest';
import {
  currentSchemaId,
  newEditDocument,
  type EditDocument,
  type FrameIndexDoc,
  type RecordingDoc,
  type Track,
  type VideoPart,
} from '@loom/format';
import type { ExportSettings } from '@loom/ipc';
import {
  COPY_TIMESCALE,
  StreamCopyRefused,
  planStreamCopy,
  streamCopyEligibility,
} from '../src/export/stream-copy.ts';

const SIZE: [number, number] = [1920, 1080];
const FPS = 30;
/** Keyframes every 15 frames, so a cut can be on one and a cut can miss one. */
const GOP = 15;
const FRAMES = 60;

function index(): FrameIndexDoc {
  const pts: number[] = [];
  const sizes: number[] = [];
  const offsets: number[] = [];
  const keyframes: number[] = [];
  let offset = 0;
  for (let i = 0; i < FRAMES; i++) {
    pts.push(Math.round((i * 1_000_000) / FPS));
    const byteLength = 100 + i;
    sizes.push(byteLength);
    offsets.push(offset);
    offset += byteLength;
    if (i % GOP === 0) keyframes.push(i);
  }
  return {
    schema: currentSchemaId('loom.index'),
    timescale: 1_000_000,
    keyframes,
    pts,
    sizes,
    offsets,
  };
}

function part(): VideoPart {
  return {
    file: 'media/screen.000.mp4',
    index: 'media/screen.000.index.json',
    codec: 'avc1.640028',
    startTimeSec: 0,
    durationSec: FRAMES / FPS,
    endedEarly: false,
    size: SIZE,
    frameCount: FRAMES,
    rate: { mode: 'variable', nominalFps: FPS, observedFps: FPS },
  };
}

function recording(overrides: Partial<RecordingDoc['tracks']> = {}): RecordingDoc {
  return {
    schema: currentSchemaId('loom.recording'),
    clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
    display: {
      id: 1,
      name: 'Built-in',
      logicalSize: [1728, 1117],
      pixelSize: SIZE,
      scaleFactor: 2,
      colorSpace: 'srgb',
    },
    tracks: { screen: { kind: 'video', parts: [part()] }, ...overrides },
    events: {},
    capture: {
      app: '0.0.0',
      os: '14.0',
      permissions: {
        screen: 'granted',
        camera: 'not-determined',
        microphone: 'granted',
        accessibility: false,
      },
      requestedFps: FPS,
      resolutionClamp: '3840',
      droppedFrames: {},
    },
    integrity: { finalizedAt: null, recoveredFromCrash: false, truncatedToSec: null },
  };
}

function settings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    width: SIZE[0],
    height: SIZE[1],
    fps: FPS,
    bitrate: 12_000_000,
    audioBitrate: 128_000,
    outputDir: '/tmp/exports',
    name: 'Demo',
    keepSources: false,
    ...overrides,
  };
}

function zoomTrack(): Track {
  return {
    id: 'zoom',
    kind: 'transform',
    target: 'zoom',
    domain: 'source',
    origin: 'manual',
    blend: 'replace',
    blendMs: 300,
    activeRanges: [[0, 1e9]],
    enabled: true,
    channels: { amount: { keys: [{ t: 0, v: 1.5, ease: { kind: 'hold' } }] } },
  };
}

function edit(overrides: Partial<EditDocument> = {}): EditDocument {
  return { ...newEditDocument(), ...overrides };
}

describe('streamCopyEligibility', () => {
  it('says yes to an untouched recording at its own size', () => {
    const decision = streamCopyEligibility({
      edit: edit(),
      recording: recording(),
      settings: settings(),
    });
    expect(decision).toEqual({ eligible: true, reasons: [] });
  });

  it('names every reason, not the first', () => {
    const decision = streamCopyEligibility({
      edit: edit({ tracks: [zoomTrack()] }),
      recording: recording({ webcam: { kind: 'video', parts: [part()] } }),
      settings: settings({ width: 1280, height: 720 }),
    });
    expect(decision.eligible).toBe(false);
    // The UI's job is to say what to turn off, and this is three things, not one.
    expect(decision.reasons).toHaveLength(3);
    expect(decision.reasons.join(' ')).toMatch(/1280x720/);
    expect(decision.reasons.join(' ')).toMatch(/camera track/);
    expect(decision.reasons.join(' ')).toMatch(/zoom track is enabled/);
  });

  it('ignores a disabled visual track', () => {
    const decision = streamCopyEligibility({
      edit: edit({ tracks: [{ ...zoomTrack(), enabled: false }] }),
      recording: recording(),
      settings: settings(),
    });
    expect(decision.eligible).toBe(true);
  });

  it('refuses a speed change', () => {
    const decision = streamCopyEligibility({
      edit: edit({ clips: [{ id: 'c', sourceStart: 0, sourceEnd: 2, speed: 2 }] }),
      recording: recording(),
      settings: settings(),
    });
    expect(decision.reasons.join(' ')).toMatch(/plays at 2x/);
  });

  it('refuses a multi-part screen track', () => {
    const two = recording();
    two.tracks.screen = { kind: 'video', parts: [part(), { ...part(), startTimeSec: 5 }] };
    expect(
      streamCopyEligibility({ edit: edit(), recording: two, settings: settings() }).reasons,
    ).toContain('the screen track is in 2 parts');
  });
});

describe('planStreamCopy', () => {
  it('copies every frame of an untrimmed recording, with real durations', () => {
    const plan = planStreamCopy(index(), part(), []);
    expect(plan.timescale).toBe(COPY_TIMESCALE);
    expect(plan.samples).toHaveLength(FRAMES);
    expect(plan.width).toBe(SIZE[0]);
    expect(plan.samples[0]?.isKey).toBe(true);
    expect(plan.samples[1]?.isKey).toBe(false);
    // Durations measured against the next frame's PTS, exactly as the capture writer
    // measured them — and the last frame stands for the rest of the part.
    expect(plan.samples[0]?.durationUnits).toBe(Math.round(1_000_000 / FPS));
    expect(plan.durationSec).toBeCloseTo(FRAMES / FPS, 4);
    // The byte ranges are the source's own, so the copy is a read and a write.
    expect(plan.samples[0]).toMatchObject({ offset: 0, byteLength: 100 });
  });

  it('copies only the clipped ranges when the cuts are on keyframes', () => {
    const plan = planStreamCopy(index(), part(), [
      { id: 'a', sourceStart: GOP / FPS, sourceEnd: (GOP * 2) / FPS, speed: 1 },
      { id: 'b', sourceStart: (GOP * 3) / FPS, sourceEnd: FRAMES / FPS, speed: 1 },
    ]);
    // 15..30 inclusive of the frame the range ends on, then 45..59.
    expect(plan.samples).toHaveLength(GOP + 1 + (FRAMES - GOP * 3));
    expect(plan.samples[0]?.isKey).toBe(true);
    // The second clip's first sample is a keyframe too — a decoder starts there.
    expect(plan.samples[GOP + 1]?.isKey).toBe(true);
  });

  it('refuses a cut that is not on a keyframe', () => {
    // §5.3's condition. A P-frame carried across a cut references a picture the copy
    // left behind, and what comes out plays and is garbage.
    expect(() =>
      planStreamCopy(index(), part(), [
        { id: 'a', sourceStart: 3 / FPS, sourceEnd: 20 / FPS, speed: 1 },
      ]),
    ).toThrow(StreamCopyRefused);
  });

  it('control: the same cut one frame earlier, on the keyframe, is accepted', () => {
    // Without this, "it refuses everything" and "it refuses non-keyframe cuts" read
    // identically.
    expect(() =>
      planStreamCopy(index(), part(), [{ id: 'a', sourceStart: 0, sourceEnd: 20 / FPS, speed: 1 }]),
    ).not.toThrow();
  });

  it('refuses a speed change it was somehow handed', () => {
    expect(() =>
      planStreamCopy(index(), part(), [{ id: 'a', sourceStart: 0, sourceEnd: 1, speed: 2 }]),
    ).toThrow(/cannot change speed/);
  });
});
