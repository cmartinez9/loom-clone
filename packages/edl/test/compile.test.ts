/**
 * What `compile` refuses, what it ignores, and the seams it reaches a recording
 * through.
 *
 * The line between the two is §2.7's: an **unknown schema** is refused, an unknown
 * *key* is not. A channel or a target this build does not render is a newer build's
 * addition and must leave the recording openable; a `domain` that is neither
 * `source` nor `timeline` is a document that cannot be read at all, because §3.2
 * says the field is explicit and there is nothing to fall back to.
 */

import { describe, expect, it } from 'vitest';
import type { EditDocument, RecordingDoc, Track } from '@loom/format';
import {
  arrayClickStream,
  arrayCursorStream,
  ChannelCompileError,
  cloneResolvedState,
  compile,
  compileClips,
  DEFAULT_SPRING,
  EMPTY_COMPILE_CONTEXT,
  identityTimeline,
  manualZoomTrack,
  resolve,
  sourceDurationSec,
} from '../src/index.ts';

function documentWith(tracks: Track[]): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 1,
    output: { size: [1920, 1240], fps: 30, background: { kind: 'none' } },
    clips: [{ id: 'c1', sourceStart: 0, sourceEnd: 60, speed: 1 }],
    tracks,
  };
}

describe('compile refuses what cannot be read', () => {
  it('refuses a track whose domain is neither source nor timeline', () => {
    const track = {
      ...manualZoomTrack({
        id: 't',
        activeRanges: [[0, 1]],
        amount: [{ t: 0, v: 1, ease: { kind: 'hold' } }],
      }),
      domain: 'whenever',
    } as unknown as Track;
    expect(() => compile(documentWith([track]))).toThrow(/expected "source" or "timeline"/);
  });

  it('refuses a channel that mixes spring and curve easings, even off a fixture', () => {
    // §3.4's rule is stated in the validator for documents read from disk and again
    // here, because a generator's output and a test fixture never touch a disk.
    const track = manualZoomTrack({
      id: 't',
      activeRanges: [[0, 10]],
      amount: [
        { t: 0, v: 1, ease: { kind: 'spring' } },
        { t: 1, v: 2, ease: { kind: 'linear' } },
      ],
      spring: DEFAULT_SPRING,
    });
    expect(() => compile(documentWith([track]))).toThrow(ChannelCompileError);
  });
});

describe('compile ignores what it does not recognise', () => {
  it('keeps a track with an unknown target out of every stack, and does not throw', () => {
    const future: Track = {
      id: 't-future',
      kind: 'transform',
      target: 'grade',
      domain: 'timeline',
      origin: 'manual',
      blend: 'replace',
      blendMs: 0,
      activeRanges: [[0, 60]],
      enabled: true,
      channels: { exposure: { keys: [{ t: 0, v: 0.4, ease: { kind: 'hold' } }] } },
    };
    const ct = compile(documentWith([future]));
    expect(ct.springSamples.size).toBe(0);
    expect(ct.curveIndex.size).toBe(0);
    expect(resolve(ct, 5).zoom.amount).toBe(1);
  });

  it('keeps a channel the target does not define out of the fold', () => {
    const track = manualZoomTrack({
      id: 't',
      activeRanges: [[0, 60]],
      amount: [{ t: 0, v: 2, ease: { kind: 'hold' } }],
    });
    track.channels['rotation'] = { keys: [{ t: 0, v: 45, ease: { kind: 'hold' } }] };
    const ct = compile(documentWith([track]));
    expect(resolve(ct, 5).zoom.amount).toBe(2);
    expect([...ct.curveIndex.keys()]).toEqual(['t.amount']);
  });

  it('drops a disabled track at compile time, not in the hot path', () => {
    const track = manualZoomTrack({
      id: 't',
      activeRanges: [[0, 60]],
      amount: [{ t: 0, v: 2, ease: { kind: 'spring' } }],
      spring: DEFAULT_SPRING,
    });
    const ct = compile(documentWith([{ ...track, enabled: false }]));
    // No table was even built for it — a disabled thirty-minute spring track costs
    // nothing to have around.
    expect(ct.springSamples.size).toBe(0);
  });
});

describe('§3.6’s two public maps', () => {
  it('are keyed by `<trackId>.<channel>`, and by span for a span’s channels', () => {
    const zoom = manualZoomTrack({
      id: 't-zoom',
      activeRanges: [[0, 60]],
      amount: [{ t: 0, v: 1, ease: { kind: 'spring' } }],
      center: [{ t: 0, v: [0.5, 0.5], ease: { kind: 'spring' } }],
      spring: DEFAULT_SPRING,
    });
    const annotation: Track = {
      id: 't-ann',
      kind: 'object',
      target: 'annotation',
      domain: 'source',
      origin: 'manual',
      blend: 'replace',
      blendMs: 0,
      activeRanges: [[0, 60]],
      enabled: true,
      channels: {},
      spans: [
        {
          id: 'a1',
          start: 1,
          end: 2,
          type: 'arrow',
          channels: { opacity: { keys: [{ t: 1, v: 1, ease: { kind: 'hold' } }] } },
        },
      ],
    };
    const ct = compile(documentWith([zoom, annotation]));
    expect([...ct.springSamples.keys()].sort()).toEqual(['t-zoom.amount', 't-zoom.center']);
    expect([...ct.curveIndex.keys()]).toEqual(['t-ann#a1.opacity']);
  });
});

