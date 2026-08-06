/**
 * The §6.6 measurement itself — including the one agreement it cannot import.
 *
 * `budget.ts` measures the pan on the *visible* centre, which is
 * `sourceSampleRect`'s clamp restated. `compositor` depends on `edl`, so `edl` cannot
 * import it back; this test can, and does, so the restatement is pinned by an assertion
 * rather than by a comment. §4.5 is why it matters: preview and export must agree on
 * that rect, and a comfort budget measured against a different one would be measuring a
 * camera the product does not have.
 */

import { describe, expect, it } from 'vitest';
import { sourceSampleRect } from '@loom/compositor';
import type { Track } from '@loom/format';
import {
  emptySeasicknessReport,
  framingTrack,
  measureSeasickness,
  measurementDocument,
  seasicknessPenalty,
  visibleCentre,
  SEASICKNESS_BUDGET,
  type SeasicknessReport,
} from '../src/generators/budget.ts';
import { ALWAYS } from '../src/tracks.ts';

function centreOnlyTrack(keys: [number, number, number][], amount: number): Track[] {
  return [
    framingTrack(amount),
    {
      id: 't-under-test',
      kind: 'transform',
      target: 'zoom',
      domain: 'source',
      origin: 'generated',
      blend: 'replace',
      blendMs: 0,
      activeRanges: ALWAYS,
      enabled: true,
      channels: {
        center: {
          keys: keys.map(([t, x, y]) => ({ t, v: [x, y], ease: { kind: 'linear' as const } })),
        },
      },
    },
  ];
}

