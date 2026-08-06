/**
 * Annotation authoring, as ops over one `kind: 'object'` track.
 *
 * Phase 11 built what an annotation *means* (`@loom/edl`'s `annotations.ts`) and what
 * it *looks like* (`@loom/compositor`'s `AnnotationPass`), and said in as many words
 * that nothing authors one: *"the editor shell has no annotation tools, and they are
 * `loom-p15`'s."* This is that half, and — like every other phase since 7 — it adds
 * **no primitive**. An annotation is a `Span` on an `annotationTrack`; placing one is
 * `span.set`, deleting one is `span.remove`, and both already have exact inverses in
 * `inverse.ts`, including the `track.patch` that takes the `spans` array back off when
 * the first one is undone.
 *
 * ## Geometry is normalized SOURCE, and that is what the pointer has to be converted to
 *
 * `annotations.ts` argues it at length and the argument is a privacy one: geometry
 * normalized against the *output* would let a zoom slide the content out from under a
 * blur and publish the thing the user hid. So a drag on the preview canvas is in
 * output pixels, and {@link outputToSource} is the one place it becomes a source
 * coordinate — through the same `sourceSampleRect` and `contentRect` the compositor
 * samples with, inverted. Not an approximation of them: a redaction placed a few
 * pixels off the thing it is covering is a redaction that does not cover it.
 *
 * ## One track, and z-order is array order
 *
 * Every span the user places lives on one track, because §3.3 already makes a span
 * the unit and because *"spans draw in document order with no exceptions — a blur
 * after a rectangle blurs the rectangle."* Splitting them across tracks would put
 * that ordering under the stacking model the captain took out of the MVP. `span.set`
 * without `at` appends, so a newly placed annotation is on top, which is what a person
 * means by drawing one.
 */

import { annotationSpan, annotationTrack, isAnnotationKind, type AnnotationKind } from '@loom/edl';
import type { EditDocument, EditOp, Seconds, Span, Track, Vec2 } from '@loom/format';

/** The id every annotation this editor writes lives on. */
export const ANNOTATION_TRACK_ID = 't-annotations';

/**
 * How long a newly placed annotation lasts, in source seconds.
 *
 * Long enough to read a short label at speaking pace, short enough that placing one
 * and forgetting it does not stamp the whole recording. It is the *initial* value
 * and the span's ends are draggable on the timeline like a trim handle, which is
 * where a person changes it.
 */
export const DEFAULT_SPAN_SEC = 4;

/** The shortest span a drag may leave — a fifth of a second, `MIN_TRIM_SEC`'s reasoning. */
export const MIN_SPAN_SEC = 0.2;

/**
 * The tools the rail offers, in the rail's order.
 *
 * Every member of `ANNOTATION_KINDS` except `stroke`, which is the live drawing
 * overlay's (phase 12) and is placed by a pen during a recording rather than by a
 * tool afterwards — its points are in `style.points` and there is nothing an
 * after-the-fact tool would put in them. Deleting an imported stroke is `track.remove`
 * and already works (`drawing.ts`); drawing a new one in the editor would be a second
 * pen, on a canvas that is not the one the presenter was looking at.
 */
export const ANNOTATION_TOOLS = [
  'rect',
  'ellipse',
  'arrow',
  'highlight',
  'text',
  'blur',
  'mask',
] as const satisfies readonly AnnotationKind[];

export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

/** The editor's annotation track, or `null` when nothing has been placed. */
export function annotationTrackOf(doc: EditDocument): Track | null {
  return doc.tracks.find((track) => track.id === ANNOTATION_TRACK_ID) ?? null;
}

/** One placed annotation, as a surface needs to see it. */
export interface AnnotationView {
  span: Span;
  kind: AnnotationKind;
  startSec: Seconds;
  endSec: Seconds;
  /** Where it is, read back out of its channels. `null` for a kind with no box. */
  center: Vec2 | null;
  size: Vec2 | null;
  from: Vec2 | null;
  to: Vec2 | null;
}

/**
 * Every annotation on the editor's track, in document order.
 *
 * Document order, not time order: array order is z-order (§ the module comment), so a
 * list sorted by time would put the rows in a different sequence from the pixels.
 * Spans whose `type` this build does not render are skipped rather than shown — a
 * newer build's annotation must not make a recording unopenable (`isAnnotationKind`
 * says why), and it must not appear in a list of things this editor can edit either.
 */