describe('the clip list', () => {
  it('drops clips with no extent or no speed rather than putting two at one start', () => {
    const compiled = compileClips(
      [
        { id: 'a', sourceStart: 0, sourceEnd: 0, speed: 1 },
        { id: 'b', sourceStart: 5, sourceEnd: 10, speed: 1 },
        { id: 'c', sourceStart: 20, sourceEnd: 25, speed: 0 },
      ],
      100,
    );
    expect(compiled.count).toBe(1);
    expect(compiled.durationSec).toBe(5);
  });

  it('is empty, not one clip of nothing, when there is neither a clip list nor a recording', () => {
    const compiled = compileClips([], 0);
    expect(compiled.count).toBe(0);
    expect(compiled.durationSec).toBe(0);
  });
});

describe('sourceDurationSec', () => {
  const recording = (parts: { startTimeSec: number; durationSec: number }[]): RecordingDoc =>
    ({
      schema: 'loom.recording/1',
      clock: { kind: 'videoframe-timestamp-us', t0Us: 0 },
      display: {
        id: 1,
        name: 'x',
        logicalSize: [1, 1],
        pixelSize: [1, 1],
        scaleFactor: 1,
        colorSpace: 'srgb',
      },
      tracks: {
        screen: {
          kind: 'video',
          parts: parts.map((p, i) => ({
            file: `media/screen.00${i}.mp4`,
            codec: 'avc1',
            index: `media/screen.00${i}.index.json`,
            startTimeSec: p.startTimeSec,
            durationSec: p.durationSec,
            endedEarly: false,
            size: [1, 1],
            frameCount: 1,
            rate: { mode: 'variable', nominalFps: 30, observedFps: 30 },
          })),
        },
      },
      events: {},
      capture: {
        app: '0',
        os: '14',
        permissions: {
          screen: 'granted',
          camera: 'denied',
          microphone: 'denied',
          accessibility: false,
        },
        requestedFps: 30,
        resolutionClamp: 'none',
        droppedFrames: {},
      },
      integrity: { finalizedAt: null, recoveredFromCrash: false, truncatedToSec: null },
    }) satisfies RecordingDoc;

  it('is the end of the last video part, not the sum of their durations', () => {
    // A track is a list of parts and a later part starts where the recording clock
    // says, not where the previous one ended (§2.3, §7.4).
    expect(
      sourceDurationSec(
        recording([
          { startTimeSec: 0, durationSec: 30 },
          { startTimeSec: 45, durationSec: 20 },
        ]),
      ),
    ).toBe(65);
  });

  it('is zero when there is no recording at all', () => {
    expect(sourceDurationSec(null)).toBe(0);
  });
});

describe('the event-log seams', () => {
  it('finds the last sample at or before a time, and reports absence as -1', () => {
    const stream = arrayCursorStream([
      { t: 2, x: 0.2, y: 0.3, c: 'arrow' },
      { t: 1, x: 0.1, y: 0.1, c: 'arrow' },
      { t: 5, x: 0.5, y: 0.5, c: 'ibeam' },
    ]);
    expect(stream.count).toBe(3);
    expect(stream.indexAt(0.5)).toBe(-1);
    expect(stream.indexAt(1)).toBe(0);
    expect(stream.indexAt(4.99)).toBe(1);
    expect(stream.indexAt(5)).toBe(2);
    expect(stream.indexAt(1e6)).toBe(2);
    // Unsorted input is sorted, so the binary search is sound whatever the caller did.
    expect(stream.tAt(0)).toBe(1);
    expect(stream.imageIdAt(2)).toBe('ibeam');
  });

  it('does the same for clicks, and reports an empty stream as -1 everywhere', () => {
    expect(arrayClickStream([]).indexAt(0)).toBe(-1);
    const stream = arrayClickStream([
      { t: 1, e: 'down', b: 0, x: 0.1, y: 0.2 },
      { t: 1.1, e: 'up', b: 0, x: 0.1, y: 0.2 },
    ]);
    expect(stream.phaseAt(0)).toBe('down');
    expect(stream.phaseAt(1)).toBe('up');
    expect(stream.buttonAt(0)).toBe(0);
  });

  it('is optional — a context that reaches nothing still compiles', () => {
    expect(compile(documentWith([]), EMPTY_COMPILE_CONTEXT).durationSec).toBe(60);
  });
});

describe('cloneResolvedState', () => {
  it('detaches a borrowed state so it survives the next resolve', () => {
    const ct = identityTimeline(10);
    const kept = cloneResolvedState(resolve(ct, 3));
    resolve(ct, 7);
    expect(kept.timelineTime).toBe(3);
    expect(kept.zoom.center).toEqual([0.5, 0.5]);
    expect(kept.zoom).not.toBe(ct.state.zoom);
  });
});
