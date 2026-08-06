/**
 * What the golden-frame gate reports back, and the bridge it reports over.
 *
 * Shared by the renderer half (`harness.ts`), the Electron main half (`main.ts`) and
 * the judge (`test/phase8-gate.test.ts`), so the three cannot disagree about what a
 * number means.
 */

/** One of §4.5's 24 timestamps, judged. */
export interface GoldenSample {
  /** Output frame number. The two paths are compared at `index / fps`. */
  index: number;
  atSec: number;
  /**
   * Largest absolute per-channel difference between the preview composite and the
   * export composite, over every pixel. §4.5 requires **0**.
   */
  maxDelta: number;
  /** Byte offset of the worst pixel, so a failure says where. */
  atByte: number;
  /** Differing bytes, so "one pixel" and "the whole frame" are distinguishable. */
  differingBytes: number;
  /** Resolved zoom at this instant, so a pass on an identity state is visible as one. */
  zoomAmount: number;
  /** True when both paths composited a decoded source frame rather than holding. */
  drawn: boolean;
}

/** A deliberate divergence, and what the comparison made of it. */
export interface ControlOutcome {
  name: string;
  /** What was perturbed, for the failure message. */
  what: string;
  /** Largest delta the same comparison found. Must be > 0 for a divergence control. */
  maxDelta: number;
  /** How many of the 24 timestamps differed at all. */
  differingSamples: number;
}

/** One frame decoded back out of the finished file. */
export interface DecodedFrameCheck {
  index: number;
  atSec: number;
  expectedFrame: number;
  observedFrame: number;
}

export interface ExportedFile {
  bytes: number;
  durationSec: number;
  expectedDurationSec: number;
  videoSampleCount: number;
  audioSampleCount: number;
  /** §7.5's five checks, as `verifyExport` recorded them. */
  verified: {
    exists: boolean;
    bytes: number;
    durationSec: number;
    lastFrameDecodable: boolean;
    sha256: string;
  };
  verificationFailure: string | null;
  decodedFrames: DecodedFrameCheck[];
}

/**
 * Which of §4.5's *"must be identical"* rows this run actually looked at.
 *
 * `maxDelta === 0` over 24 timestamps is only evidence about the rows that **drew**.
 * The bubble and the cursor have no compositor pass on `main` — `Compositor.render`
 * throws when handed a `webcam` or a `cursor` frame, and nothing ever passes one — so
 * both paths draw nothing for them and agreeing about it says nothing at all. This
 * carries the boundary into the printed report, so a reader of a *passing* run sees
 * what the pass covers rather than inferring it from the headline number.
 *
 * {@link CoverageReport.tripwire} is what stops it rotting: it re-asks the compositor
 * whether it still refuses those two frame kinds. The day somebody builds the passes,
 * the refusal stops and the gate goes red — which forces this list to be updated in
 * the same change that makes it wrong.
 */
export interface CoverageReport {
  /** Rows this run perturbs and compares. */
  exercised: string[];
  /** Rows it cannot, and why. */
  notExercised: { row: string; why: string }[];
  tripwire: {
    /** True while `Compositor.render` still refuses a `webcam` frame. */
    webcamPassStillAbsent: boolean;
    /** True while it still refuses a `cursor` frame. */
    cursorPassStillAbsent: boolean;
    /** What it did when handed each, so a failure says which changed. */
    detail: string;
  };
}

/**
 * What {@link CoverageReport.tripwire}'s detail says when the run never got there.
 *
 * A constant rather than three copies of a sentence, because `readingsTaken` in
 * `verdict.ts` asks *"did this probe run?"* by comparing against it — and a gate that
 * decides whether it has a verdict by matching a string literal one of its writers can
 * reword is a gate with a silent branch in it.
 */
export const COVERAGE_PROBE_NOT_REACHED = 'the run did not reach the coverage probe';

