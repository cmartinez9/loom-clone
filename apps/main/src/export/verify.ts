/**
 * §7.5, obligation 1 — *"Delete only after a verified-good export"*.
 *
 * > Export writes `<name>.mp4.partial`, `fsync`, atomic rename. Then verify: file
 * > exists · size > 0 · demuxes · duration within 100 ms of expected · **last frame
 * > actually decodes** · sha256 recorded. All five recorded in
 * > `project.json.exports[].verified`. Any failure → sources kept, export marked
 * > failed.
 *
 * This file is those checks. **Phase 8 does not delete anything** — phase 9 does —
 * but what phase 9 is allowed to delete is decided entirely by what this returns, so
 * the bar is that every check is answered from the bytes on disk rather than from
 * what the writing process believed it wrote.
 *
 * That is not a stylistic preference. The failures this exists to catch are exactly
 * the ones where memory and disk disagree: a short write nobody noticed, a chunk
 * offset off by a byte, a `rename` that landed on a full volume. Asking
 * `ExportMp4Writer` whether it wrote correctly would be asking the wrong process,
 * and would pass every one of them.
 *
 * ## The one check that cannot happen here
 *
 * A `VideoDecoder` lives in a renderer. So this module produces the *request* — the
 * last GOP's encoded chunks, read out of the file at the offsets the file's own
 * sample table gives — and the caller carries it to the export window and brings
 * back the answer. Encoded chunks are precisely what may cross IPC (§1.4).
 */

import { HEADER_PROBE_BYTES, movieHeaderLength, parseMovie, type Movie } from '@loom/mux';
import type { ExportDecodeRequest, ExportVerification } from '@loom/ipc';

/** §7.5's tolerance, verbatim. */
export const DURATION_TOLERANCE_SEC = 0.1;

/**
 * Longest run of samples a verification will read back.
 *
 * The last GOP at §5.3's two-second keyframe cadence is 60 frames at 30 fps. A file
 * whose final sync sample is further back than this is not one we wrote, and reading
 * an unbounded run out of it to find out is how a verifier becomes a way to make the
 * app read a gigabyte.
 */
export const MAX_VERIFY_SAMPLES = 600;

/** Everything a check can fail on, named so a failure says which one. */
export type VerificationFailure =
  | 'missing'
  | 'empty'
  | 'undemuxable'
  | 'not-faststart'
  | 'no-video-track'
  | 'no-samples'
  | 'duration'
  | 'no-sync-sample'
  | 'gop-too-long'
  | 'last-frame';

export class VerificationError extends Error {
  readonly failure: VerificationFailure;
  constructor(failure: VerificationFailure, message: string) {
    super(message);
    this.name = 'VerificationError';
    this.failure = failure;
  }
}

/** The byte ranges the caller has to read, and what to do with them. */
export interface DecodePlan {
  movie: Movie;
  ranges: { offset: number; byteLength: number }[];
  /** Parallel to `ranges`. */
  samples: { isKey: boolean; timestampUs: number }[];
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description: Uint8Array;
  expectLastTimestampUs: number;
}

/**
 * Checks 3 and 4, plus the plan for check 5.
 *
 * Pure — it takes the header bytes and the expectation and returns either a plan or
 * a named failure, so every branch is reachable from a unit test without a
 * filesystem, an Electron window or a decoder.
 */
