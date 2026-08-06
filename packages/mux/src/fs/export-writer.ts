/**
 * The file descriptors an export is written through.
 *
 * One instance owns one output MP4 and the two temporary payload streams behind it.
 * Constructed only by `ProjectStore` — main is the only writer (architecture report
 * §0, rule 2), and `eslint.config.mjs` restricts `@loom/mux/fs` to that one file.
 *
 * ## Why there are three files and not one
 *
 * `moov` carries every sample's size and file offset, so a faststart file cannot be
 * written front to back in one pass (see `faststart.ts`). The samples therefore land
 * in two scratch streams — one per track — while the tables accumulate in memory,
 * and {@link ExportMp4Writer.finalize} assembles the real file behind the finished
 * header. That also decouples the output's interleave from the order the exporter
 * happens to produce samples in, which is what lets the audio pass run to completion
 * before the video pass starts.
 *
 * ## What a killed or cancelled export leaves
 *
 * **Nothing that could be mistaken for an export.** Architecture report §7.5,
 * obligation 1: sources are deleted only after a verified-good export, and phase 9
 * will act on the success signal this class produces. So:
 *
 *  - the output path is never opened for writing. The finished bytes are assembled
 *    in `<out>.partial`, `fsync`ed, and moved into place by `rename(2)`, exactly as
 *    `writeAtomic` does for documents — a reader at any instant sees no file or a
 *    complete one, never a growing one;
 *  - {@link ExportMp4Writer.cancel} removes every scratch file and the `.partial`;
 *  - a process killed at any point leaves only scratch files, which carry no `moov`
 *    and are not playable by anything, under names no user will mistake for output.
 *
 * Cancel is deliberately not "stop and keep what we have". A truncated export is a
 * shorter video that looks finished, and the one thing phase 9 must never delete
 * sources on the strength of.
 */

import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  FastStartWriter,
  type ChunkPlanEntry,
  type FastStartPlan,
  type FastStartSample,
  type FastStartWriterOptions,
} from '../faststart.ts';
import { writeAllBytes } from './io.ts';

/** Bytes copied per read/write while assembling the finished file. */
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ExportMp4WriterOptions extends FastStartWriterOptions {
  /** Absolute path of the finished `.mp4`. Never opened for writing. */
  outputPath: string;
  /**
   * Seconds of media between `fsync`s on the scratch streams.
   *
   * Lower than capture's cadence would be pointless — an interrupted export is
   * discarded rather than recovered, so this is about not holding minutes of a 4K
   * encode in the page cache, not about crash survival.
   */
  syncIntervalSec?: number;
}

export interface FinalizedExport {
  path: string;
  byteLength: number;
  durationSec: number;
  videoSampleCount: number;
  audioSampleCount: number;
}

type Lane = 'video' | 'audio';

interface Stream {
  path: string;
  handle: FileHandle;
  bytes: number;
  syncedBytes: number;
}

export class ExportMp4Writer {
  readonly #options: ExportMp4WriterOptions;
  readonly #plan: FastStartWriter;
  readonly #streams = new Map<Lane, Stream>();
  readonly #partialPath: string;
  /** Serializes appends, so bytes reach a scratch stream in the order produced. */
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(options: ExportMp4WriterOptions) {
    this.#options = options;
    this.#plan = new FastStartWriter(options);
    this.#partialPath = `${options.outputPath}.partial`;
  }

  /**
   * Open the scratch streams.
   *
   * `wx+` on both scratch paths — exclusive create, so a second export aimed at the
   * same destination is a refusal rather than two writers interleaving into one
   * file, and readable because {@link finalize} copies back out of them.
   */
  static async create(options: ExportMp4WriterOptions): Promise<ExportMp4Writer> {
    const writer = new ExportMp4Writer(options);
    try {
      for (const lane of ['video', 'audio'] as const) {
        if (lane === 'audio' && options.audio === undefined) continue;
        const path = `${options.outputPath}.${lane}.part`;
        const handle = await open(path, 'wx+', 0o644);
        writer.#streams.set(lane, { path, handle, bytes: 0, syncedBytes: 0 });
      }
    } catch (error) {
      await writer.cancel();
      throw error;
    }
    return writer;
  }

  get outputPath(): string {
    return this.#options.outputPath;
  }

  get videoSampleCount(): number {
    return this.#plan.videoSampleCount;
  }

  get audioSampleCount(): number {
    return this.#plan.audioSampleCount;
  }

  /** Seconds of video accepted so far, for progress. */
  get videoDurationSec(): number {
    return this.#plan.videoDurationSec;
  }

