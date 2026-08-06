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

export interface GoldenReport {
  ok: boolean;
  error?: string;
  contextLost: boolean;
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
