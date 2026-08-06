/**
 * §6.5 auto-zoom-on-click, and the captain's rule about what happens when there are no
 * clicks to zoom on.
 *
 * The five steps of §6.5 get one describe each. The sixth block is the one that is not
 * arithmetic: `data/loom-scope/decision-accessibility-clicks.md` requires that a user
 * who declined Accessibility still gets a working recorder and that **only** this
 * generator degrades — and phase 5's rule that "no clicks" and "no tap" are different
 * answers, never the same zero.
 */

import { describe, expect, it } from 'vitest';
import type { RecordingDoc } from '@loom/format';
import { arrayClickStream, type ClickEventInput } from '../src/streams.ts';
import {
  clusterClicks,
  edgeSnap,
  generateAutoZoom,
  mergeSegments,
  segmentOf,
  DEFAULT_AUTO_ZOOM_PARAMS,
  type Click,
} from '../src/generators/auto-zoom.ts';
import {
  capturedClicks,
  clickSourceFrom,
  describeClickUnavailable,
  unavailableClicks,
} from '../src/generators/clicks.ts';

const P = DEFAULT_AUTO_ZOOM_PARAMS;

function clicks(list: [number, number, number][]): ReturnType<typeof arrayClickStream> {
  const events: ClickEventInput[] = [];
  for (const [t, x, y] of list) {
    events.push({ t, e: 'down', b: 0, x, y });
    events.push({ t: t + 0.06, e: 'up', b: 0, x, y });
  }
  return arrayClickStream(events);
}

function at(t: number, x: number, y: number): Click {
  return { t, x, y };
}

describe('§6.5 step 1 — cluster greedily', () => {
  it('keeps nearby clicks together', () => {
    const clustered = clusterClicks([at(0, 0.5, 0.5), at(1, 0.55, 0.52), at(2, 0.52, 0.48)], P);
    expect(clustered).toHaveLength(1);
    expect(clustered[0]?.clicks).toHaveLength(3);
  });

  it('starts a new cluster when the bbox would burst clusterBox', () => {
    const clustered = clusterClicks([at(0, 0.05, 0.5), at(1, 0.95, 0.5)], P);
    expect(clustered).toHaveLength(2);
  });

  it('clusterBox is exactly where the amount hits its floor', () => {
    // The reading `auto-zoom.ts` documents: clusterBox[0] = targetFill / amountRange[0].
    expect(P.clusterBox[0]).toBeCloseTo(P.targetFill / P.amountRange[0], 12);
  });

  it('clusterGapSec is the gap at which step 1 and step 4 agree', () => {
    // Derived, not chosen: below it a step-1 split is undone by step 4's merge, at or
    // above it step 4 would keep the two apart. Anything else makes the two disagree.
    expect(P.clusterGapSec).toBeCloseTo(P.preRollSec + P.postRollSec + P.mergeGapSec, 12);
  });

  it('splits two bursts at the same spot when they are more than clusterGapSec apart', () => {
    // Spatially identical, so nothing but the time criterion can separate them — this
    // is the case a purely spatial step 1 turns into one zoom held across the gap.
    const gap = P.clusterGapSec + 0.5;
    const clustered = clusterClicks(
      [at(1, 0.5, 0.5), at(1.4, 0.51, 0.5), at(1 + gap, 0.5, 0.5), at(1.4 + gap, 0.51, 0.5)],
      P,
    );
    expect(clustered).toHaveLength(2);
    expect(clustered[0]?.clicks).toHaveLength(2);
    expect(clustered[1]?.clicks).toHaveLength(2);

    const segments = mergeSegments(
      clustered.map((cluster) => segmentOf(cluster, P)),
      P,
    );
    expect(segments).toHaveLength(2);
  });

  it('keeps two clicks closer than clusterGapSec in one cluster', () => {
    const clustered = clusterClicks([at(1, 0.5, 0.5), at(1 + P.clusterGapSec - 0.1, 0.5, 0.5)], P);
    expect(clustered).toHaveLength(1);
  });

  it('measures the gap against the previous click, so a long steady burst stays one', () => {
    // Every gap is under clusterGapSec but the burst runs far longer than it. Measured
    // from the cluster's *first* click this would be cut at an arbitrary point.
    const step = P.clusterGapSec - 0.4;
    const clicks30 = Array.from({ length: 30 }, (_, i) => at(i * step, 0.5, 0.5));
    const clustered = clusterClicks(clicks30, P);
    expect(clustered).toHaveLength(1);
    expect(clustered[0]?.clicks).toHaveLength(30);
  });

  it('minDurationSec cannot fire under §6.5’s own numbers, and is left alone', () => {
    // The shortest segment a single click can make is preRoll + postRoll, or postRoll
    // where the pre-roll is clamped at zero. Both exceed minDurationSec, so step 4's
    // drop is dead — a finding recorded in the module header rather than a number tuned.
    expect(P.postRollSec).toBeGreaterThan(P.minDurationSec);
    const atZero = segmentOf(clusterClicks([at(0, 0.5, 0.5)], P)[0]!, P);
    expect(atZero.end - atZero.start).toBeGreaterThan(P.minDurationSec);
    expect(mergeSegments([atZero], P)).toHaveLength(1);
  });
});