  /** Bytes handed to the scratch streams so far. */
  get mediaBytes(): number {
    let total = 0;
    for (const stream of this.#streams.values()) total += stream.bytes;
    return total;
  }

  appendVideo(sample: FastStartSample & { data: Uint8Array }): Promise<void> {
    return this.#append('video', sample);
  }

  appendAudio(sample: FastStartSample & { data: Uint8Array }): Promise<void> {
    return this.#append('audio', sample);
  }

  #append(lane: Lane, sample: FastStartSample & { data: Uint8Array }): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('this export writer is closed'));
    const stream = this.#streams.get(lane);
    if (stream === undefined) {
      return Promise.reject(new Error(`this export has no ${lane} track`));
    }
    // The table is updated synchronously, before the write is queued: it is what
    // decides the file's layout, and a caller that fires appends without awaiting
    // must still see a table in the order it offered the samples.
    const record: FastStartSample = {
      byteLength: sample.data.byteLength,
      durationUnits: sample.durationUnits,
      isKey: sample.isKey,
      ...(sample.timestampUs === undefined ? {} : { timestampUs: sample.timestampUs }),
    };
    if (lane === 'video') this.#plan.addVideoSample(record);
    else this.#plan.addAudioSample(record);

    const result = this.#chain.then(async () => {
      await writeAllBytes(stream.handle, sample.data, stream.path);
      stream.bytes += sample.data.byteLength;
      await maybeSync(stream, this.#syncEveryBytes);
    });
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * How many bytes of scratch accumulate between `fsync`s.
   *
   * Bytes rather than seconds of media, because that is what the page cache holds
   * and what this cadence is about. An interrupted export is discarded rather than
   * recovered (see the class comment), so nothing here is protecting data — it is
   * keeping minutes of a 4K encode from sitting dirty in memory.
   */
  get #syncEveryBytes(): number {
    return Math.max(1, Math.round(this.#options.syncIntervalSec ?? 4)) * 8 * 1024 * 1024;
  }

  /**
   * Assemble the finished file and move it into place.
   *
   * The order is the one `writeAtomic` documents and for the same reason: write,
   * `fsync` the file, `rename(2)`, then `fsync` the *directory* — the last step is
   * the one people leave out, and it is the one that loses the file.
   */
  async finalize(): Promise<FinalizedExport> {
    if (this.#closed) throw new Error('this export writer is closed');
    // Drain whatever was fired without awaiting, so the scratch streams hold every
    // sample the table describes before the plan is read.
    await this.#chain;
    const plan = this.#plan.plan();
    this.#assertStreamsMatch(plan);

    this.#closed = true;
    let renamed = false;
    try {
      for (const stream of this.#streams.values()) await stream.handle.sync();

      const out = await open(this.#partialPath, 'wx', 0o644);
      try {
        await writeAllBytes(out, plan.header, this.#partialPath);
        await this.#copyChunks(out, plan.chunks);
        await out.sync();
      } finally {
        await out.close();
      }

      await rename(this.#partialPath, this.#options.outputPath);
      renamed = true;

      const dir = await open(dirname(this.#options.outputPath), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await this.#closeStreams();
      if (!renamed) await unlink(this.#partialPath).catch(() => undefined);
      await this.#removeScratch();
    }

    return {
      path: this.#options.outputPath,
      byteLength: plan.totalBytes,
      durationSec: plan.durationSec,
      videoSampleCount: plan.videoSampleCount,
      audioSampleCount: plan.audioSampleCount,
    };
  }

  /**
   * The plan says how many bytes of each track's payload it will copy; the scratch
   * streams say how many are there. A mismatch means a short write nobody noticed,
   * and it would produce a file whose every offset after the shortfall is wrong —
   * which plays as garbage rather than as an error.
   */
  #assertStreamsMatch(plan: FastStartPlan): void {
    const expected: Record<Lane, number> = {
      video: plan.videoPayloadBytes,
      audio: plan.audioPayloadBytes,
    };
    for (const [lane, stream] of this.#streams) {
      if (stream.bytes !== expected[lane]) {
        throw new Error(
          `the ${lane} payload stream holds ${stream.bytes} bytes but the sample table ` +
            `describes ${expected[lane]}`,
        );
      }
    }
  }

  async #copyChunks(out: FileHandle, chunks: readonly ChunkPlanEntry[]): Promise<void> {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (const chunk of chunks) {
      const stream = this.#streams.get(chunk.track);
      if (stream === undefined) throw new Error(`no ${chunk.track} stream to copy from`);
      let remaining = chunk.byteLength;
      let position = chunk.payloadOffset;
      while (remaining > 0) {
        const want = Math.min(remaining, buffer.byteLength);
        const { bytesRead } = await stream.handle.read(buffer, 0, want, position);
        if (bytesRead <= 0) {
          throw new Error(`${stream.path} ended ${remaining} bytes before the plan said it would`);
        }
        await writeAllBytes(out, buffer.subarray(0, bytesRead), this.#partialPath);
        remaining -= bytesRead;
        position += bytesRead;
      }
    }
  }

  /**
   * Abandon the export, leaving nothing behind.
   *
   * Idempotent, and safe to call after {@link finalize}: the finished file has been
   * renamed by then, and only the scratch paths — already gone — are touched.
   */
  async cancel(): Promise<void> {
    this.#closed = true;
    await this.#chain.catch(() => undefined);
    await this.#closeStreams();
    await this.#removeScratch();
    await unlink(this.#partialPath).catch(() => undefined);
  }

  async #closeStreams(): Promise<void> {
    for (const stream of this.#streams.values()) {
      await stream.handle.close().catch(() => undefined);
    }
  }

  async #removeScratch(): Promise<void> {
    for (const stream of this.#streams.values()) {
      await unlink(stream.path).catch(() => undefined);
    }
    this.#streams.clear();
  }
}

async function maybeSync(stream: Stream, everyBytes: number): Promise<void> {
  if (stream.bytes - stream.syncedBytes < everyBytes) return;
  stream.syncedBytes = stream.bytes;
  await stream.handle.sync();
}
