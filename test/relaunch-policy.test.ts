/**
 * A gate may relaunch for exactly one reason, and this is the fence around it.
 *
 * `GATE_ATTEMPTS = 3` exists because a lost WebGL context is not a measurement — see
 * `test/gate/relaunch.ts`. That is a narrow and defensible exception, and it stays
 * defensible only while it stays narrow: the moment the trigger admits "the run
 * failed", the phase 6 gate becomes a coin flipped until it lands, and every
 * acceptance criterion behind it becomes advisory.
 *
 * **Both halves are fenced here, and they are fenced differently.** The trigger is
 * fixed and never moves: the cases below enumerate the ways a run can be *bad* and
 * require that none of them earns a launch. The count is fixed too — pinned by this
 * file — but it is the one part that may answer to evidence, and only to the kind that
 * moved it last: a measured demonstration that every launch the gate currently gets can
 * fail to yield a reading for one shared cause. It went from two to three on CI run
 * 31084636446, where both launches lost the context at the same place, 18 s and 16 s
 * in, on one runner inside 35 s, with `GPU process gone: abnormal-exit (exit 8704)`
 * naming the shared cause — two launches, no reading. Anyone raising it again owes a
 * reading of that kind, and the pin below is what makes them come here to say so
 * rather than nudge a number in a gate file.
 *
 * So this file enumerates the ways a run can be *bad* and requires that none of them
 * earns a second launch. It is cheap and runs in Node; the gates it guards cost a 4K
 * encode and a real Electron launch each.
 *
 * **Two gates, two predicates, one rule.** Phase 8's golden-frame gate
 * (`test/export-golden/relaunch.ts`) runs on the same virtualised runners and loses
 * its contexts the same way — Chromium's GPU process exits on a context loss and
 * takes all four of that harness's contexts with it. It gets its own predicate rather
 * than sharing phase 6's, so a widening in one cannot silently apply to the other,
 * and its own block of cases below.
 */

import { describe, expect, it } from 'vitest';
import { CONTROL_PERIOD_MS, CONTROL_TARGET_MS } from './gate/budget-control.ts';
import { GATE_ATTEMPTS, shouldRelaunch } from './gate/relaunch.ts';
import type { GateReport } from './gate/report.ts';
import { shouldRelaunchGolden } from './export-golden/relaunch.ts';
import type { GoldenReport } from './export-golden/report.ts';

const EMPTY_METRICS = {
  count: 0,
  maxMs: 0,
  maxAt: -1,
  meanMs: 0,
  p50Ms: 0,
  p99Ms: 0,
  overBudget: 0,
};

/** A control that found the host healthy: half a budget of arithmetic, taking it. */
const HEALTHY_CONTROL = {
  targetMs: CONTROL_TARGET_MS,
  periodMs: CONTROL_PERIOD_MS,
  count: 962,
  maxMs: 8.6,
  maxAt: 411,
  meanMs: 8.4,
  overBudget: 0,
};

/** A clean, passing report; each case below spoils exactly one thing. */
function report(overrides: Partial<GateReport> = {}): GateReport {
  return {
    ok: true,
    contextLost: false,
    environment: {
      glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer)',
      scheduler: 'raf',
      hardwareEncode: 'prefer-hardware',
      hardwareDecode: 'yes',
      electron: '',
      chrome: '',
    },
    fixture: {
      width: 3456,
      height: 2234,
      frameCount: 130,
      durationSec: 8,
      byteLength: 546_480,
      codec: 'avc1.640034',
      observedFps: 16.3,
      longestHoldSec: 0.5,
      encodeMs: 1500,
    },
    viewport: [2560, 1440],
    ringCapacity: 20,
    peakLiveFrames: 18,
    liveFramesAtEnd: 0,
    warmup: { ...EMPTY_METRICS, count: 12 },
    scrub: { ...EMPTY_METRICS, count: 112 },
    play: { ...EMPTY_METRICS, count: 962 },
    control: {
      scrub: { ...HEALTHY_CONTROL, count: 112, maxAt: 40 },
      play: HEALTHY_CONTROL,
    },
    gpuCost: {
      scrub: { count: 38, medianMs: 0.312, maxMs: 0.44 },
      play: { count: 310, medianMs: 0.309, maxMs: 0.51 },
    },
    slowCompositor: {
      injectedMs: 66.67,
      frames: { ...EMPTY_METRICS, count: 24, maxMs: 67.2, maxAt: 3, overBudget: 24 },
      control: { ...HEALTHY_CONTROL, count: 24, maxAt: 9 },
    },
    scrubChecks: [],
    playSamples: [],
    settleSamples: 40,
    settleBlackFrames: 0,
    controlDetectsBlack: true,
    playHits: 961,
    playMisses: 1,
    decodedFrames: 219,
    seeks: 13,
    bytesRead: 546_480,
    gpuCompositeMs: 0.5,
    logs: [],
    ...overrides,
  };
}

