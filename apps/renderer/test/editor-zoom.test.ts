/**
 * Manual zoom, and keyframe editing, as arithmetic over a document.
 *
 * The window's half — a pointer, a slider, a diamond on a lane — is measured by
 * `test/phase15-gate.test.ts` in a real Electron renderer. This is the half that is
 * wrong invisibly: a region whose keys are not strictly increasing, an op batch whose
 * inverse does not invert, a key drag that lands on its neighbour and deletes it.
 *
 * ## Everything here goes through `applyOps` and `validateEditDocument`
 *
 * Not "the batch looks right" — *the document it produces opens*. `AGENTS.md` states
 * the bar for a generated track and it is the same bar here: **a `NaN` keyframe
 * reaches `edit.json` and leaves a recording that stops opening**, and a validator is
 * the only thing that can say a document does not. Every test that produces ops
 * applies them and validates the result.
 *
 * And every batch is round-tripped through `inverseOps`, because §3.5's manual zoom is
 * the one thing in this editor that rewrites a whole track — `track.remove` +
 * `track.add` — and an inverse that restored it at the wrong **index** would leave a
 * valid document and a wrong picture, which `AGENTS.md` calls the hardest kind of bug
 * to see.
 */

import { describe, expect, it } from 'vitest';
import {
  applyOps,
  newEditDocument,
  validateEditDocument,
  type EditDocument,
  type EditOp,
  type Track,
} from '@loom/format';
import {
  compile,
  DEFAULT_SPRING,
  EMPTY_COMPILE_CONTEXT,
  inverseOps,
  manualZoomTrack,
  resolve,
  segmentSettleTailSec,
} from '@loom/edl';
import {
  generatedSegmentAt,
  isKeyEditable,
  KEY_GAP_SEC,
  MANUAL_ZOOM_TRACK_ID,
  MAX_ZOOM_AMOUNT,
  moveKeyOps,
  neighbourBounds,
  overrideZoomOps,
  placeZoomOps,
  removeKeyOps,
  removeZoomOps,
  setKeyValueOps,
  updateZoomOps,
  zoomKeysOf,
  zoomRegionAt,
  zoomRegionsOf,
  ZOOM_RAMP_SEC,
} from '../src/editor/zoom.ts';

const DURATION = 60;

function empty(): EditDocument {
  return newEditDocument();
}

/** Apply a batch and require the result to be a document that opens. */
function apply(doc: EditDocument, ops: EditOp[] | null): EditDocument {
  expect(ops, 'the batch under test produced no ops').not.toBeNull();
  const next = applyOps(structuredClone(doc), ops ?? []);
  const result = validateEditDocument(next);
  expect(result.ok ? [] : result.issues, 'the ops produced a document that will not open').toEqual(
    [],
  );
  return next;
}

/**
 * Apply a batch, then its inverse, and answer what came back.
 *
 * `revision` is stripped, and that is not a convenience: §2.7's whole point is that
 * *an undo is an edit* — it travels the same path, lands in the same journal and
 * advances the same counter. A round trip that came back at the same revision would
 * mean the undo had not been journalled. What has to be identical is everything else.
 */
function roundTrip(doc: EditDocument, ops: EditOp[]): Omit<EditDocument, 'revision'> {
  const inverse = inverseOps(doc, ops);
  const forward = applyOps(structuredClone(doc), ops);
  const back = applyOps(forward, inverse);
  expect(back.revision, 'an undo is an edit and must advance the revision').toBeGreaterThan(
    doc.revision,
  );
  const { revision: _revision, ...rest } = back;
  return rest;
}

/** The same document minus its revision, for comparison with a round trip. */
function withoutRevision(doc: EditDocument): Omit<EditDocument, 'revision'> {
  const { revision: _revision, ...rest } = doc;
  return rest;
}