export function annotationsOf(doc: EditDocument): AnnotationView[] {
  const track = annotationTrackOf(doc);
  if (track === null) return [];
  const out: AnnotationView[] = [];
  for (const span of track.spans ?? []) {
    if (!isAnnotationKind(span.type)) continue;
    out.push({
      span,
      kind: span.type,
      startSec: span.start,
      endSec: span.end,
      center: pairOf(span, 'center'),
      size: pairOf(span, 'size'),
      from: pairOf(span, 'from'),
      to: pairOf(span, 'to'),
    });
  }
  return out;
}

/** What a tool drag asks for, in normalized source coordinates. */
export interface PlacedAnnotation {
  kind: AnnotationKind;
  startSec: Seconds;
  endSec: Seconds;
  /** The dragged box, for every kind but `arrow`. */
  center?: Vec2;
  size?: Vec2;
  /** The dragged line, for `arrow`. */
  from?: Vec2;
  to?: Vec2;
  style?: Record<string, unknown>;
}

/**
 * The ops that place one annotation, or `null` when the drag produced nothing usable.
 *
 * The geometry is written as a **single `hold` key per channel**, which is §3.3's
 * *"because a span carries its own channels, an animated arrow is free rather than a
 * special case"* read the other way: a still annotation is the same primitive with
 * one key, and animating it later is `key.set` rather than a new feature.
 *
 * A degenerate box is refused rather than clamped, and for the two privacy kinds it
 * is refused *loudly* upstream as well — `readAnnotationGeometry` throws on a
 * zero-area `blur` or `mask` and the compositor refuses the frame. Writing one would
 * therefore not produce a small redaction; it would produce a recording whose preview
 * will not composite. So the check is here, where the pointer is, and the two rules
 * agree rather than one discovering the other.
 */
export function placeAnnotationOps(doc: EditDocument, placed: PlacedAnnotation): EditOp[] | null {
  const startSec = Math.max(0, Math.min(placed.startSec, placed.endSec));
  const endSec = Math.max(startSec + MIN_SPAN_SEC, Math.max(placed.startSec, placed.endSec));
  const channels: Record<string, { keys: { t: number; v: number[]; ease: { kind: 'hold' } }[] }> =
    {};

  if (placed.kind === 'arrow') {
    const from = placed.from;
    const to = placed.to;
    if (from === undefined || to === undefined) return null;
    if (!finitePair(from) || !finitePair(to)) return null;
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < MIN_EXTENT) return null;
    channels['from'] = holdPair(startSec, from);
    channels['to'] = holdPair(startSec, to);
  } else {
    const center = placed.center;
    const size = placed.size;
    if (center === undefined || size === undefined) return null;
    if (!finitePair(center) || !finitePair(size)) return null;
    if (size[0] < MIN_EXTENT || size[1] < MIN_EXTENT) return null;
    channels['center'] = holdPair(startSec, center);
    channels['size'] = holdPair(startSec, size);
  }

  const span = annotationSpan({
    id: newSpanId(doc, placed.kind),
    kind: placed.kind,
    start: startSec,
    end: endSec,
    ...(placed.style === undefined ? {} : { style: placed.style }),
    channels,
  });

  const existing = annotationTrackOf(doc);
  if (existing === null) {
    // At the end of the array, which is the top of the stack — the same place a
    // manual zoom goes, and for the same §3.5 reason. Annotations resolve on their
    // own target, so this decides nothing about the zoom; it decides that a later
    // annotation track (a re-imported drawing log, say) does not silently outrank
    // the one the user is drawing on.
    return [
      {
        op: 'track.add',
        track: annotationTrack({ id: ANNOTATION_TRACK_ID, spans: [span] }),
        at: doc.tracks.length,
      },
    ];
  }
  return [{ op: 'span.set', trackId: ANNOTATION_TRACK_ID, span }];
}

