/**
 * The file descriptor a capture part is written through.
 *
 * One instance owns one `media/<track>.<part>.mp4` and its `.index.json` sidecar.
 * It is constructed only by `ProjectStore` — main is the only writer (architecture
 * report §0, rule 2), and `eslint.config.mjs` restricts `@loom/mux/fs` to that one
 * file so the rule is structural rather than remembered.
 *
 * ## What makes a killed recording recoverable
 *
 * Three properties, and all three are here rather than spread across callers:
 *
 * 1. **The initialisation segment is written before the first frame.** A file with
 *    `ftyp` + an empty `moov` is a readable MP4 from the instant it exists. The
 *    alternative — a `moov` written when recording stops — is the configuration
 *    the architecture report measured at *zero* recovered frames (§12.2).
 * 2. **Every fragment reaches `write(2)` as soon as it exists.** A `SIGKILL` takes
 *    what the process still holds, not what the kernel already has; bytes handed to
 *    `write(2)` survive it. So nothing is batched here, and the append path is kept
 *    short on purpose — anything queued behind it is exactly what a crash costs.
 * 3. **`fsync` on a cadence of roughly one second of media** (§7.1). Measured at
 *    3.49 ms per call (§12.6), which is 0.35% of the second it protects. This one
 *    is about power loss rather than `SIGKILL`, and is cheap enough not to argue
 *    about.
 *
 * The frame index is held in memory and written at finalize. Architecture report
 * §2.4 asks for it to be written as chunks arrive "so it also survives a crash";
 * that property is met a better way — {@link recoverMediaPart} rebuilds the index
 * from the media file, whose fragments *were* written as chunks arrived, so the
 * index survives a crash without a growing JSON document being rewritten once a
 * second for the length of the recording (~1.2 GB of pointless writes over
 * 30 minutes, against a 2.3 GB recording).
 */

import { open, type FileHandle } from 'node:fs/promises';
import { writeAtomic } from '@loom/format/fs';
import type { FrameIndexDoc } from '@loom/format';
import {
  FragmentWriter,
  frameIndexDoc,
  partDurationSec,
  type ColourDescription,
  type EncodedSample,
  type IndexedFrame,
} from '../index.ts';

export interface MediaPartWriterOptions {
  /** Absolute path of `media/<track>.<part>.mp4`. */
  mediaPath: string;
  /** Absolute path of `media/<track>.<part>.index.json`. */
  indexPath: string;
  /** Coded size, in pixels. */
  width: number;
  height: number;
  /** The `avcC` record from `VideoDecoderConfig.description`. */
  avcC: Uint8Array;
  /** Requested capture rate. Used only for the final sample's duration. */
  nominalFps: number;
  colour?: ColourDescription;
  /** Seconds of media between `fsync`s. Architecture report §7.1 says ~1. */
  syncIntervalSec?: number;
}

export interface FinalizedPart {
  frameCount: number;
  keyframeCount: number;
  durationSec: number;
  observedFps: number;
  byteLength: number;
}

export class MediaPartWriter {
  private readonly options: MediaPartWriterOptions;
  private readonly writer: FragmentWriter;
  private readonly frames: IndexedFrame[] = [];
  private handle: FileHandle | null = null;
  private syncedThroughUnits = 0;
  /** Serializes appends, so bytes reach the file in the order they were produced. */
  private chain: Promise<void> = Promise.resolve();

  private constructor(options: MediaPartWriterOptions, handle: FileHandle) {
    this.options = options;
    this.writer = new FragmentWriter({ nominalFps: options.nominalFps });
    this.handle = handle;
  }

