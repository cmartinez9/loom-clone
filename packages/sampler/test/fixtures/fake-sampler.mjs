#!/usr/bin/env node
/**
 * A scripted stand-in for `loom-input-sampler`.
 *
 * The real helper is exercised by `accessibility-revoked.test.ts`, and that is the
 * phase-5 gate. But the *granted* paths — a live tap, a click, a tap that dies
 * mid-recording — cannot be produced on a machine without the Accessibility grant,
 * and the grant needs a human in System Settings plus an app restart. The captain's
 * decision says as much: the scout proved the failure mode and could not observe the
 * success path.
 *
 * So the success and mid-recording-degradation paths are driven from here, on the
 * real wire protocol, through the real `InputSampler`. What this cannot prove is
 * that macOS behaves as scripted; that is flagged as unverified in the decision and
 * belongs to a manual pass from a signed bundle.
 *
 * Usage: `fake-sampler.mjs run …` with `LOOM_FAKE_SCENARIO` naming a scenario below.
 * Unknown arguments are ignored, exactly as the real helper ignores them.
 */

const scenario = process.env.LOOM_FAKE_SCENARIO ?? 'granted';

/** A fixed epoch so every assertion in the tests can be exact. */
const T0 = 1_000_000_000;

const tap = (over) => ({
  available: false,
  reason: null,
  requested: true,
  axTrusted: false,
  tapCreated: false,
  tapEnabled: false,
  ...over,
});

const LIVE = tap({
  available: true,
  reason: null,
  axTrusted: true,
  tapCreated: true,
  tapEnabled: true,
});
const DEAD = tap({ reason: 'tap-disabled-by-timeout', axTrusted: true, tapCreated: true });
const GRANTED_NO_TAP = tap({ reason: 'tap-dead', axTrusted: true, tapCreated: true });

const SCENARIOS = {
  /** The happy path: the tap comes up live and stays live. No clicks happen. */
  granted: [
    { k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 17 },
    { k: 'display', tUs: T0, display: 1, logicalSize: [1728, 1117], scaleFactor: 2 },
    { k: 'status', tUs: T0, clicks: LIVE },
    { k: 'cursor', tUs: T0 + 8000, x: 0.5, y: 0.5, c: '', m: 0 },
    {
      k: 'health',
      tUs: T0 + 1_000_000,
      samples: 1,
      clicks: 0,
      dropped: 0,
      axTrusted: true,
      tapCreated: true,
      tapEnabled: true,
    },
  ],

  /** Clicks arrive. Both buttons, both edges, a modifier. */
  clicking: [
    { k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 17 },
    { k: 'status', tUs: T0, clicks: LIVE },
    { k: 'cursor', tUs: T0 + 8000, x: 0.5, y: 0.5, c: '', m: 0 },
    { k: 'click', tUs: T0 + 1_204_300, e: 'down', b: 0, x: 0.6001, y: 0.3312, m: 0 },
    { k: 'click', tUs: T0 + 1_287_100, e: 'up', b: 0, x: 0.6001, y: 0.3312, m: 0 },
    { k: 'click', tUs: T0 + 4_883_000, e: 'down', b: 1, x: 0.2214, y: 0.7702, m: 8 },
  ],

  /**
   * The tap comes up live and the kernel kills it partway through — §7.3's
   * "permission revoked mid-session", and the case where a log is real but partial.
   */
  'granted-then-dead': [
    { k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 17 },
    { k: 'status', tUs: T0, clicks: LIVE },
    { k: 'click', tUs: T0 + 500_000, e: 'down', b: 0, x: 0.25, y: 0.25, m: 0 },
    { k: 'status', tUs: T0 + 2_000_000, clicks: DEAD },
    { k: 'cursor', tUs: T0 + 2_100_000, x: 0.5, y: 0.5, c: '', m: 0 },
  ],

  /**
   * The tap comes up live and the *helper* dies under it. The log is populated and
   * real, and stops being a faithful record at a knowable moment — which has to be
   * recorded, because "one click happened" and "one click was captured before we
   * went blind" are different facts.
   */
  'granted-then-crash': [
    { k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 17 },
    { k: 'status', tUs: T0, clicks: LIVE },
    { k: 'click', tUs: T0 + 500_000, e: 'down', b: 0, x: 0.25, y: 0.25, m: 0 },
    { k: 'cursor', tUs: T0 + 2_000_000, x: 0.5, y: 0.5, c: '', m: 0 },
  ],

  /**
   * TCC says the process is trusted and the tap still will not come up — the
   * "granted, now relaunch" case the captain's decision requires be handled.
   */
  'needs-restart': [
    { k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 17 },
    { k: 'status', tUs: T0, clicks: GRANTED_NO_TAP },
  ],

  /** The helper's bounded output buffer overran. Must never be reported as zero. */
  dropping: [
    { k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 17 },
    { k: 'status', tUs: T0, clicks: LIVE },
    {
      k: 'health',
      tUs: T0 + 1_000_000,
      samples: 120,
      clicks: 0,
      dropped: 41,
      axTrusted: true,
      tapCreated: true,
      tapEnabled: true,
    },
  ],

  /** A display reconfiguration mid-recording (§2.5). */
  reconfigure: [
    { k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 17 },
    // The real helper always emits the starting display before anything else.
    { k: 'display', tUs: T0, display: 1, logicalSize: [1728, 1117], scaleFactor: 2 },
    { k: 'status', tUs: T0, clicks: tap({ reason: 'accessibility-denied' }) },
    { k: 'cursor', tUs: T0 + 8000, x: 0.5, y: 0.5, c: '', m: 0 },
    { k: 'display', tUs: T0 + 12_771_000, display: 1, logicalSize: [1512, 982], scaleFactor: 2 },
    { k: 'cursor', tUs: T0 + 12_780_000, x: 0.4, y: 0.4, c: '', m: 0 },
  ],
};

if (scenario === 'crash') {
  process.stdout.write(
    `${JSON.stringify({ k: 'hello', version: 1, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 0 })}\n`,
  );
  process.exit(3);
}

if (scenario === 'future-protocol') {
  process.stdout.write(
    `${JSON.stringify({ k: 'hello', version: 99, pid: process.pid, tUs: T0, monotonicUs: T0, hz: 120, shapeNames: 0 })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ k: 'status', tUs: T0, clicks: LIVE })}\n`);
}

// `silent` spawns cleanly and never says a word — a stale binary behind the override,
// or an AppKit call that blocks without a window server. `start()` has to bound its
// wait rather than leave a recording waiting on a helper that will never answer.
const lines = scenario === 'silent' ? [] : (SCENARIOS[scenario] ?? SCENARIOS.granted);
// Written as one chunk on purpose: the real helper batches on a 100 ms timer, so the
// reader must cope with many lines per chunk — and with a chunk that splits a line,
// which the interleaved partial write below produces.
const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
const split = Math.max(1, Math.floor(text.length / 2) + 3);
process.stdout.write(text.slice(0, split));
process.stdout.write(text.slice(split));

if (scenario === 'granted-then-crash') process.exit(4);

// Stay alive until the parent says stop or closes the pipe, exactly like the helper.
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('"stop"')) {
    process.stdout.write(`${JSON.stringify({ k: 'bye', tUs: T0 + 30_000_000 })}\n`);
    process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