/** The ops that move or resize one annotation's geometry. `null` when nothing changed. */
export function moveAnnotationOps(
  doc: EditDocument,
  spanId: string,
  geometry: { center?: Vec2; size?: Vec2; from?: Vec2; to?: Vec2 },
): EditOp[] | null {
  const view = annotationsOf(doc).find((a) => a.span.id === spanId);
  if (view === undefined) return null;
  const channels = { ...(view.span.channels ?? {}) };
  let changed = false;
  for (const [name, value] of Object.entries(geometry)) {
    if (value === undefined || !finitePair(value)) continue;
    const at = view.span.start;
    const existing = channels[name]?.keys[0]?.v;
    if (Array.isArray(existing) && existing[0] === value[0] && existing[1] === value[1]) continue;
    channels[name] = holdPair(at, value);
    changed = true;
  }
  if (!changed) return null;
  return [{ op: 'span.set', trackId: ANNOTATION_TRACK_ID, span: { ...view.span, channels } }];
}

/**
 * The ops that move one annotation's ends in source time.
 *
 * Which fields are **present** is what says what the gesture was, and the three cases
 * behave differently on purpose:
 *
 *  - one end alone is a resize, and it stops {@link MIN_SPAN_SEC} clear of the other
 *    rather than pushing it. `moveHandle` makes the same choice for the trim handles
 *    and gives the reason: pushing is what makes a fast drag past the far end
 *    silently discard everything;
 *  - both is a move, and the span keeps its length — clamped into the recording at
 *    whichever end reaches it first, so a span dragged off the start slides rather
 *    than shrinks.
 *
 * The span's own `start` is where its channel keys are, so either way the keys move
 * with it — otherwise a span dragged later would carry keys that fall before it and
 * evaluate at their first value forever, which looks identical and is not the same
 * document.
 */
export function retimeAnnotationOps(
  doc: EditDocument,
  spanId: string,
  times: { startSec?: Seconds; endSec?: Seconds },
  sourceDurationSec: Seconds,
): EditOp[] | null {
  const view = annotationsOf(doc).find((a) => a.span.id === spanId);
  if (view === undefined) return null;
  const duration = Math.max(0, sourceDurationSec);
  let startSec: Seconds;
  let endSec: Seconds;
  if (times.startSec !== undefined && times.endSec !== undefined) {
    const length = Math.max(MIN_SPAN_SEC, view.endSec - view.startSec);
    startSec = clamp(times.startSec, 0, Math.max(0, duration - length));
    endSec = startSec + length;
  } else if (times.startSec !== undefined) {
    endSec = view.endSec;
    startSec = clamp(times.startSec, 0, endSec - MIN_SPAN_SEC);
  } else if (times.endSec !== undefined) {
    startSec = view.startSec;
    endSec = clamp(times.endSec, startSec + MIN_SPAN_SEC, duration);
  } else {
    return null;
  }
  if (!(endSec - startSec >= MIN_SPAN_SEC)) return null;
  if (startSec === view.startSec && endSec === view.endSec) return null;

  const channels: Record<string, { keys: { t: number; v: number[]; ease: { kind: 'hold' } }[] }> =
    {};
  for (const [name, channel] of Object.entries(view.span.channels ?? {})) {
    const value = channel.keys[0]?.v;
    if (!Array.isArray(value)) continue;
    channels[name] = holdPair(startSec, [value[0] ?? 0.5, value[1] ?? 0.5]);
  }
  return [
    {
      op: 'span.set',
      trackId: ANNOTATION_TRACK_ID,
      span: { ...view.span, start: startSec, end: endSec, channels },
    },
  ];
}

/** The ops that change one annotation's style keys. `null` when nothing changed. */
export function styleAnnotationOps(
  doc: EditDocument,
  spanId: string,
  patch: Record<string, unknown>,
): EditOp[] | null {
  const view = annotationsOf(doc).find((a) => a.span.id === spanId);
  if (view === undefined) return null;
  const style = { ...(view.span.style ?? {}), ...patch };
  if (JSON.stringify(style) === JSON.stringify(view.span.style ?? {})) return null;
  return [{ op: 'span.set', trackId: ANNOTATION_TRACK_ID, span: { ...view.span, style } }];
}

/**
 * The ops that delete one annotation — and the track when it was the last one.
 *
 * Same bargain as {@link removeZoomOps}: a track with an empty `spans` array is inert
 * and still a row somebody has to decide about. `inverse.ts` restores a removed track
 * at its index, so nothing is lost by removing it.
 */
