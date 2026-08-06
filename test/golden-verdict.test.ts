/**
 * The fence around the phase 8 gate's third outcome.
 *
 * `test/export-golden/verdict.ts` lets the golden-frame gate report **no verdict** when
 * every launch had its GPU context taken away before it compared anything. That is a
 * branch on which an acceptance gate does not go red, so it needs the same scrutiny as
 * the relaunch beside it: `test/relaunch-policy.test.ts` enumerates the ways a run can
 * be bad and requires that none of them earns a second launch, and this file enumerates
 * the ways a run can carry a **finding** and requires that none of them earns a withheld
 * verdict.
 *
 * The one that matters most is the last kind: a run whose pixels disagree must be judged
 * and must fail, whatever else went wrong afterwards. A gate that can be talked out of
 * failing is not a gate.
 *
 * Cheap, and runs in Node; the gate it guards costs a real Electron launch, a real H.264
 * encode and a real export.
 */

import { describe, expect, it } from 'vitest';
import {
  instrumentOutOfCalibration,
  MIN_LOST_LAUNCHES,
  readingsTaken,
} from './export-golden/verdict.ts';
import { COVERAGE_PROBE_NOT_REACHED } from './export-golden/report.ts';
import type { GoldenReport } from './export-golden/report.ts';

/** A finished export that passed §7.5's five checks. */
const CLEAN_EXPORT: NonNullable<GoldenReport['exported']> = {
  bytes: 117_568,
  durationSec: 5.6,
  expectedDurationSec: 5.6,
  videoSampleCount: 168,
  audioSampleCount: 0,
  verified: {
    exists: true,
    bytes: 117_568,
    durationSec: 5.6,
    lastFrameDecodable: true,
    sha256: 'a'.repeat(64),
  },
  verificationFailure: null,
  decodedFrames: [{ index: 0, atSec: 0, expectedFrame: 0, observedFrame: 0 }],
};

function samplesWithWorstDelta(maxDelta: number): GoldenReport['samples'] {
  return Array.from({ length: 24 }, (_unused, i) => ({
    index: i,
    atSec: i / 30,
    maxDelta: i === 7 ? maxDelta : 0,
    atByte: 0,
    differingBytes: maxDelta === 0 ? 0 : 4096,
    zoomAmount: 1 + i / 24,
    drawn: true,
  }));
}

/**
 * A run that completed and compared everything. `overrides` spoils exactly one thing.
 *
 * Deliberately a second copy of `test/relaunch-policy.test.ts`'s builder rather than an
 * import of it: these two files fence two different decisions, and a shared fixture is a
 * fixture a change made for one fence silently applies to the other.
 */
function completed(overrides: Partial<GoldenReport> = {}): GoldenReport {
  return {
    ok: true,
    contextLost: false,
    coverage: {
      exercised: ['frame selection', 'zoom state'],
      notExercised: [
        { row: 'the webcam bubble', why: 'no webcam pass on main' },
        { row: 'the cursor', why: 'no cursor pass on main' },
      ],
      tripwire: {
        webcamPassStillAbsent: true,
        cursorPassStillAbsent: true,
        detail: 'webcam: no webcam pass yet | cursor: cursor compositing lands',
      },
    },
    environment: {
      glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer)',
      electron: '',
      chrome: '',
      hardwareEncode: 'prefer-hardware',
    },
    fixture: { width: 1024, height: 576, frameCount: 90, durationSec: 5.57, longestHoldSec: 0.5 },
    outputSize: [768, 432],
    fps: 30,
    samples: samplesWithWorstDelta(0),
    identityMaxDelta: 0,
    controls: [
      { name: 'clock-skew', what: '', maxDelta: 255, differingSamples: 19 },
      { name: 'frame-selection', what: '', maxDelta: 255, differingSamples: 14 },
    ],
    liveFramesAtEnd: 0,
    exported: CLEAN_EXPORT,
    cancelLeftBehind: [],
    gpuProcessGone: null,
    logs: [],
    ...overrides,
  };
}

