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
  type KeyView,
  type ZoomRegion,
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
 * A region-level edit changes what it names, and nothing else.
 *
 * The keys on the manual track are the **user's** — `isKeyEditable` says so, and the
 * lane and the inspector both let a person drag one and set its value. Reading a region
 * out of those keys and then writing it back as `buildManualZoomTrack`'s canonical
 * layout discarded everything the four-number summary could not carry, and the flow
 * that reached it is the natural one: lengthen a ramp by hand, then nudge the Amount
 * slider. The finer edit went silently, which is the *"your edit was overwritten"*
 * shape §3.5 argues against one level out.
 *
 * So every one of the five region-level verbs is exercised over a document whose keys
 * have been hand-edited **through the shipping ops** — `moveKeyOps` and
 * `setKeyValueOps`, the real path a person takes — and each has to leave both edits
 * standing. Covering `amount` alone would be the same bug with a smaller mouth.
 *
 * The consequence is asserted rather than the key list: the document still opens, and
 * `zoomRegionsOf` still reads the region back as what was asked for.
 */
describe('a region-level edit keeps the keys the user placed', () => {
  const FRAMED: [number, number] = [0.6, 0.4];
  /** Where the INTERIOR fixture drags the hold's first `amount` key — 0.9 s later. */
  const HOLD_DRAGGED_TO = 11.5;
  /** What the interior fixture gives the ramp-in key: a zoom that starts slightly in. */
  const RAMP_IN_VALUE = 1.4;
  /** Where the BOUNDARY fixture drags the ramp-in `amount` key — a shorter ramp in. */
  const RAMP_IN_DRAGGED_TO = 10.5;
  /** What the boundary fixture gives the ramp-out key, so its value is the user's too. */
  const RAMP_OUT_VALUE = 1.2;

  function amountKeys(document_: EditDocument): KeyView[] {
    return zoomKeysOf(document_).filter((key) => key.channel === 'amount');
  }

  /** The times of region 0's two hold keys — what no region-level edit may retime. */
  function interiorOf(document_: EditDocument): number[] {
    return amountKeys(document_)
      .map((key) => key.t)
      .slice(1, 3);
  }

  /** The times of the *other* region's keys, which no edit to region 0 may touch. */
  function otherRegionOf(document_: EditDocument): number[] {
    return amountKeys(document_)
      .map((key) => key.t)
      .slice(4);
  }

  function twoRegions(): EditDocument {
    const doc = place(empty(), { startSec: 10, endSec: 18, amount: 2, center: FRAMED });
    return place(doc, { startSec: 30, endSec: 38, amount: 2.5, center: [0.4, 0.6] });
  }

  function drag(document_: EditDocument, at: number, toSec: number): EditDocument {
    const key = amountKeys(document_)[at];
    expect(key, 'the fixture has no key to drag there').toBeDefined();
    return apply(document_, key === undefined ? null : moveKeyOps(document_, key, toSec));
  }

  function revalue(document_: EditDocument, at: number, value: number): EditDocument {
    const key = amountKeys(document_)[at];
    expect(key, 'the fixture has no key to revalue there').toBeDefined();
    return apply(document_, key === undefined ? null : setKeyValueOps(document_, key, value));
  }

  /**
   * One document a person has hand-edited, and what "the hand edit is still there"
   * means for it.
   *
   * Two of them, because the two halves of the fix fail in different places. The
   * INTERIOR fixture drags a key the region's extent does not touch — the flow the
   * whole patch-don't-regenerate change is named for. The BOUNDARY fixture drags the
   * key that *carries* the extent, which the first version of that change got wrong: a
   * stale `center` key was then counted as interior and the next edit dragged the
   * extent back over the drag, 1 ms *earlier* than it had ever been, from an edit that
   * named only the amount.
   */
  interface HandEditedFixture {
    label: string;
    build: () => EditDocument;
    /** Where the hand editing leaves the region, before any region-level edit. */
    startSec: number;
    endSec: number;
    /** Every hand edit still standing, whatever region-level edit has just run. */
    expectIntact: (document_: EditDocument, why: string) => void;
  }

  const FIXTURES: HandEditedFixture[] = [
    {
      label: 'an interior key dragged',
      startSec: 10,
      endSec: 18,
      build: () => revalue(drag(twoRegions(), 1, HOLD_DRAGGED_TO), 0, RAMP_IN_VALUE),
      expectIntact: (document_, why) => {
        const keys = amountKeys(document_);
        expect(
          keys.map((key) => key.t),
          `${why}: the dragged hold key was retimed`,
        ).toContain(HOLD_DRAGGED_TO);
        const region = zoomRegionsOf(document_)[0];
        const rampIn = keys.find((key) => Math.abs(key.t - (region?.startSec ?? -1)) < 1e-9);
        expect(rampIn?.key.v, `${why}: the ramp-in key’s own value was overwritten`).toBe(
          RAMP_IN_VALUE,
        );
      },
    },
    {
      label: 'a boundary key dragged',
      startSec: RAMP_IN_DRAGGED_TO,
      endSec: 18,
      build: () => revalue(drag(twoRegions(), 0, RAMP_IN_DRAGGED_TO), 3, RAMP_OUT_VALUE),
      expectIntact: (document_, why) => {
        const keys = amountKeys(document_);
        const region = zoomRegionsOf(document_)[0];
        const rampOut = keys.find((key) => Math.abs(key.t - (region?.endSec ?? -1)) < 1e-9);
        expect(rampOut?.key.v, `${why}: the ramp-out key’s own value was overwritten`).toBe(
          RAMP_OUT_VALUE,
        );
      },
    },
  ];

  interface Verb {
    label: string;
    ops: (document_: EditDocument) => EditOp[] | null;
    /** The extent this verb names, when it names one. */
    startSec?: number;
    endSec?: number;
    regions: number;
    expectRegion: (region: ZoomRegion | undefined) => void;
  }

  const VERBS: Verb[] = [
    {
      label: 'AMOUNT rewrites the hold',
      ops: (document_) => updateZoomOps(document_, 0, { amount: 3 }, DURATION),
      regions: 2,
      expectRegion: (region) => {
        expect(region?.amount).toBeCloseTo(3, 6);
        expect(region?.center[0]).toBeCloseTo(FRAMED[0], 6);
      },
    },
    {
      label: 'CENTRE rewrites the framing key',
      ops: (document_) => updateZoomOps(document_, 0, { center: [0.35, 0.65] }, DURATION),
      regions: 2,
      expectRegion: (region) => {
        expect(region?.center[0]).toBeCloseTo(0.35, 6);
        expect(region?.center[1]).toBeCloseTo(0.65, 6);
        expect(region?.amount).toBeCloseTo(2, 6);
      },
    },
    {
      label: 'START moves the boundary keys',
      ops: (document_) => updateZoomOps(document_, 0, { startSec: 9 }, DURATION),
      startSec: 9,
      regions: 2,
      expectRegion: (region) => {
        expect(region?.center[0]).toBeCloseTo(FRAMED[0], 6);
      },
    },
    {
      label: 'END moves the boundary keys',
      ops: (document_) => updateZoomOps(document_, 0, { endSec: 20 }, DURATION),
      endSec: 20,
      regions: 2,
      expectRegion: (region) => {
        // The window still runs past the last keyframe by the spring's settle tail.
        expect(region?.windowEndSec).toBeCloseTo(20 + segmentSettleTailSec(DEFAULT_SPRING), 6);
      },
    },
    {
      label: 'REMOVE takes the other region out',
      ops: (document_) => removeZoomOps(document_, 1),
      regions: 1,
      expectRegion: (region) => {
        expect(region?.amount).toBeCloseTo(2, 6);
        expect(region?.center[0]).toBeCloseTo(FRAMED[0], 6);
        expect(region?.center[1]).toBeCloseTo(FRAMED[1], 6);
      },
    },
  ];

  for (const fixture of FIXTURES) {
    describe(fixture.label, () => {
      it('is what the fixture says it is before any region-level edit', () => {
        // The precondition, so a fixture that quietly stopped hand-editing anything
        // cannot make every assertion below pass by describing a region nobody touched.
        const doc = fixture.build();
        const region = zoomRegionsOf(doc)[0];
        expect(zoomRegionsOf(doc)).toHaveLength(2);
        expect(region?.startSec).toBeCloseTo(fixture.startSec, 6);
        expect(region?.endSec).toBeCloseTo(fixture.endSec, 6);
        fixture.expectIntact(doc, 'the fixture itself');
      });

      for (const verb of VERBS) {
        it(`${verb.label} and leaves everything else alone`, () => {
          const doc = fixture.build();
          const kept = interiorOf(doc);
          const others = otherRegionOf(doc);
          const next = apply(doc, verb.ops(doc));
          fixture.expectIntact(next, verb.label);
          expect(interiorOf(next), 'a key between the boundaries was retimed').toEqual(kept);
          if (verb.regions > 1) {
            expect(otherRegionOf(next), 'the other region was retimed').toEqual(others);
          }
          expect(zoomRegionsOf(next)).toHaveLength(verb.regions);
          const region = zoomRegionsOf(next)[0];
          expect(region, 'the region stopped being readable at all').toBeDefined();
          // The extent is the fixture's unless this verb named one — which is the
          // whole regression: an edit that named only the amount used to move the
          // start out from under a key the user had just dragged.
          expect(region?.startSec, 'the extent moved without being asked to').toBeCloseTo(
            verb.startSec ?? fixture.startSec,
            6,
          );
          expect(region?.endSec, 'the extent moved without being asked to').toBeCloseTo(
            verb.endSec ?? fixture.endSec,
            6,
          );
          verb.expectRegion(region);
        });
      }

      it('is exactly invertible', () => {
        const doc = fixture.build();
        const ops = updateZoomOps(doc, 0, { amount: 3, center: [0.3, 0.3] }, DURATION);
        expect(roundTrip(doc, ops ?? [])).toEqual(withoutRevision(doc));
      });

      it('survives a second zoom being placed beside it', () => {
        // The same class one verb over: `placeZoomOps` inserts a fresh region's
        // canonical keys beside what is already on the track rather than rebuilding
        // every region.
        const doc = fixture.build();
        const kept = amountKeys(doc)
          .map((key) => key.t)
          .slice(0, 4);
        const next = place(doc, { startSec: 45, endSec: 50, amount: 2, center: [0.5, 0.5] });
        fixture.expectIntact(next, 'placing a third region');
        expect(
          amountKeys(next)
            .map((key) => key.t)
            .slice(0, 4),
        ).toEqual(kept);
        expect(zoomRegionsOf(next)).toHaveLength(3);
      });
    });
  }

  it('holds a boundary off the region’s own keys rather than dragging them along', () => {
    // `keyBounds` from the other side. A start dragged past one of its own keys is a
    // repeated `t` (§2.6, which `validateEditDocument` refuses) or a key stranded
    // outside the window that owns it, and dragging the key along is the very
    // re-derivation this whole path exists to stop. So the drag stops instead.
    const doc = revalue(drag(twoRegions(), 1, HOLD_DRAGGED_TO), 0, RAMP_IN_VALUE);
    const kept = interiorOf(doc);
    const next = apply(doc, updateZoomOps(doc, 0, { startSec: 14 }, DURATION));
    expect(interiorOf(next), 'the hold was dragged along instead of the drag being held').toEqual(
      kept,
    );
    const region = zoomRegionsOf(next)[0];
    expect(region?.startSec, 'the start did not move at all').toBeGreaterThan(10);
    expect(
      region?.startSec,
      'the start was let past a key it would have collided with',
    ).toBeLessThan(kept[0] ?? 0);
  });

  it('still edits a region whose own key was dragged past the end of the recording', () => {
    // `keyBounds` bounds a key by its `activeRanges` window, and a window runs
    // `segmentSettleTailSec` past the region's end — so the last `center` key of a
    // region near the end of a recording can legally be dragged past
    // `sourceDurationSec`. Counting that key as interior made every region-level
    // control refuse for the rest of that recording's life, silently: no amount, no
    // centre, no start, no end, and nothing on screen saying why.
    const doc = place(empty(), { startSec: 55, endSec: 59.9, amount: 2, center: [0.5, 0.5] });
    const centreKeys = zoomKeysOf(doc).filter((key) => key.channel === 'center');
    const last = centreKeys[centreKeys.length - 1];
    expect(last, 'the fixture has no ramp-out centre key').toBeDefined();
    const beyond = (zoomRegionsOf(doc)[0]?.windowEndSec ?? 0) - KEY_GAP_SEC;
    expect(beyond, 'the settle tail no longer reaches past the recording').toBeGreaterThan(
      DURATION,
    );
    const dragged = apply(doc, last === undefined ? null : moveKeyOps(doc, last, beyond));
    expect(
      zoomKeysOf(dragged)
        .filter((key) => key.channel === 'center')
        .map((key) => key.t),
    ).toContain(beyond);

    const next = apply(dragged, updateZoomOps(dragged, 0, { amount: 3 }, DURATION));
    expect(zoomRegionsOf(next)[0]?.amount).toBeCloseTo(3, 6);
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

/**
 * Which `center` key a region *means*, and the corruption a positional answer causes.
 *
 * `buildManualZoomTrack` writes three centre keys per region — identity at `startSec`,
 * the user's framing at the hold, identity at `endSec` — and the reader used to take
 * the middle of the set filtered by the **`amount`** channel's extent. That index was a
 * position standing in for identity: the moment the set gained a second member the
 * middle of two was the identity ramp-out key, the region read back `[0.5, 0.5]`, and
 * the next region-level edit rebuilt the whole track from `asInput(current)` and wrote
 * the frame centre in over the user's framing.
 *
 * Two ordinary drags reach it and **only one of them is a window question**, which is
 * why `keyBounds` could not close the class on its own.
 */
describe('a region reports the centre the user framed', () => {
  /** Comfortably inside the legal centre interval at 2× ([0.25, 0.75]) and at 3×. */
  const FRAMED: [number, number] = [0.6, 0.4];

  function framed(startSec = 10, endSec = 18): EditDocument {
    return place(empty(), { startSec, endSec, amount: 2, center: [FRAMED[0], FRAMED[1]] });
  }

  function centreOf(document_: EditDocument): [number, number] {
    const region = zoomRegionsOf(document_)[0];
    expect(region, 'the region stopped being readable at all').toBeDefined();
    return [region?.center[0] ?? -1, region?.center[1] ?? -1];
  }

  function expectFramed(document_: EditDocument, why: string): void {
    const [x, y] = centreOf(document_);
    expect(x, why).toBeCloseTo(FRAMED[0], 6);
    expect(y, why).toBeCloseTo(FRAMED[1], 6);
  }

  /**
   * The consequence, not the intermediate reading: a region-level edit rebuilds the
   * track from `asInput(current)`, so a misread centre is written into the document.
   */
  function expectFramingSurvivesAnEdit(document_: EditDocument): void {
    const tuned = apply(document_, updateZoomOps(document_, 0, { amount: 3 }, DURATION));
    expect(zoomRegionsOf(tuned)[0]?.amount).toBeCloseTo(3, 6);
    expectFramed(tuned, 'a region-level edit wrote the frame centre over the user’s framing');
    const written = tuned.tracks[0]?.channels['center']?.keys ?? [];
    const kept = written.find(
      (key) => Array.isArray(key.v) && Math.abs((key.v[0] ?? 0) - FRAMED[0]) < 1e-9,
    );
    expect(kept, 'the rebuilt track carries no key with the user’s framing on it').toBeDefined();
  }

  function keysOn(document_: EditDocument, channel: string): KeyView[] {
    return zoomKeysOf(document_).filter((key) => key.channel === channel);
  }

  function last(views: readonly KeyView[]): KeyView {
    const view = views[views.length - 1];
    expect(view, 'the channel under test has no keys').toBeDefined();
    return (
      view ?? {
        trackId: '',
        channel: '',
        t: 0,
        key: { t: 0, v: 0, ease: { kind: 'hold' } },
        editable: false,
      }
    );
  }

  it('reads it back from a region nobody has touched', () => {
    expectFramed(framed(), 'a freshly placed region');
  });

  it('SIBLING 1: the last `amount` key dragged later — `endSec` passes the ramp-out key', () => {
    const doc = framed();
    const moved = apply(doc, moveKeyOps(doc, last(keysOn(doc, 'amount')), 18.2));
    // The precondition: the drag landed and `endSec` is now past the centre key at 18,
    // which is exactly what let the old filter admit a second candidate.
    expect(zoomRegionsOf(moved)[0]?.endSec).toBeGreaterThan(18 + 1e-6);
    expectFramed(moved, 'dragging the last `amount` key later lost the framing');
    expectFramingSurvivesAnEdit(moved);
  });

  it('SIBLING 2: the last `center` key dragged earlier — and no bound reaches this one', () => {
    const doc = framed();
    const moved = apply(doc, moveKeyOps(doc, last(keysOn(doc, 'center')), 12));
    // The key never leaves its own `activeRanges` window, so `keyBounds` permits it and
    // always will: the reader is the only thing that can be right here.
    expect(keysOn(moved, 'center').map((key) => key.t)).toContain(12);
    expect(zoomRegionsOf(moved)[0]?.endSec).toBeCloseTo(18, 6);
    expectFramed(moved, 'dragging the last `center` key earlier lost the framing');
    expectFramingSurvivesAnEdit(moved);
  });

  describe('attacking the reader on purpose', () => {
    it('keeps the framing when the START ramp’s centre key is deleted', () => {
      const doc = framed();
      const next = apply(doc, removeKeyOps(doc, keysOn(doc, 'center')[0]!));
      expectFramed(next, 'deleting the ramp-in centre key lost the framing');
    });

    it('keeps the framing when the END ramp’s centre key is deleted', () => {
      const doc = framed();
      const next = apply(doc, removeKeyOps(doc, last(keysOn(doc, 'center'))));
      expectFramed(next, 'deleting the ramp-out centre key lost the framing');
    });

    it('keeps the framing when the hold’s `amount` key is deleted', () => {
      // The case that rules out deriving the hold from the `amount` channel: with that
      // key gone the largest amount sits at `holdEnd`, near the far end of the region.
      const doc = framed();
      const next = apply(doc, removeKeyOps(doc, keysOn(doc, 'amount')[1]!));
      expectFramed(next, 'deleting the hold’s `amount` key lost the framing');
    });

    it('answers identity when the user deleted their OWN centre key', () => {
      // Honest rather than clever: the framing is gone from the document, so the
      // region has no centre of its own and `[0.5, 0.5]` is what it means.
      const doc = framed();
      const next = apply(doc, removeKeyOps(doc, keysOn(doc, 'center')[1]!));
      expect(centreOf(next)).toEqual([0.5, 0.5]);
    });

    it('keeps the framing on the shortest region the model allows', () => {
      // Both ramps and the minimum hold, so every key is as close to every other as
      // this editor can place them. A region whose hold has no length at all is not on
      // the list: `buildManualZoomTrack` writes `holdEnd` at `max(holdStart +
      // MIN_HOLD_SEC, …)`, so the two can never coincide however short the request.
      const shortest = framed(10, 10 + 2 * ZOOM_RAMP_SEC + 0.2);
      const holdKeys = keysOn(shortest, 'amount').map((key) => key.t);
      expect(holdKeys[2] ?? 0).toBeGreaterThan(holdKeys[1] ?? 0);
      expectFramed(shortest, 'the shortest legal region');
    });

    it('degrades rather than throwing on a track with no `center` channel at all', () => {
      // A hand-edited or older document is not obliged to carry the shape this editor
      // writes, and refusing to read one would take the whole panel down with it.
      const doc = framed();
      const track = doc.tracks[0];
      expect(track).toBeDefined();
      const { center: _center, ...channels } = track?.channels ?? {};
      const stripped: EditDocument = {
        ...doc,
        tracks: [{ ...track!, channels }],
      };
      expect(centreOf(stripped)).toEqual([0.5, 0.5]);
    });

    it('never reads a baked generator track through this path at all', () => {
      // Out of reach rather than covered: `zoomRegionsOf` reads `manualZoomTrackOf`,
      // which is the one track this editor writes. A baked generated track keeps its
      // own id, so its keys are never decoded as regions.
      const { generator, ...rest } = generatedZoom([[8, 14]], 2);
      const baked: Track = { ...rest, origin: 'manual', generatedFrom: generator! };
      expect(baked.id).not.toBe(MANUAL_ZOOM_TRACK_ID);
      expect(zoomRegionsOf({ ...empty(), tracks: [baked] })).toEqual([]);
    });
  });
});