/**
 * A clip list covering the whole recording.
 *
 * `compile` reads an empty one as "the whole source", and the only place a source
 * length exists is `recording.json` — which `EMPTY_COMPILE_CONTEXT` does not carry, so
 * a document with no clips compiles to a **zero-length** timeline and every `resolve`
 * lands at t = 0. Stated once here rather than discovered per test.
 */
const WHOLE: EditDocument['clips'] = [{ id: 'all', sourceStart: 0, sourceEnd: DURATION, speed: 1 }];

function place(
  doc: EditDocument,
  init: { startSec: number; endSec: number; amount: number; center: [number, number] },
): EditDocument {
  return apply(doc, placeZoomOps(doc, init, DURATION));
}

describe('placing a zoom by hand', () => {
  it('writes one track, at the top of the stack, that validates', () => {
    const doc = place(empty(), {
      startSec: 10,
      endSec: 16,
      amount: 2,
      center: [0.3, 0.4],
    });
    expect(doc.tracks).toHaveLength(1);
    const track = doc.tracks[0]!;
    expect(track.id).toBe(MANUAL_ZOOM_TRACK_ID);
    expect(track.target).toBe('zoom');
    // §3.2: a manual zoom is anchored in source time so trimming does not re-time it.
    expect(track.domain).toBe('source');
    expect(track.origin).toBe('manual');
  });

  it('reads back the region it was asked for', () => {
    const doc = place(empty(), { startSec: 10, endSec: 16, amount: 2.5, center: [0.3, 0.4] });
    const regions = zoomRegionsOf(doc);
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region?.startSec).toBeCloseTo(10, 6);
    expect(region?.endSec).toBeCloseTo(16, 6);
    expect(region?.amount).toBeCloseTo(2.5, 6);
    // Edge-snapped, so the number in the document is the number that will be used:
    // at 2.5x the legal centre interval is [0.2, 0.8] and 0.3 is inside it.
    expect(region?.center[0]).toBeCloseTo(0.3, 6);
    expect(region?.center[1]).toBeCloseTo(0.4, 6);
  });

  it('runs its window past the last keyframe by the spring’s settle tail', () => {
    // Phase 10's finding, inherited: at the last key the target is identity but the
    // spring is still on its way there, so a window that ended on the key would hand
    // `blendMs` a discontinuity and turn a 0.6 s zoom-out into a 300 ms one.
    const doc = place(empty(), { startSec: 10, endSec: 16, amount: 2, center: [0.5, 0.5] });
    const region = zoomRegionsOf(doc)[0];
    expect(region?.windowEndSec).toBeCloseTo(16 + segmentSettleTailSec(DEFAULT_SPRING), 6);
  });

  it('emits §6.5’s four keys on `amount` and three on `center`, strictly increasing', () => {
    const doc = place(empty(), { startSec: 10, endSec: 16, amount: 2, center: [0.5, 0.5] });
    const track = doc.tracks[0]!;
    const amount = track.channels['amount']?.keys ?? [];
    const center = track.channels['center']?.keys ?? [];
    expect(amount.map((k) => k.v)).toEqual([1, 2, 2, 1]);
    expect(center).toHaveLength(3);
    for (const keys of [amount, center]) {
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i]?.t, 'keys must be strictly increasing (§2.6)').toBeGreaterThan(
          keys[i - 1]?.t ?? 0,
        );
      }
    }
  });

  it('uses spring easing over `DEFAULT_SPRING`, never a curve', () => {
    // §3.4: a channel is one evaluator or the other and mixing them inside one is a
    // validation error. It is also §6.3's own shape, so a hand-placed zoom and a
    // generated one move at the same speed.
    const doc = place(empty(), { startSec: 10, endSec: 16, amount: 2, center: [0.5, 0.5] });
    const track = doc.tracks[0]!;
    for (const channel of Object.values(track.channels)) {
      expect(channel.spring).toEqual(DEFAULT_SPRING);
      for (const key of channel.keys) expect(key.ease.kind).toBe('spring');
    }
  });

  it('clamps the magnification into §3.3’s bound, and writes the bound down', () => {
    const doc = place(empty(), { startSec: 10, endSec: 16, amount: 99, center: [0.5, 0.5] });
    expect(zoomRegionsOf(doc)[0]?.amount).toBe(MAX_ZOOM_AMOUNT);
    expect(doc.tracks[0]!.channels['amount']?.clamp).toEqual([1, MAX_ZOOM_AMOUNT]);
  });

  it('edge-snaps a centre the zoomed viewport could not reach', () => {
    // §6.5 step 3. At 2x the legal centre interval is [0.25, 0.75]; a request at 0.02
    // is outside it, and `sourceSampleRect` would clamp the *rect* while the document
    // still claimed 0.02 — so the snap happens here and the two agree.
    const doc = place(empty(), { startSec: 10, endSec: 16, amount: 2, center: [0.02, 0.5] });
    expect(zoomRegionsOf(doc)[0]?.center[0]).toBeCloseTo(0.25, 6);
  });

  it('refuses a second region that would overlap the first', () => {
    const doc = place(empty(), { startSec: 10, endSec: 16, amount: 2, center: [0.5, 0.5] });
    expect(
      placeZoomOps(doc, { startSec: 12, endSec: 20, amount: 2, center: [0.5, 0.5] }, DURATION),
    ).toBeNull();
  });

  it('keeps two regions that do not overlap, in time order', () => {
    let doc = place(empty(), { startSec: 10, endSec: 16, amount: 2, center: [0.5, 0.5] });
    doc = place(doc, { startSec: 30, endSec: 36, amount: 3, center: [0.6, 0.6] });
    const regions = zoomRegionsOf(doc);
    expect(regions.map((r) => Math.round(r.startSec))).toEqual([10, 30]);
    expect(regions.map((r) => r.amount)).toEqual([2, 3]);
    expect(doc.tracks).toHaveLength(1);
  });

  it('refuses a recording with no room for a zoom in it', () => {
    const shortest = 2 * ZOOM_RAMP_SEC;
    expect(
      placeZoomOps(
        empty(),
        { startSec: 0, endSec: shortest, amount: 2, center: [0.5, 0.5] },
        shortest / 2,
      ),
    ).toBeNull();
  });

  it('is exactly invertible, back to the same document', () => {
    const before = empty();
    const ops = placeZoomOps(
      before,
      { startSec: 10, endSec: 16, amount: 2, center: [0.5, 0.5] },
      DURATION,
    );
    expect(roundTrip(before, ops ?? [])).toEqual(withoutRevision(before));
  });
});