describe('§6.5 step 2 — the zoom shape', () => {
  it('is pre-roll before the first click and post-roll after the last', () => {
    const segment = segmentOf(clusterClicks([at(5, 0.5, 0.5), at(7, 0.52, 0.5)], P)[0]!, P);
    expect(segment.start).toBeCloseTo(5 - P.preRollSec, 12);
    expect(segment.end).toBeCloseTo(7 + P.postRollSec, 12);
    expect(segment.holdStart).toBe(5);
    expect(segment.holdEnd).toBe(7);
  });

  it('amount is targetFill / the bbox extent, clamped to amountRange', () => {
    const tight = segmentOf(clusterClicks([at(0, 0.5, 0.5)], P)[0]!, P);
    expect(tight.amount).toBe(P.amountRange[1]);

    const wide = segmentOf(clusterClicks([at(0, 0.25, 0.5), at(1, 0.75, 0.5)], P)[0]!, P);
    expect(wide.amount).toBeCloseTo(P.amountRange[0], 6);

    const middling = segmentOf(clusterClicks([at(0, 0.4, 0.5), at(1, 0.7, 0.5)], P)[0]!, P);
    expect(middling.amount).toBeCloseTo(P.targetFill / 0.3, 6);
  });

  it('the pre-roll is clamped at zero — there is no recording before it', () => {
    const segment = segmentOf(clusterClicks([at(0.2, 0.5, 0.5)], P)[0]!, P);
    expect(segment.start).toBe(0);
  });
});

describe('§6.5 step 3 — edge-snap the centre', () => {
  it('keeps the viewport inside the frame', () => {
    const snapped = edgeSnap([0.02, 0.98], 2.5, P.edgeSnapRatio);
    expect(snapped[0]).toBeGreaterThanOrEqual(0.5 / 2.5);
    expect(snapped[1]).toBeLessThanOrEqual(1 - 0.5 / 2.5);
  });

  it('snaps flush rather than hovering a sliver inside the boundary', () => {
    const half = 0.5 / 2;
    const justInside = half + P.edgeSnapRatio * half * 0.5;
    expect(edgeSnap([justInside, 0.5], 2, P.edgeSnapRatio)[0]).toBeCloseTo(half, 12);
  });

  it('leaves a centre in the middle of the frame alone', () => {
    expect(edgeSnap([0.5, 0.5], 2, P.edgeSnapRatio)).toEqual([0.5, 0.5]);
  });

  it('at amount 1 the only legal centre is 0.5', () => {
    expect(edgeSnap([0.1, 0.9], 1, P.edgeSnapRatio)).toEqual([0.5, 0.5]);
  });
});

