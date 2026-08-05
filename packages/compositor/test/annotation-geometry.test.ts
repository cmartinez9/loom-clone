/**
 * The two pure pieces of the annotation passes: where a source-anchored annotation
 * lands, and where a glyph goes.
 *
 * Both are checkable exhaustively in Node, which is the point of keeping them out of
 * the GL code — `geometry.ts` says so at the top and this is the other end of that
 * bargain. The GL that consumes them is judged by `test/phase11-golden.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { contentRect, rectToNdc, sourceSampleRect, sourceToOutput } from '../src/geometry.ts';
import {
  layoutText,
  MAX_TEXT_GLYPHS,
  type GlyphMetric,
  type TextAtlas,
} from '../src/text-atlas.ts';

const SOURCE: readonly [number, number] = [3456, 2234];

function mapFor(zoom: { amount: number; center: [number, number] }, output: [number, number]) {
  return sourceToOutput(sourceSampleRect(zoom), contentRect(SOURCE, output));
}

function point(map: ReturnType<typeof sourceToOutput>, x: number, y: number): [number, number] {
  return [map.originX + map.scaleX * x, map.originY + map.scaleY * y];
}

describe('sourceToOutput places an annotation on the pixels the screen pass drew', () => {
  it('maps the source’s corners onto the content rect at zoom 1', () => {
    const output: [number, number] = [1920, 1240];
    const content = contentRect(SOURCE, output);
    const map = mapFor({ amount: 1, center: [0.5, 0.5] }, output);
    expect(point(map, 0, 0)).toEqual([content.x, content.y]);
    const [x, y] = point(map, 1, 1);
    expect(x).toBeCloseTo(content.x + content.width, 9);
    expect(y).toBeCloseTo(content.y + content.height, 9);
  });

  it('is the exact inverse of the screen pass’s own sampling', () => {
    // The screen shader draws content-rect pixel `p` from source coordinate
    // `source.xy + unit * source.zw`. So mapping that source coordinate back must
    // land on `p` — that identity is the whole reason a blur cannot drift off the
    // thing it redacts.
    const output: [number, number] = [1600, 900];
    for (const amount of [1, 1.4, 2.5, 4]) {
      for (const centre of [
        [0.5, 0.5],
        [0.1, 0.9],
        [0.87, 0.2],
      ] as [number, number][]) {
        const zoom = { amount, center: centre };
        const source = sourceSampleRect(zoom);
        const content = contentRect(SOURCE, output);
        const map = sourceToOutput(source, content);
        for (const [u, v] of [
          [0, 0],
          [1, 0],
          [0.5, 0.5],
          [1, 1],
        ]) {
          const sx = source.x + (u ?? 0) * source.width;
          const sy = source.y + (v ?? 0) * source.height;
          const [px, py] = point(map, sx, sy);
          expect(px).toBeCloseTo(content.x + (u ?? 0) * content.width, 6);
          expect(py).toBeCloseTo(content.y + (v ?? 0) * content.height, 6);
        }
      }
    }
  });

  it('zooming magnifies an annotation with the content, not against it', () => {
    const output: [number, number] = [1920, 1240];
    const one = mapFor({ amount: 1, center: [0.5, 0.5] }, output);
    const two = mapFor({ amount: 2, center: [0.5, 0.5] }, output);
    expect(two.scaleX / one.scaleX).toBeCloseTo(2, 9);
    // The centre of the source is the centre of the output either way.
    expect(point(two, 0.5, 0.5)[0]).toBeCloseTo(point(one, 0.5, 0.5)[0], 6);
  });

  it('is affine, so a rectangle stays a rectangle at every zoom', () => {
    const map = mapFor({ amount: 3, center: [0.3, 0.7] }, [1280, 720]);
    const a = point(map, 0.2, 0.4);
    const b = point(map, 0.6, 0.4);
    const c = point(map, 0.2, 0.8);
    expect(b[1]).toBeCloseTo(a[1], 9);
    expect(c[0]).toBeCloseTo(a[0], 9);
  });

  it('a degenerate source rect maps to nothing rather than to infinity', () => {
    const map = sourceToOutput(
      { x: 0, y: 0, width: 0, height: 0 },
      contentRect(SOURCE, [100, 100]),
    );
    expect(Number.isFinite(map.scaleX)).toBe(true);
    expect(map.scaleX).toBe(0);
  });

  it('an NDC rect from the mapped pixels round-trips through rectToNdc', () => {
    const output: [number, number] = [800, 600];
    const ndc = rectToNdc({ x: 200, y: 150, width: 400, height: 300 }, output);
    expect(ndc.x).toBeCloseTo(-0.5, 9);
    expect(ndc.y).toBeCloseTo(-0.5, 9);
    expect(ndc.width).toBeCloseTo(1, 9);
    expect(ndc.height).toBeCloseTo(1, 9);
  });
});

// --------------------------------------------------------------- text layout

function glyph(advance: number, width = advance * 0.8, height = 0.7): GlyphMetric {
  return {
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    advance,
    bearingX: 0,
    bearingY: height,
    width,
    height,
  };
}

const ATLAS: TextAtlas = {
  texture: {},
  glyphs: new Map([
    ['A', glyph(0.6)],
    ['B', glyph(0.6)],
    [' ', { ...glyph(0.3), width: 0, height: 0 }],
  ]),
  lineHeight: 1.2,
  capHeight: 0.7,
  fallbackAdvance: 0.5,
};

function run(text: string, align: 'start' | 'center' | 'end' = 'center') {
  const out = new Float32Array(MAX_TEXT_GLYPHS * 24);
  const result = layoutText(text, ATLAS, { cx: 500, cy: 300, hx: 200, hy: 50 }, 100, align, out);
  return { out, result };
}

describe('layoutText', () => {
  it('centres a line on the box', () => {
    const { out, result } = run('AB');
    expect(result.vertexCount).toBe(12);
    // Two glyphs of 0.6 em at 100 px = 120 px of advance, centred on 500.
    expect(out[0]).toBeCloseTo(440, 6);
  });

  it('honours start and end alignment against the box’s own edges', () => {
    expect(run('AB', 'start').out[0]).toBeCloseTo(300, 6);
    // The last glyph's advance still ends at the right edge: 700 - 120 = 580.
    expect(run('AB', 'end').out[0]).toBeCloseTo(580, 6);
  });

  it('centres the cap height, not the baseline', () => {
    const { out } = run('A');
    // One line: baseline at cy + capPx/2 = 300 + 35; the glyph's top is one
    // bearingY (0.7 em = 70 px) above it.
    expect(out[1]).toBeCloseTo(300 + 35 - 70, 6);
  });

  it('stacks newline-separated lines around the centre', () => {
    const { out } = run('A\nB');
    const firstTop = out[1] ?? 0;
    const secondTop = out[24 + 1] ?? 0;
    expect(secondTop - firstTop).toBeCloseTo(120, 6);
    // The block straddles the centre rather than starting at it.
    expect((firstTop + secondTop) / 2 + 70 - 35).toBeCloseTo(300, 6);
  });

  it('advances past a glyph with no ink and emits no quad for it', () => {
    const { result } = run('A B');
    expect(result.vertexCount).toBe(12);
  });

  it('advances past a glyph the atlas does not have, rather than piling up', () => {
    const { out } = run('AéB', 'start');
    // A (0.6) + the fallback (0.5) = 1.1 em before B.
    expect(out[24]).toBeCloseTo(300 + 110, 6);
  });

  it('truncates rather than running off the end of the caller’s buffer', () => {
    const { result } = run('A'.repeat(MAX_TEXT_GLYPHS + 40));
    expect(result.truncated).toBe(true);
    expect(result.vertexCount).toBe(MAX_TEXT_GLYPHS * 6);
  });

  it('emits two triangles per glyph with the atlas sub-rect on their corners', () => {
    const { out } = run('A', 'start');
    const x0 = out[0] ?? 0;
    const y0 = out[1] ?? 0;
    const x1 = out[4] ?? 0;
    const y1 = out[9] ?? 0;
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
    expect([out[2], out[3]]).toEqual([0, 0]);
    // The fifth vertex is the (x1, y1) corner; its uv is the sub-rect's far corner.
    expect([out[18], out[19]]).toEqual([1, 1]);
  });
});
