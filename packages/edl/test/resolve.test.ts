/**
 * `resolve` — the two time domains, the track stack, and the first consumer.
 *
 * The three claims worth testing by hand rather than by property, because each is a
 * decision the report argues for at length and each has an obvious wrong answer:
 *
 *  1. **§3.2 — effects are anchored in source time.** *"Trimming re-times your
 *     zooms"* is the Cap behaviour being rejected. The test is literal: place a zoom
 *     on a moment, cut eight seconds out ahead of it, and the zoom must still be on
 *     that moment.
 *  2. **§3.5 — tracks on the same target stack, topmost with an opinion wins.** A
 *     generated track underneath, a manual track above with its own `activeRanges`,
 *     and a `blendMs` crossfade in the seam.
 *  3. **Decision 3 — manual keyframed zoom is the first consumer.** The end of that
 *     chain is `sourceSampleRect`, which is what the compositor samples, so the test
 *     ends there rather than at a number in a struct.
 */

import { describe, expect, it } from 'vitest';
import { sourceSampleRect } from '@loom/compositor';
import type { EditDocument, Track } from '@loom/format';
import {
  ALWAYS,
  arrayCursorStream,
  bubbleTrack,
  compile,
  DEFAULT_SPRING,
  identityState,
  identityTimeline,
  manualZoomTrack,
  resolve,
  windowWeight,
} from '../src/index.ts';

function documentWith(
  tracks: Track[],
  clips = [{ id: 'c1', sourceStart: 0, sourceEnd: 60, speed: 1 }],
): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 1,
    output: { size: [1920, 1240], fps: 30, background: { kind: 'none' } },
    clips,
    tracks,
  };
}

describe('the clip list is the only mapping between the domains — §3.1', () => {
  it('maps timeline time to source time through the clip it lands in', () => {
    const doc = documentWith(
      [],
      [
        { id: 'c1', sourceStart: 4, sourceEnd: 10, speed: 1 },
        { id: 'c2', sourceStart: 30, sourceEnd: 40, speed: 2 },
      ],
    );
    const ct = compile(doc);
    // c1 is 6 s of source at 1×, so 6 s of timeline. c2 is 10 s of source at 2×, so 5 s.
    expect(ct.durationSec).toBe(11);
    expect(Array.from(ct.clipStarts)).toEqual([0, 6]);

    expect(resolve(ct, 0).sourceTime).toBe(4);
    expect(resolve(ct, 3).sourceTime).toBe(7);
    expect(resolve(ct, 6).sourceTime).toBe(30);
    expect(resolve(ct, 6).clipIndex).toBe(1);
    // Speed 2 means source advances twice as fast as the timeline.
    expect(resolve(ct, 8).sourceTime).toBe(34);
    expect(resolve(ct, 11).sourceTime).toBe(40);
  });

  it('clamps the playhead into the timeline rather than extrapolating past it', () => {
    const ct = identityTimeline(12);
    expect(resolve(ct, -5).timelineTime).toBe(0);
    expect(resolve(ct, 99).timelineTime).toBe(12);
    expect(resolve(ct, 99).sourceTime).toBe(12);
  });

  it('reads an empty clip list as the whole source, from `recording.json`', () => {
    const ct = compile(documentWith([], []), {
      cursor: null,
      clicks: null,
      recording: {
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
            parts: [
              {
                file: 'media/screen.000.mp4',
                codec: 'avc1',
                index: 'media/screen.000.index.json',
                startTimeSec: 0,
                durationSec: 42.5,
                endedEarly: false,
                size: [1, 1],
                frameCount: 1,
                rate: { mode: 'variable', nominalFps: 30, observedFps: 30 },
              },
            ],
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
      },
    });
    expect(ct.durationSec).toBe(42.5);
    expect(resolve(ct, 10).sourceTime).toBe(10);
  });
});