describe('tuning a zoom that is already there', () => {
  const base = place(empty(), { startSec: 10, endSec: 18, amount: 2, center: [0.5, 0.5] });

  it('changes the amount and leaves the extent alone', () => {
    const doc = apply(base, updateZoomOps(base, 0, { amount: 3 }, DURATION));
    const region = zoomRegionsOf(doc)[0];
    expect(region?.amount).toBeCloseTo(3, 6);
    expect(region?.startSec).toBeCloseTo(10, 6);
    expect(region?.endSec).toBeCloseTo(18, 6);
  });

  it('answers null when nothing would change', () => {
    // `trimOp`'s rule: an op that changes nothing still costs a revision, a journal
    // line and an undo step that appears to do nothing when it is used.
    expect(updateZoomOps(base, 0, { amount: 2 }, DURATION)).toBeNull();
  });

  it('answers null for a region that is not there', () => {
    expect(updateZoomOps(base, 7, { amount: 3 }, DURATION)).toBeNull();
  });

  it('refuses a change that would make two regions overlap', () => {
    const two = place(base, { startSec: 30, endSec: 36, amount: 2, center: [0.5, 0.5] });
    expect(updateZoomOps(two, 0, { endSec: 34 }, DURATION)).toBeNull();
  });

  it('is exactly invertible', () => {
    const ops = updateZoomOps(base, 0, { amount: 3, center: [0.3, 0.3] }, DURATION);
    expect(roundTrip(base, ops ?? [])).toEqual(withoutRevision(base));
  });

  it('removes the whole track when the last region goes', () => {
    const doc = apply(base, removeZoomOps(base, 0));
    expect(doc.tracks).toEqual([]);
  });

  it('keeps the track when one of two regions goes', () => {
    const two = place(base, { startSec: 30, endSec: 36, amount: 3, center: [0.5, 0.5] });
    const doc = apply(two, removeZoomOps(two, 1));
    expect(zoomRegionsOf(doc)).toHaveLength(1);
    expect(zoomRegionsOf(doc)[0]?.amount).toBeCloseTo(2, 6);
  });
});