/**
 * The report both failure paths actually write — `harness.ts`'s catch-all and
 * `main.ts`'s `failureReport` — with the GPU exit main watched.
 *
 * Every field that could carry a reading is at the sentinel those two write there:
 * `-1` for a number, `null` for an object, `[]` for a list. This is the shape CI
 * produced on run 31094399329, and the only shape a verdict may be withheld over.
 */
function tookNoReading(overrides: Partial<GoldenReport> = {}): GoldenReport {
  return {
    ok: false,
    error:
      'the WebGL context was lost while compositing output frame 15; the export is ' +
      'refused rather than encoding frames nothing drew (architecture report §10.2).',
    contextLost: true,
    gpuProcessGone: 'GPU process gone: abnormal-exit (exit 8704)',
    coverage: {
      exercised: [],
      notExercised: [],
      tripwire: {
        webcamPassStillAbsent: false,
        cursorPassStillAbsent: false,
        detail: COVERAGE_PROBE_NOT_REACHED,
      },
    },
    environment: { glRenderer: '', electron: '', chrome: '', hardwareEncode: '' },
    fixture: { width: 0, height: 0, frameCount: 0, durationSec: 0, longestHoldSec: 0 },
    outputSize: [0, 0],
    fps: 0,
    samples: [],
    identityMaxDelta: -1,
    controls: [],
    liveFramesAtEnd: -1,
    exported: null,
    cancelLeftBehind: null,
    logs: [],
    ...overrides,
  };
}

describe('a verdict is withheld only where nothing was measured', () => {
  it('withholds when every launch lost the context and read nothing', () => {
    // CI run 31094399329, both launches. `samples n=0`, `identity max delta=-1`,
    // `export did not run` — §4.5's per-pixel zero was neither met nor missed.
    expect(instrumentOutOfCalibration([tookNoReading(), tookNoReading()])).toBe(true);
  });

  it('does not withhold a single lost launch', () => {
    // One loss is a shared host having a moment, and it is what the relaunch absorbs.
    expect(instrumentOutOfCalibration([tookNoReading()])).toBe(false);
    expect(MIN_LOST_LAUNCHES).toBe(2);
  });

  it('does not withhold when there were no launches at all', () => {
    expect(instrumentOutOfCalibration([])).toBe(false);
  });

  it('does not withhold when a later launch got a reading', () => {
    // The ordinary good outcome of the relaunch: lost once, then compared.
    expect(instrumentOutOfCalibration([tookNoReading(), completed()])).toBe(false);
  });

  it('does not withhold when a run failed without losing the context', () => {
    // A harness that died for any other reason produced no reading either — and that
    // is a failure of this gate's own apparatus, which must go red rather than quiet.
    // `contextLost` is the only mechanism this branch will absorb.
    const crashed = tookNoReading({
      contextLost: false,
      gpuProcessGone: null,
      error: 'the gate did not finish within 480000ms',
    });
    expect(instrumentOutOfCalibration([crashed, crashed])).toBe(false);
  });

  it('does not withhold when only one of the launches lost the context', () => {
    const crashed = tookNoReading({ contextLost: false, gpuProcessGone: null });
    expect(instrumentOutOfCalibration([tookNoReading(), crashed])).toBe(false);
    expect(instrumentOutOfCalibration([crashed, tookNoReading()])).toBe(false);
  });
});

/**
 * The counter-cases, and the reason this branch is allowed to run before the gate's
 * assertions rather than after them.
 *
 * Phase 6's withheld verdict is safe by *ordering* — its `skip()` is the last statement
 * in the test, so everything else has already been asserted. This gate cannot do that: a
 * lost context empties the report and every assertion would fail on the absence. So the
 * safety is the predicate's, and this is where it is required: a report carrying **any**
 * reading is judged, not withheld, however the run ended.
 */