export function planVerification(head: Uint8Array, expectedDurationSec: number): DecodePlan {
  const headerLength = movieHeaderLength(head);
  if (headerLength === null) {
    throw new VerificationError(
      'not-faststart',
      'the file does not begin with ftyp + moov, so it is not the faststart movie the ' +
        'exporter writes',
    );
  }
  if (headerLength > head.byteLength) {
    throw new VerificationError(
      'undemuxable',
      `the moov declares ${headerLength} bytes but only ${head.byteLength} were read`,
    );
  }

  let movie: Movie;
  try {
    movie = parseMovie(head.subarray(0, headerLength));
  } catch (error) {
    throw new VerificationError(
      'undemuxable',
      `the file does not demux: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!movie.fastStart) {
    throw new VerificationError('not-faststart', 'the moov does not precede the mdat');
  }

  const video = movie.tracks.find((track) => track.handler === 'vide');
  if (video === undefined) {
    throw new VerificationError('no-video-track', 'the file carries no video track');
  }
  if (video.samples.length === 0) {
    throw new VerificationError('no-samples', 'the video track has no samples');
  }

  const drift = Math.abs(movie.durationSec - expectedDurationSec);
  if (drift > DURATION_TOLERANCE_SEC) {
    throw new VerificationError(
      'duration',
      `the file is ${movie.durationSec.toFixed(3)}s where ${expectedDurationSec.toFixed(3)}s ` +
        `was expected — ${(drift * 1000).toFixed(0)}ms out, past the ` +
        `${DURATION_TOLERANCE_SEC * 1000}ms §7.5 allows`,
    );
  }

  const description = video.codecDescription;
  if (description === null) {
    throw new VerificationError('undemuxable', 'the video sample entry carries no avcC');
  }

  // Walk back to the last sync sample: a decoder cannot be handed a delta first, so
  // "does the last frame decode" is really "does the last GOP decode".
  let first = video.samples.length - 1;
  while (first > 0 && video.samples[first]?.isSync !== true) first -= 1;
  if (video.samples[first]?.isSync !== true) {
    throw new VerificationError(
      'no-sync-sample',
      'no sync sample precedes the last frame, so nothing in this file can be decoded',
    );
  }
  const run = video.samples.slice(first);
  if (run.length > MAX_VERIFY_SAMPLES) {
    throw new VerificationError(
      'gop-too-long',
      `the final GOP is ${run.length} frames, past the ${MAX_VERIFY_SAMPLES} this check reads`,
    );
  }

  const toUs = (units: number): number => Math.round((units / video.timescale) * 1e6);
  return {
    movie,
    ranges: run.map((sample) => ({ offset: sample.offset, byteLength: sample.byteLength })),
    samples: run.map((sample) => ({ isKey: sample.isSync, timestampUs: toUs(sample.decodeUnits) })),
    codec: avcCodecString(description),
    codedWidth: video.width,
    codedHeight: video.height,
    description,
    expectLastTimestampUs: toUs(run[run.length - 1]?.decodeUnits ?? 0),
  };
}

/** `avc1.PPCCLL` from an `avcC`. The same derivation the renderer's reader uses. */
export function avcCodecString(avcC: Uint8Array): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1] ?? 0)}${hex(avcC[2] ?? 0)}${hex(avcC[3] ?? 0)}`;
}

/** What the caller has to be able to do for {@link verifyExport} to run. */
export interface VerificationIo {
  size(path: string): Promise<number | null>;
  readHead(path: string, byteLength: number): Promise<Uint8Array>;
  readRanges(
    path: string,
    ranges: readonly { offset: number; byteLength: number }[],
  ): Promise<Uint8Array[]>;
  hash(path: string): Promise<string>;
  /** Carries the request to a renderer and brings back what its decoder did. */
  decode(request: ExportDecodeRequest): Promise<{ ok: boolean; error?: string }>;
}

export interface VerificationOutcome {
  verified: ExportVerification;
  /** `null` when every check passed. */
  failure: VerificationFailure | null;
  error: string | null;
}

/**
 * Run all five checks, plus the hash.
 *
 * Never throws for a *failed* export — a failure is the answer, and §7.5 requires
 * the partial `verified` record to be written either way so that "which check
 * stopped it" survives into `project.json`. It throws only when the I/O it was
 * handed fails, which is a different thing from the file being bad.
 */
export async function verifyExport(
  path: string,
  expectedDurationSec: number,
  io: VerificationIo,
): Promise<VerificationOutcome> {
  const verified: ExportVerification = {
    exists: false,
    bytes: 0,
    durationSec: 0,
    lastFrameDecodable: false,
    sha256: '',
  };

  const bytes = await io.size(path);
  if (bytes === null) {
    return { verified, failure: 'missing', error: `${path} is not there` };
  }
  verified.exists = true;
  verified.bytes = bytes;
  if (bytes === 0) {
    return { verified, failure: 'empty', error: `${path} is empty` };
  }

  let plan: DecodePlan;
  try {
    const probe = Math.min(bytes, HEADER_PROBE_BYTES);
    let head = await io.readHead(path, probe);
    const declared = movieHeaderLength(head);
    // A `moov` bigger than the probe is ordinary rather than exceptional: it holds a
    // size and an offset per sample, so an hour-long export's is megabytes.
    if (declared !== null && declared > head.byteLength) {
      head = await io.readHead(path, Math.min(bytes, declared));
    }
    plan = planVerification(head, expectedDurationSec);
  } catch (error) {
    if (error instanceof VerificationError) {
      return { verified, failure: error.failure, error: error.message };
    }
    throw error;
  }
  verified.durationSec = plan.movie.durationSec;

  const payloads = await io.readRanges(path, plan.ranges);
  const outcome = await io.decode({
    codec: plan.codec,
    codedWidth: plan.codedWidth,
    codedHeight: plan.codedHeight,
    description: plan.description,
    chunks: payloads.map((data, i) => ({
      data,
      isKey: plan.samples[i]?.isKey ?? false,
      timestampUs: plan.samples[i]?.timestampUs ?? 0,
    })),
    expectLastTimestampUs: plan.expectLastTimestampUs,
  });
  if (!outcome.ok) {
    return {
      verified,
      failure: 'last-frame',
      error: `the last frame of the export does not decode: ${outcome.error ?? 'no detail'}`,
    };
  }
  verified.lastFrameDecodable = true;
  verified.sha256 = await io.hash(path);
  return { verified, failure: null, error: null };
}
