/**
 * What the phase-6 gate measures, as a document.
 *
 * Shared by the harness that produces it, the Electron main that writes it out and
 * the vitest file that asserts on it. Dependency-free on purpose: it is imported
 * into three different bundles with three different module formats. The one import
 * below is `import type` and so is erased entirely — `ControlPhase` is declared beside
 * the control that produces it, and re-exported here so a reader of the report shape
 * has the whole document in one place.
 *
 * Architecture report §8, phase 6's gate: *"Scrub and play a 4K fixture with no
 * frame over 16 ms at 1440p viewport; live `VideoFrame` count never exceeds the ring
 * cap."* Both halves are here, and so is everything needed to tell a real pass from
 * a vacuous one — because a preview that renders nothing renders it very quickly.
 */

import type { ControlPhase } from './budget-control.ts';

export type { ControlPhase };

export interface PhaseMetrics {
  /** Frames measured. */
  count: number;
  maxMs: number;
  /**
   * Which frame of the phase {@link maxMs} was, or `-1` when nothing was measured.
   *
   * `FrameMetrics` has always tracked this — *"so a failure can name when it
   * happened"* — and the report used to drop it, which is the difference between
   * "the gate failed" and "the gate failed on the second frame of the phase".
   */
  maxAt: number;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  /** Frames whose *work* exceeded one 60 Hz refresh. The gate requires zero. */
  overBudget: number;
}

export interface ScrubCheck {
  targetSec: number;
  /** The frame the index says is on screen at `targetSec`. */
  expectedFrame: number;
  /** The frame number read back out of the composited pixels, or `-1` if unreadable. */
  observedFrame: number;
  /** Milliseconds from the seek to the correct frame being on screen. */
  settleMs: number;
}

/** A frame read back out of the framebuffer while playback was running. */
export interface PlaySample {
  atSec: number;
  expectedFrame: number;
  observedFrame: number;
}

export interface GateEnvironment {
  glRenderer: string;
  /** `'raf'` when `requestAnimationFrame` drove the loop, `'timer'` for the fallback. */
  scheduler: 'raf' | 'timer';
  hardwareEncode: string;
  electron: string;
  chrome: string;
}

export interface GateFixture {
  width: number;
  height: number;
  frameCount: number;
  durationSec: number;
  byteLength: number;
  codec: string;
  /** Frames per second averaged over the part — well under nominal, because VFR. */
  observedFps: number;
  /** The longest hold between two frames. Proves the fixture is genuinely VFR. */
  longestHoldSec: number;
  encodeMs: number;
}

/**
 * The measured environment control, and the proof that it is not an escape hatch.
 *
 * `test/gate/budget-control.ts` is the whole argument. In short: §8's bound is the
 * compositor's to meet on any host whose control clears it, and on a host whose
 * control does not, the shortfall is reported with the measured figure and the
 * compositor is held to the ceiling that control just demonstrated.
 */
export interface GateBudgetControl {
  /** Measured in the scrub phase's own frames. */
  scrub: ControlPhase;
  /** Measured in the play phase's own frames. */
  play: ControlPhase;
}

/**
 * CONTROL. A deliberately-slowed compositor path, measured by the same instrument in
 * the same run, with the environment control still spinning beside it.
 *
 * The control above defers §8's absolute number on a host that cannot hold it. This is
 * what keeps that honest: a compositor that cannot hold the budget must fail the gate
 * on any host that can — and must fail the tracking bound even on one that cannot.
 * `test/phase6-gate.test.ts` asserts both branches of that.
 */
export interface GateSlowCompositor {
  /** Milliseconds burned inside `render`, on top of the real composite. */
  injectedMs: number;
  /** What the shipping `PreviewLoop` measured while that was happening. */
  frames: PhaseMetrics;
  /** The environment control, measured in those same frames. */
  control: ControlPhase;
}

export interface GateReport {
  ok: boolean;
  error?: string;
  /**
   * The renderer's WebGL context was taken away mid-run.
   *
   * Not a result: it is the instrument dying, and every number after it is stale.
   * The run is abandoned as soon as it is noticed and the gate re-runs, because a
   * driver that drops a context on a shared paravirtual GPU is telling you about the
   * host, not about this commit. `test/phase6-gate.test.ts` has the whole story.
   */
  contextLost: boolean;
  environment: GateEnvironment;
  fixture: GateFixture;
  viewport: [number, number];
  /** §4.2's cap. The live count must never exceed it. */
  ringCapacity: number;
  /** Highest live `VideoFrame` count seen at any point, by any observer. */
  peakLiveFrames: number;
  /** Live frames once everything is closed. Must be zero. */
  liveFramesAtEnd: number;
  /** Frames rendered before measuring — shader link, first 4K upload, FBO warm. */
  warmup: PhaseMetrics;
  scrub: PhaseMetrics;
  play: PhaseMetrics;
  /** What this host could sustain, measured in the very frames above. */
  control: GateBudgetControl;
  /** CONTROL for that control: a compositor that cannot hold the budget. */
  slowCompositor: GateSlowCompositor;
  scrubChecks: ScrubCheck[];
  /**
   * Composites sampled *while* each scrub was settling, not once it had settled.
   * That window is where §4.3's "a miss holds the previous frame" is decided.
   */
  settleSamples: number;
  /** Of those, composites that came back as bare background. Must be zero. */
  settleBlackFrames: number;
  /**
   * CONTROL. The behaviour the hold replaced — clearing the target before
   * discovering there was no frame to draw — reproduced and seen by the same
   * detector. Without it, "zero black frames" and "the detector is blind" read
   * identically.
   */
  controlDetectsBlack: boolean;
  /** Frames read back mid-playback, proving the picture advances rather than holds. */
  playSamples: PlaySample[];
  /** `frameAt` hits and misses during playback; a black preview would be all misses. */
  playHits: number;
  playMisses: number;
  decodedFrames: number;
  seeks: number;
  bytesRead: number;
  gpuCompositeMs: number | null;
  logs: string[];
}

/** The preload surface. Declared here so the harness and the preload cannot drift. */
export interface GateBridge {
  options(): Promise<{ fixtureDir: string; frameCount: number; gopSize: number }>;
  write(bundleRelativePath: string, data: Uint8Array): Promise<void>;
  finish(report: GateReport): Promise<void>;
  log(message: string): void;
}
