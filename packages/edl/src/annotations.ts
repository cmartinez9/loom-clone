/**
 * Annotations — what a `kind: 'object'` span's channels and style *mean*.
 *
 * Phase 11. There is **no new primitive here**: §3.3 already says annotations are
 * `kind: 'object'` tracks with one span each, and *"because a span carries its own
 * channels, an animated arrow is free rather than a special case"*. `compile()`
 * already reduces every span to a {@link ResolvedAnnotation} and `resolve()` already
 * gates it on §3.5's window. What was missing — and all this file adds — is the
 * *reading*: which channel names each `type` uses, what its `style` keys mean, and
 * what the numbers are in.
 *
 * It lives in `@loom/edl` rather than in the compositor because §4.5 puts
 * *"annotation geometry, colour, opacity"* on the **must be identical** list. A
 * reading that lived in the renderer would be a second reading the moment the
 * exporter needed one; there is one, it is pure, and preview and export both arrive
 * at their pixels through it.
 *
 * ## The coordinate decision, and why it is not a matter of taste
 *
 * **Annotation geometry is in normalized _source_ coordinates** — the same space
 * `zoom.center` is in (`state.ts`), origin top-left, matching how a `VideoFrame` is
 * laid out and how `events/cursor.ndjson` records position (§2.5). Not output
 * coordinates.
 *
 * That follows from §3.2 — effect tracks are anchored in source time so trimming
 * does not re-time them — applied to space instead of time: an annotation is placed
 * on *content*, so it must travel with the content. The consequence that settles it
 * is the privacy one. A blur is placed over a name in the recording. If its geometry
 * were normalized against the output frame, a zoom would slide the content out from
 * under the redaction and **publish the thing the user hid**, with the blur still
 * visibly present a few centimetres away. Source-anchored, the redaction is welded
 * to the pixels it covers and the compositor maps it through the very same
 * `sourceSampleRect` the screen pass samples with.
 *
 * Scalars follow the same logic but are **isotropic fractions of the frame width**
 * (`strokeWidth`, `cornerRadius`, the arrow head): normalized source coordinates are
 * anisotropic — x over width, y over height — so a stroke expressed per-axis would
 * be thicker vertically than horizontally on any non-square frame. `size` and
 * `center` stay per-axis, which is the reading §2.6's own blur span implies with
 * `"size": [0.26, 0.05]`.
 *
 * `blurPx` is the exception and keeps its §2.6 name and unit: **source pixels**, the
 * pixels of the recording. The compositor converts to output pixels with the zoom
 * and the contain-fit scale, so the same document blurs the same *picture* at any
 * preview viewport or export resolution.
 *
 * ## Fail closed, because two of these are privacy features
 *
 * A blur that does not apply has published something the user meant to hide, and it
 * fails *silently* — the frame looks fine, it is simply not redacted. So the two
 * privacy kinds are read strictly and the decorations leniently:
 *
 *  - **`blur` and `mask`**: a missing, non-finite or degenerate `center`/`size`
 *    throws {@link AnnotationError}. The compositor has no defensible fallback when
 *    it does not know *where* to redact, and a frame that cannot be redacted must
 *    not be composited.
 *  - **everything else**: a missing channel takes a documented default. A decoration
 *    that renders in the wrong place is a cosmetic bug; nothing leaks.
 *
 * The other half of failing closed is not here but in the compositor: when the
 * geometry *is* known and the blur pass cannot run, the region is filled opaque
 * rather than left clear. See `packages/compositor/src/annotations.ts`.
 */

import type { ResolvedAnnotation } from './state.ts';

/** The six annotation families phase 11 ships; `mask` is `blur`'s hard sibling. */
export const ANNOTATION_KINDS = [
  'arrow',
  'rect',
  'ellipse',
  'text',
  'highlight',
  'blur',
  'mask',
] as const;

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

const KINDS = new Set<string>(ANNOTATION_KINDS);

/**
 * Whether this build renders `type`.
 *
 * An unrecognised type is ignored rather than refused, for the reason
 * `compile.ts` ignores an unrecognised `target`: a newer build's annotation must not
 * make a recording unopenable, and §2.7 refuses unknown *schemas*, not unknown
 * values. `mute` reaches here too — an audio track's spans and an annotation
 * track's are the same shape — and is not one of ours.
 */