describe('§6.5 step 4 — merge, then drop', () => {
  it('merges two segments closer than mergeGapSec and keeps the larger amount', () => {
    const a = segmentOf(clusterClicks([at(5, 0.5, 0.5)], P)[0]!, P);
    const b = segmentOf(clusterClicks([at(6.5, 0.45, 0.5)], P)[0]!, P);
    b.amount = 1.5;
    const merged = mergeSegments([a, b], P);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.amount).toBe(P.amountRange[1]);
    expect(merged[0]?.clicks).toBe(2);
  });

  it('drops a segment shorter than minDurationSec', () => {
    const short = { ...segmentOf(clusterClicks([at(5, 0.5, 0.5)], P)[0]!, P) };
    short.end = short.start + 0.2;
    expect(mergeSegments([short], P)).toHaveLength(0);
  });

  it('merges before dropping, so two short adjacent clusters survive as one', () => {
    const a = { ...segmentOf(clusterClicks([at(5, 0.5, 0.5)], P)[0]!, P), end: 5.7 };
    const b = { ...segmentOf(clusterClicks([at(6, 0.5, 0.5)], P)[0]!, P), start: 5.9, end: 6.7 };
    const merged = mergeSegments([a, b], { ...P, minDurationSec: 1 });
    expect(merged).toHaveLength(1);
  });
});

describe('§6.5 step 5 — the emitted track', () => {
  const result = generateAutoZoom({
    clicks: capturedClicks(
      clicks([
        [5, 0.7, 0.3],
        [6, 0.72, 0.32],
        [20, 0.2, 0.8],
      ]),
    ),
    generatedAt: '2026-08-05T00:00:00.000Z',
  });

  it('is an ordinary generated zoom track anchored in source time', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.kind).toBe('transform');
    expect(result.track.target).toBe('zoom');
    expect(result.track.domain).toBe('source');
    expect(result.track.origin).toBe('generated');
    expect(result.track.generator?.type).toBe('auto-zoom-on-click');
    expect(result.track.blendMs).toBe(250);
  });

  it('has §6.5’s 1 → A → A → 1 amount shape per segment, all springs', () => {
    if (!result.ok) return;
    const keys = result.track.channels['amount']?.keys ?? [];
    expect(keys.every((k) => k.ease.kind === 'spring')).toBe(true);
    for (const segment of result.segments) {
      const within = keys.filter((k) => k.t >= segment.start && k.t <= segment.end);
      // Four keys, except where the hold has no length: a cluster of one click has
      // `holdStart === holdEnd`, the two A keys land on the same 8 ms grid point, and
      // §2.6 forbids a repeated `t`. Three keys is the same shape with a zero-length
      // hold — pre-roll in, click, post-roll out — not a missing keyframe.
      const expected = segment.holdEnd > segment.holdStart ? 4 : 3;
      expect(within).toHaveLength(expected);
      expect(within[0]?.v).toBe(1);
      expect(within[within.length - 1]?.v).toBe(1);
      for (let i = 1; i < within.length - 1; i++) expect(within[i]?.v).toBe(segment.amount);
    }
  });

  it('opens and closes each segment on the frame centre, where amount is 1', () => {
    if (!result.ok) return;
    const keys = result.track.channels['center']?.keys ?? [];
    for (const segment of result.segments) {
      expect(keys.find((k) => k.t === segment.start)?.v).toEqual([0.5, 0.5]);
      expect(keys.find((k) => k.t === segment.end)?.v).toEqual([0.5, 0.5]);
    }
  });

  it('activeRanges is the segment list, so the track below shows through between them', () => {
    if (!result.ok) return;
    expect(result.track.activeRanges).toHaveLength(result.segments.length);
    expect(result.track.activeRanges[0]?.[0]).toBe(result.segments[0]?.start);
  });

  it('carries the parameters and the input fingerprint it was generated from', () => {
    if (!result.ok) return;
    expect(result.track.generator?.params['targetFill']).toBe(P.targetFill);
    expect(result.track.generator?.generatedAt).toBe('2026-08-05T00:00:00.000Z');
  });
});