  /**
   * Create the part file and write its initialisation segment.
   *
   * `wx` rather than `w`: a part file that already exists means the part index was
   * reused, and silently truncating somebody's footage to find that out is not a
   * trade worth making.
   */
  static async create(options: MediaPartWriterOptions): Promise<MediaPartWriter> {
    const handle = await open(options.mediaPath, 'wx', 0o644);
    const part = new MediaPartWriter(options, handle);
    try {
      const init = part.writer.begin({
        width: options.width,
        height: options.height,
        timescale: part.writer.timescaleUnits,
        avcC: options.avcC,
        ...(options.colour === undefined ? {} : { colour: options.colour }),
      });
      await part.writeAll(handle, init);
      // The header is fsync'd immediately. Everything after it is recoverable only
      // if this is on disk, so it is the one write that does not wait for a cadence.
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    return part;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Frames produced but not yet on the file — what a `SIGKILL` would cost. */
  get pendingFrames(): number {
    return this.writer.pending;
  }

  /**
   * Append one encoded sample.
   *
   * Resolves once the bytes for the *previous* sample are with the kernel. The
   * one-sample lag is {@link FragmentWriter}'s, and is what buys exact durations on
   * a variable-rate screen track.
   */
  append(sample: EncodedSample): Promise<void> {
    return this.enqueue(async (handle) => {
      const emitted = this.writer.push(sample);
      if (emitted === null) return;
      await this.writeAll(handle, emitted.bytes);
      this.frames.push(emitted.frame);
      await this.syncIfDue(handle, emitted.frame);
    });
  }

  /**
   * Write the held sample, the index sidecar, and close.
   *
   * `endTimestampUs` is when capture stopped, on the encoder's clock; it is what
   * lets the last frame stand for the still screen that followed it rather than for
   * a nominal 1/30 s. See {@link FragmentWriter.flush}.
   *
   * Order matters: media bytes and their `fsync` first, then the sidecar. The
   * sidecar describes the media, so a sidecar durable ahead of the media it
   * describes would be a lie a reader could act on.
   *
   * The `finally` is not decoration. `ProjectStore` drops this writer from its map
   * before calling us, so if the sidecar write threw and the descriptor were left
   * open, nothing could ever reclaim it — not `close(id)`, not `abortAllMediaParts`.
   * {@link abort} has always been safe this way; so is this.
   */
  async finalize(endTimestampUs?: number): Promise<FinalizedPart> {
    try {
      return await this.enqueue(async (handle) => {
        const last = this.writer.flush(endTimestampUs);
        if (last !== null) {
          await this.writeAll(handle, last.bytes);
          this.frames.push(last.frame);
        }
        await handle.sync();
        await writeAtomic(this.options.indexPath, indexBytes(this.indexDoc()));
        return this.summary();
      });
    } finally {
      await this.close();
    }
  }

  /**
   * Give up on this part without losing what it already holds.
   *
   * Used when capture fails partway: the bytes already written stay, the held
   * sample is written if it can be, and the sidecar is produced from whatever the
   * part actually contains. "Withhold what cannot be verified, open what can"
   * (`decision-journal-damage-recovery`) applies to a failed capture as much as to
   * a damaged journal.
   */
  async abort(): Promise<FinalizedPart> {
    const summary = await this.enqueue(async (handle) => {
      try {
        const last = this.writer.flush();
        if (last !== null) {
          await this.writeAll(handle, last.bytes);
          this.frames.push(last.frame);
        }
        await handle.sync();
        await writeAtomic(this.options.indexPath, indexBytes(this.indexDoc()));
      } catch {
        // An abort that throws would mask the failure that caused it. The media
        // file keeps whatever reached the kernel, and recovery rebuilds the index
        // from it.
      }
      return this.summary();
    }).catch(() => this.summary());
    await this.close();
    return summary;
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) await handle.close().catch(() => undefined);
  }

  private indexDoc(): FrameIndexDoc {
    return frameIndexDoc(this.frames, this.writer.timescaleUnits);
  }

  private summary(): FinalizedPart {
    const durationSec = partDurationSec(this.frames, this.writer.timescaleUnits);
    return {
      frameCount: this.frames.length,
      keyframeCount: this.frames.filter((f) => f.isKey).length,
      durationSec,
      observedFps: durationSec > 0 ? this.frames.length / durationSec : 0,
      byteLength: this.writer.byteLength,
    };
  }

  private async syncIfDue(handle: FileHandle, frame: IndexedFrame): Promise<void> {
    const interval = (this.options.syncIntervalSec ?? 1) * this.writer.timescaleUnits;
    if (frame.ptsUnits - this.syncedThroughUnits < interval) return;
    this.syncedThroughUnits = frame.ptsUnits;
    await handle.sync();
  }

  /** `write(2)` may write fewer bytes than it was given; loop until it has them all. */
  private async writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
      if (bytesWritten <= 0) {
        throw new Error(`write to ${this.options.mediaPath} made no progress`);
      }
      offset += bytesWritten;
    }
  }

  private enqueue<T>(work: (handle: FileHandle) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const handle = this.handle;
      if (handle === null) throw new Error(`${this.options.mediaPath} is closed`);
      return work(handle);
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** The sidecar, serialized exactly as `writeJsonAtomic` would. */
export function indexBytes(doc: FrameIndexDoc): Uint8Array {
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}