describe('the gate relaunches only for a lost context', () => {
  /**
   * The count, pinned — so raising it is a deliberate edit *here* rather than a nudge
   * in a gate file.
   *
   * Not a property of the code under test, and that is the point: it is the tripwire
   * that routes anyone changing the number through the paragraph above, which says what
   * a change to it costs. `GATE_ATTEMPTS` moved once, from two to three, on a measured
   * demonstration that two launches can leave the gate with no reading at all; the next
   * move owes evidence of the same kind. Every other guard in this file fences the
   * *trigger*, which does not move at all.
   */
  it('pins the number of launches, so the count cannot drift without this file', () => {
    expect(
      GATE_ATTEMPTS,
      'GATE_ATTEMPTS changed. This is the fence, not an obstacle: the trigger is fixed ' +
        'and a reading is still never retried, but the count may only be raised on a ' +
        'measured demonstration that every launch the gate currently gets can fail to ' +
        'yield a reading for one shared cause — the way CI run 31084636446 raised it to ' +
        'three. Record that evidence in test/gate/relaunch.ts and in this file, then ' +
        'change this number.',
    ).toBe(3);
  });

  it('relaunches when the context was lost', () => {
    expect(shouldRelaunch(report({ contextLost: true }))).toBe(true);
  });

  it('does not relaunch a clean run', () => {
    expect(shouldRelaunch(report())).toBe(false);
  });

  it.each([
    ['over budget', { play: { ...EMPTY_METRICS, count: 962, maxMs: 19, overBudget: 1 } }],
    ['short of frames', { play: { ...EMPTY_METRICS, count: 3 } }],
    ['holding a leaked frame', { liveFramesAtEnd: 4 }],
    ['over the ring cap', { peakLiveFrames: 41 }],
    ['black frames while settling', { settleBlackFrames: 7 }],
    ['a black-detection control that did not fire', { controlDetectsBlack: false }],
    ['mostly misses', { playHits: 10, playMisses: 900 }],
    // The environment control is a *reading* too, on both of its branches. A host
    // that could not hold the budget is reported once and a compositor that could not
    // hold the ceiling that host earned fails once; neither buys another launch.
    [
      'on a host whose control could not hold the budget',
      {
        play: { ...EMPTY_METRICS, count: 962, maxMs: 21.4, overBudget: 2 },
        control: {
          scrub: { ...HEALTHY_CONTROL, count: 112, maxAt: 40 },
          play: { ...HEALTHY_CONTROL, maxMs: 84.1, overBudget: 3 },
        },
      },
    ],
    [
      'holding a slow-compositor control that did not fail',
      { slowCompositor: { injectedMs: 0, frames: EMPTY_METRICS, control: HEALTHY_CONTROL } },
    ],
    // A host that cannot run the product's workload is a reading about the *host*, and
    // the surest reading this gate takes: no hardware decoder does not become one on a
    // second launch. It defers §8's absolute number to the tracking bound and reports
    // the figures; relaunching for it would be re-rolling a machine, not a measurement.
    [
      'on a host with no hardware decoder and a CPU-backed composite',
      {
        environment: {
          glRenderer: 'ANGLE (Apple, Apple Paravirtual device)',
          scheduler: 'raf' as const,
          hardwareEncode: 'prefer-software',
          hardwareDecode: 'no' as const,
          electron: '',
          chrome: '',
        },
        gpuCost: {
          scrub: { count: 30, medianMs: 3.309, maxMs: 6.1 },
          play: { count: 290, medianMs: 3.28, maxMs: 7.4 },
        },
        play: { ...EMPTY_METRICS, count: 380, maxMs: 17.2, maxAt: 186, overBudget: 1 },
      },
    ],
    ['not ok', { ok: false }],
    ['an error', { error: 'no WebGL2 context; the gate cannot run' }],
    [
      'a failed launch reporting zeroes',
      { ok: false, error: 'electron exited 1', play: EMPTY_METRICS },
    ],
  ] satisfies [string, Partial<GateReport>][])(
    'does NOT relaunch a run that was %s',
    (_label, overrides) => {
      // Each of these is a *reading*. Reporting it once is the whole job of a gate;
      // launching again until it comes out differently is the opposite of one.
      expect(shouldRelaunch(report(overrides))).toBe(false);
    },
  );

  it('does not relaunch even when a bad run also failed outright', () => {
    // The tempting widening — "it failed, try once more" — stated explicitly so
    // that making it true has to break this line.
    expect(shouldRelaunch(report({ ok: false, error: 'boom', liveFramesAtEnd: 9 }))).toBe(false);
  });
});

/** A finished export that passed §7.5's five checks. */
const CLEAN_EXPORT: NonNullable<GoldenReport['exported']> = {
  bytes: 144_527,
  durationSec: 5.6,
  expectedDurationSec: 5.6,
  videoSampleCount: 168,
  audioSampleCount: 0,
  verified: {
    exists: true,
    bytes: 144_527,
    durationSec: 5.6,
    lastFrameDecodable: true,
    sha256: 'a'.repeat(64),
  },
  verificationFailure: null,
  decodedFrames: [{ index: 0, atSec: 0, expectedFrame: 0, observedFrame: 0 }],
};