export function isAnnotationKind(type: string): type is AnnotationKind {
  return KINDS.has(type);
}

/**
 * The two kinds whose failure mode is a disclosure rather than a wrong picture.
 *
 * Everything that treats blur and mask differently from the other four asks this
 * rather than testing the strings, so there is one place to add a third.
 */
export function isPrivacyKind(kind: AnnotationKind): boolean {
  return kind === 'blur' || kind === 'mask';
}

/** A refusal to render an annotation, rather than rendering it wrongly. */
export class AnnotationError extends Error {
  override readonly name = 'AnnotationError';
  readonly annotationId: string;
  constructor(annotationId: string, message: string) {
    super(`annotation ${JSON.stringify(annotationId)}: ${message}`);
    this.annotationId = annotationId;
  }
}

/**
 * RGBA in the render target's own encoding, components `0..1`.
 *
 * Not linear light. The screen pass uploads a `VideoFrame` with
 * `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` into an RGBA8 target that is not
 * sRGB-typed, so every value in the pipeline is display-encoded from end to end.
 * `#FF3B30` therefore becomes `[1, 0.231, 0.188]` by dividing by 255 and nothing
 * else — the moment a conversion appeared on one side of §4.5 and not the other,
 * preview and export would differ by a gamma curve.
 */
export type Rgba = [number, number, number, number];

/** Text alignment inside the span's box. */
export type TextAlign = 'start' | 'center' | 'end';

/**
 * The style keys, read once per compile.
 *
 * `Span.style` is `Record<string, unknown>` on disk (§3.3) and stays that way; this
 * is the typed reading of it, with every default stated. Parsing happens once
 * because `CompiledSpan.resolved.style` is the same object for the life of a
 * compile — the compositor caches on its identity — so nothing here is on the frame
 * budget.
 */
export interface AnnotationStyle {
  fill: Rgba;
  stroke: Rgba;
  /** Fraction of the frame width. §2.6's arrow uses `0.004` — about 14 px at 3456. */
  strokeWidth: number;
  /** Rect corner radius, fraction of the frame width. */
  cornerRadius: number;
  /** Arrow head length along the shaft, fraction of the frame width. */
  headLength: number;
  /** Arrow head width across the shaft, fraction of the frame width. */
  headWidth: number;
  /** §2.6's `blurPx`, in **source** pixels. */
  blurPx: number;
  /** Softness of a privacy region's edge, in normalized source units. */
  feather: number;
  /** The string a `text` span draws. */
  text: string;
  /** Cap height as a fraction of the frame **height**. */
  fontSizeY: number;
  align: TextAlign;
}

const TRANSPARENT: Rgba = [0, 0, 0, 0];

/** §2.6's arrow colour, and the one every default below is built around. */
const DEFAULT_STROKE: Rgba = [1, 0x3b / 255, 0x30 / 255, 1];

/**
 * Defaults, per kind.
 *
 * Stated as data rather than as branches so that "what does a rect with an empty
 * style look like" has one answer and it is readable.
 */
const DEFAULTS: Record<AnnotationKind, Partial<AnnotationStyle>> = {
  arrow: { stroke: DEFAULT_STROKE, fill: DEFAULT_STROKE, strokeWidth: 0.004 },
  rect: { stroke: DEFAULT_STROKE, fill: TRANSPARENT, strokeWidth: 0.004, cornerRadius: 0 },
  ellipse: { stroke: DEFAULT_STROKE, fill: TRANSPARENT, strokeWidth: 0.004 },
  // A highlighter is a fill and no outline: the marker over the word, not a box
  // around it. Yellow at 35% is what that reads as over both light and dark content.
  highlight: { stroke: TRANSPARENT, fill: [1, 0xd6 / 255, 0x0a / 255, 0.35], strokeWidth: 0 },
  text: { fill: DEFAULT_STROKE, stroke: TRANSPARENT, strokeWidth: 0, fontSizeY: 0.05 },
  // Black, opaque, no outline. A mask is the answer to "make this unreadable"; a
  // translucent one is not an answer.
  mask: { fill: [0, 0, 0, 1], stroke: TRANSPARENT, strokeWidth: 0 },
  blur: { fill: [0, 0, 0, 1], stroke: TRANSPARENT, strokeWidth: 0, blurPx: 24, feather: 0.01 },
};

