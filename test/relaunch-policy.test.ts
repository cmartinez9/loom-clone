/**
 * The gate may relaunch for exactly one reason, and this is the fence around it.
 *
 * `GATE_ATTEMPTS = 2` exists because a lost WebGL context is not a measurement — see
 * `test/gate/relaunch.ts`. That is a narrow and defensible exception, and it stays
 * defensible only while it stays narrow: the moment the trigger admits "the run
 * failed", the phase 6 gate becomes a coin flipped twice, and every acceptance
 * criterion behind it becomes advisory.
 *
 * So this file enumerates the ways a run can be *bad* and requires that none of them
 * earns a second launch. It is cheap and runs in Node; the gate it guards costs a 4K
 * encode and a real Electron launch.
 */

import { describe, expect, it } from 'vitest';
import { CONTROL_PERIOD_MS, CONTROL_TARGET_MS } from './gate/budget-control.ts';
import { shouldRelaunch } from './gate/relaunch.ts';
import type { GateReport } from './gate/report.ts';

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
