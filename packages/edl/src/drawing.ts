/**
 * `events/drawing.ndjson` → one **generated annotation track**. Phase 12's import.
 *
 * Architecture report §8 puts it in one line — *"strokes → `drawing.ndjson`,
 * imported at edit time as a generated annotation track"* — and §3.5 is what makes
 * that a sentence rather than a feature:
 *
 * > A **generated** cursor-follow track sits at the bottom. The user's **manual**
 * > zoom keyframes sit above it… **Regeneration rewrites only the generated track.**
 * > User edits survive by construction, because they were never in that track.
 *
 * The same three properties fall out here. The drawing track is `origin:
 * 'generated'` with a {@link GeneratorSpec} naming the log and its hash, so
 * re-importing rewrites it whole and the annotations the user drew *in the editor*
 * are untouched — they live in a different track. It stacks under or over those by
 * ordinary track order. And it is deleted by an ordinary `track.remove`, which is
 * the third of §8's phase-12 gate: *"deletable in the editor"* is not a feature
 * this file adds, it is a feature this file **declines to opt out of**.
 *
 * ## Pure, and therefore not the reader
 *
 * `@loom/edl` has no filesystem (§1.3), so this parses text it is handed. Main
 * reads the bytes; `apps/main/src/overlay.ts` writes them. {@link parseDrawingLog}
 * is deliberately tolerant of a torn last line, because §2.5's whole point is that
 * the log is appended during a recording that may be `SIGKILL`ed — a half-written
 * final stroke must cost that stroke and not the recording's ink.
 *
 * ## The two things a stroke has that a rectangle does not
 *
 * **A stroke ends when it is rubbed out, not when the pen comes up.** The overlay is
 * content-protected, so nothing the user drew is in the captured pixels; what the
 * editor re-composites is what *was on the overlay*, which is the interval from the
 * pen going down to the `erase` or `clear` that removed it — or to the end of the
 * recording. A stroke drawn at 0:04 and cleared at 0:40 is a 36-second span.
 *
 * **A stroke is revealed as it was drawn.** `progress` runs 0 → 1 linearly across
 * the stroke's own duration; `readAnnotationGeometry` reads it and the compositor
 * truncates the polyline by arc length. Without it the finished shape would appear
 * whole at the moment the pen went down.
 */

import {
  isDrawingStroke,
  type DrawingEvent,
  type DrawingStrokeEvent,
  type GeneratorSpec,
  type IsoTimestamp,
  type Keyframe,
  type Span,
  type Track,
} from '@loom/format';
import { MAX_STROKE_POINTS, MIN_STROKE_HALF_EXTENT } from './annotations.ts';
import { ALWAYS } from './tracks.ts';

/**
 * The one generated drawing track's id.
 *
 * Fixed rather than minted, because §3.5's *"regeneration rewrites only the
 * generated track"* needs a name to rewrite. A second import replaces this track;
 * it does not accumulate a second one.
 */
export const DRAWING_TRACK_ID = 'trk_drawing';

/** The prefix an imported stroke's span id carries, so its provenance is legible. */
export const DRAWING_SPAN_PREFIX = 'ann_draw_';

/**
 * The generated track's crossfade at its `activeRanges` edges.
 *
 * Shorter than a zoom's 250–300 ms: a zoom that snapped would be a jolt, where ink
 * appearing is a discrete event the viewer expects to be discrete. 80 ms takes the
 * hard edge off a parked range without making the pen feel late.
 */
export const DRAWING_BLEND_MS = 80;

/** A highlighter's ink is translucent; a pen's is not. §2.6's colours are hex. */
const HIGHLIGHTER_ALPHA = 0.35;

export interface DrawingImportOptions {
  /**
   * Where the recording ends, in **source** seconds.
   *
   * A stroke that is never rubbed out is on the overlay until the recording stops,
   * and a span needs a finite `end`. Comes from `recording.json`'s screen track.
   */
  durationSec: number;
  /**
   * `sha256:…` of the log these strokes were read from, for the generator's
   * `inputs` fingerprint (§3.5). Absent when the caller has not hashed it, which
   * costs the "regenerate" prompt rather than the import.
   */
  logHash?: string;
  generatedAt: IsoTimestamp;
  /** Track id, for a caller that is importing into a document that already has one. */
  trackId?: string;
  activeRanges?: [number, number][];
}