const BASE: AnnotationStyle = {
  fill: TRANSPARENT,
  stroke: DEFAULT_STROKE,
  strokeWidth: 0.004,
  cornerRadius: 0,
  headLength: 0.03,
  headWidth: 0.022,
  blurPx: 24,
  feather: 0.01,
  text: '',
  fontSizeY: 0.05,
  align: 'center',
};

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * `#rgb`, `#rrggbb`, `#rrggbbaa` or `none` → {@link Rgba}, or `null` when it is not
 * a colour this understands.
 *
 * Deliberately not a CSS colour parser: `edit.json` is written by this app, the
 * §2.6 reference document uses `#FF3B30` and `"none"`, and a parser that accepts
 * `color(display-p3 …)` would have to answer what that means in the target's
 * encoding — a question §4.5 does not let two implementations answer differently.
 */
export function parseColor(input: unknown): Rgba | null {
  if (Array.isArray(input)) {
    if (input.length < 3) return null;
    const out: Rgba = [0, 0, 0, 1];
    for (let i = 0; i < 4; i++) {
      const raw: unknown = input[i];
      if (i === 3 && raw === undefined) break;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
      out[i] = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    }
    return out;
  }
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (text === 'none' || text === 'transparent') return [0, 0, 0, 0];
  if (!text.startsWith('#')) return null;
  const hex = text.slice(1);
  const wide = hex.length === 3 || hex.length === 4;
  if (!wide && hex.length !== 6 && hex.length !== 8) return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const step = wide ? 1 : 2;
  const read = (index: number): number => {
    const at = index * step;
    if (at >= hex.length) return 1;
    const part = hex.slice(at, at + step);
    const value = Number.parseInt(wide ? part + part : part, 16);
    return value / 255;
  };
  return [read(0), read(1), read(2), read(3)];
}