export function removeAnnotationOps(doc: EditDocument, spanId: string): EditOp[] | null {
  const track = annotationTrackOf(doc);
  if (track === null) return null;
  const spans = track.spans ?? [];
  if (!spans.some((span) => span.id === spanId)) return null;
  if (spans.length === 1) return [{ op: 'track.remove', trackId: track.id }];
  return [{ op: 'span.remove', trackId: track.id, spanId }];
}

// ------------------------------------------------------- pointer → source space

/** Where the picture is drawn inside the output, and what part of the source it shows. */
export interface StageMapping {
  /** `edit.output.size`. */
  outputSize: readonly [number, number];
  /** The captured frame's size in pixels. */
  sourceSize: readonly [number, number];
  /** `resolve(...).zoom`, at the instant the pointer is on. */
  zoom: { amount: number; center: readonly [number, number] };
}

/**
 * A point on the preview, in `0..1` of the **canvas**, as a normalized **source**
 * coordinate — or `null` when it is on the letterbox rather than on the picture.
 *
 * This is `sourceToOutput` inverted, and it is written out rather than imported
 * because `@loom/compositor`'s copy maps the other way and is on the frame path. The
 * two must agree, and what makes them agree is that both are two lines of the same
 * arithmetic over `sourceSampleRect` and `contentRect` — which is also why the same
 * two rects are computed here from the same inputs rather than passed in already
 * combined.
 *
 * `null` for a point outside the picture is the honest answer: an annotation dropped
 * on the letterbox has no content to be welded to, and clamping it to the edge would
 * put a redaction somewhere the user did not point at.
 */
export function outputToSource(mapping: StageMapping, at: Vec2): Vec2 | null {
  const [outW, outH] = mapping.outputSize;
  const [srcW, srcH] = mapping.sourceSize;
  if (!(outW > 0) || !(outH > 0) || !(srcW > 0) || !(srcH > 0)) return null;

  // `sourceSampleRect`: the window of the source the zoom shows, clamped into it.
  const amount = Math.max(1, Number.isFinite(mapping.zoom.amount) ? mapping.zoom.amount : 1);
  const span = 1 / amount;
  const rx = clamp((mapping.zoom.center[0] ?? 0.5) - span / 2, 0, 1 - span);
  const ry = clamp((mapping.zoom.center[1] ?? 0.5) - span / 2, 0, 1 - span);

  // `contentRect`: contain-fit of the sampled window inside the output, centred.
  const sampledW = srcW * span;
  const sampledH = srcH * span;
  const scale = Math.min(outW / sampledW, outH / sampledH);
  const drawW = sampledW * scale;
  const drawH = sampledH * scale;
  const left = (outW - drawW) / 2;
  const top = (outH - drawH) / 2;

  const px = at[0] * outW;
  const py = at[1] * outH;
  if (px < left || px > left + drawW || py < top || py > top + drawH) return null;
  return [rx + ((px - left) / drawW) * span, ry + ((py - top) / drawH) * span];
}

/**
 * The other direction: a normalized source coordinate as `0..1` of the **canvas**.
 *
 * `@loom/compositor`'s `sourceToOutput` is the same map and is the one the *pixels*
 * go through; this one places a selection handle over them. They are written twice
 * rather than shared for the reason phase 11's golden fixture gives about its own
 * expectation box — *"sharing `sourceToOutput` would make the expectation follow the
 * defect"* — and the same argument applies to a handle: a handle computed by the code
 * under test would sit exactly on a wrongly-drawn annotation and look right.
 *
 * Unclamped on purpose. An annotation whose box runs off the zoomed viewport has
 * handles off the picture, and moving them back is how a person gets it on screen
 * again; clamping would pin the handle to the edge and make the drag fight them.
 */
export function sourceToOutput01(mapping: StageMapping, at: Vec2): Vec2 {
  const [outW, outH] = mapping.outputSize;
  const [srcW, srcH] = mapping.sourceSize;
  if (!(outW > 0) || !(outH > 0) || !(srcW > 0) || !(srcH > 0)) return [0.5, 0.5];

  const amount = Math.max(1, Number.isFinite(mapping.zoom.amount) ? mapping.zoom.amount : 1);
  const span = 1 / amount;
  const rx = clamp((mapping.zoom.center[0] ?? 0.5) - span / 2, 0, 1 - span);
  const ry = clamp((mapping.zoom.center[1] ?? 0.5) - span / 2, 0, 1 - span);

  const sampledW = srcW * span;
  const sampledH = srcH * span;
  const scale = Math.min(outW / sampledW, outH / sampledH);
  const drawW = sampledW * scale;
  const drawH = sampledH * scale;
  const left = (outW - drawW) / 2;
  const top = (outH - drawH) / 2;

  return [
    (left + ((at[0] - rx) / span) * drawW) / outW,
    (top + ((at[1] - ry) / span) * drawH) / outH,
  ];
}