export interface GoldenReport {
  ok: boolean;
  error?: string;
  contextLost: boolean;
  /**
   * What Chromium said died, when what died was the **GPU process**. `null` otherwise.
   *
   * Stamped by `main.ts`'s `finish`, never by the harness: the harness only ever sees
   * the lights going out, and `child-process-gone` is the same event arriving by the
   * one route that names the mechanism and the exit code. It is **evidence, not a
   * condition** — `verdict.ts` prints it and does not key on it, because a context can
   * be lost without the process exiting and a run that produced no reading is a run
   * that produced no reading either way.
   */
  gpuProcessGone?: string | null;
  /** §4.5's rows, split into what this gate judges and what it cannot. */
  coverage: CoverageReport;
  environment: {
    glRenderer: string;
    electron: string;
    chrome: string;
    hardwareEncode: string;
  };
  fixture: {
    width: number;
    height: number;
    frameCount: number;
    durationSec: number;
    longestHoldSec: number;
  };
  outputSize: [number, number];
  fps: number;
  /** §4.5's 24. */
  samples: GoldenSample[];
  /** The export path run twice — the comparator's own control. Must be 0. */
  identityMaxDelta: number;
  /** Deliberate divergences. Each must be > 0. */
  controls: ControlOutcome[];
  /** Live `VideoFrame` count once everything has been closed. §10.2. */
  liveFramesAtEnd: number;
  /** `null` when the end-to-end export did not run. */
  exported: ExportedFile | null;
  /** Cancellation, proved rather than asserted: what was on disk afterwards. */
  cancelLeftBehind: string[] | null;
  logs: string[];
}

/** The named channels the harness reaches main through. No generic invoke (§1.4). */
export interface GoldenBridge {
  options(): Promise<{ outDir: string }>;
  /**
   * Write the fixture as a real capture part and hand back the `loom://` URLs.
   *
   * Through `ProjectStore`, in main — a renderer has no filesystem (§0, rule 2), and
   * the point of writing a real part rather than an elementary stream is that the
   * exporter then reads its codec description off the disk like it does in the app.
   */
  writeFixture(request: {
    width: number;
    height: number;
    fps: number;
    avcC: Uint8Array;
    bytes: Uint8Array;
    frames: { offset: number; byteLength: number; timestampUs: number; isKey: boolean }[];
    endTimestampUs: number;
  }): Promise<{ mediaUrl: string; indexUrl: string; durationSec: number; frameCount: number }>;
  /** Open the export writer for the end-to-end run. */
  beginExport(request: {
    name: string;
    width: number;
    height: number;
    timescale: number;
    avcC: Uint8Array;
  }): Promise<void>;
  appendExport(sample: {
    data: Uint8Array;
    durationUnits: number;
    isKey: boolean;
    timestampUs: number;
  }): Promise<void>;
  /**
   * Assemble the file and run §7.5's checks against it.
   *
   * `expectedDurationSec` is the **timeline's**, handed in by the harness exactly as
   * `ExportSession` hands in `job.expectedDurationSec` — never `finalizeExport`'s own
   * tally, which is the number `mvhd.duration` was written from.
   */
  finalizeExport(expectedDurationSec: number): Promise<{
    path: string;
    url: string;
    bytes: number;
    durationSec: number;
    videoSampleCount: number;
    audioSampleCount: number;
    verified: ExportedFile['verified'];
    verificationFailure: string | null;
  }>;
  /** Feed one verification decode request back; used by `finalizeExport`. */
  onVerifyRequest(
    handler: (request: {
      codec: string;
      codedWidth: number;
      codedHeight: number;
      description: Uint8Array;
      chunks: { data: Uint8Array; isKey: boolean; timestampUs: number }[];
      expectLastTimestampUs: number;
    }) => Promise<{ ok: boolean; error?: string }>,
  ): void;
  /** Write some samples, cancel, and report what is left in the directory. */
  cancelProbe(): Promise<string[]>;
  finish(report: GoldenReport): Promise<void>;
  log(message: string): void;
}