/**
 * A generated track shaped like the one `generateAutoZoom` produces, without running
 * a generator.
 *
 * The generator is phase 10's and is exercised over ten real recordings by its own
 * gate; what is under test here is the *editor's* reading of §3.5 — where a manual
 * track goes relative to a generated one, and what happens to the picture on each
 * side of the window.
 */
function generatedZoom(windows: [number, number][], amount: number): Track {
  const keys = windows.flatMap((window) => [
    { t: window[0], v: 1, ease: { kind: 'spring' as const } },
    { t: window[0] + 0.6, v: amount, ease: { kind: 'spring' as const } },
    { t: window[1] - 0.6, v: amount, ease: { kind: 'spring' as const } },
    { t: window[1], v: 1, ease: { kind: 'spring' as const } },
  ]);
  return {
    ...manualZoomTrack({
      id: 't-zoom-auto',
      activeRanges: windows,
      amount: keys,
      spring: DEFAULT_SPRING,
    }),
    origin: 'generated',
    blendMs: 250,
    generator: {
      type: 'auto-zoom-on-click',
      params: {},
      inputs: { clicks: 'sha256:aaaa' },
      generatedAt: '2026-08-06T00:00:00.000Z',
    },
  };
}

describe('§3.5: taking manual control of a zoom the generator produced', () => {
  const generated = generatedZoom(
    [
      [8, 14],
      [30, 36],
    ],
    2,
  );
  const withGenerated: EditDocument = { ...empty(), clips: WHOLE, tracks: [generated] };

  it('finds the generated segment the playhead is inside, and none outside it', () => {
    expect(generatedSegmentAt(generated, 11)).toEqual({ startSec: 8, endSec: 14 });
    expect(generatedSegmentAt(generated, 20)).toBeNull();
  });

  it('places the manual track ABOVE the generated one, which is what makes it win', () => {
    const doc = apply(
      withGenerated,
      overrideZoomOps(
        withGenerated,
        { atSec: 11, seed: { amount: 2, center: [0.3, 0.3] }, span: { startSec: 8, endSec: 14 } },
        DURATION,
      ),
    );
    // Array order is stacking order and `resolve` folds in it, so the LAST track with
    // an opinion wins. A manual zoom written at index 0 would resolve underneath the
    // generator and do nothing — a valid document and a wrong picture.
    expect(doc.tracks.map((t) => t.id)).toEqual(['t-zoom-auto', MANUAL_ZOOM_TRACK_ID]);
  });

  it('covers the generated segment rather than an arbitrary window', () => {
    const doc = apply(
      withGenerated,
      overrideZoomOps(
        withGenerated,
        { atSec: 11, seed: { amount: 2, center: [0.3, 0.3] }, span: { startSec: 8, endSec: 14 } },
        DURATION,
      ),
    );
    const region = zoomRegionsOf(doc)[0];
    expect(region?.startSec).toBeCloseTo(8, 6);
    expect(region?.endSec).toBeCloseTo(14, 6);
  });

  it('seeds from what the generator is doing, so the picture does not jump', () => {
    const doc = apply(
      withGenerated,
      overrideZoomOps(
        withGenerated,
        {
          atSec: 11,
          seed: { amount: 1.8, center: [0.45, 0.42] },
          span: { startSec: 8, endSec: 14 },
        },
        DURATION,
      ),
    );
    const region = zoomRegionsOf(doc)[0];
    expect(region?.amount).toBeCloseTo(1.8, 6);
    // Well inside the legal centre interval at 1.8x ([0.278, 0.722]) and clear of the
    // edge-snap band, so what comes back is what the generator was doing rather than
    // a snapped approximation of it.
    expect(region?.center[0]).toBeCloseTo(0.45, 6);
  });

  it('does not seed a magnification of 1 — a zoom that magnifies nothing is not one', () => {
    const doc = apply(
      withGenerated,
      overrideZoomOps(
        withGenerated,
        { atSec: 20, seed: { amount: 1, center: [0.5, 0.5] } },
        DURATION,
      ),
    );
    expect(zoomRegionsOf(doc)[0]?.amount).toBeGreaterThan(1);
  });

  it('leaves the generated track byte-for-byte alone', () => {
    // §3.5: *"Regeneration rewrites only the generated track. User edits survive by
    // construction, because they were never in that track."* Taking manual control
    // must therefore not touch it — a partial-override merge is the thing §3.5 says
    // does not exist.
    const doc = apply(
      withGenerated,
      overrideZoomOps(
        withGenerated,
        { atSec: 11, seed: { amount: 2, center: [0.3, 0.3] }, span: { startSec: 8, endSec: 14 } },
        DURATION,
      ),
    );
    expect(doc.tracks.find((t) => t.id === 't-zoom-auto')).toEqual(generated);
  });

  it('WINS inside its window and DEFERS outside it, measured through `resolve`', () => {
    const doc = apply(
      withGenerated,
      overrideZoomOps(
        withGenerated,
        { atSec: 11, seed: { amount: 2, center: [0.5, 0.5] }, span: { startSec: 8, endSec: 14 } },
        DURATION,
      ),
    );
    const tuned = apply(doc, updateZoomOps(doc, 0, { amount: 3.6 }, DURATION));
    const compiled = compile(tuned, EMPTY_COMPILE_CONTEXT);

    // Inside: the user's magnification, not the generator's. Sampled at the middle of
    // the hold, where a spring over `DEFAULT_SPRING` has settled (4/(ζω₀) ≈ 0.45 s).
    const inside = resolve(compiled, 11).zoom.amount;
    expect(inside).toBeGreaterThan(3);

    // Outside, over the generator's *other* segment: the generator drives, and it is
    // still doing exactly what it did before anybody took control of the first one.
    const outside = resolve(compiled, 33).zoom.amount;
    expect(outside).toBeGreaterThan(1.5);
    expect(outside).toBeLessThan(2.5);

    // The control that makes both of those mean something: with the manual track
    // removed, the first segment reads the generator's own amount.
    const withoutManual = compile(
      { ...tuned, tracks: tuned.tracks.filter((t) => t.id !== MANUAL_ZOOM_TRACK_ID) },
      EMPTY_COMPILE_CONTEXT,
    );
    expect(resolve(withoutManual, 11).zoom.amount).toBeLessThan(2.5);
  });

  it('has no opinion between the regions, so what is underneath shows through', () => {
    const doc = apply(
      withGenerated,
      overrideZoomOps(
        withGenerated,
        { atSec: 11, seed: { amount: 3, center: [0.5, 0.5] }, span: { startSec: 8, endSec: 14 } },
        DURATION,
      ),
    );
    const region = zoomRegionsOf(doc)[0];
    expect(zoomRegionAt(doc, 20)).toBeNull();
    expect(zoomRegionAt(doc, 11)?.index).toBe(region?.index);
  });
});