describe('visibleCentre agrees with the compositor’s sourceSampleRect', () => {
  it('is the centre of the rect the compositor would sample, at every amount', () => {
    for (const amount of [1, 1.0001, 1.2, 1.5, 2, 2.5, 4, 8]) {
      // Including the non-finite centres: `sourceSampleRect` answers `low` for one, and
      // a `visibleCentre` that let a NaN through would make every §6.6 inequality false
      // and report `pass` on a camera it could not measure.
      for (const centre of [
        -1,
        0,
        0.05,
        0.2,
        0.5,
        0.8,
        0.95,
        1,
        2,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        const rect = sourceSampleRect({ amount, center: [centre, centre] });
        const expectedX = rect.x + rect.width / 2;
        const expectedY = rect.y + rect.height / 2;
        expect(visibleCentre(centre, amount), `amount ${amount} centre ${centre}`).toBeCloseTo(
          expectedX,
          12,
        );
        expect(visibleCentre(centre, amount)).toBeCloseTo(expectedY, 12);
      }
    }
  });

  it('never hands back a value that is not a number', () => {
    for (const amount of [1, 2, 2.5, Number.NaN]) {
      for (const centre of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(Number.isFinite(visibleCentre(centre, amount)), `${centre} at ${amount}`).toBe(true);
      }
    }
  });

  it('pins every centre to 0.5 at amount 1, where the whole frame is shown', () => {
    expect(visibleCentre(0.1, 1)).toBe(0.5);
    expect(visibleCentre(0.9, 1)).toBe(0.5);
    expect(visibleCentre(0.9, 0.5)).toBe(0.5);
  });
});

describe('the measurement', () => {
  it('reads zero for a still camera', () => {
    const report = measureSeasickness(
      measurementDocument(
        centreOnlyTrack(
          [
            [0, 0.4, 0.6],
            [10, 0.4, 0.6],
          ],
          2,
        ),
        10,
      ),
      { cursorTravelUv: 1 },
    );
    expect(report.panSpeedUvPerSec).toBeCloseTo(0, 9);
    expect(report.panAccelUvPerSec2).toBeCloseTo(0, 9);
    expect(report.cameraTravelUv).toBeCloseTo(0, 9);
    expect(report.pass).toBe(true);
  });

  it('measures a constant pan at its actual speed', () => {
    const report = measureSeasickness(
      measurementDocument(
        centreOnlyTrack(
          [
            [0, 0.3, 0.5],
            [10, 0.7, 0.5],
          ],
          2,
        ),
        10,
      ),
      { cursorTravelUv: 1 },
    );
    expect(report.panSpeedUvPerSec).toBeCloseTo(0.04, 4);
    expect(report.cameraTravelUv).toBeCloseTo(0.4, 3);
    expect(report.travelRatio).toBeCloseTo(0.4, 3);
  });

  it('fails each assertion on its own', () => {
    const fast = measureSeasickness(
      measurementDocument(
        centreOnlyTrack(
          [
            [0, 0.25, 0.5],
            [0.5, 0.75, 0.5],
            [10, 0.75, 0.5],
          ],
          2,
        ),
        10,
      ),
      { cursorTravelUv: 100 },
    );
    expect(fast.failures).toContain('panSpeed');
    expect(fast.failures).toContain('panAccel');

    const wandering = measureSeasickness(
      measurementDocument(
        centreOnlyTrack(
          Array.from({ length: 200 }, (_, i): [number, number, number] => [
            i * 0.5,
            i % 2 === 0 ? 0.3 : 0.7,
            0.5,
          ]),
          2,
        ),
        100,
      ),
      { cursorTravelUv: 1 },
    );
    expect(wandering.failures).toContain('travelRatio');
  });

  it('measures nothing when there is no `amount` in the document', () => {
    // A `center`-only track alone: every centre resolves to 0.5 and the camera cannot
    // be measured at all. This is why `measureTrack` puts a framing track underneath.
    const report = measureSeasickness(
      measurementDocument(
        centreOnlyTrack(
          [
            [0, 0.25, 0.5],
            [1, 0.75, 0.5],
          ],
          1,
        ),
        10,
      ),
      { cursorTravelUv: 1 },
    );
    expect(report.cameraTravelUv).toBeCloseTo(0, 9);
    expect(report.rawCentreTravelUv).toBeGreaterThan(0.4);
  });

  it('a span too short to take a derivative over is an empty report, not a throw', () => {
    const report = measureSeasickness(measurementDocument([], 0.001), { cursorTravelUv: 1 });
    expect(report.pass).toBe(true);
    expect(report.sampleCount).toBe(0);
    expect(report.cursorTravelUv).toBe(1);
  });

  it('a still cursor makes the ratio vacuous rather than infinite', () => {
    const report = measureSeasickness(
      measurementDocument(
        centreOnlyTrack(
          [
            [0, 0.4, 0.5],
            [10, 0.45, 0.5],
          ],
          2,
        ),
        10,
      ),
      { cursorTravelUv: 0 },
    );
    expect(Number.isFinite(report.travelRatio)).toBe(true);
    expect(report.failures).not.toContain('travelRatio');
  });
});

describe('the ordering §6.6 picks “the best attempt” by', () => {
  const report = (over: Partial<SeasicknessReport>): SeasicknessReport => ({
    ...emptySeasicknessReport(),
    ...over,
  });

  it('prefers fewer failures over a smaller overshoot', () => {
    const oneBadly = report({ failures: ['panSpeed'], panSpeedUvPerSec: 10 });
    const twoBarely = report({
      failures: ['panSpeed', 'panAccel'],
      panSpeedUvPerSec: SEASICKNESS_BUDGET.panSpeedUvPerSec * 1.01,
      panAccelUvPerSec2: SEASICKNESS_BUDGET.panAccelUvPerSec2 * 1.01,
    });
    expect(seasicknessPenalty(oneBadly)).toBeLessThan(seasicknessPenalty(twoBarely));
  });

  it('prefers the smaller overshoot among equal failure counts', () => {
    const near = report({ failures: ['panSpeed'], panSpeedUvPerSec: 0.4 });
    const far = report({ failures: ['panSpeed'], panSpeedUvPerSec: 4 });
    expect(seasicknessPenalty(near)).toBeLessThan(seasicknessPenalty(far));
  });

  it('always prefers a pass', () => {
    const passing = report({ panSpeedUvPerSec: SEASICKNESS_BUDGET.panSpeedUvPerSec });
    const failing = report({
      failures: ['panAccel'],
      panAccelUvPerSec2: SEASICKNESS_BUDGET.panAccelUvPerSec2 * 1.0001,
    });
    expect(seasicknessPenalty(passing)).toBeLessThan(seasicknessPenalty(failing));
  });
});
