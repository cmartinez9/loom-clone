/**
 * Annotation authoring, and the map a pointer crosses to get there.
 *
 * Two things are worth testing without a window, and they are different kinds of
 * wrong.
 *
 * **The ops.** A span placed by a drag has to produce a document that opens, and the
 * two privacy kinds have to be refused *here* rather than discovered by the
 * compositor — `readAnnotationGeometry` throws on a zero-area `blur`, and
 * `Compositor.render` then refuses the whole frame, so writing one would not produce a
 * small redaction, it would produce a recording whose preview will not composite.
 *
 * **The coordinate map.** `outputToSource` is `sourceSampleRect` + `contentRect`
 * inverted, and phase 11's argument for source-normalized geometry is a privacy one:
 * geometry in output space lets a zoom slide a redaction off the thing it hides. The
 * test that matters is therefore the **round trip against the compositor's own
 * forward map** — `sourceToOutput`, imported from `@loom/compositor`, so the two are
 * compared rather than one being asserted about itself.
 */

import { describe, expect, it } from 'vitest';
import {
  applyOps,
  newEditDocument,
  validateEditDocument,
  type EditDocument,
  type EditOp,
  type Vec2,
} from '@loom/format';
import { readAnnotationGeometry, newAnnotationGeometry, compile, resolve } from '@loom/edl';
import { sourceToOutput, sourceSampleRect, contentRect } from '@loom/compositor';
import {
  annotationAt,
  annotationsOf,
  ANNOTATION_TOOLS,
  ANNOTATION_TRACK_ID,
  MIN_SPAN_SEC,
  moveAnnotationOps,
  outputToSource,
  placeAnnotationOps,
  removeAnnotationOps,
  retimeAnnotationOps,
  sourceToOutput01,
  styleAnnotationOps,
  type StageMapping,
} from '../src/editor/annotate.ts';

const DURATION = 60;

function apply(doc: EditDocument, ops: EditOp[] | null): EditDocument {
  expect(ops, 'the batch under test produced no ops').not.toBeNull();
  const next = applyOps(structuredClone(doc), ops ?? []);
  const result = validateEditDocument(next);
  expect(result.ok ? [] : result.issues, 'the ops produced a document that will not open').toEqual(
    [],
  );
  return next;
}

function withRect(doc: EditDocument = newEditDocument()): EditDocument {
  return apply(
    doc,
    placeAnnotationOps(doc, {
      kind: 'rect',
      startSec: 4,
      endSec: 8,
      center: [0.4, 0.6],
      size: [0.2, 0.1],
    }),
  );
}