describe('effects are anchored in SOURCE time — §3.2', () => {
  /** A zoom on "the moment I clicked Deploy", at source time 40. */
  const zoom = manualZoomTrack({
    id: 't-zoom',
    activeRanges: [[38, 44]],
    amount: [
      { t: 38, v: 1, ease: { kind: 'linear' } },
      { t: 40, v: 2.5, ease: { kind: 'hold' } },
      { t: 44, v: 2.5, ease: { kind: 'hold' } },
    ],
    blendMs: 0,
  });

  it('keeps a zoom on its moment when eight seconds are cut ahead of it', () => {
    const before = compile(
      documentWith([zoom], [{ id: 'c1', sourceStart: 0, sourceEnd: 60, speed: 1 }]),
    );
    // The zoom is at timeline 40 because nothing has been trimmed yet.
    expect(resolve(before, 40).zoom.amount).toBeCloseTo(2.5, 6);

    // Now delete eight seconds of dead air at 0:30.
    const after = compile(
      documentWith(
        [zoom],
        [
          { id: 'c1', sourceStart: 0, sourceEnd: 30, speed: 1 },
          { id: 'c2', sourceStart: 38, sourceEnd: 60, speed: 1 },
        ],
      ),
    );
    // The same content is now at timeline 32, and the zoom moved with the content.
    expect(resolve(after, 32).sourceTime).toBe(40);
    expect(resolve(after, 32).zoom.amount).toBeCloseTo(2.5, 6);
    // §3.2's rejected behaviour: it must NOT still be at timeline 40, where the
    // content is now source 48.
    expect(resolve(after, 40).sourceTime).toBe(48);
    expect(resolve(after, 40).zoom.amount).toBe(1);
  });

  it('drops an effect whose region was cut away', () => {
    const inTheCut = manualZoomTrack({
      id: 't-cut',
      activeRanges: [[32, 36]],
      amount: [{ t: 32, v: 3, ease: { kind: 'hold' } }],
      blendMs: 0,
    });
    const ct = compile(
      documentWith(
        [inTheCut],
        [
          { id: 'c1', sourceStart: 0, sourceEnd: 30, speed: 1 },
          { id: 'c2', sourceStart: 38, sourceEnd: 60, speed: 1 },
        ],
      ),
    );
    // No timeline time maps into source [32, 36], so the zoom is simply never active.
    for (let t = 0; t <= ct.durationSec; t += 0.25) expect(resolve(ct, t).zoom.amount).toBe(1);
  });

  it('a `timeline`-domain track describes the output, and does not move with a trim', () => {
    // §3.2: "tracks that describe the *output* rather than the *content* … set
    // `domain: 'timeline'`". The field is explicit, so flipping it is the whole test.
    const track: Track = { ...zoom, id: 't-timeline', domain: 'timeline' };
    const ct = compile(
      documentWith(
        [track],
        [
          { id: 'c1', sourceStart: 0, sourceEnd: 30, speed: 1 },
          { id: 'c2', sourceStart: 38, sourceEnd: 60, speed: 1 },
        ],
      ),
    );
    expect(resolve(ct, 40).zoom.amount).toBeCloseTo(2.5, 6);
    expect(resolve(ct, 32).zoom.amount).toBe(1);
  });
});

describe('tracks on the same target stack — §3.5', () => {
  const generated: Track = {
    ...manualZoomTrack({
      id: 't-zoom-auto',
      activeRanges: [[0, 100]],
      amount: [{ t: 0, v: 1.5, ease: { kind: 'hold' } }],
      center: [{ t: 0, v: [0.2, 0.2], ease: { kind: 'hold' } }],
      blendMs: 0,
    }),
    origin: 'generated',
  };

  const manual = manualZoomTrack({
    id: 't-zoom-manual',
    activeRanges: [[20, 30]],
    amount: [{ t: 20, v: 3, ease: { kind: 'hold' } }],
    center: [{ t: 20, v: [0.8, 0.8], ease: { kind: 'hold' } }],
    blendMs: 0,
  });

  it('lets the topmost track with an opinion win where it has one', () => {
    const ct = compile(documentWith([generated, manual]));
    expect(resolve(ct, 10).zoom.amount).toBe(1.5);
    expect(resolve(ct, 10).zoom.center).toEqual([0.2, 0.2]);
    // Inside the manual track's range the manual track wins outright.
    expect(resolve(ct, 25).zoom.amount).toBe(3);
    expect(resolve(ct, 25).zoom.center).toEqual([0.8, 0.8]);
    // …and the generator drives again once it ends.
    expect(resolve(ct, 40).zoom.amount).toBe(1.5);
  });

  it('crossfades the handoff over `blendMs` so it does not pop', () => {
    const faded: Track = { ...manual, blendMs: 400 };
    const ct = compile(documentWith([generated, faded]));
    // At the edge the manual track contributes nothing…
    expect(resolve(ct, 20).zoom.amount).toBe(1.5);
    // …half way through the crossfade it is half of the way there…
    expect(resolve(ct, 20.2).zoom.amount).toBeCloseTo(1.5 + (3 - 1.5) * 0.5, 6);
    // …and past it, all the way.
    expect(resolve(ct, 21).zoom.amount).toBe(3);
    expect(resolve(ct, 29.8).zoom.amount).toBeCloseTo(2.25, 6);
    expect(resolve(ct, 30).zoom.amount).toBe(1.5);
  });

  it('treats an opinion as per channel, not per track', () => {
    // A manual track with only `amount` must not reset the centre the generated
    // track below it set.
    const amountOnly = manualZoomTrack({
      id: 't-amount-only',
      activeRanges: [[20, 30]],
      amount: [{ t: 20, v: 4, ease: { kind: 'hold' } }],
      blendMs: 0,
    });
    const ct = compile(documentWith([generated, amountOnly]));
    const state = resolve(ct, 25);
    expect(state.zoom.amount).toBe(4);
    expect(state.zoom.center).toEqual([0.2, 0.2]);
  });

  it('skips a disabled track entirely', () => {
    const ct = compile(documentWith([generated, { ...manual, enabled: false }]));
    expect(resolve(ct, 25).zoom.amount).toBe(1.5);
  });

  it('adds and multiplies as well as replacing', () => {
    const added: Track = {
      ...manual,
      blend: 'add',
      channels: { amount: { keys: [{ t: 20, v: 0.5, ease: { kind: 'hold' } }] } },
    };
    expect(resolve(compile(documentWith([generated, added])), 25).zoom.amount).toBe(2);

    const multiplied: Track = { ...added, blend: 'multiply' };
    expect(resolve(compile(documentWith([generated, multiplied])), 25).zoom.amount).toBe(0.75);
  });
});

