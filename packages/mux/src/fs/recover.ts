/**
 * Reading a capture part back after a crash. Architecture report §7.1.
 *
 * The contract is the captain's, from `decision-journal-damage-recovery`:
 * *"withhold what cannot be verified, open what can, and tell the user what was
 * lost."* Concretely, for a media part:
 *
 * - every `moof`/`mdat` pair that is **wholly** present contributes its frames;
 * - the first pair that is not is where the recording ends, and everything from
 *   there is truncated away — a torn tail welded onto the file is how the *next*
 *   thing to read it silently loses more than the crash did;
 * - the frame index is rebuilt from the fragments themselves rather than trusted
 *   from a sidecar that may predate the crash;
 * - nothing is inferred. A fragment this build cannot fully account for stops the
 *   scan; it never contributes a guessed frame.
 *
 * Video and audio parts are the same file shape — `ftyp | moov | (moof mdat)*` —
 * so they are scanned by the same walk. They differ only in what the fragments
 * mean: frames with durations to be indexed, or samples to be counted.
 */

import { open, type FileHandle } from 'node:fs/promises';
import { writeAtomic } from '@loom/format/fs';
import {
  MAX_BOX_HEADER_BYTES,
  MIN_BOX_HEADER_BYTES,
  Mp4ParseError,
  codecStringFromAsc,
  codecStringFromAvcC,
  frameIndexDoc,
  parseAudioInitSegment,
  parseInitSegment,
  parseMoof,
  partDurationSec,
  readBoxHeader,
  type IndexedFrame,
} from '../index.ts';
import { indexBytes } from './media-part-writer.ts';

/** Enough for the initialisation segment; ours is well under a kilobyte. */
const HEADER_WINDOW_BYTES = 64 * 1024;

/** One read per fragment: a `moof` is ~110 bytes and the `mdat` header follows it. */
const FRAGMENT_WINDOW_BYTES = 8 * 1024;

export interface RecoveredPart {
  frameCount: number;
  keyframeCount: number;
  durationSec: number;
  observedFps: number;
  /** Coded size read back from the initialisation segment. */
  size: [number, number];
  /** `avc1.PPCCLL`, from the `avcC` record. */
  codec: string;
  timescale: number;
  /** Bytes discarded from a torn tail. `0` when the file ended on a fragment boundary. */
  truncatedBytes: number;
  /** Total bytes the recovered part occupies. */
  byteLength: number;
}

/**
 * What survived of an audio part.
 *
 * Deliberately smaller than {@link RecoveredPart}: `startTimeSec`,
 * `measuredSampleRate` and `gaps` are **not** in this list, because they are not in
 * the file. They were measured against the capture clock by the process that died
 * (§5.5), and a scanner that invented them would be guessing at the one set of
 * numbers A/V sync depends on. The caller keeps whatever the provisional
 * `recording.json` recorded and marks the recording recovered.
 */
export interface RecoveredAudioPart {
  frameCount: number;
  /** Samples per channel in the file, encoder priming included. */
  sampleCount: number;
  /**
   * Priming samples the part's edit list tells a reader to skip.
   *
   * The difference between the samples in the file and the samples anyone will
   * hear — 2112 of them, 44 ms, twice this project's sync budget. A caller
   * turning {@link sampleCount} into an `AudioPart.durationSec` has to subtract
   * it, because `startTimeSec` is defined on the *decoded* stream.
   */
  encoderDelaySamples: number;
  /** Duration of the media in the file, at the nominal rate, priming included. */
  mediaDurationSec: number;
  sampleRate: number;
  channels: number;
  /** `mp4a.40.2`, from the `esds` AudioSpecificConfig. */
  codec: string;
  truncatedBytes: number;
  byteLength: number;
}