/** §4.5's 24 timestamps, all agreeing. */
const CLEAN_SAMPLES: GoldenReport['samples'] = Array.from({ length: 24 }, (_unused, i) => ({
  index: i,
  atSec: i / 30,
  maxDelta: 0,
  atByte: 0,
  differingBytes: 0,
  zoomAmount: 1 + i / 24,
  drawn: true,
}));

/** A clean phase-8 report; each case below spoils exactly one thing. */
function golden(overrides: Partial<GoldenReport> = {}): GoldenReport {
  return {
    ok: true,
    contextLost: false,
    coverage: {
      exercised: ['frame selection', 'zoom state'],
      notExercised: [
        { row: 'the webcam bubble', why: 'no webcam pass on main' },
        { row: 'the cursor', why: 'no cursor pass on main' },
      ],
      tripwire: { webcamPassStillAbsent: true, cursorPassStillAbsent: true, detail: '' },
    },
    environment: {
      glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer)',
      electron: '',
      chrome: '',
      hardwareEncode: 'prefer-hardware',
    },
    fixture: { width: 1920, height: 1080, frameCount: 90, durationSec: 5.6, longestHoldSec: 0.5 },
    outputSize: [1280, 720],
    fps: 30,
    samples: CLEAN_SAMPLES,
    identityMaxDelta: 0,
    controls: [
      { name: 'clock-skew', what: '', maxDelta: 255, differingSamples: 19 },
      { name: 'frame-selection', what: '', maxDelta: 255, differingSamples: 14 },
    ],
    liveFramesAtEnd: 0,
    exported: CLEAN_EXPORT,
    cancelLeftBehind: [],
    logs: [],
    ...overrides,
  };
}

describe('the golden-frame gate relaunches only for a lost context', () => {
  it('relaunches when the context was lost', () => {
    expect(shouldRelaunchGolden(golden({ contextLost: true }))).toBe(true);
  });

  it('does not relaunch a clean run', () => {
    expect(shouldRelaunchGolden(golden())).toBe(false);
  });

  it.each([
    // §4.5's per-pixel zero, missed. The whole point of the gate; one report, one read.
    [
      'showing a per-pixel difference between preview and export',
      {
        samples: CLEAN_SAMPLES.map((sample, i) =>
          i === 3 ? { ...sample, maxDelta: 7, differingBytes: 912 } : sample,
        ),
      },
    ],
    ['a comparator that could not report zero', { identityMaxDelta: 4 }],
    // A control that saw nothing means the zero above proves nothing — which is a
    // finding about this build, not about the host.
    [
      'a divergence control that did not move a pixel',
      {
        controls: [
          { name: 'clock-skew', what: '', maxDelta: 0, differingSamples: 0 },
          { name: 'frame-selection', what: '', maxDelta: 255, differingSamples: 14 },
        ],
      },
    ],
    ['holding a leaked frame', { liveFramesAtEnd: 3 }],
    ['an export that failed §7.5', { exported: null }],
    [
      'an export whose last frame would not decode',
      {
        exported: {
          ...CLEAN_EXPORT,
          verificationFailure: 'the last frame did not decode',
          verified: { ...CLEAN_EXPORT.verified, lastFrameDecodable: false },
        },
      },
    ],
    ['a cancelled export that left a file behind', { cancelLeftBehind: ['Cancelled.mp4.partial'] }],
    // A tripped §4.5 coverage tripwire is a finding about the *code* — somebody built
    // the bubble or the cursor pass and the gate's coverage list is now wrong — so it
    // is reported once and never re-rolled.
    [
      'a §4.5 coverage tripwire that went off',
      {
        coverage: {
          exercised: ['frame selection', 'zoom state'],
          notExercised: [{ row: 'the cursor', why: 'no cursor pass on main' }],
          tripwire: {
            webcamPassStillAbsent: false,
            cursorPassStillAbsent: true,
            detail: 'webcam: render() accepted it',
          },
        },
      },
    ],
    ['not ok', { ok: false }],
    ['an error', { error: 'the export writer was never opened' }],
    [
      'a launch that produced nothing',
      { ok: false, error: 'the gate did not finish within 480000ms', samples: [] },
    ],
  ] satisfies [string, Partial<GoldenReport>][])(
    'does NOT relaunch a run that was %s',
    (_label, overrides) => {
      expect(shouldRelaunchGolden(golden(overrides))).toBe(false);
    },
  );

  it('does not relaunch even when a bad run also failed outright', () => {
    expect(shouldRelaunchGolden(golden({ ok: false, error: 'boom', liveFramesAtEnd: 9 }))).toBe(
      false,
    );
  });
});