describe('windowWeight — §3.5’s `window(track, t)`', () => {
  it('is zero outside every range and one inside a hard-edged one', () => {
    const ranges = Float64Array.from([10, 20, 40, 50]);
    expect(windowWeight(ranges, 0, 9.999)).toBe(0);
    expect(windowWeight(ranges, 0, 10)).toBe(1);
    expect(windowWeight(ranges, 0, 15)).toBe(1);
    expect(windowWeight(ranges, 0, 20)).toBe(1);
    expect(windowWeight(ranges, 0, 30)).toBe(0);
    expect(windowWeight(ranges, 0, 45)).toBe(1);
    expect(windowWeight(ranges, 0, 50.001)).toBe(0);
  });

  it('ramps in and out over blendSec, and never exceeds one', () => {
    const ranges = Float64Array.from([10, 20]);
    expect(windowWeight(ranges, 0.5, 10)).toBe(0);
    expect(windowWeight(ranges, 0.5, 10.25)).toBeCloseTo(0.5, 9);
    expect(windowWeight(ranges, 0.5, 11)).toBe(1);
    expect(windowWeight(ranges, 0.5, 19.75)).toBeCloseTo(0.5, 9);
    expect(windowWeight(ranges, 0.5, 20)).toBe(0);
  });

  it('fades up and back down when the range is shorter than two crossfades', () => {
    const ranges = Float64Array.from([10, 10.4]);
    const peak = windowWeight(ranges, 1, 10.2);
    expect(peak).toBeCloseTo(0.2, 9);
    expect(peak).toBeLessThan(1);
  });

  it('is never active with no ranges at all', () => {
    expect(windowWeight(new Float64Array(0), 0, 5)).toBe(0);
    expect(windowWeight(new Float64Array(0), 1, 5)).toBe(0);
  });
});

