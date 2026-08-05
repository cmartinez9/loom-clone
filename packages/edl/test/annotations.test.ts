/**
 * What an annotation span means — the pure half of phase 11.
 *
 * Two properties carry the phase and both are asserted here rather than only in the
 * golden gate, because a gate that renders pixels cannot say *why* it went red:
 *
 *  - **Annotations are the §3.3 primitive and nothing else.** A track built by
 *    `annotationTrack` compiles and resolves through the same `compile`/`resolve`
 *    a zoom does, its window gates it exactly as §3.5 says, and a parked track has
 *    no opinion.
 *  - **The privacy kinds fail closed.** A blur whose region cannot be read throws
 *    rather than resolving to something that draws nothing, and each refusal has a
 *    control beside it showing the same input is *accepted* for a decoration.
 */

import { describe, expect, it } from 'vitest';
import type { EditDocument, Keyframe, Track } from '@loom/format';
import {
  annotationSpan,
  annotationTrack,
  AnnotationError,
  ANNOTATION_KINDS,
  compile,
  isAnnotationKind,
  isPrivacyKind,
  newAnnotationGeometry,
  parseColor,
  readAnnotationGeometry,
  readAnnotationStyle,
  resolve,
  type AnnotationKind,
  type ResolvedAnnotation,
} from '../src/index.ts';

const hold = (v: number | number[]): { keys: Keyframe[] } => ({
  keys: [{ t: 0, v, ease: { kind: 'hold' } }],
});

function documentWith(tracks: Track[], durationSec = 10): EditDocument {
  return {
    schema: 'loom.edit/1',
    revision: 1,
    output: { size: [1920, 1080], fps: 30, background: { kind: 'none' } },
    clips: [{ id: 'c1', sourceStart: 0, sourceEnd: durationSec, speed: 1 }],
    tracks,
  };
}

function boxSpan(id: string, kind: AnnotationKind, style?: Record<string, unknown>) {
  return annotationSpan({
    id,
    kind,
    start: 0,
    end: 10,
    ...(style === undefined ? {} : { style }),
    channels: { center: hold([0.4, 0.6]), size: hold([0.2, 0.1]), opacity: hold(1) },
  });
}

function resolvedAt(tracks: Track[], t: number): ResolvedAnnotation[] {
  return [...resolve(compile(documentWith(tracks)), t).annotations];
}