describe('placing an annotation', () => {
  it('writes one track with one span, and it validates', () => {
    const doc = withRect();
    expect(doc.tracks).toHaveLength(1);
    const track = doc.tracks[0];
    expect(track?.id).toBe(ANNOTATION_TRACK_ID);
    expect(track?.kind).toBe('object');
    expect(track?.target).toBe('annotation');
    // §3.2's argument applied to space: an annotation is placed on content, so it is
    // anchored in source time and travels with a trim.
    expect(track?.domain).toBe('source');
    expect(track?.spans).toHaveLength(1);
  });

  it('adds a second span to the same track, in document order', () => {
    const doc = apply(
      withRect(),
      placeAnnotationOps(withRect(), {
        kind: 'blur',
        startSec: 4,
        endSec: 8,
        center: [0.7, 0.7],
        size: [0.2, 0.1],
      }),
    );
    expect(doc.tracks).toHaveLength(1);
    // Array order is z-order and a new span appends, so the last one placed is on
    // top — which is what "spans draw in document order with no exceptions" means for
    // somebody who just drew one.
    expect(annotationsOf(doc).map((a) => a.kind)).toEqual(['rect', 'blur']);
  });

  it('names each span uniquely, even after one is deleted', () => {
    // `span.set` upserts by id, so a collision silently replaces somebody's
    // annotation instead of adding one.
    let doc = withRect();
    doc = apply(
      doc,
      placeAnnotationOps(doc, {
        kind: 'rect',
        startSec: 10,
        endSec: 14,
        center: [0.5, 0.5],
        size: [0.2, 0.1],
      }),
    );
    doc = apply(doc, removeAnnotationOps(doc, 'rect-1'));
    doc = apply(
      doc,
      placeAnnotationOps(doc, {
        kind: 'rect',
        startSec: 20,
        endSec: 24,
        center: [0.5, 0.5],
        size: [0.2, 0.1],
      }),
    );
    const ids = annotationsOf(doc).map((a) => a.span.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('rect-2');
  });

  it('writes the geometry the compositor reads, in normalized source coordinates', () => {
    const doc = withRect();
    const compiled = compile(
      { ...doc, clips: [{ id: 'all', sourceStart: 0, sourceEnd: DURATION, speed: 1 }] },
      { cursor: null, clicks: null, recording: null },
    );
    const state = resolve(compiled, 6);
    expect(state.annotations).toHaveLength(1);
    const out = newAnnotationGeometry();
    readAnnotationGeometry(state.annotations[0]!, 'rect', out);
    expect(out.cx).toBeCloseTo(0.4, 6);
    expect(out.cy).toBeCloseTo(0.6, 6);
    expect(out.hx).toBeCloseTo(0.1, 6);
    expect(out.hy).toBeCloseTo(0.05, 6);
  });

  it('writes an arrow as `from`/`to`, not as a box', () => {
    const doc = apply(
      newEditDocument(),
      placeAnnotationOps(newEditDocument(), {
        kind: 'arrow',
        startSec: 2,
        endSec: 6,
        from: [0.2, 0.3],
        to: [0.7, 0.8],
      }),
    );
    const view = annotationsOf(doc)[0];
    expect(view?.from).toEqual([0.2, 0.3]);
    expect(view?.to).toEqual([0.7, 0.8]);
    expect(view?.center).toBeNull();
  });

  it('refuses a degenerate box, which is what a click rather than a drag produces', () => {
    for (const kind of ANNOTATION_TOOLS) {
      const ops =
        kind === 'arrow'
          ? placeAnnotationOps(newEditDocument(), {
              kind,
              startSec: 1,
              endSec: 3,
              from: [0.5, 0.5],
              to: [0.5, 0.5],
            })
          : placeAnnotationOps(newEditDocument(), {
              kind,
              startSec: 1,
              endSec: 3,
              center: [0.5, 0.5],
              size: [0, 0],
            });
      expect(ops, `${kind} accepted a zero-area drag`).toBeNull();
    }
  });

  it('refuses a non-finite geometry outright', () => {
    expect(
      placeAnnotationOps(newEditDocument(), {
        kind: 'blur',
        startSec: 1,
        endSec: 3,
        center: [Number.NaN, 0.5],
        size: [0.2, 0.2],
      }),
    ).toBeNull();
  });

  it('keeps a span at least `MIN_SPAN_SEC` long even from a zero-length request', () => {
    const doc = apply(
      newEditDocument(),
      placeAnnotationOps(newEditDocument(), {
        kind: 'rect',
        startSec: 5,
        endSec: 5,
        center: [0.5, 0.5],
        size: [0.2, 0.2],
      }),
    );
    const view = annotationsOf(doc)[0];
    expect((view?.endSec ?? 0) - (view?.startSec ?? 0)).toBeGreaterThanOrEqual(MIN_SPAN_SEC);
  });
});

describe('editing an annotation', () => {
  const base = withRect();

  it('moves the box and leaves everything else', () => {
    const doc = apply(base, moveAnnotationOps(base, 'rect-1', { center: [0.6, 0.2] }));
    const view = annotationsOf(doc)[0];
    expect(view?.center).toEqual([0.6, 0.2]);
    expect(view?.size).toEqual([0.2, 0.1]);
    expect(view?.startSec).toBe(4);
  });

  it('answers null when nothing would change', () => {
    expect(moveAnnotationOps(base, 'rect-1', { center: [0.4, 0.6] })).toBeNull();
    expect(styleAnnotationOps(base, 'rect-1', {})).toBeNull();
    expect(retimeAnnotationOps(base, 'rect-1', {}, DURATION)).toBeNull();
  });

  it('moves the channel keys with the span, so they never fall outside it', () => {
    // A span dragged later whose keys stayed behind evaluates at its first value for
    // ever: identical on screen, and not the same document.
    const doc = apply(
      base,
      retimeAnnotationOps(base, 'rect-1', { startSec: 20, endSec: 24 }, DURATION),
    );
    const span = annotationsOf(doc)[0]?.span;
    expect(span?.start).toBeCloseTo(20, 6);
    for (const channel of Object.values(span?.channels ?? {})) {
      expect(channel.keys[0]?.t).toBeCloseTo(20, 6);
    }
  });

  it('resizes one end without pushing the other', () => {
    // `moveHandle`'s rule for the trim handles, applied to a span: pushing is what
    // makes a fast drag past the far end silently discard everything.
    const doc = apply(base, retimeAnnotationOps(base, 'rect-1', { endSec: 4.05 }, DURATION));
    const view = annotationsOf(doc)[0];
    expect(view?.startSec).toBeCloseTo(4, 6);
    expect(view?.endSec).toBeCloseTo(4 + MIN_SPAN_SEC, 6);
  });

  it('moves both ends together and keeps the length', () => {
    const doc = apply(
      base,
      retimeAnnotationOps(base, 'rect-1', { startSec: 30, endSec: 99 }, DURATION),
    );
    const view = annotationsOf(doc)[0];
    expect((view?.endSec ?? 0) - (view?.startSec ?? 0)).toBeCloseTo(4, 6);
    expect(view?.startSec).toBeCloseTo(30, 6);
  });

  it('slides rather than shrinks when a move runs off the end', () => {
    const doc = apply(
      base,
      retimeAnnotationOps(base, 'rect-1', { startSec: 999, endSec: 999 }, DURATION),
    );
    const view = annotationsOf(doc)[0];
    expect(view?.endSec).toBeCloseTo(DURATION, 6);
    expect((view?.endSec ?? 0) - (view?.startSec ?? 0)).toBeCloseTo(4, 6);
  });

  it('removes the track when the last span goes, and only then', () => {
    const two = apply(
      base,
      placeAnnotationOps(base, {
        kind: 'mask',
        startSec: 10,
        endSec: 14,
        center: [0.5, 0.5],
        size: [0.2, 0.2],
      }),
    );
    expect(apply(two, removeAnnotationOps(two, 'mask-1')).tracks).toHaveLength(1);
    expect(apply(base, removeAnnotationOps(base, 'rect-1')).tracks).toEqual([]);
  });

  it('hits the topmost span under a point, and only while it covers the playhead', () => {
    const two = apply(
      base,
      placeAnnotationOps(base, {
        kind: 'blur',
        startSec: 4,
        endSec: 8,
        center: [0.4, 0.6],
        size: [0.3, 0.2],
      }),
    );
    // Both boxes contain (0.4, 0.6); the blur was placed last, so it is on top.
    expect(annotationAt(two, 6, [0.4, 0.6])?.kind).toBe('blur');
    // Outside every span's time, nothing is hit — a click there is a deselect.
    expect(annotationAt(two, 20, [0.4, 0.6])).toBeNull();
    // Outside every box, nothing is hit.
    expect(annotationAt(two, 6, [0.95, 0.95])).toBeNull();
  });
});

/**
 * The pointer's map, checked against the compositor's own.
 *
 * Both directions and both rects — a 16:9 source in a 16:9 output (no letterbox), and
 * a 4:3 source in a 16:9 output (letterbox on both sides), which is what a
 * `edit.output.size` nothing sets from the recording routinely produces.
 */
describe('the pointer’s map into normalized source space', () => {
  const cases: { name: string; mapping: StageMapping }[] = [
    {
      name: 'no letterbox, no zoom',
      mapping: {
        outputSize: [1920, 1080],
        sourceSize: [3840, 2160],
        zoom: { amount: 1, center: [0.5, 0.5] },
      },
    },
    {
      name: 'letterboxed 4:3 in 16:9',
      mapping: {
        outputSize: [1920, 1080],
        sourceSize: [1600, 1200],
        zoom: { amount: 1, center: [0.5, 0.5] },
      },
    },
    {
      name: 'zoomed and off-centre',
      mapping: {
        outputSize: [1280, 720],
        sourceSize: [2560, 1440],
        zoom: { amount: 2.5, center: [0.35, 0.62] },
      },
    },
  ];

  for (const { name, mapping } of cases) {
    it(`round-trips through the compositor’s own forward map — ${name}`, () => {
      const source: Vec2 = [0.42, 0.58];
      // The compositor's `sourceToOutput` is the affine map the annotation pass draws
      // through, in **output pixels**; this window's `sourceToOutput01` answers in
      // fractions of the canvas. They must place the same point, or a handle sits
      // somewhere the annotation is not.
      const rect = sourceSampleRect({
        amount: mapping.zoom.amount,
        center: [mapping.zoom.center[0] ?? 0.5, mapping.zoom.center[1] ?? 0.5],
      });
      const content = contentRect(mapping.sourceSize, mapping.outputSize);
      const map = sourceToOutput(rect, content);
      const ours = sourceToOutput01(mapping, source);
      expect(ours[0] * mapping.outputSize[0]).toBeCloseTo(map.originX + map.scaleX * source[0], 6);
      expect(ours[1] * mapping.outputSize[1]).toBeCloseTo(map.originY + map.scaleY * source[1], 6);

      // And back: a point taken to the canvas and returned is the point it started at.
      const back = outputToSource(mapping, ours);
      expect(back).not.toBeNull();
      expect(back?.[0]).toBeCloseTo(source[0], 6);
      expect(back?.[1]).toBeCloseTo(source[1], 6);
    });
  }

  it('answers null on the letterbox, rather than clamping onto the picture', () => {
    // An annotation dropped there has no content to be welded to, and clamping would
    // put a redaction somewhere the user did not point at.
    const mapping = cases[1]!.mapping;
    expect(outputToSource(mapping, [0.01, 0.5])).toBeNull();
    expect(outputToSource(mapping, [0.5, 0.5])).not.toBeNull();
  });
});
