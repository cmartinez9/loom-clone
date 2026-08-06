/**
 * §3.5 — how a generated track relates to a hand-authored one, exercised with real
 * generated tracks rather than with fixtures shaped like them.
 *
 * > **One mechanism: tracks on the same `target` stack, and the topmost track with an
 * > opinion wins.**
 * >
 * > - A **generated** cursor-follow track sits at the bottom.
 * > - The user's **manual** zoom keyframes sit above it, with their own `activeRanges`.
 * > - Where the user has authored something, they win. Everywhere else the generator
 * >   drives. The `blendMs` crossfade means the handoff does not pop.
 * > - **Regeneration rewrites only the generated track.** User edits survive by
 * >   construction, because they were never in that track.
 *
 * Plus the bake, and the fingerprint that decides whether the UI offers *regenerate*.
 */

import { describe, expect, it } from 'vitest';
import { applyOps, newEditDocument, type EditDocument, type Track } from '@loom/format';
import { compile, EMPTY_COMPILE_CONTEXT } from '../src/compile.ts';
import { resolve } from '../src/resolve.ts';
import { manualZoomTrack } from '../src/tracks.ts';
import { arrayCursorStream, arrayClickStream, type CursorSampleInput } from '../src/streams.ts';
import { generateCursorFollow } from '../src/generators/cursor-follow.ts';
import { generateAutoZoom } from '../src/generators/auto-zoom.ts';
import { capturedClicks } from '../src/generators/clicks.ts';
import {
  bakeOps,
  bakeTrack,
  generatedTracks,
  generatedTrackStaleness,
  isRegenerable,
  regenerateOps,
} from '../src/generators/lifecycle.ts';
import { framingTrack, measurementDocument } from '../src/generators/budget.ts';

function drift(seconds: number, fromX: number, toX: number): CursorSampleInput[] {
  const out: CursorSampleInput[] = [];
  const count = Math.round(seconds * 120);
  for (let i = 0; i < count; i++) {
    out.push({ t: i / 120, x: fromX + ((toX - fromX) * i) / count, y: 0.5, c: 'arrow' });
  }
  return out;
}

function followTrackOver(samples: CursorSampleInput[]): Track {
  return generateCursorFollow({
    cursor: arrayCursorStream(samples),
    inputs: { cursor: 'sha256:aaaa' },
    generatedAt: '2026-08-05T00:00:00.000Z',
  }).track;
}

