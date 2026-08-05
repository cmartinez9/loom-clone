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
 */

import { open } from 'node:fs/promises';
import { writeAtomic } from '@loom/format/fs';
import {
  MAX_BOX_HEADER_BYTES,
  Mp4ParseError,
  codecStringFromAvcC,
  frameIndexDoc,
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

    const header = Buffer.alloc(Math.min(HEADER_WINDOW_BYTES, fileBytes));
    await handle.read(header, 0, header.byteLength, 0);
    let facts;
    try {
      facts = parseInitSegment(header);
    } catch (error) {
      throw new UnrecoverablePartError(
        mediaPath,
        error instanceof Mp4ParseError ? error.message : String(error),
      );
    }

    let at = initSegmentEnd(header);
    const frames: IndexedFrame[] = [];
    const window = Buffer.alloc(FRAGMENT_WINDOW_BYTES);

    for (;;) {
      if (at + MAX_BOX_HEADER_BYTES > fileBytes) break;
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
        mdatAt - at + MAX_BOX_HEADER_BYTES <= view.byteLength
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
        frames.push({
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

    const truncatedBytes = fileBytes - at;
    if (truncatedBytes > 0) {
      // The tail is a fragment that was being written when the process died. It is
      // removed rather than left in place: the next writer would append after it,
      // welding a partial box to a whole one.
      await handle.truncate(at);
      await handle.sync();
    }

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
      byteLength: at,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
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
  handle: Awaited<ReturnType<typeof open>>,
  at: number,
  fileBytes: number,
): Promise<ReturnType<typeof readBoxHeader>> {
  if (at + MAX_BOX_HEADER_BYTES > fileBytes) return null;
  const buffer = Buffer.alloc(MAX_BOX_HEADER_BYTES);
  await handle.read(buffer, 0, MAX_BOX_HEADER_BYTES, at);
  return readBoxHeader(buffer, 0);
}
