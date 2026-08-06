/**
 * The **export** MP4: one file, `moov` first, real sample tables.
 *
 * Architecture report §1.3 names the two halves of this package — *"MP4 writer
 * (fragmented for capture, faststart for export)"*. `fragment-writer.ts` is the
 * first; this is the second, and the two are deliberately different shapes because
 * they are solving opposite problems:
 *
 * | | capture (`FragmentWriter`) | export (this file) |
 * |---|---|---|
 * | layout | `ftyp` `moov`(empty) `moof`+`mdat` × n | `ftyp` `moov`(full) `mdat` |
 * | optimised for | surviving `SIGKILL` mid-write | being opened and scrubbed |
 * | sample table | rebuilt by scanning (§12.2) | written once, at the end |
 * | a crash costs | the fragment in hand | the whole export, on purpose |
 *
 * A killed export is *supposed* to leave nothing: §7.5's obligation 1 is that
 * sources are deleted only after a verified-good export, and a half-finished file
 * that a scanner could partially recover is the one artifact that must never be
 * mistaken for one. `ExportMp4Writer` (in `@loom/mux/fs`) is what enforces that;
 * this class only ever produces bytes.
 *
 * ## Why `moov` first, and what it costs
 *
 * `moov` carries every sample's size and file offset, so it cannot be written until
 * the last sample exists. A writer that streams samples straight into the output
 * therefore has to put `moov` at the *end* — which is a legal MP4 that QuickTime,
 * Premiere and every browser will open, and then seek to the end of before they can
 * play a frame. `-movflags +faststart` is ffmpeg's name for fixing that, and the fix
 * is a second pass: assemble the header once the tables are known, then copy the
 * media in behind it.
 *
 * So this class does not write anything. It **plans**: {@link FastStartWriter.plan}
 * returns the finished `ftyp` + `moov` + `mdat` header and the exact list of byte
 * ranges to copy out of each track's payload stream, in output order. The caller
 * owns the streams and the copy — which is what keeps a 4 GB export out of this
 * process's heap, and what lets the whole layout be tested against bytes with no
 * filesystem at all.
 *
 * ## Interleaving
 *
 * Samples are grouped into chunks of about {@link DEFAULT_CHUNK_SEC} of media,
 * alternating video and audio. That is why the two payload streams are separate:
 * the exporter produces all of one track and then all of the other (audio first —
 * it is seconds of work against minutes for video), and the interleave is applied
 * at plan time rather than being a constraint on the order frames are encoded in.
 * Each chunk is a contiguous run of one track's samples, so the copy is sequential
 * in both inputs and in the output.
 *
 * ## No `ctts`, and why that is checked rather than assumed
 *
 * The export encoder runs with no B-frames, so decode order is presentation order
 * and a composition-offset table is unnecessary. If it ever stopped being true the
 * file would silently present frames in the wrong order, so
 * {@link FastStartWriter.addVideoSample} refuses a timestamp that goes backwards
 * instead of writing a table that cannot express it.
 */

import {
  UNITY_MATRIX,
  audioSampleEntry,
  avcSampleEntry,
  box,
  concat,
  editList,
  fixed16_16,
  fourcc,
  fullBox,
  u16,
  u32,
  u64,
  MOVIE_TIMESCALE,
  type AudioInitSegmentSpec,
  type ColourDescription,
  type InitSegmentSpec,
} from './boxes.ts';
import { AAC_FRAME_SAMPLES } from './audio-fragment-writer.ts';

const encoder = new TextEncoder();
const ZERO = (count: number): Uint8Array => new Uint8Array(count);

/** Track ids. Video is 1 so a video-only export matches the capture files' `trak`. */
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;

/** Seconds of media per chunk. One second is what every muxer in the wild uses. */
export const DEFAULT_CHUNK_SEC = 1;

/** Largest `mdat` payload a 32-bit box size can carry, header included. */
const MAX_32BIT_MDAT_PAYLOAD = 0xffff_ffff - 8;