/**
 * The topmost annotation covering `atSec` whose geometry contains `at` (source space).
 *
 * Topmost is **last** in the array, because array order is z-order and the last span
 * is the one drawn over the others — so a click selects what a person sees. An arrow
 * is hit against its bounding box, which is what `readAnnotationGeometry` already
 * makes of it.
 */
export function annotationAt(doc: EditDocument, atSec: Seconds, at: Vec2): AnnotationView | null {
  const covering = annotationsOf(doc).filter(
    (view) => atSec >= view.startSec && atSec <= view.endSec,
  );
  for (let i = covering.length - 1; i >= 0; i--) {
    const view = covering[i];
    if (view === undefined) continue;
    const box = boxOf(view);
    if (box === null) continue;
    if (
      at[0] >= box.cx - box.hx &&
      at[0] <= box.cx + box.hx &&
      at[1] >= box.cy - box.hy &&
      at[1] <= box.cy + box.hy
    ) {
      return view;
    }
  }
  return null;
}

/** One annotation's box in source space — the arrow's is the box its two ends bound. */
export function boxOf(
  view: AnnotationView,
): { cx: number; cy: number; hx: number; hy: number } | null {
  if (view.kind === 'arrow') {
    const from = view.from;
    const to = view.to;
    if (from === null || to === null) return null;
    return {
      cx: (from[0] + to[0]) / 2,
      cy: (from[1] + to[1]) / 2,
      // A perfectly horizontal arrow has no height, and a zero-height hit box is a
      // thing that cannot be clicked. Padded to the same floor a stroke's degenerate
      // axis is padded to, which is under a pixel at 4K.
      hx: Math.max(MIN_HIT_HALF, Math.abs(to[0] - from[0]) / 2),
      hy: Math.max(MIN_HIT_HALF, Math.abs(to[1] - from[1]) / 2),
    };
  }
  const center = view.center;
  const size = view.size;
  if (center === null || size === null) return null;
  return {
    cx: center[0],
    cy: center[1],
    hx: Math.max(MIN_HIT_HALF, size[0] / 2),
    hy: Math.max(MIN_HIT_HALF, size[1] / 2),
  };
}

/** Half-extent a hit box is padded to, so a degenerate axis is still clickable. */
const MIN_HIT_HALF = 0.006;

// ---------------------------------------------------------------- internals

/**
 * The smallest half-sensible extent a drag may produce, normalized.
 *
 * A thousandth of the frame is under a pixel at 4K. Below it a `size` is a click
 * rather than a drag, and for a privacy kind it is a span the compositor will refuse.
 */
const MIN_EXTENT = 0.001;

function holdPair(
  t: Seconds,
  value: Vec2,
): { keys: { t: number; v: number[]; ease: { kind: 'hold' } }[] } {
  return { keys: [{ t, v: [value[0], value[1]], ease: { kind: 'hold' } }] };
}

function pairOf(span: Span, channel: string): Vec2 | null {
  const value = span.channels?.[channel]?.keys[0]?.v;
  if (!Array.isArray(value) || value.length < 2) return null;
  return [value[0] ?? 0, value[1] ?? 0];
}

function finitePair(value: Vec2): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

/**
 * A span id that is not already in the document.
 *
 * Counted rather than random: `span.set` upserts by id, so a collision would silently
 * replace somebody's annotation instead of adding one, and a readable id is what makes
 * `edit.json` and `edit.journal.ndjson` diffable by a person. The counter walks past
 * ids already taken rather than trusting the count, because deleting the second of
 * three would otherwise hand the next placement an id that exists.
 */
export function newSpanId(doc: EditDocument, kind: AnnotationKind): string {
  const taken = new Set((annotationTrackOf(doc)?.spans ?? []).map((span) => span.id));
  for (let n = 1; ; n++) {
    const id = `${kind}-${String(n)}`;
    if (!taken.has(id)) return id;
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