/**
 * Parse `events/drawing.ndjson`.
 *
 * Blank lines are skipped and unparseable ones are **dropped, not thrown on**: this
 * file is appended to live and its tail may be a fragment of a line that a crash
 * interrupted. A malformed line in the middle is the same shape of damage and gets
 * the same treatment, because there is no reading of it that is safer than ignoring
 * it — an annotation log is not a redaction.
 */
export function parseDrawingLog(ndjson: string): DrawingEvent[] {
  const out: DrawingEvent[] = [];
  for (const line of ndjson.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const event = readDrawingEvent(parsed);
    if (event !== null) out.push(event);
  }
  // Sorted rather than assumed sorted. The log is written in the order strokes
  // *ended*, so a long stroke started before a short one lands after it, and the
  // erase replay below reads events in the order they happened.
  out.sort((a, b) => a.t - b.t);
  return out;
}

function readDrawingEvent(value: unknown): DrawingEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const t = o['t'];
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  switch (o['e']) {
    case 'clear':
      return { e: 'clear', t };
    case 'erase': {
      const ids = o['ids'];
      if (!Array.isArray(ids)) return null;
      return { e: 'erase', t, ids: ids.filter((id): id is string => typeof id === 'string') };
    }
    case 'stroke': {
      const id = o['id'];
      const p = o['p'];
      const w = o['w'];
      const t1 = o['t1'];
      if (typeof id !== 'string' || id.length === 0) return null;
      if (!Array.isArray(p) || p.length < 2) return null;
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return null;
      if (typeof t1 !== 'number' || !Number.isFinite(t1) || t1 < t) return null;
      const points: number[] = [];
      for (const raw of p.slice(0, MAX_STROKE_POINTS * 2)) {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
        points.push(raw);
      }
      if (points.length < 2) return null;
      return {
        e: 'stroke',
        t,
        t1,
        id,
        tool: o['tool'] === 'highlighter' ? 'highlighter' : 'pen',
        color: typeof o['color'] === 'string' ? o['color'] : '#DC3F12',
        w,
        // An odd trailing coordinate is a torn line; the pair it belongs to is not
        // knowable, so it is dropped rather than paired with a zero.
        p: points.length % 2 === 0 ? points : points.slice(0, points.length - 1),
      };
    }
    default:
      return null;
  }
}

/**
 * The interval one stroke was on the overlay, in source seconds.
 *
 * Exported because it is the whole of what "a stroke ends when it is rubbed out"
 * means, and a test that re-derives it would be testing its own arithmetic.
 */
export function strokeEndSec(
  stroke: DrawingStrokeEvent,
  events: readonly DrawingEvent[],
  durationSec: number,
): number {
  for (const event of events) {
    if (event.t <= stroke.t) continue;
    if (event.e === 'clear') return event.t;
    if (event.e === 'erase' && event.ids.includes(stroke.id)) return event.t;
  }
  return Math.max(stroke.t, durationSec);
}

/**
 * Turn a parsed log into the one generated annotation track.
 *
 * Returns `null` when the log contains no drawable stroke. A track with no spans is
 * not the honest description of a recording nobody drew on — it is a row in the
 * editor's track list that does nothing, and `recording.json` already distinguishes
 * "no log" from "an empty log" for exactly this reason (§2.5).
 */
export function drawingTrack(
  events: readonly DrawingEvent[],
  options: DrawingImportOptions,
): Track | null {
  const spans: Span[] = [];
  for (const event of events) {
    if (!isDrawingStroke(event)) continue;
    const span = strokeSpan(event, events, options.durationSec);
    if (span !== null) spans.push(span);
  }
  if (spans.length === 0) return null;

  const generator: GeneratorSpec = {
    type: 'live-drawing',
    params: { strokeCount: spans.length },
    inputs: options.logHash === undefined ? {} : { drawing: options.logHash },
    generatedAt: options.generatedAt,
  };

  return {
    id: options.trackId ?? DRAWING_TRACK_ID,
    kind: 'object',
    target: 'annotation',
    // §3.2, and the same reading `annotationTrack` gives: ink is placed on the
    // content, so a trim carries it rather than sliding it.
    domain: 'source',
    origin: 'generated',
    generator,
    blend: 'replace',
    blendMs: DRAWING_BLEND_MS,
    activeRanges: options.activeRanges ?? ALWAYS,
    enabled: true,
    channels: {},
    spans,
  };
}