export interface FastStartVideoSpec {
  /** Coded size in pixels — the output size the compositor rendered at. */
  width: number;
  height: number;
  /**
   * Units per second on the video media timeline.
   *
   * The exporter uses `fps * 1000`, so every frame is exactly 1000 units and a CFR
   * output has no rounding in its timebase at all. A microsecond timescale would
   * put 33333.333 µs frames in a 30 fps file and accumulate a millisecond every
   * hundred seconds.
   */
  timescale: number;
  /** The `avcC` record from the encoder's `VideoDecoderConfig.description`. */
  avcC: Uint8Array;
  colour?: ColourDescription;
}

export interface FastStartAudioSpec {
  /** The rate the mixed stream was encoded at. Also the media timescale. */
  sampleRate: number;
  channels: number;
  /** `AudioDecoderConfig.description` — the AudioSpecificConfig. */
  audioSpecificConfig: Uint8Array;
  bitrate?: number;
  /**
   * Priming samples to trim on playback, written as an `elst`.
   *
   * Defaults to the platform's AAC delay. Getting this wrong is 44 ms of lip-sync
   * error — see `AAC_ENCODER_DELAY_SAMPLES`, which measured it.
   */
  encoderDelaySamples?: number;
}

export interface FastStartWriterOptions {
  video: FastStartVideoSpec;
  audio?: FastStartAudioSpec;
  chunkSec?: number;
}

/** One sample, as it is offered to the writer. The bytes stay with the caller. */
export interface FastStartSample {
  byteLength: number;
  /** Duration in that track's media timescale units. */
  durationUnits: number;
  isKey: boolean;
  /** Microseconds, for the monotonicity check. Video only. */
  timestampUs?: number;
}

/** One contiguous run of one track's samples, to be copied into the `mdat`. */
export interface ChunkPlanEntry {
  track: 'video' | 'audio';
  /** Byte offset of this run inside that track's own payload stream. */
  payloadOffset: number;
  byteLength: number;
  /** 0-based index of this run's first sample within its track. */
  firstSample: number;
  sampleCount: number;
}

export interface FastStartPlan {
  /** `ftyp` + `moov` + the `mdat` box header. Written first, in one call. */
  header: Uint8Array;
  /** The copy list, in output order. */
  chunks: ChunkPlanEntry[];
  /** Bytes of sample data inside the `mdat`. */
  mdatPayloadBytes: number;
  /** `header.byteLength + mdatPayloadBytes` — what the finished file will measure. */
  totalBytes: number;
  /** Movie duration, seconds. What verification compares against the expectation. */
  durationSec: number;
  videoSampleCount: number;
  audioSampleCount: number;
  videoPayloadBytes: number;
  audioPayloadBytes: number;
}

export class FastStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FastStartError';
  }
}

interface TrackTable {
  sizes: number[];
  durations: number[];
  /** 1-based sample numbers, as `stss` stores them. */
  syncSamples: number[];
  payloadBytes: number;
  durationUnits: number;
}

function emptyTable(): TrackTable {
  return { sizes: [], durations: [], syncSamples: [], payloadBytes: 0, durationUnits: 0 };
}

export class FastStartWriter {
  readonly #options: Required<Pick<FastStartWriterOptions, 'chunkSec'>> & FastStartWriterOptions;
  readonly #video = emptyTable();
  readonly #audio = emptyTable();
  #lastVideoTimestampUs = Number.NEGATIVE_INFINITY;

  constructor(options: FastStartWriterOptions) {
    if (options.video.timescale <= 0 || !Number.isInteger(options.video.timescale)) {
      throw new FastStartError(`video timescale must be a positive integer`);
    }
    if (options.video.avcC.byteLength === 0) {
      throw new FastStartError('an export needs the encoder’s avcC to describe its samples');
    }
    if (options.audio?.audioSpecificConfig.byteLength === 0) {
      throw new FastStartError('an audio track needs an AudioSpecificConfig');
    }
    this.#options = { chunkSec: options.chunkSec ?? DEFAULT_CHUNK_SEC, ...options };
  }

