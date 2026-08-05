/**
 * What the phase-6 gate measures, as a document.
 *
 * Shared by the harness that produces it, the Electron main that writes it out and
 * the vitest file that asserts on it. Dependency-free on purpose: it is imported
 * into three different bundles with three different module formats.
 *
 * Architecture report §8, phase 6's gate: *"Scrub and play a 4K fixture with no
 * frame over 16 ms at 1440p viewport; live `VideoFrame` count never exceeds the ring
 * cap."* Both halves are here, and so is everything needed to tell a real pass from
 * a vacuous one — because a preview that renders nothing renders it very quickly.
 */

export interface PhaseMetrics {
  /** Frames measured. */
  count: number;
  maxMs: number;
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

export interface GateReport {
  ok: boolean;
  error?: string;
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
  scrubChecks: ScrubCheck[];
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