describe('the bubble — §3.3, shape as geometry', () => {
  it('is invisible when there is no bubble track', () => {
    expect(resolve(identityTimeline(10), 5).bubble.visible).toBe(false);
  });

  it('resolves a still pose, and morphs between two shapes', () => {
    const still = bubbleTrack({
      id: 't-bubble',
      center: [0.88, 0.84],
      sizeY: 0.22,
      aspect: 1,
      corner01: 1,
      shapePreset: 'circle',
    });
    const state = resolve(compile(documentWith([still])), 5).bubble;
    expect(state.visible).toBe(true);
    expect(state.center).toEqual([0.88, 0.84]);
    expect(state.sizeY).toBe(0.22);
    expect(state.aspect).toBe(1);
    expect(state.corner01).toBe(1);
    expect(state.mirror).toBe(false);

    // A square morphing into a circle is an interpolation of `corner01`, not a
    // change of enum — §3.3's "get the primitive right and the feature is free".
    const morphing: Track = {
      ...still,
      id: 't-morph',
      channels: {
        ...still.channels,
        corner01: {
          keys: [
            { t: 0, v: 0.1, ease: { kind: 'linear' } },
            { t: 2, v: 1, ease: { kind: 'hold' } },
          ],
        },
      },
    };
    const ct = compile(documentWith([morphing]));
    expect(resolve(ct, 0).bubble.corner01).toBeCloseTo(0.1, 9);
    expect(resolve(ct, 1).bubble.corner01).toBeCloseTo(0.55, 9);
    expect(resolve(ct, 2).bubble.corner01).toBe(1);
  });

  it('goes invisible when its opacity reaches zero, and comes back', () => {
    const fading = bubbleTrack({
      id: 't-bubble',
      center: [0.5, 0.5],
      sizeY: 0.2,
      aspect: 1,
      corner01: 1,
    });
    fading.channels['opacity'] = {
      keys: [
        { t: 0, v: 1, ease: { kind: 'linear' } },
        { t: 1, v: 0, ease: { kind: 'hold' } },
        { t: 3, v: 0, ease: { kind: 'linear' } },
        { t: 4, v: 1, ease: { kind: 'hold' } },
      ],
    };
    const ct = compile(documentWith([fading]));
    expect(resolve(ct, 0).bubble.visible).toBe(true);
    expect(resolve(ct, 2).bubble.visible).toBe(false);
    expect(resolve(ct, 5).bubble.visible).toBe(true);
  });

  it('reads `mirror` as a channel, thresholded — it is a number on disk', () => {
    const mirrored = bubbleTrack({
      id: 't-bubble',
      center: [0.5, 0.5],
      sizeY: 0.2,
      aspect: 1,
      corner01: 1,
      mirror: true,
    });
    expect(resolve(compile(documentWith([mirrored])), 1).bubble.mirror).toBe(true);
  });
});

describe('cursor, annotations and audio', () => {
  it('reports no cursor when there is no cursor data, rather than one at the origin', () => {
    const track: Track = {
      id: 't-cursor',
      kind: 'transform',
      target: 'cursor',
      domain: 'source',
      origin: 'manual',
      blend: 'replace',
      blendMs: 0,
      activeRanges: ALWAYS,
      enabled: true,
      channels: { scale: { keys: [{ t: 0, v: 1.4, ease: { kind: 'hold' } }] } },
    };
    expect(resolve(compile(documentWith([track])), 5).cursor).toBeNull();

    const withStream = compile(documentWith([track]), {
      cursor: arrayCursorStream([
        { t: 0, x: 0.1, y: 0.2, c: 'arrow' },
        { t: 5, x: 0.6, y: 0.7, c: 'ibeam' },
      ]),
      clicks: null,
      recording: null,
    });
    const state = resolve(withStream, 6);
    expect(state.cursor).not.toBeNull();
    expect(state.cursor?.pos).toEqual([0.6, 0.7]);
    expect(state.cursor?.imageId).toBe('ibeam');
    expect(state.cursor?.scale).toBe(1.4);
  });

  it('resolves an annotation span with its own channels', () => {
    const track: Track = {
      id: 't-ann',
      kind: 'object',
      target: 'annotation',
      domain: 'source',
      origin: 'manual',
      blend: 'replace',
      blendMs: 0,
      activeRanges: ALWAYS,
      enabled: true,
      channels: {},
      spans: [
        {
          id: 'a1',
          start: 10,
          end: 20,
          type: 'arrow',
          style: { stroke: '#FF3B30' },
          channels: {
            opacity: {
              keys: [
                { t: 10, v: 0, ease: { kind: 'linear' } },
                { t: 11, v: 1, ease: { kind: 'hold' } },
              ],
            },
            to: {
              keys: [
                { t: 10, v: [0.2, 0.3], ease: { kind: 'linear' } },
                { t: 20, v: [0.6, 0.5], ease: { kind: 'hold' } },
              ],
            },
          },
        },
      ],
    };
    const ct = compile(documentWith([track]));
    expect(resolve(ct, 5).annotations).toHaveLength(0);
    const state = resolve(ct, 15);
    expect(state.annotations).toHaveLength(1);
    const annotation = state.annotations[0];
    expect(annotation?.id).toBe('a1');
    expect(annotation?.type).toBe('arrow');
    expect(annotation?.style).toEqual({ stroke: '#FF3B30' });
    expect(Array.from(annotation?.values.get('opacity') ?? [])).toEqual([1]);
    expect(Array.from(annotation?.values.get('to') ?? [])).toEqual([0.4, 0.4]);
    expect(resolve(ct, 25).annotations).toHaveLength(0);
  });

  it('turns gainDb into a linear gain, and a mute span into a hard zero', () => {
    const mic: Track = {
      id: 't-mic',
      kind: 'audio',
      target: 'audio:mic',
      domain: 'source',
      origin: 'manual',
      blend: 'replace',
      blendMs: 0,
      activeRanges: ALWAYS,
      enabled: true,
      channels: { gainDb: { keys: [{ t: 0, v: -6, ease: { kind: 'hold' } }] } },
      spans: [{ id: 'm1', start: 88.4, end: 91.2, type: 'mute' }],
    };
    const ct = compile(
      documentWith([mic], [{ id: 'c1', sourceStart: 0, sourceEnd: 120, speed: 1 }]),
    );
    expect(resolve(ct, 10).audio.micGain).toBeCloseTo(Math.pow(10, -6 / 20), 12);
    expect(resolve(ct, 90).audio.micGain).toBe(0);
    // Unity by default, and untouched by the mic's mute.
    expect(resolve(ct, 90).audio.systemGain).toBe(1);
  });
});