describe('keyframe editing', () => {
  const doc = place(empty(), { startSec: 10, endSec: 18, amount: 2, center: [0.5, 0.5] });
  const keys = zoomKeysOf(doc);
  const amountKeys = keys.filter((k) => k.channel === 'amount');

  it('lists every zoom key in time order, with its provenance', () => {
    expect(keys.length).toBe(7);
    expect(keys.every((k) => k.editable)).toBe(true);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]?.t).toBeGreaterThanOrEqual(keys[i - 1]?.t ?? 0);
    }
  });

  it('refuses to edit a key on a live generated track', () => {
    // §3.5 again, at the seam a person can reach: an edit made in the one place a
    // regeneration is licensed to overwrite would be thrown away without warning.
    const generated = generatedZoom([[8, 14]], 2);
    expect(isKeyEditable(generated)).toBe(false);
    const withGen: EditDocument = { ...empty(), tracks: [generated] };
    const first = zoomKeysOf(withGen)[0];
    expect(first?.editable).toBe(false);
    expect(moveKeyOps(withGen, first ?? { trackId: '', channel: '', t: 0 }, 9)).toBeNull();
    expect(setKeyValueOps(withGen, first ?? { trackId: '', channel: '', t: 0 }, 3)).toBeNull();
    expect(removeKeyOps(withGen, first ?? { trackId: '', channel: '', t: 0 })).toBeNull();
  });

  it('ALLOWS editing a key on a baked track — that is what a bake is for', () => {
    const baked = generatedZoom([[8, 14]], 2);
    const { generator, ...rest } = baked;
    expect(generator).toBeDefined();
    const track: Track = { ...rest, origin: 'manual', generatedFrom: generator! };
    expect(isKeyEditable(track)).toBe(true);
    const withBaked: EditDocument = { ...empty(), tracks: [track] };
    expect(zoomKeysOf(withBaked)[0]?.editable).toBe(true);
  });

  it('moves a key, as remove-then-set in one batch', () => {
    const key = amountKeys[1];
    expect(key).toBeDefined();
    const ops = moveKeyOps(doc, key ?? { trackId: '', channel: '', t: 0 }, 11.2);
    expect(ops?.map((op) => op.op)).toEqual(['key.remove', 'key.set']);
    const next = apply(doc, ops);
    const moved = zoomKeysOf(next).filter((k) => k.channel === 'amount');
    expect(moved.map((k) => k.t)).toContain(11.2);
  });

  it('stops a key clear of its neighbours rather than replacing one', () => {
    // `setKey` upserts by `t`: a move that landed exactly on a neighbour would
    // **delete** that neighbour and report success.
    const key = amountKeys[1];
    const bounds = neighbourBounds(doc.tracks[0]!.channels['amount']?.keys ?? [], key?.t ?? 0);
    const ops = moveKeyOps(doc, key ?? { trackId: '', channel: '', t: 0 }, 1000);
    const next = apply(doc, ops);
    const after = next.tracks[0]!.channels['amount']?.keys ?? [];
    expect(after).toHaveLength(4);
    expect(after[1]?.t).toBeCloseTo(bounds.highSec, 9);
    expect(after[1]?.t).toBeLessThan(after[2]?.t ?? 0);
    expect(bounds.highSec).toBeCloseTo((after[2]?.t ?? 0) - KEY_GAP_SEC, 9);
  });

  it('changes a key’s value, and is invertible', () => {
    const key = amountKeys[1];
    const ops = setKeyValueOps(doc, key ?? { trackId: '', channel: '', t: 0 }, 3);
    const next = apply(doc, ops);
    expect(next.tracks[0]!.channels['amount']?.keys[1]?.v).toBe(3);
    expect(roundTrip(doc, ops ?? [])).toEqual(withoutRevision(doc));
  });

  /**
   * A key dragged out of its own `activeRanges` window is data corruption the user
   * cannot see: `zoomRegionsOf` filters it out, the region reads back short and
   * starting at its hold, the lane's band stops matching the window, and the next
   * region-level edit rebuilds the track from that misreading and writes it in.
   */
  describe('a keyframe stays inside the window it belongs to', () => {
    const amountOf = (document_: EditDocument): number[] =>
      (document_.tracks[0]?.channels['amount']?.keys ?? []).map((key) => key.t);
    const windowOf = (document_: EditDocument): [number, number] => {
      const range = document_.tracks[0]?.activeRanges[0];
      expect(range, 'the manual track has no window').toBeDefined();
      return [range?.[0] ?? 0, range?.[1] ?? 0];
    };

    it('refuses a drag before the window start — the first key is already on it', () => {
      const window = windowOf(doc);
      const first = amountKeys[0];
      expect(first?.t).toBeCloseTo(window[0], 9);
      // Nothing to do rather than a key at t = 5 on a region that opens at 10: the
      // neighbour bound alone leaves `lowSec` at 0 for the first key of the first
      // region, which is what let a drag take it out of its own window.
      expect(
        moveKeyOps(doc, first ?? { trackId: '', channel: '', t: 0 }, window[0] - 5),
      ).toBeNull();
    });

    it('stops a drag past the window end ON the window end', () => {
      const window = windowOf(doc);
      const last = amountKeys[amountKeys.length - 1];
      const next = apply(doc, moveKeyOps(doc, last ?? { trackId: '', channel: '', t: 0 }, 1000));
      const times = amountOf(next);
      expect(times).toHaveLength(4);
      expect(times[3]).toBeCloseTo(window[1], 9);
    });

    it('leaves the region readable, and every key inside its window', () => {
      // The property, not the arithmetic: whatever a drag does, the region has to read
      // back as the one that was placed. Both directions, because the two bounds come
      // from different places — a neighbour on one side, the window on the other.
      for (const [key, to] of [
        [amountKeys[0], -20],
        [amountKeys[amountKeys.length - 1], 1000],
      ] as const) {
        const ops = moveKeyOps(doc, key ?? { trackId: '', channel: '', t: 0 }, to);
        const next = ops === null ? doc : apply(doc, ops);
        const [start, end] = windowOf(next);
        expect(amountOf(next), `dragged to ${String(to)}`).toHaveLength(4);
        for (const t of amountOf(next)) {
          expect(t, `dragged to ${String(to)}`).toBeGreaterThanOrEqual(start);
          expect(t, `dragged to ${String(to)}`).toBeLessThanOrEqual(end);
        }
        const region = zoomRegionsOf(next)[0];
        expect(region?.startSec, `dragged to ${String(to)}`).toBeCloseTo(10, 6);
        expect(region?.amount, `dragged to ${String(to)}`).toBeCloseTo(2, 6);
      }
    });

    it('keeps the neighbour bound alone for a track with no window over the key', () => {
      // A baked track whose keys sit outside its own `activeRanges` is not this
      // editor's to re-frame; the §2.6 bound is the only one that applies there.
      const { generator, ...rest } = generatedZoom([[8, 14]], 2);
      const baked: Track = {
        ...rest,
        origin: 'manual',
        generatedFrom: generator!,
        activeRanges: [[30, 40]],
      };
      const withBaked: EditDocument = { ...empty(), tracks: [baked] };
      const first = zoomKeysOf(withBaked)[0];
      const ops = moveKeyOps(withBaked, first ?? { trackId: '', channel: '', t: 0 }, 1);
      expect(ops).not.toBeNull();
      const next = apply(withBaked, ops);
      expect(next.tracks[0]?.channels['amount']?.keys[0]?.t).toBeCloseTo(1, 9);
    });
  });

  it('refuses to delete a key that would leave a channel unable to describe a change', () => {
    // A spring channel with one key is a step from rest to that key, held for the
    // rest of the recording — so deleting down to one is a zoom that never comes back.
    const two = apply(
      doc,
      removeKeyOps(
        doc,
        zoomKeysOf(doc).filter((k) => k.channel === 'center')[1] ?? {
          trackId: '',
          channel: '',
          t: 0,
        },
      ),
    );
    const centre = zoomKeysOf(two).filter((k) => k.channel === 'center');
    expect(centre).toHaveLength(2);
    expect(removeKeyOps(two, centre[0] ?? { trackId: '', channel: '', t: 0 })).toBeNull();
  });
});