describe('§3.5 the stack', () => {
  const generated = followTrackOver(drift(20, 0.15, 0.85));
  const manual = manualZoomTrack({
    id: 't-zoom-manual',
    activeRanges: [[8, 12]],
    amount: [
      { t: 8, v: 1, ease: { kind: 'linear' } },
      { t: 9, v: 3, ease: { kind: 'hold' } },
    ],
    center: [{ t: 8, v: [0.2, 0.2], ease: { kind: 'hold' } }],
    blendMs: 0,
  });

  it('the manual track wins where it has an opinion, and the generator drives elsewhere', () => {
    const doc = measurementDocument([framingTrack(2), generated, manual], 20);
    const compiled = compile(doc, EMPTY_COMPILE_CONTEXT);

    const inside = resolve(compiled, 10);
    expect(inside.zoom.center[0]).toBeCloseTo(0.2, 6);
    expect(inside.zoom.amount).toBeCloseTo(3, 6);

    const outside = resolve(compiled, 16);
    expect(outside.zoom.center[0]).not.toBeCloseTo(0.2, 2);
    expect(outside.zoom.amount).toBeCloseTo(2, 6);
  });

  it('a generated track carrying only `center` leaves `amount` to the stack', () => {
    expect(Object.keys(generated.channels)).toEqual(['center']);
    const doc = measurementDocument([framingTrack(1.6), generated], 20);
    const state = resolve(compile(doc, EMPTY_COMPILE_CONTEXT), 10);
    expect(state.zoom.amount).toBeCloseTo(1.6, 6);
  });

  it('respects `activeRanges`: a parked generated track says nothing at all', () => {
    const parked: Track = { ...generated, activeRanges: [] };
    const doc = measurementDocument([framingTrack(2), parked], 20);
    const state = resolve(compile(doc, EMPTY_COMPILE_CONTEXT), 10);
    expect(state.zoom.center[0]).toBeCloseTo(0.5, 9);
  });

  it('the `blendMs` crossfade makes the handoff a ramp rather than a step', () => {
    const fading = manualZoomTrack({
      id: 't-zoom-manual-fade',
      activeRanges: [[8, 12]],
      amount: [{ t: 8, v: 3, ease: { kind: 'hold' } }],
      center: [{ t: 8, v: [0.25, 0.25], ease: { kind: 'hold' } }],
      blendMs: 400,
    });
    const doc = measurementDocument([framingTrack(2), generated, fading], 20);
    const compiled = compile(doc, EMPTY_COMPILE_CONTEXT);
    const before = resolve(compiled, 7.99).zoom.amount;
    const quarter = resolve(compiled, 8.1).zoom.amount;
    const full = resolve(compiled, 8.4).zoom.amount;
    expect(before).toBeCloseTo(2, 6);
    expect(quarter).toBeGreaterThan(before);
    expect(quarter).toBeLessThan(full);
    expect(full).toBeCloseTo(3, 6);
  });

  it('auto-zoom stacks above cursor-follow and hands the centre back between segments', () => {
    const cursor = arrayCursorStream(drift(20, 0.15, 0.85));
    const follow = generateCursorFollow({
      cursor,
      generatedAt: '2026-08-05T00:00:00.000Z',
    }).track;
    const auto = generateAutoZoom({
      clicks: capturedClicks(
        arrayClickStream([
          { t: 9, e: 'down', b: 0, x: 0.8, y: 0.3 },
          { t: 10, e: 'down', b: 0, x: 0.82, y: 0.32 },
        ]),
      ),
      cursor,
      durationSec: 20,
      generatedAt: '2026-08-05T00:00:00.000Z',
    });
    expect(auto.ok).toBe(true);
    if (!auto.ok) return;

    const doc = measurementDocument([framingTrack(1.6), follow, auto.track], 20);
    const compiled = compile(doc, EMPTY_COMPILE_CONTEXT);
    // Inside the segment the auto track owns the amount…
    expect(resolve(compiled, 9.6).zoom.amount).toBeGreaterThan(1.7);
    // …and outside it the framing below shows through untouched.
    expect(resolve(compiled, 18).zoom.amount).toBeCloseTo(1.6, 6);
  });
});

describe('§3.5 regeneration', () => {
  function docWith(tracks: Track[]): EditDocument {
    const doc = newEditDocument();
    doc.tracks = tracks;
    return doc;
  }

  it('rewrites only the generated track, and keeps its place in the stack', () => {
    const generated = followTrackOver(drift(10, 0.2, 0.8));
    const manual = manualZoomTrack({
      id: 't-zoom-manual',
      activeRanges: [[2, 4]],
      amount: [{ t: 2, v: 2, ease: { kind: 'hold' } }],
    });
    const doc = docWith([generated, manual]);

    const replacement = followTrackOver(drift(10, 0.8, 0.2));
    const ops = regenerateOps(doc, replacement);
    expect(ops.map((op) => op.op)).toEqual(['track.remove', 'track.add']);

    const applied = applyOps(doc, ops);
    // Track order *is* stacking order: the generated track must come back underneath.
    expect(applied.tracks.map((t) => t.id)).toEqual([replacement.id, 't-zoom-manual']);
    expect(applied.tracks[1]).toEqual(manual);
  });

  it('adds at the bottom when there is no generated track yet', () => {
    const manual = manualZoomTrack({
      id: 't-zoom-manual',
      activeRanges: [[2, 4]],
      amount: [{ t: 2, v: 2, ease: { kind: 'hold' } }],
    });
    const doc = docWith([manual]);
    const ops = regenerateOps(doc, followTrackOver(drift(5, 0.2, 0.8)));
    expect(ops).toHaveLength(1);
    expect(applyOps(doc, ops).tracks[0]?.origin).toBe('generated');
  });

  it('finds generated tracks by type', () => {
    const doc = docWith([followTrackOver(drift(5, 0.2, 0.8))]);
    expect(generatedTracks(doc, 'cursor-follow')).toHaveLength(1);
    expect(generatedTracks(doc, 'auto-zoom-on-click')).toHaveLength(0);
  });
});