describe('manual keyframed zoom, all the way to the sampled rect — decision 3', () => {
  it('drives the rect the compositor samples, and returns to the whole frame', () => {
    // The end of the chain phase 7 exists to build: a keyframe becomes a
    // `ResolvedState`, and `sourceSampleRect` turns that into the region the
    // compositor reads. Preview and export both walk exactly this path (§4.5).
    const ct = compile(
      documentWith([
        manualZoomTrack({
          id: 't-zoom',
          activeRanges: [[0, 20]],
          amount: [
            { t: 0, v: 1, ease: { kind: 'linear' } },
            { t: 4, v: 2, ease: { kind: 'hold' } },
            { t: 16, v: 2, ease: { kind: 'linear' } },
            { t: 20, v: 1, ease: { kind: 'hold' } },
          ],
          center: [{ t: 4, v: [0.25, 0.75], ease: { kind: 'hold' } }],
          amountClamp: [1, 4],
          blendMs: 0,
        }),
      ]),
    );

    expect(sourceSampleRect(resolve(ct, 0).zoom)).toEqual({ x: 0, y: 0, width: 1, height: 1 });

    const zoomed = sourceSampleRect(resolve(ct, 10).zoom);
    expect(zoomed.width).toBeCloseTo(0.5, 9);
    expect(zoomed.height).toBeCloseTo(0.5, 9);
    expect(zoomed.x).toBeCloseTo(0, 9); // centre 0.25 with a half-width of 0.25
    expect(zoomed.y).toBeCloseTo(0.5, 9);

    // Half way in, the rect is half way in.
    const rising = sourceSampleRect(resolve(ct, 2).zoom);
    expect(rising.width).toBeCloseTo(1 / 1.5, 9);

    expect(sourceSampleRect(resolve(ct, 20).zoom)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('a spring zoom never lands outside its clamp', () => {
    const ct = compile(
      documentWith([
        manualZoomTrack({
          id: 't-spring',
          activeRanges: [[0, 30]],
          amount: [
            { t: 0, v: 1, ease: { kind: 'spring' } },
            { t: 1, v: 4, ease: { kind: 'spring' } },
            { t: 8, v: 1, ease: { kind: 'spring' } },
          ],
          spring: DEFAULT_SPRING,
          amountClamp: [1, 4],
          blendMs: 0,
        }),
      ]),
    );
    for (let t = 0; t <= 30; t += 1 / 240) {
      const amount = resolve(ct, t).zoom.amount;
      expect(amount).toBeGreaterThanOrEqual(1);
      expect(amount).toBeLessThanOrEqual(4);
    }
  });
});

describe('the resolved state is borrowed, and allocation-free', () => {
  it('returns the same object every call', () => {
    const ct = identityTimeline(10);
    const first = resolve(ct, 1);
    const second = resolve(ct, 2);
    expect(second).toBe(first);
    expect(first.timelineTime).toBe(2);
  });

  it('starts from the documented identity', () => {
    const identity = identityState(3);
    const resolved = resolve(identityTimeline(10), 3);
    expect(resolved.zoom).toEqual(identity.zoom);
    expect(resolved.bubble.visible).toBe(identity.bubble.visible);
    expect(resolved.cursor).toBeNull();
    expect(resolved.annotations).toEqual([]);
    expect(resolved.audio).toEqual(identity.audio);
  });
});