function readNumber(style: Record<string, unknown>, key: string, fallback: number): number {
  const raw = style[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return raw;
}

function readColor(style: Record<string, unknown>, key: string, fallback: Rgba): Rgba {
  const parsed = parseColor(style[key]);
  return parsed ?? fallback;
}

/**
 * The typed reading of one span's `style`. Called once per compile, never per frame.
 *
 * A privacy kind refuses a `blurPx` or `feather` it cannot use rather than falling
 * back to the default: a document that says `"blurPx": 0` is asking for a redaction
 * that renders as identity, and the whole point of the strict branch is that we do
 * not quietly do that.
 */
export function readAnnotationStyle(
  id: string,
  kind: AnnotationKind,
  style: Record<string, unknown> | null,
): AnnotationStyle {
  const defaults = { ...BASE, ...DEFAULTS[kind] };
  const s = style ?? {};
  const out: AnnotationStyle = {
    fill: readColor(s, 'fill', defaults.fill),
    stroke: readColor(s, 'stroke', defaults.stroke),
    strokeWidth: Math.max(0, readNumber(s, 'strokeWidth', defaults.strokeWidth)),
    cornerRadius: Math.max(0, readNumber(s, 'cornerRadius', defaults.cornerRadius)),
    headLength: Math.max(0, readNumber(s, 'headLength', defaults.headLength)),
    headWidth: Math.max(0, readNumber(s, 'headWidth', defaults.headWidth)),
    blurPx: readNumber(s, 'blurPx', defaults.blurPx),
    feather: Math.max(0, readNumber(s, 'feather', defaults.feather)),
    text: typeof s['text'] === 'string' ? s['text'] : defaults.text,
    fontSizeY: Math.max(0, readNumber(s, 'fontSizeY', defaults.fontSizeY)),
    align:
      s['align'] === 'start' || s['align'] === 'center' || s['align'] === 'end'
        ? s['align']
        : defaults.align,
  };

  if (kind === 'blur') {
    if (!isFinitePositive(out.blurPx)) {
      throw new AnnotationError(
        id,
        `blur has blurPx ${JSON.stringify(s['blurPx'])}; a redaction that renders as ` +
          'identity is refused rather than composited',
      );
    }
    if (!Number.isFinite(out.feather)) {
      throw new AnnotationError(id, 'blur has a non-finite feather');
    }
  }
  if (kind === 'mask' && out.fill[3] <= 0) {
    throw new AnnotationError(
      id,
      'mask has a fully transparent fill; a redaction that renders as identity is ' +
        'refused rather than composited',
    );
  }
  return out;
}

/**
 * One span's geometry at one instant, in normalized source coordinates.
 *
 * Every kind fills every field — `cx/cy/hx/hy` are the box, `x0y0`/`x1y1` the arrow's
 * endpoints, and an arrow's box is the bounding box of its two ends — so the
 * compositor's per-kind branches read numbers rather than ask which are valid.
 *
 * Written into a caller-owned record. §3.6's *"no allocation"* is not a property of
 * `resolve` alone; anything on the frame path keeps it.
 */
export interface AnnotationGeometry {
  /** Box centre, normalized source, origin top-left. */
  cx: number;
  cy: number;
  /** Box half-extent, normalized source. Never negative. */
  hx: number;
  hy: number;
  /** Arrow tail. */
  x0: number;
  y0: number;
  /** Arrow tip. */
  x1: number;
  y1: number;
  /**
   * The span's own `opacity` channel **times the owning track's window weight**.
   *
   * The multiplication is here rather than in the compositor because §3.5's window
   * is the track's opinion and a parked track has none — the same rule the mute
   * fix restored for audio spans. `resolve` already skips a layer whose weight is
   * zero; this carries the *crossfade* through to the pixels so the edge of an
   * `activeRange` fades an annotation out instead of cutting it.
   */
  opacity: number;
}

/** A geometry record to be overwritten. One per span, allocated at wiring time. */
export function newAnnotationGeometry(): AnnotationGeometry {
  return { cx: 0.5, cy: 0.5, hx: 0, hy: 0, x0: 0, y0: 0, x1: 0, y1: 0, opacity: 0 };
}

function component(values: ReadonlyMap<string, Float64Array>, name: string, at: number): number {
  const array = values.get(name);
  if (array === undefined || at >= array.length) return Number.NaN;
  return array[at] ?? Number.NaN;
}

function or(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Read one resolved span into `out`. The hot path: no allocation, no strings.
 *
 * Throws {@link AnnotationError} for a privacy kind whose region is unknown or
 * degenerate — see the module comment. For every other kind a missing channel takes
 * its default and the span still draws.
 */
export function readAnnotationGeometry(
  annotation: ResolvedAnnotation,
  kind: AnnotationKind,
  out: AnnotationGeometry,
): void {
  const values = annotation.values;
  const opacity = or(component(values, 'opacity', 0), 1);
  out.opacity = Math.max(0, Math.min(1, opacity)) * annotation.weight;

  if (kind === 'arrow') {
    out.x0 = or(component(values, 'from', 0), 0.25);
    out.y0 = or(component(values, 'from', 1), 0.5);
    out.x1 = or(component(values, 'to', 0), 0.75);
    out.y1 = or(component(values, 'to', 1), 0.5);
    out.cx = (out.x0 + out.x1) / 2;
    out.cy = (out.y0 + out.y1) / 2;
    out.hx = Math.abs(out.x1 - out.x0) / 2;
    out.hy = Math.abs(out.y1 - out.y0) / 2;
    return;
  }

  const cx = component(values, 'center', 0);
  const cy = component(values, 'center', 1);
  const w = component(values, 'size', 0);
  const h = component(values, 'size', 1);

  if (isPrivacyKind(kind)) {
    // The strict branch. `resolve` has already evaluated the channels, so a NaN
    // here means the document did not carry the channel at all, or carried one
    // whose value is not a number — either way the region is unknown and there is
    // nothing safe to draw.
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      throw new AnnotationError(
        annotation.id,
        `${kind} has no usable \`center\` channel; a redaction with an unknown region ` +
          'is refused rather than composited',
      );
    }
    if (!isFinitePositive(w) || !isFinitePositive(h)) {
      throw new AnnotationError(
        annotation.id,
        `${kind} has \`size\` [${String(w)}, ${String(h)}]; a redaction covering no area ` +
          'is refused rather than composited',
      );
    }
  }

  out.cx = or(cx, 0.5);
  out.cy = or(cy, 0.5);
  out.hx = Math.max(0, or(w, 0.2)) / 2;
  out.hy = Math.max(0, or(h, 0.1)) / 2;
  out.x0 = out.cx - out.hx;
  out.y0 = out.cy - out.hy;
  out.x1 = out.cx + out.hx;
  out.y1 = out.cy + out.hy;
}