export class UnrecoverablePartError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} cannot be recovered: ${reason}`);
    this.name = 'UnrecoverablePartError';
  }
}

/**
 * Repair one capture part in place and rewrite its index sidecar.
 *
 * Returns the facts `recording.json` needs. Throws only when the file has no
 * readable initialisation segment at all — a part with a header and zero
 * fragments recovers as an empty part, which is a thing the caller can report
 * rather than a thing that stops a bundle from opening.
 */
export async function recoverMediaPart(
  mediaPath: string,
  indexPath: string,
): Promise<RecoveredPart> {
  const handle = await open(mediaPath, 'r+');
  try {
    const { size: fileBytes } = await handle.stat();
    const header = await readHeaderWindow(handle, fileBytes);
    let facts;
    try {
      facts = parseInitSegment(header);
    } catch (error) {
      throw new UnrecoverablePartError(
        mediaPath,
        error instanceof Mp4ParseError ? error.message : String(error),
      );
    }

    const scan = await scanFragments(handle, fileBytes, initSegmentEnd(header));
    const frames = scan.samples;
    const truncatedBytes = await truncateTornTail(handle, scan.endsAt, fileBytes);

    await writeAtomic(indexPath, indexBytes(frameIndexDoc(frames, facts.timescale)));

    const durationSec = partDurationSec(frames, facts.timescale);
    return {
      frameCount: frames.length,
      keyframeCount: frames.filter((f) => f.isKey).length,
      durationSec,
      observedFps: durationSec > 0 ? frames.length / durationSec : 0,
      size: [facts.width, facts.height],
      codec: codecStringFromAvcC(facts.avcC),
      timescale: facts.timescale,
      truncatedBytes,
      byteLength: scan.endsAt,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Repair one audio part in place.
 *
 * The same walk as {@link recoverMediaPart}, with no sidecar to write: what an
 * audio part needs back is how many samples survived, which is the sum of the
 * fragment durations, in a timescale that is the sample rate.
 */
export async function recoverAudioPart(mediaPath: string): Promise<RecoveredAudioPart> {
  const handle = await open(mediaPath, 'r+');
  try {
    const { size: fileBytes } = await handle.stat();
    const header = await readHeaderWindow(handle, fileBytes);
    let facts;
    try {
      facts = parseAudioInitSegment(header);
    } catch (error) {
      throw new UnrecoverablePartError(
        mediaPath,
        error instanceof Mp4ParseError ? error.message : String(error),
      );
    }

    const scan = await scanFragments(handle, fileBytes, initSegmentEnd(header));
    const truncatedBytes = await truncateTornTail(handle, scan.endsAt, fileBytes);
    const last = scan.samples.at(-1);
    const sampleCount = last === undefined ? 0 : last.ptsUnits + last.durationUnits;

    return {
      frameCount: scan.samples.length,
      sampleCount,
      encoderDelaySamples: facts.encoderDelaySamples,
      mediaDurationSec: facts.timescale > 0 ? sampleCount / facts.timescale : 0,
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      codec: codecStringFromAsc(facts.audioSpecificConfig),
      truncatedBytes,
      byteLength: scan.endsAt,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Walk `moof`/`mdat` pairs from `from` until one is not wholly present.
 *
 * The stopping rule is the whole of recovery: a pair that cannot be fully
 * accounted for ends the file, and nothing after it is looked at. `tfdt` carries
 * each fragment's exact decode time, `tfhd` its sample's size and sync flag, and
 * the `mdat` position gives the byte offset — so the index is derivable from bytes
 * that were written as chunks arrived rather than from a checkpoint that may be
 * stale.
 */
async function scanFragments(
  handle: FileHandle,
  fileBytes: number,
  from: number,
): Promise<{ samples: IndexedFrame[]; endsAt: number }> {
  let at = from;
  const samples: IndexedFrame[] = [];
  const window = Buffer.alloc(FRAGMENT_WINDOW_BYTES);

  for (;;) {
    // A box header is eight bytes; sixteen only when it carries a 64-bit
    // `largesize`, which this writer never emits. Requiring sixteen here dropped
    // the last fragment of an audio part whose final frame was a few bytes of
    // silence — a real file, and a frame lost for no reason.
    if (at + MIN_BOX_HEADER_BYTES > fileBytes) break;
    const { bytesRead } = await handle.read(
      window,
      0,
      Math.min(window.byteLength, fileBytes - at),
      at,
    );
    const view = window.subarray(0, bytesRead);

    const moofHeader = readBoxHeader(view, 0);
    if (moofHeader?.type !== 'moof') break;
    if (at + moofHeader.size > fileBytes) break;

    // A `moof` larger than the window is not ours, but reading it costs one
    // syscall and refusing to would be a silent frame loss.
    let moofBytes = view.subarray(0, moofHeader.size);
    if (moofHeader.size > view.byteLength) {
      const wide = Buffer.alloc(moofHeader.size);
      await handle.read(wide, 0, moofHeader.size, at);
      moofBytes = wide;
    }

    let parsed;
    try {
      parsed = parseMoof(moofBytes);
    } catch {
      break;
    }

    const mdatAt = at + moofHeader.size;
    const mdatHeader =
      mdatAt - at + MIN_BOX_HEADER_BYTES <= view.byteLength
        ? readBoxHeader(view, mdatAt - at)
        : await readHeaderAt(handle, mdatAt, fileBytes);
    if (mdatHeader?.type !== 'mdat') break;
    if (mdatAt + mdatHeader.size > fileBytes) break;

    const payloadBytes = mdatHeader.size - mdatHeader.headerBytes;
    const declared = parsed.samples.reduce((sum, s) => sum + s.sizeBytes, 0);
    if (declared > payloadBytes) break;

    let offset = mdatAt + mdatHeader.headerBytes;
    let pts = parsed.baseMediaDecodeTime;
    for (const sample of parsed.samples) {
      samples.push({
        ptsUnits: pts,
        durationUnits: sample.durationUnits,
        sizeBytes: sample.sizeBytes,
        offsetBytes: offset,
        isKey: sample.isKey,
      });
      pts += sample.durationUnits;
      offset += sample.sizeBytes;
    }

    at = mdatAt + mdatHeader.size;
  }

  return { samples, endsAt: at };
}

/**
 * Cut off whatever was being written when the process died.
 *
 * Removed rather than left in place: the next writer would append after it,
 * welding a partial box to a whole one, and the damage would outlive the crash
 * that caused it.
 */
async function truncateTornTail(
  handle: FileHandle,
  endsAt: number,
  fileBytes: number,
): Promise<number> {
  const truncatedBytes = fileBytes - endsAt;
  if (truncatedBytes > 0) {
    await handle.truncate(endsAt);
    await handle.sync();
  }
  return truncatedBytes;
}

async function readHeaderWindow(handle: FileHandle, fileBytes: number): Promise<Buffer> {
  const header = Buffer.alloc(Math.min(HEADER_WINDOW_BYTES, fileBytes));
  await handle.read(header, 0, header.byteLength, 0);
  return header;
}

/** Byte offset just past the last top-level box before the first fragment. */
function initSegmentEnd(header: Uint8Array): number {
  let at = 0;
  for (;;) {
    const box = readBoxHeader(header, at);
    if (box === null || at + box.size > header.byteLength) return at;
    if (box.type === 'moof') return at;
    at += box.size;
  }
}

async function readHeaderAt(
  handle: FileHandle,
  at: number,
  fileBytes: number,
): Promise<ReturnType<typeof readBoxHeader>> {
  const available = Math.min(MAX_BOX_HEADER_BYTES, fileBytes - at);
  if (available < MIN_BOX_HEADER_BYTES) return null;
  const buffer = Buffer.alloc(available);
  await handle.read(buffer, 0, available, at);
  return readBoxHeader(buffer, 0);
}