describe('annotations are spans in the existing model', () => {
  it('compiles and resolves through the same compile/resolve a zoom does', () => {
    const track = annotationTrack({
      id: 't-ann',
      spans: [boxSpan('a1', 'rect'), boxSpan('a2', 'ellipse')],
    });
    const annotations = resolvedAt([track], 5);
    expect(annotations.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(annotations.map((a) => a.type)).toEqual(['rect', 'ellipse']);
  });

  it('states its domain explicitly, and it is source (§3.2)', () => {
    const track = annotationTrack({ id: 't', spans: [] });
    expect(track.domain).toBe('source');
    expect(track.kind).toBe('object');
    expect(track.target).toBe('annotation');
  });

  it('resolves spans in document order, which is stacking order (§3.5)', () => {
    const first = annotationTrack({ id: 't1', spans: [boxSpan('under', 'rect')] });
    const second = annotationTrack({ id: 't2', spans: [boxSpan('over', 'rect')] });
    expect(resolvedAt([first, second], 5).map((a) => a.id)).toEqual(['under', 'over']);
    expect(resolvedAt([second, first], 5).map((a) => a.id)).toEqual(['over', 'under']);
  });

  it('animates a span through its own channels — §3.3’s "an animated arrow is free"', () => {
    const track = annotationTrack({
      id: 't',
      spans: [
        annotationSpan({
          id: 'a',
          kind: 'arrow',
          start: 0,
          end: 10,
          channels: {
            from: hold([0.2, 0.3]),
            to: {
              keys: [
                { t: 0, v: [0.2, 0.3], ease: { kind: 'linear' } },
                { t: 4, v: [0.6, 0.5], ease: { kind: 'hold' } },
              ],
            },
          },
        }),
      ],
    });
    const geometry = newAnnotationGeometry();
    const compiled = compile(documentWith([track]));
    readAnnotationGeometry(resolve(compiled, 0).annotations[0]!, 'arrow', geometry);
    expect(geometry.x1).toBeCloseTo(0.2, 10);
    readAnnotationGeometry(resolve(compiled, 2).annotations[0]!, 'arrow', geometry);
    expect(geometry.x1).toBeCloseTo(0.4, 10);
    readAnnotationGeometry(resolve(compiled, 4).annotations[0]!, 'arrow', geometry);
    expect(geometry.x1).toBeCloseTo(0.6, 10);
  });
});

describe('the track window gates an annotation, exactly as it gates a mute', () => {
  it('a parked track — enabled, empty activeRanges — has no opinion anywhere', () => {
    const track = annotationTrack({ id: 't', spans: [boxSpan('a', 'rect')], activeRanges: [] });
    expect(resolvedAt([track], 0)).toHaveLength(0);
    expect(resolvedAt([track], 5)).toHaveLength(0);
    expect(resolvedAt([track], 10)).toHaveLength(0);
  });

  it('CONTROL: the same track with a window does resolve, so the check is not vacuous', () => {
    const track = annotationTrack({
      id: 't',
      spans: [boxSpan('a', 'rect')],
      activeRanges: [[0, 1e9]],
    });
    expect(resolvedAt([track], 5)).toHaveLength(1);
  });

  it('a span outside the track’s ranges is silent even though the span covers t', () => {
    const track = annotationTrack({
      id: 't',
      spans: [boxSpan('a', 'rect')],
      activeRanges: [[6, 8]],
    });
    expect(resolvedAt([track], 5)).toHaveLength(0);
    expect(resolvedAt([track], 7)).toHaveLength(1);
  });

  it('a disabled track is dropped at compile', () => {
    const track = annotationTrack({ id: 't', spans: [boxSpan('a', 'rect')], enabled: false });
    expect(resolvedAt([track], 5)).toHaveLength(0);
  });

  it('blendMs crossfades the window into the annotation’s own opacity', () => {
    const track = annotationTrack({
      id: 't',
      spans: [boxSpan('a', 'rect')],
      activeRanges: [[2, 8]],
      blendMs: 1000,
    });
    const compiled = compile(documentWith([track]));
    const geometry = newAnnotationGeometry();

    readAnnotationGeometry(resolve(compiled, 2.5).annotations[0]!, 'rect', geometry);
    expect(geometry.opacity).toBeCloseTo(0.5, 6);
    readAnnotationGeometry(resolve(compiled, 5).annotations[0]!, 'rect', geometry);
    expect(geometry.opacity).toBeCloseTo(1, 6);
    readAnnotationGeometry(resolve(compiled, 7.75).annotations[0]!, 'rect', geometry);
    expect(geometry.opacity).toBeCloseTo(0.25, 6);
  });
});

describe('the privacy kinds fail closed', () => {
  const geometry = newAnnotationGeometry();

  it('names blur and mask, and only those', () => {
    expect(ANNOTATION_KINDS.filter(isPrivacyKind)).toEqual(['blur', 'mask']);
  });

  for (const kind of ['blur', 'mask'] as const) {
    it(`${kind}: a missing centre channel is refused, not defaulted`, () => {
      const track = annotationTrack({
        id: 't',
        spans: [
          annotationSpan({
            id: 'p',
            kind,
            start: 0,
            end: 10,
            channels: { size: hold([0.2, 0.1]) },
          }),
        ],
      });
      const annotation = resolvedAt([track], 5)[0]!;
      expect(() => {
        readAnnotationGeometry(annotation, kind, geometry);
      }).toThrow(AnnotationError);
    });

    it(`${kind}: a zero-area region is refused`, () => {
      const track = annotationTrack({
        id: 't',
        spans: [
          annotationSpan({
            id: 'p',
            kind,
            start: 0,
            end: 10,
            channels: { center: hold([0.5, 0.5]), size: hold([0, 0.1]) },
          }),
        ],
      });
      const annotation = resolvedAt([track], 5)[0]!;
      expect(() => {
        readAnnotationGeometry(annotation, kind, geometry);
      }).toThrow(/covering no area/);
    });
  }

  it('CONTROL: a decoration takes the same inputs and draws — the strictness is the kind, not the reader', () => {
    const track = annotationTrack({
      id: 't',
      spans: [
        annotationSpan({ id: 'd', kind: 'rect', start: 0, end: 10, channels: {} }),
        annotationSpan({
          id: 'e',
          kind: 'ellipse',
          start: 0,
          end: 10,
          channels: { center: hold([0.5, 0.5]), size: hold([0, 0.1]) },
        }),
      ],
    });
    const annotations = resolvedAt([track], 5);
    for (const annotation of annotations) {
      expect(() => {
        readAnnotationGeometry(annotation, annotation.type as AnnotationKind, geometry);
      }).not.toThrow();
    }
  });

  it('a blurPx that would render as identity is refused', () => {
    expect(() => readAnnotationStyle('p', 'blur', { blurPx: 0 })).toThrow(AnnotationError);
    expect(() => readAnnotationStyle('p', 'blur', { blurPx: -4 })).toThrow(AnnotationError);
    expect(() => readAnnotationStyle('p', 'blur', { blurPx: 'lots' })).not.toThrow();
  });

  it('a fully transparent mask is refused', () => {
    expect(() => readAnnotationStyle('p', 'mask', { fill: 'none' })).toThrow(AnnotationError);
    expect(() => readAnnotationStyle('p', 'mask', { fill: '#00000000' })).toThrow(AnnotationError);
    expect(() => readAnnotationStyle('p', 'mask', {})).not.toThrow();
  });

  it('CONTROL: a transparent fill is fine on a decoration', () => {
    expect(readAnnotationStyle('d', 'rect', { fill: 'none' }).fill[3]).toBe(0);
  });

  it('an authored opacity of zero is intent, not a failure — it resolves and does not throw', () => {
    const track = annotationTrack({
      id: 't',
      spans: [
        annotationSpan({
          id: 'p',
          kind: 'blur',
          start: 0,
          end: 10,
          channels: { center: hold([0.5, 0.5]), size: hold([0.2, 0.1]), opacity: hold(0) },
        }),
      ],
    });
    const annotation = resolvedAt([track], 5)[0]!;
    readAnnotationGeometry(annotation, 'blur', geometry);
    expect(geometry.opacity).toBe(0);
  });
});

describe('style reading', () => {
  it('parses the colour forms §2.6 uses, and refuses the rest', () => {
    expect(parseColor('#FF3B30')).toEqual([1, 0x3b / 255, 0x30 / 255, 1]);
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#00000080')).toEqual([0, 0, 0, 0x80 / 255]);
    expect(parseColor('none')).toEqual([0, 0, 0, 0]);
    expect(parseColor('rgb(1,2,3)')).toBeNull();
    expect(parseColor('#gg0000')).toBeNull();
    expect(parseColor(42)).toBeNull();
  });

  it('divides by 255 and does not linearise — the pipeline is display-encoded throughout', () => {
    // A linearising reader would answer 0.0508 for 0x3B, not 0.2314. The screen pass
    // uploads with UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE into a non-sRGB RGBA8
    // target, so a conversion here would put annotations a whole gamma curve away
    // from the picture they sit on.
    expect(parseColor('#FF3B30')?.[1]).toBeCloseTo(0.2314, 4);
  });

  it('gives every kind a usable default with no style at all', () => {
    for (const kind of ANNOTATION_KINDS) {
      const style = readAnnotationStyle('x', kind, null);
      expect(Number.isFinite(style.strokeWidth)).toBe(true);
      expect(style.fill[3] + style.stroke[3]).toBeGreaterThan(0);
    }
  });

  it('does not claim a type it cannot render', () => {
    expect(isAnnotationKind('mute')).toBe(false);
    expect(isAnnotationKind('scribble')).toBe(false);
    expect(isAnnotationKind('blur')).toBe(true);
  });
});