describe('§3.5 the fingerprint', () => {
  const track = followTrackOver(drift(5, 0.2, 0.8));

  it('is fresh while the inputs match', () => {
    expect(generatedTrackStaleness(track, { cursor: 'sha256:aaaa' }).stale).toBe(false);
  });

  it('is stale when the cursor log’s hash changed', () => {
    const report = generatedTrackStaleness(track, { cursor: 'sha256:bbbb' });
    expect(report.stale).toBe(true);
    expect(report.reasons).toContain('input-changed');
    expect(report.changedInputs).toEqual(['cursor']);
  });

  it('is stale when an input the spec named is gone', () => {
    expect(generatedTrackStaleness(track, {}).reasons).toContain('input-missing');
  });

  it('ignores inputs the spec never named', () => {
    expect(
      generatedTrackStaleness(track, { cursor: 'sha256:aaaa', clicks: 'sha256:whatever' }).stale,
    ).toBe(false);
  });

  it('is stale when a parameter the caller would use now differs', () => {
    const current = { ...track.generator?.params, zoomAmount: 3 };
    const report = generatedTrackStaleness(track, { cursor: 'sha256:aaaa' }, current);
    expect(report.reasons).toContain('params-changed');
    expect(report.changedParams).toEqual(['zoomAmount']);
  });

  it('compares array parameters by value', () => {
    const same = { ...track.generator?.params };
    expect(generatedTrackStaleness(track, { cursor: 'sha256:aaaa' }, same).stale).toBe(false);
    const different = { ...same, restBox: [0.4, 0.45] };
    expect(generatedTrackStaleness(track, { cursor: 'sha256:aaaa' }, different).stale).toBe(true);
  });

  it('a manual track has no generator to be fresh about', () => {
    const manual = manualZoomTrack({
      id: 'm',
      activeRanges: [[0, 1]],
      amount: [{ t: 0, v: 1, ease: { kind: 'hold' } }],
    });
    expect(generatedTrackStaleness(manual, {}).reasons).toEqual(['not-generated']);
  });
});

describe('§3.5 bake', () => {
  const track = followTrackOver(drift(5, 0.2, 0.8));

  it('is one op, and removes the generator by name so the undo survives JSON', () => {
    const ops = bakeOps(track);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op?.op).toBe('track.patch');
    if (op?.op !== 'track.patch') return;
    expect(op.patch.remove).toEqual(['generator']);
    expect(op.patch.origin).toBe('manual');
    expect(op.patch.generatedFrom).toEqual(track.generator);
    // The removal has to survive the journal: `{generator: undefined}` would
    // `JSON.stringify` to `"patch":{}` and replay as a no-op.
    expect(JSON.stringify(op)).toContain('"remove":["generator"]');
  });

  it('leaves a manual track with the spec as provenance and no generator', () => {
    const baked = bakeTrack(track);
    expect(baked.origin).toBe('manual');
    expect(baked.generator).toBeUndefined();
    expect(baked.generatedFrom).toEqual(track.generator);
    expect(baked.channels).toEqual(track.channels);
  });

  it('detaches it from regeneration — there is no third state', () => {
    expect(isRegenerable(track)).toBe(true);
    expect(isRegenerable(bakeTrack(track))).toBe(false);
  });

  it('applies through the op vocabulary main journals', () => {
    const doc = newEditDocument();
    doc.tracks = [track];
    const applied = applyOps(doc, bakeOps(track));
    const after = applied.tracks[0];
    expect(after?.origin).toBe('manual');
    expect(after?.generator).toBeUndefined();
    expect(after?.generatedFrom).toEqual(track.generator);
  });

  it('baking something that was never generated is a no-op, not an error', () => {
    const manual = manualZoomTrack({
      id: 'm',
      activeRanges: [[0, 1]],
      amount: [{ t: 0, v: 1, ease: { kind: 'hold' } }],
    });
    expect(bakeOps(manual)).toEqual([]);
    expect(bakeTrack(manual)).toBe(manual);
  });
});