/** Read a log and build the track in one call. The path main and the editor use. */
export function importDrawingLog(ndjson: string, options: DrawingImportOptions): Track | null {
  return drawingTrack(parseDrawingLog(ndjson), options);
}

/**
 * One stroke → one `kind: 'object'` span of `type: 'stroke'`.
 *
 * The points arrive normalized against the logical display (§2.5) and leave
 * normalized against the span's own box, `-1..1`, because that is what lets
 * `center`/`size` move and scale the ink as ordinary keys rather than as a rewrite
 * of every coordinate. A degenerate axis — a perfectly straight vertical line has
 * no width — is padded to {@link MIN_STROKE_HALF_EXTENT} here, in the document,
 * rather than guarded around in the renderer.
 */
function strokeSpan(
  stroke: DrawingStrokeEvent,
  events: readonly DrawingEvent[],
  durationSec: number,
): Span | null {
  const pairs = stroke.p.length >> 1;
  if (pairs < 1) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pairs; i++) {
    const x = stroke.p[i * 2] ?? 0;
    const y = stroke.p[i * 2 + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hx = Math.max((maxX - minX) / 2, MIN_STROKE_HALF_EXTENT);
  const hy = Math.max((maxY - minY) / 2, MIN_STROKE_HALF_EXTENT);

  const points: number[] = [];
  for (let i = 0; i < pairs; i++) {
    points.push(((stroke.p[i * 2] ?? 0) - cx) / hx, ((stroke.p[i * 2 + 1] ?? 0) - cy) / hy);
  }

  const end = strokeEndSec(stroke, events, durationSec);
  if (!(end > stroke.t)) return null;

  const hold = (v: number | number[]): { keys: Keyframe[] } => ({
    keys: [{ t: stroke.t, v, ease: { kind: 'hold' } }],
  });

  return {
    id: `${DRAWING_SPAN_PREFIX}${stroke.id}`,
    start: stroke.t,
    end,
    type: 'stroke',
    style: {
      stroke: inkColor(stroke),
      fill: 'none',
      strokeWidth: stroke.w,
      points,
      tool: stroke.tool,
    },
    channels: {
      center: hold([cx, cy]),
      size: hold([hx * 2, hy * 2]),
      progress: { keys: progressKeys(stroke) },
    },
  };
}

/**
 * The reveal: 0 when the pen went down, 1 when it came up, held after.
 *
 * A stroke whose start and end are the same instant — a dot — gets one key at 1
 * rather than two keys at the same `t`, which the schema forbids and which would
 * make the whole document fail validation over a tap of the pen.
 */
function progressKeys(stroke: DrawingStrokeEvent): Keyframe[] {
  if (!(stroke.t1 > stroke.t)) return [{ t: stroke.t, v: 1, ease: { kind: 'hold' } }];
  return [
    { t: stroke.t, v: 0, ease: { kind: 'linear' } },
    { t: stroke.t1, v: 1, ease: { kind: 'hold' } },
  ];
}

/**
 * A highlighter's colour, with its translucency applied.
 *
 * The alpha is put into the document rather than inferred from `tool` by the
 * renderer, so what the editor shows is a colour the user can see and change. `tool`
 * is kept alongside it as provenance — which pen drew this — and nothing downstream
 * branches on it.
 */
function inkColor(stroke: DrawingStrokeEvent): string {
  if (stroke.tool !== 'highlighter') return stroke.color;
  const hex = stroke.color.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return stroke.color;
  const alpha = Math.round(HIGHLIGHTER_ALPHA * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${alpha}`;
}