describe('a run that measured something is judged, never withheld', () => {
  it.each([
    [
      'a pixel disagreement — the finding this gate exists for',
      { samples: samplesWithWorstDelta(255) },
    ],
    ['agreeing pixels', { samples: samplesWithWorstDelta(0) }],
    ['the identity control', { identityMaxDelta: 0 }],
    ['a broken identity control', { identityMaxDelta: 12 }],
    [
      'a divergence control that saw nothing',
      { controls: [{ name: 'clock-skew', what: '', maxDelta: 0, differingSamples: 0 }] },
    ],
    ['a leaked VideoFrame (§10.2)', { liveFramesAtEnd: 3 }],
    ['a clean live-frame count', { liveFramesAtEnd: 0 }],
    ['an exported file', { exported: CLEAN_EXPORT }],
    [
      'an exported file that failed §7.5',
      { exported: { ...CLEAN_EXPORT, verificationFailure: 'the last frame did not decode' } },
    ],
    ['a cancellation probe that found leftovers', { cancelLeftBehind: ['Cancelled.mp4.partial'] }],
    ['a clean cancellation probe', { cancelLeftBehind: [] }],
    [
      'a coverage tripwire that fired',
      {
        coverage: {
          exercised: [],
          notExercised: [],
          tripwire: {
            webcamPassStillAbsent: false,
            cursorPassStillAbsent: true,
            detail: 'webcam: render() accepted it',
          },
        },
      },
    ],
    ['a harness that reported success', { ok: true }],
  ] satisfies [string, Partial<GoldenReport>][])(
    'does not withhold a lost-context run carrying %s',
    (_label, overrides) => {
      // Both launches lost the context — and both carry this reading anyway. The
      // reading is what decides: `instrumentOutOfCalibration` refuses, the gate judges
      // the run, and a finding in it fails there.
      const carrying = tookNoReading(overrides);
      expect(readingsTaken(carrying).length).toBeGreaterThan(0);
      expect(instrumentOutOfCalibration([carrying, carrying])).toBe(false);
      // And it is enough for *one* of the launches to have read something.
      expect(instrumentOutOfCalibration([tookNoReading(), carrying])).toBe(false);
      expect(instrumentOutOfCalibration([carrying, tookNoReading()])).toBe(false);
    },
  );

  it('is not withheld for a healthy run whose pixels disagree', () => {
    // The case the whole change has to survive: the context never went, the comparison
    // happened, and it came out non-zero. Nothing here is withheld, so the gate reaches
    // its `expect(sample.maxDelta).toBe(0)` and fails on it.
    const diverged = completed({ samples: samplesWithWorstDelta(255) });
    expect(instrumentOutOfCalibration([diverged])).toBe(false);
    expect(instrumentOutOfCalibration([diverged, diverged])).toBe(false);
  });

  it('is not withheld for a healthy run whose pixels agree', () => {
    expect(instrumentOutOfCalibration([completed()])).toBe(false);
  });
});

describe('readingsTaken enumerates what a report carries', () => {
  it('finds nothing in the report a lost context leaves behind', () => {
    // Field by field, and this is the whole list being empty rather than `ok === false`
    // standing in for it — `mayDeleteSources`'s discipline, applied to a verdict
    // instead of to a deletion.
    expect(readingsTaken(tookNoReading())).toEqual([]);
  });

  it('finds every reading in a completed run', () => {
    const found = readingsTaken(completed()).join('\n');
    expect(found).toMatch(/24 of §4.5's timestamps were compared/);
    expect(found).toMatch(/identity control read 0/);
    expect(found).toMatch(/divergence control/);
    expect(found).toMatch(/live frame count/);
    expect(found).toMatch(/export produced a file/);
    expect(found).toMatch(/cancellation probe/);
    expect(found).toMatch(/coverage tripwire ran/);
    expect(found).toMatch(/reported the run as successful/);
  });

  it('does not read `ok` or `error` as a substitute for a measurement', () => {
    // A report that *claims* success while carrying nothing is still nothing, and a
    // report that carries a comparison is a reading whatever it says about itself.
    // Neither is why this predicate decides; the fields are.
    const { error: _dropped, ...noError } = tookNoReading();
    expect(readingsTaken(noError)).toEqual([]);
    expect(readingsTaken(tookNoReading({ error: '' }))).toEqual([]);
    expect(
      readingsTaken(completed({ ok: false, error: 'boom' })).some((line) =>
        line.includes("§4.5's timestamps"),
      ),
    ).toBe(true);
  });
});
