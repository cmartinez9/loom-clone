/**
 * The composite's geometry.
 *
 * These are §4.5 tests. *"Zoom amount and center"* is on the **must be identical**
 * list and *"output resolution"* is on the **may differ** list, which together say
 * something precise: the sampled source rect must be a function of the state alone,
 * and the destination rect must be a function of the state and the output size. Get
 * that split wrong and preview and export diverge in a way phase 8's golden-frame
 * test will find at 24 timestamps and nobody will enjoy debugging.
 */

import { describe, expect, it } from 'vitest';
import { contentRect, MIN_ZOOM, rectToNdc, sourceSampleRect } from '../src/geometry.ts';
import { identityState } from '../src/resolved-state.ts';

const FOUR_K: readonly [number, number] = [3456, 2234];

describe('sourceSampleRect', () => {
  it('shows the whole frame at zoom 1', () => {
    expect(sourceSampleRect(identityState().zoom)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('depends on the state alone, never on the output size', () => {
    // The function's signature is the proof, but state it as a test so a future
    // "just pass the viewport in for the aspect" change fails here first.
    const zoom = { amount: 2.5, center: [0.3, 0.7] as [number, number] };
    expect(sourceSampleRect(zoom)).toEqual(sourceSampleRect({ ...zoom }));
  });

  it('keeps the source aspect, so a zoom never stretches the picture', () => {
    const rect = sourceSampleRect({ amount: 3, center: [0.5, 0.5] });
    expect(rect.width).toBeCloseTo(1 / 3, 12);
    expect(rect.height).toBeCloseTo(1 / 3, 12);
  });

  it('slides against the edge rather than sampling past it', () => {
    const topLeft = sourceSampleRect({ amount: 2, center: [0, 0] });
    expect(topLeft).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    const bottomRight = sourceSampleRect({ amount: 2, center: [1, 1] });
    expect(bottomRight.x).toBeCloseTo(0.5, 12);
    expect(bottomRight.y).toBeCloseTo(0.5, 12);
    expect(bottomRight.x + bottomRight.width).toBeCloseTo(1, 12);
    expect(bottomRight.y + bottomRight.height).toBeCloseTo(1, 12);
  });

  it('stays inside the source for every centre and every magnification', () => {
    for (let amount = 1; amount <= 8; amount += 0.25) {
      for (let cx = -0.5; cx <= 1.5; cx += 0.1) {
        for (let cy = -0.5; cy <= 1.5; cy += 0.1) {
          const rect = sourceSampleRect({ amount, center: [cx, cy] });
          expect(rect.x).toBeGreaterThanOrEqual(-1e-12);
          expect(rect.y).toBeGreaterThanOrEqual(-1e-12);
          expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-12);
          expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-12);
        }
      }
    }
  });

  it('clamps an overshooting spring rather than inverting the rect', () => {
    // Phase 7 drives `amount` from a spring, and §12.5 measured springs overshooting.
    for (const amount of [0.5, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rect = sourceSampleRect({ amount, center: [0.5, 0.5] });
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.width).toBeLessThanOrEqual(1 / MIN_ZOOM);
    }
    for (const center of [
      [Number.NaN, 0.5],
      [0.5, Number.NaN],
    ] as [number, number][]) {
      const rect = sourceSampleRect({ amount: 2, center });
      expect(Number.isFinite(rect.x)).toBe(true);
      expect(Number.isFinite(rect.y)).toBe(true);
    }
  });
});

describe('contentRect', () => {
  it('contains the source and centres the letterbox', () => {
    // A 4K panel (1.547:1) inside a 16:9 viewport: pillarboxed.
    const rect = contentRect(FOUR_K, [2560, 1440]);
    expect(rect.height).toBeCloseTo(1440, 6);
    expect(rect.width).toBeCloseTo((3456 / 2234) * 1440, 6);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.x).toBeCloseTo((2560 - rect.width) / 2, 6);
    expect(rect.x + rect.width).toBeCloseTo(2560 - rect.x, 6);
  });

  it('fills exactly when the aspects match', () => {
    expect(contentRect([1920, 1080], [1280, 720])).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it('is float-exact, so a preview and an export of different sizes stay proportional', () => {
    const preview = contentRect(FOUR_K, [1440, 930]);
    const exported = contentRect(FOUR_K, [2880, 1860]);
    expect(exported.x / preview.x || 0).toBeCloseTo(2, 9);
    expect(exported.width / preview.width).toBeCloseTo(2, 9);
    expect(exported.height / preview.height).toBeCloseTo(2, 9);
    // Rounding to whole pixels would break this at 1440p, where the fitted width is
    // 1438.66… — not an integer.
    expect(Number.isInteger(preview.width)).toBe(false);
  });

  it('returns an empty rect rather than a NaN one for a degenerate size', () => {
    expect(contentRect([0, 0], [100, 100])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(contentRect(FOUR_K, [0, 100])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('rectToNdc', () => {
  it('maps the full output to the full clip volume, flipping y once', () => {
    const ndc = rectToNdc({ x: 0, y: 0, width: 1440, height: 930 }, [1440, 930]);
    expect(ndc).toEqual({ x: -1, y: -1, width: 2, height: 2 });
  });

  it('puts the top of the picture at the top of the screen', () => {
    // A rect hugging the top of the output must land at the top of NDC (y ≈ +1).
    const ndc = rectToNdc({ x: 0, y: 0, width: 100, height: 10 }, [100, 100]);
    expect(ndc.y + ndc.height).toBeCloseTo(1, 12);
    expect(ndc.y).toBeCloseTo(0.8, 12);
  });

  it('is the inverse of the pixel rect it came from', () => {
    const output: [number, number] = [1600, 1000];
    const pixels = contentRect(FOUR_K, output);
    const ndc = rectToNdc(pixels, output);
    expect(((ndc.x + 1) / 2) * output[0]).toBeCloseTo(pixels.x, 9);
    expect((ndc.width / 2) * output[0]).toBeCloseTo(pixels.width, 9);
    expect((ndc.height / 2) * output[1]).toBeCloseTo(pixels.height, 9);
  });
});