describe('clicks may be absent, and that is not zero clicks', () => {
  const recordingWith = (clicksBlock: RecordingDoc['events']['clicks']): RecordingDoc =>
    ({ events: { clicks: clicksBlock } }) as RecordingDoc;

  it('a live tap that saw nothing generates an empty-but-real track', () => {
    const result = generateAutoZoom({ clicks: capturedClicks(clicks([])) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.empty).toBe(true);
    expect(result.clicks).toBe(0);
    expect(result.segments).toHaveLength(0);
  });

  it('a dead tap refuses, with a sentence, and never an empty track', () => {
    const result = generateAutoZoom({ clicks: unavailableClicks('not-captured') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-captured');
    expect(result.message).toContain('Accessibility');
    expect(result.message).toContain('Cursor-follow and manual zoom are unaffected');
  });

  it('reads recording.json’s answer and does not improve on it', () => {
    const stream = clicks([[1, 0.5, 0.5]]);
    expect(clickSourceFrom(recordingWith(undefined), stream)).toEqual({
      kind: 'unavailable',
      reason: 'not-recorded',
    });
    expect(
      clickSourceFrom(
        recordingWith({ file: 'events/clicks.ndjson', available: false, source: 'cgeventtap' }),
        stream,
      ),
    ).toEqual({ kind: 'unavailable', reason: 'not-captured' });
    // Claimed available, but the caller could not open it: that is not "no clicks".
    expect(
      clickSourceFrom(
        recordingWith({ file: 'events/clicks.ndjson', available: true, source: 'cgeventtap' }),
        null,
      ),
    ).toEqual({ kind: 'unavailable', reason: 'log-unreadable' });
    expect(
      clickSourceFrom(
        recordingWith({ file: 'events/clicks.ndjson', available: true, source: 'cgeventtap' }),
        stream,
      ).kind,
    ).toBe('captured');
  });

  it('every unavailable reason has its own sentence', () => {
    const said = new Set(
      (['not-recorded', 'not-captured', 'log-unreadable'] as const).map(describeClickUnavailable),
    );
    expect(said.size).toBe(3);
    for (const sentence of said) expect(sentence.length).toBeGreaterThan(40);
  });
});

describe('the click sanity pass', () => {
  it('drops a log whose origin was never subtracted, and answers instead of throwing', () => {
    // `clicks.ndjson` is written by the same sampler as `cursor.ndjson`, from the same
    // `t0Us`, so a log written with `t0Us = 0` carries machine uptime in both — 2,678,930
    // seconds of it, measured. Kept, those keys compile a spring table past
    // MAX_SPRING_TABLE_SEC and `measureTrack` throws out of the generator.
    const uptime = 2_678_930;
    const result = generateAutoZoom({
      clicks: capturedClicks(
        clicks(
          Array.from({ length: 12 }, (_, i): [number, number, number] => [
            uptime + i * 0.5,
            0.5,
            0.5,
          ]),
        ),
      ),
      generatedAt: '2026-08-05T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clicks).toBe(0);
    expect(result.rejected).toBe(12);
    expect(result.segments).toHaveLength(0);
    expect(result.track.channels['amount']?.keys ?? []).toHaveLength(0);
  });

  it('counts what it refused, so an unusable log is not an empty one', () => {
    const result = generateAutoZoom({
      clicks: capturedClicks(
        arrayClickStream([
          { t: 1, e: 'down', b: 0, x: 0.5, y: 0.5 },
          { t: Number.NaN, e: 'down', b: 0, x: 0.5, y: 0.5 },
          { t: 0.5, e: 'down', b: 0, x: 0.5, y: 0.5 },
        ]),
      ),
    });
    expect(result.ok && result.clicks).toBe(1);
    expect(result.ok && result.rejected).toBe(2);
    expect(result.ok && result.empty).toBe(false);
  });
});

describe('clicks that are not the primary button', () => {
  it('are ignored by default and can be asked for', () => {
    const events: ClickEventInput[] = [
      { t: 1, e: 'down', b: 1, x: 0.5, y: 0.5 },
      { t: 2, e: 'down', b: 1, x: 0.52, y: 0.5 },
    ];
    const stream = arrayClickStream(events);
    const ignored = generateAutoZoom({ clicks: capturedClicks(stream) });
    expect(ignored.ok && ignored.clicks).toBe(0);
    const wanted = generateAutoZoom({ clicks: capturedClicks(stream), buttons: [0, 1] });
    expect(wanted.ok && wanted.clicks).toBe(2);
  });

  it('an `up` is not a second click', () => {
    const result = generateAutoZoom({ clicks: capturedClicks(clicks([[1, 0.5, 0.5]])) });
    expect(result.ok && result.clicks).toBe(1);
  });
});