  get videoSampleCount(): number {
    return this.#video.sizes.length;
  }

  get audioSampleCount(): number {
    return this.#audio.sizes.length;
  }

  /** Bytes of video sample data offered so far — the video payload stream's length. */
  get videoPayloadBytes(): number {
    return this.#video.payloadBytes;
  }

  get audioPayloadBytes(): number {
    return this.#audio.payloadBytes;
  }

  /** Seconds of video accepted so far. Drives export progress. */
  get videoDurationSec(): number {
    return this.#video.durationUnits / this.#options.video.timescale;
  }

  addVideoSample(sample: FastStartSample): void {
    const at = sample.timestampUs;
    if (at !== undefined) {
      // No `ctts` is written, so decode order *is* presentation order. A backwards
      // timestamp means the encoder emitted B-frames and this table cannot describe
      // the file — which would present frames in the wrong order with nothing to
      // say about it.
      if (at < this.#lastVideoTimestampUs) {
        throw new FastStartError(
          `video sample timestamps went backwards (${at} after ${this.#lastVideoTimestampUs}); ` +
            'the export encoder must not emit B-frames',
        );
      }
      this.#lastVideoTimestampUs = at;
    }
    push(this.#video, sample);
  }

  addAudioSample(sample: FastStartSample): void {
    if (this.#options.audio === undefined) {
      throw new FastStartError('this export has no audio track to add a sample to');
    }
    push(this.#audio, sample);
  }

  /**
   * The finished header and the copy list.
   *
   * Two passes over the `moov`: the first learns its length with the chunk offsets
   * zeroed, the second writes the real ones. `co64` is used unconditionally, so the
   * box is a fixed size whatever the offsets turn out to be and the second pass
   * cannot change the length the first one measured. (A `stco` would be half the
   * size and would have to be re-measured whenever an offset crossed 4 GB — which
   * is a fixed point iteration in exchange for a few kilobytes.)
   */
  plan(): FastStartPlan {
    if (this.#video.sizes.length === 0) {
      throw new FastStartError('an export must contain at least one video frame');
    }

    const chunks = this.#planChunks();
    const mdatPayloadBytes = this.#video.payloadBytes + this.#audio.payloadBytes;
    const mdatHeaderBytes = mdatPayloadBytes > MAX_32BIT_MDAT_PAYLOAD ? 16 : 8;
    const ftyp = exportFtyp();

    const measure = this.#movie(chunks, new Float64Array(chunks.length));
    const mediaStart = ftyp.byteLength + measure.byteLength + mdatHeaderBytes;

    const offsets = new Float64Array(chunks.length);
    let cursor = mediaStart;
    for (const [i, chunk] of chunks.entries()) {
      offsets[i] = cursor;
      cursor += chunk.byteLength;
    }
    const moov = this.#movie(chunks, offsets);
    if (moov.byteLength !== measure.byteLength) {
      // Impossible while `co64` is fixed-width, and worth failing loudly rather than
      // shipping a file whose every chunk offset is wrong by the difference.
      throw new FastStartError('moov length changed between the measuring and writing passes');
    }

    const mdatHeader =
      mdatHeaderBytes === 8
        ? concat([u32(mdatPayloadBytes + 8), fourcc('mdat')])
        : concat([u32(1), fourcc('mdat'), u64(mdatPayloadBytes + 16)]);

    return {
      header: concat([ftyp, moov, mdatHeader]),
      chunks,
      mdatPayloadBytes,
      totalBytes: mediaStart + mdatPayloadBytes,
      durationSec: this.#durationSec(),
      videoSampleCount: this.#video.sizes.length,
      audioSampleCount: this.#audio.sizes.length,
      videoPayloadBytes: this.#video.payloadBytes,
      audioPayloadBytes: this.#audio.payloadBytes,
    };
  }

  /** Longest track, in seconds. */
  #durationSec(): number {
    const video = this.#video.durationUnits / this.#options.video.timescale;
    const audio =
      this.#options.audio === undefined
        ? 0
        : this.#audio.durationUnits / this.#options.audio.sampleRate;
    return Math.max(video, audio);
  }

  /**
   * Group both tracks into ~`chunkSec` runs, alternating video then audio.
   *
   * Walking by time rather than by sample count is what keeps the interleave honest
   * on a track whose samples are not all the same length — and the video track's
   * are, today, only because the output is CFR.
   */
  #planChunks(): ChunkPlanEntry[] {
    const windowSec = Math.max(0.05, this.#options.chunkSec);
    const lanes = [
      new ChunkLane('video', this.#video, this.#options.video.timescale),
      new ChunkLane('audio', this.#audio, this.#options.audio?.sampleRate ?? 1),
    ];

    const chunks: ChunkPlanEntry[] = [];
    let windowEndSec = windowSec;
    while (lanes.some((lane) => !lane.done)) {
      const before = chunks.length;
      for (const lane of lanes) lane.take(windowEndSec, chunks);
      if (chunks.length === before) {
        // Every remaining sample is at or past the window and the window is not
        // advancing fast enough to reach it — which a zero-length track can arrange.
        // Emitting the tails outright terminates rather than spinning.
        for (const lane of lanes) lane.take(Number.POSITIVE_INFINITY, chunks);
        break;
      }
      windowEndSec += windowSec;
    }
    return chunks;
  }

  #movie(chunks: readonly ChunkPlanEntry[], offsets: Float64Array): Uint8Array {
    const video = this.#options.video;
    const audio = this.#options.audio;
    const durationMovieUnits = Math.round(this.#durationSec() * MOVIE_TIMESCALE);

    const videoSpec: InitSegmentSpec = {
      width: video.width,
      height: video.height,
      timescale: video.timescale,
      avcC: video.avcC,
      ...(video.colour === undefined ? {} : { colour: video.colour }),
    };

    const traks: Uint8Array[] = [
      trackBox({
        trackId: VIDEO_TRACK_ID,
        handler: 'vide',
        handlerName: 'VideoHandler',
        mediaHeader: fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
        sampleEntry: avcSampleEntry(videoSpec),
        timescale: video.timescale,
        table: this.#video,
        chunks,
        offsets,
        track: 'video',
        width: video.width,
        height: video.height,
        volume: 0,
        durationMovieUnits: Math.round(
          (this.#video.durationUnits / video.timescale) * MOVIE_TIMESCALE,
        ),
        writeSyncTable: true,
      }),
    ];

    if (audio !== undefined && this.#audio.sizes.length > 0) {
      const audioSpec: AudioInitSegmentSpec = {
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        audioSpecificConfig: audio.audioSpecificConfig,
        ...(audio.bitrate === undefined ? {} : { bitrate: audio.bitrate }),
      };
      const delaySamples = Math.max(0, Math.round(audio.encoderDelaySamples ?? 0));
      const audioMovieUnits = Math.round(
        ((this.#audio.durationUnits - delaySamples) / audio.sampleRate) * MOVIE_TIMESCALE,
      );
      traks.push(
        trackBox({
          trackId: AUDIO_TRACK_ID,
          handler: 'soun',
          handlerName: 'SoundHandler',
          mediaHeader: fullBox('smhd', 0, 0, u16(0), u16(0)),
          sampleEntry: audioSampleEntry(audioSpec),
          timescale: audio.sampleRate,
          table: this.#audio,
          chunks,
          offsets,
          track: 'audio',
          width: 0,
          height: 0,
          volume: 0x0100,
          durationMovieUnits: Math.max(0, audioMovieUnits),
          writeSyncTable: false,
          // The whole point of a finished file: the priming samples are in the
          // stream and this is what tells every demuxer to skip them. Unlike the
          // capture parts, the segment duration *is* known here, so it is written.
          ...(delaySamples > 0
            ? { edit: editList(delaySamples, Math.max(0, audioMovieUnits)) }
            : {}),
        }),
      );
    }

    return box(
      'moov',
      fullBox(
        'mvhd',
        0,
        0,
        u32(0), // creation_time
        u32(0), // modification_time
        u32(MOVIE_TIMESCALE),
        u32(durationMovieUnits),
        u32(0x0001_0000), // rate 1.0
        u16(0x0100), // volume 1.0
        u16(0), // reserved
        ZERO(8), // reserved
        UNITY_MATRIX,
        ZERO(24), // pre_defined
        u32(AUDIO_TRACK_ID + 1),
      ),
      ...traks,
    );
  }
}

function push(table: TrackTable, sample: FastStartSample): void {
  if (sample.byteLength <= 0) throw new FastStartError('a sample with no bytes is not a sample');
  if (sample.durationUnits <= 0) throw new FastStartError('a sample needs a positive duration');
  table.sizes.push(sample.byteLength);
  table.durations.push(sample.durationUnits);
  if (sample.isKey) table.syncSamples.push(table.sizes.length);
  table.payloadBytes += sample.byteLength;
  table.durationUnits += sample.durationUnits;
}

/**
 * One track's position in the interleave.
 *
 * It carries its own elapsed time rather than recomputing a prefix sum, which is
 * what keeps {@link FastStartWriter.plan} linear in the sample count on an hour-long
 * export.
 */
class ChunkLane {
  #at = 0;
  #payloadOffset = 0;
  #elapsedUnits = 0;

  constructor(
    private readonly track: 'video' | 'audio',
    private readonly table: TrackTable,
    private readonly timescale: number,
  ) {}

  get done(): boolean {
    return this.#at >= this.table.sizes.length;
  }

  /** Emit one chunk holding every sample that starts before `untilSec`. */
  take(untilSec: number, into: ChunkPlanEntry[]): void {
    const first = this.#at;
    let bytes = 0;
    while (this.#at < this.table.sizes.length && this.#elapsedUnits / this.timescale < untilSec) {
      bytes += this.table.sizes[this.#at] ?? 0;
      this.#elapsedUnits += this.table.durations[this.#at] ?? 0;
      this.#at += 1;
    }
    if (this.#at === first) return;
    into.push({
      track: this.track,
      payloadOffset: this.#payloadOffset,
      byteLength: bytes,
      firstSample: first,
      sampleCount: this.#at - first,
    });
    this.#payloadOffset += bytes;
  }
}

interface TrackBoxSpec {
  trackId: number;
  handler: string;
  handlerName: string;
  mediaHeader: Uint8Array;
  sampleEntry: Uint8Array;
  timescale: number;
  table: TrackTable;
  chunks: readonly ChunkPlanEntry[];
  offsets: Float64Array;
  track: 'video' | 'audio';
  width: number;
  height: number;
  volume: number;
  durationMovieUnits: number;
  writeSyncTable: boolean;
  edit?: Uint8Array;
}

function trackBox(spec: TrackBoxSpec): Uint8Array {
  return box(
    'trak',
    fullBox(
      'tkhd',
      0,
      0x0000_07, // enabled | in movie | in preview
      u32(0), // creation_time
      u32(0), // modification_time
      u32(spec.trackId),
      u32(0), // reserved
      u32(spec.durationMovieUnits),
      ZERO(8), // reserved
      u16(0), // layer
      u16(0), // alternate_group
      u16(spec.volume),
      u16(0), // reserved
      UNITY_MATRIX,
      fixed16_16(spec.width),
      fixed16_16(spec.height),
    ),
    ...(spec.edit === undefined ? [] : [spec.edit]),
    box(
      'mdia',
      fullBox(
        'mdhd',
        0,
        0,
        u32(0), // creation_time
        u32(0), // modification_time
        u32(spec.timescale),
        u32(spec.table.durationUnits),
        u16(0x55c4), // language: 'und'
        u16(0), // pre_defined
      ),
      fullBox(
        'hdlr',
        0,
        0,
        u32(0), // pre_defined
        fourcc(spec.handler),
        ZERO(12), // reserved
        encoder.encode(`${spec.handlerName}\0`),
      ),
      box(
        'minf',
        spec.mediaHeader,
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        sampleTable(spec),
      ),
    ),
  );
}

/** `stbl` — the tables that turn a `mdat` into a playable track. */
function sampleTable(spec: TrackBoxSpec): Uint8Array {
  const table = spec.table;
  const mine = spec.chunks
    .map((chunk, i) => ({ chunk, offset: spec.offsets[i] ?? 0 }))
    .filter((c) => c.chunk.track === spec.track);

  // `stts`: run-length encoded (count, delta). A CFR video track is one entry and an
  // AAC track always is, but the encoding is general because a hold-last source can
  // legitimately produce a final sample of a different length.
  const stts: Uint8Array[] = [];
  let runCount = 0;
  let runDelta = -1;
  let sttsEntries = 0;
  for (const delta of table.durations) {
    if (delta === runDelta) {
      runCount += 1;
      continue;
    }
    if (runDelta >= 0) {
      stts.push(u32(runCount), u32(runDelta));
      sttsEntries += 1;
    }
    runDelta = delta;
    runCount = 1;
  }
  if (runDelta >= 0) {
    stts.push(u32(runCount), u32(runDelta));
    sttsEntries += 1;
  }

  // `stsc`: run-length encoded (first_chunk, samples_per_chunk, description). Chunk
  // numbers here are 1-based *within this track*, which is what a demuxer pairs with
  // this track's own `co64`.
  const stsc: Uint8Array[] = [];
  let stscEntries = 0;
  let previousPerChunk = -1;
  for (const [i, entry] of mine.entries()) {
    if (entry.chunk.sampleCount === previousPerChunk) continue;
    stsc.push(u32(i + 1), u32(entry.chunk.sampleCount), u32(1));
    stscEntries += 1;
    previousPerChunk = entry.chunk.sampleCount;
  }

  const stsz = new Uint8Array(4 + table.sizes.length * 4);
  {
    const view = new DataView(stsz.buffer);
    view.setUint32(0, table.sizes.length, false);
    for (const [i, size] of table.sizes.entries()) view.setUint32(4 + i * 4, size, false);
  }

  const co64 = new Uint8Array(4 + mine.length * 8);
  {
    const view = new DataView(co64.buffer);
    view.setUint32(0, mine.length, false);
    for (const [i, entry] of mine.entries()) {
      const value = entry.offset;
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new FastStartError(`chunk offset ${value} is not exactly representable`);
      }
      view.setUint32(4 + i * 8, Math.floor(value / 0x1_0000_0000), false);
      view.setUint32(8 + i * 8, value >>> 0, false);
    }
  }

  const boxes: Uint8Array[] = [
    fullBox('stsd', 0, 0, u32(1), spec.sampleEntry),
    fullBox('stts', 0, 0, u32(sttsEntries), ...stts),
  ];
  if (spec.writeSyncTable) {
    // Omitting `stss` means "every sample is a sync sample", which is true of AAC
    // and emphatically not of H.264 — a video track without it is one a player will
    // happily seek into the middle of a GOP on.
    boxes.push(
      fullBox('stss', 0, 0, u32(table.syncSamples.length), ...table.syncSamples.map((n) => u32(n))),
    );
  }
  boxes.push(
    fullBox('stsc', 0, 0, u32(stscEntries), ...stsc),
    fullBox('stsz', 0, 0, u32(0), stsz),
    fullBox('co64', 0, 0, co64),
  );
  return box('stbl', ...boxes);
}

/**
 * `ftyp` for a finished export.
 *
 * `isom`/`mp42`/`avc1`, and deliberately **not** `iso5`: that brand is claimed by
 * the capture parts because `default_base_is_moof` needs it, and a file with no
 * fragments in it has no business advertising fragment semantics.
 */
export function exportFtyp(): Uint8Array {
  return box(
    'ftyp',
    fourcc('isom'),
    u32(512),
    fourcc('isom'),
    fourcc('iso2'),
    fourcc('avc1'),
    fourcc('mp41'),
    fourcc('mp42'),
  );
}

/** Samples per AAC frame, re-exported so an exporter needs one import for its timebase. */
export { AAC_FRAME_SAMPLES };
