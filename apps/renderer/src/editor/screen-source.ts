/**
 * The screen track as one {@link PreviewSource} over however many parts it has.
 *
 * This is the adapter `packages/decode/src/source-reader.ts`'s header says an app
 * owes the reader, and the half of it nobody had written down. Two gaps, and this
 * module closes both:
 *
 *  1. **The `avcC` description**, which `source-reader.ts` names: `recording.json`
 *     does not carry the codec description, and `MetaMsg` — the only place it ever
 *     existed — is long gone by the time an editor opens a bundle. It is read back
 *     out of the container here, from the initialisation segment at the head of the
 *     part, with `parseInitSegment` from `@loom/mux`. That is the choice this
 *     adapter makes: read it from the file rather than persist a second copy of it
 *     beside the file, because a second copy is a second thing that can disagree
 *     with the bitstream the decoder is about to be handed.
 *  2. **Part selection**, which nothing had written down. `SourceReader` knows about
 *     exactly one part, and its sidecar's `pts` starts at zero for *that* part
 *     (`fragment-writer.ts` subtracts the part's own first timestamp). A
 *     `ResolvedState.sourceTime`, meanwhile, is an offset on the **recording
 *     clock** and spans every part of the track — `clips.ts`'s `sourceDurationSec`
 *     is `max(part.startTimeSec + part.durationSec)`. So one reader per part, and
 *     every time crossing this boundary goes through {@link partTimeSec}.
 *
 * ## Every time in this file is a *source* time
 *
 * Seconds into the raw recording, on the recording clock — §3.1's first domain, and
 * the domain every method of `PreviewSource` is in. A timeline time must never
 * reach here; `PreviewLoop` converts once per frame with `resolve(...).sourceTime`
 * and `PreviewSource`'s own docstring says so.
 *
 * ## The hole between two parts
 *
 * §7.4 lets a track stop and start again — a camera unplugged, and in principle a
 * screen too — and §5.4 mechanism 5 forbids closing the hole by concatenating. So a
 * source time inside a hole selects the part **after** it, whose part-relative time
 * is then negative, and the arithmetic answers correctly without a special case:
 * `DemuxIndex.frameAtTime` has no frame at a negative time, so `frameAt` returns
 * `null` and the compositor holds the previous picture (§4.3), `hasSourceFrameAt`
 * answers `false` so §10.2's watchdog does not report a stall for time in which
 * nothing was ever captured, and `prime` fills the ring from the start of the part
 * playback is about to reach. Nothing here invents a frame for an instant the
 * recording does not contain.
 */

import {
  DemuxIndex,
  fetchByteRangeReader,
  SourceReader,
  type ByteRangeReader,
  type DecoderFactory,
} from '@loom/decode';
import { mediaPartPath, trackSourceTimeSec, type Seconds, type VideoPart } from '@loom/format';
import { parseInitSegment } from '@loom/mux';
import type { PreviewSource } from '../preview/index.ts';

/**
 * Longest head of a part read to find its initialisation segment.
 *
 * The read is normally bounded by the first frame's own offset — everything before
 * it is `ftyp` + `moov` + the first `moof`, which is where `avcC` lives. This is the
 * backstop for a part whose index says the first frame starts implausibly far in:
 * `parseInitSegment` walks boxes from byte zero, so a runaway value would pull a
 * whole recording through IPC to find a record in its first kilobyte.
 */
const MAX_INIT_SEGMENT_BYTES = 1 << 20;

/** One part, and the reader that decodes it. */
interface Part {
  /** Its own index — the `000` in `screen.000.mp4`, not its position in the list. */
  index: number;
  /** First sample of this part on the recording clock (§2.3). */
  startTimeSec: Seconds;
  /** Extent on the recording clock, so `startTimeSec + durationSec` is its end. */
  durationSec: Seconds;
  reader: SourceReader;
}

export interface ScreenSourceOptions {
  parts: readonly VideoPart[];
  /**
   * A `loom://` URL for one part file.
   *
   * Injected rather than built here so this module needs neither `window.loom` nor
   * a recording id: main is what resolves a part to a URL, having first proved the
   * file is inside the bundle (`ipc.ts`'s `projectMediaUrl`). Both the part and its
   * own index are passed because main's channel is keyed by index while
   * `recording.json` is what says where the file and its sidecar actually are.
   */
  mediaUrl: (part: VideoPart, partIndex: number) => Promise<string>;
  /** A `loom://` URL for the part's `loom.index/1` sidecar. */
  indexUrl: (part: VideoPart, partIndex: number) => string;
  /** Injected for tests; defaults to `fetch` through the `loom://` protocol. */
  fetchImpl?: typeof fetch;
  /**
   * Passed straight to every `SourceReader`. Defaults to the real `VideoDecoder`.
   *
   * `packages/decode/src/decoder.ts` explains why the seam exists at all; the
   * reason it is repeated here is that part *selection* — which part answers a
   * recording-clock time, and what time it is asked about — is the whole of what
   * this module adds, and it cannot be exercised anywhere WebCodecs is absent
   * without one.
   */
  decoderFactory?: DecoderFactory<VideoFrame>;
  /** Frames per part reader. Defaults to `@loom/decode`'s §4.2 ring capacity. */
  ringCapacity?: number;
}

export class ScreenSource implements PreviewSource {
  /** Ascending by `startTimeSec`, which for one track is also part-index order. */
  readonly #parts: readonly Part[];
  #active: Part;

  private constructor(parts: readonly Part[]) {
    const first = parts[0];
    if (first === undefined) throw new Error('a screen source needs at least one part');
    this.#parts = parts;
    this.#active = first;
  }

  /**
   * Open every part of a screen track.
   *
   * Every part is opened up front rather than lazily: opening one is two small
   * range reads, a recording has one part unless a device fell out mid-capture, and
   * a lazy open would have to happen on the render path — where §4.3's rule is that
   * nothing awaits.
   */
  static async open(options: ScreenSourceOptions): Promise<ScreenSource> {
    const usable = options.parts.filter((part) => part.frameCount > 0);
    if (usable.length === 0) {
      throw new Error('recording.json declares no screen part with any frames in it');
    }
    const parts = await Promise.all(usable.map((part) => openPart(part, options)));
    parts.sort((a, b) => a.startTimeSec - b.startTimeSec);
    return new ScreenSource(parts);
  }

  /** Every part's extent on the recording clock, for a caller drawing a lane. */
  get parts(): readonly { startTimeSec: Seconds; durationSec: Seconds }[] {
    return this.#parts.map((part) => ({
      startTimeSec: part.startTimeSec,
      durationSec: part.durationSec,
    }));
  }

  frameAt(t: Seconds): VideoFrame | null {
    const part = this.#select(t);
    return part.reader.frameAt(partTimeSec(t, part));
  }

  prime(t: Seconds, aheadSec: number): Promise<void> {
    const part = this.#select(t);
    return part.reader.prime(partTimeSec(t, part), aheadSec);
  }

  release(beforeT: Seconds): void {
    const part = this.#select(beforeT);
    part.reader.release(partTimeSec(beforeT, part));
  }

  hasSourceFrameAt(t: Seconds): boolean {
    const part = this.#select(t);
    return part.reader.hasSourceFrameAt(partTimeSec(t, part));
  }

  /**
   * Frames alive across **every** part, not just the one being read.
   *
   * `PreviewLoop.peakLiveFrames` is what a gate asserts §10.2's cap on, and a sum
   * that quietly forgot the parts that are not being read would report a ceiling
   * this source does not actually keep.
   */
  get liveFrames(): number {
    let live = 0;
    for (const part of this.#parts) live += part.reader.liveFrames;
    return live;
  }

  get ringCapacity(): number {
    return this.#active.reader.ringCapacity;
  }

  /** Close every reader and every frame it holds. Idempotent, like the readers'. */
  close(): void {
    for (const part of this.#parts) part.reader.close();
  }

  /**
   * The part covering `t`, or the one playback would reach next.
   *
   * The first part whose end is at or after `t`; the last part when `t` is past all
   * of them, for the reason `clipIndexAt` clamps — a playhead parked on the final
   * frame still has to have a frame. See the header for what a `t` inside a hole
   * between two parts resolves to, and why nothing special is done about it.
   */
  #select(t: Seconds): Part {
    for (const part of this.#parts) {
      if (t <= part.startTimeSec + part.durationSec) return this.#activate(part);
    }
    // `#parts` is never empty — the constructor refuses that — so the fallback is
    // unreachable and is here because the index signature cannot know it.
    return this.#activate(this.#parts[this.#parts.length - 1] ?? this.#active);
  }

  /**
   * Make `part` the one being read, and let the others go.
   *
   * A part that is no longer being read keeps at most the single frame its ring
   * still has to name; without this, crossing a §7.4 hole and coming back would
   * leave a full ring per part alive for the rest of the session. `release` is
   * given `+Infinity` — the reader answers it with the timestamp of its own last
   * frame, so what is kept is one frame and never a time-shaped guess.
   */
  #activate(part: Part): Part {
    if (part === this.#active) return part;
    this.#active.reader.release(Number.POSITIVE_INFINITY);
    this.#active = part;
    return part;
  }
}

/**
 * A source time, in the part's own media time.
 *
 * `trackSourceTimeSec` is §5.4 mechanism 2's arithmetic and is used rather than
 * written out: the reference here is the recording clock itself, whose origin is by
 * construction the screen track's first frame, so the reference start is 0 and this
 * reduces to `t - part.startTimeSec` — which is exactly the subtraction the sidecar
 * needs, because `fragment-writer.ts` writes `pts` relative to the part's own first
 * sample. Restating it as a subtraction here is how the two drift apart.
 */
function partTimeSec(t: Seconds, part: Part): Seconds {
  return trackSourceTimeSec(t, part.startTimeSec, 0);
}

async function openPart(part: VideoPart, options: ScreenSourceOptions): Promise<Part> {
  const index = partIndexOf(part.file);
  if (index === null) {
    throw new Error(`${part.file} is not a screen part path this bundle layout can name`);
  }
  const doFetch = options.fetchImpl ?? fetch;

  const sidecar: unknown = await readJson(doFetch, options.indexUrl(part, index), part.index);
  const demux = DemuxIndex.fromDoc(sidecar, part.index);

  const url = await options.mediaUrl(part, index);
  // The same `fetch` the sidecar was read with, so a caller that supplied one has
  // supplied one for every read this source makes and not for some of them.
  const bytes = fetchByteRangeReader(url, { fetchImpl: doFetch });
  const config: VideoDecoderConfig = {
    codec: part.codec,
    codedWidth: part.size[0],
    codedHeight: part.size[1],
    description: await readAvcC(bytes, demux, part.file),
  };

  return {
    index,
    startTimeSec: part.startTimeSec,
    durationSec: part.durationSec,
    reader: new SourceReader({
      bytes,
      index: demux,
      config,
      ...(options.decoderFactory === undefined ? {} : { decoderFactory: options.decoderFactory }),
      ...(options.ringCapacity === undefined ? {} : { ringCapacity: options.ringCapacity }),
    }),
  };
}

/**
 * The `avcC` record from the part's own initialisation segment.
 *
 * Read from the head of the file, bounded by where the index says the first frame's
 * bytes begin: everything before that is `ftyp`, `moov` and the first fragment's
 * header, and `parseInitSegment` stops at the first box it cannot complete, so a
 * truncated `mdat` at the end of the range costs nothing.
 */
async function readAvcC(
  bytes: ByteRangeReader,
  index: DemuxIndex,
  file: string,
): Promise<Uint8Array> {
  const firstFrameAt = index.frameCount > 0 ? index.byteRange(0).start : MAX_INIT_SEGMENT_BYTES;
  const end = Math.min(Math.max(firstFrameAt, 1), MAX_INIT_SEGMENT_BYTES);
  const head = await bytes.read(0, end, new AbortController().signal);
  try {
    return parseInitSegment(head).avcC;
  } catch (error) {
    // Named rather than passed through: "no complete moov box" out of a byte
    // parser, with no file in it, is the least actionable error this path can
    // produce, and the honest reading of it is that the part is not decodable.
    throw new Error(
      `${file}: could not read a codec description out of the file's own ` +
        `initialisation segment, so it cannot be decoded (${String(error)})`,
    );
  }
}

/**
 * The part index inside a `media/screen.NNN.mp4` path, or `null`.
 *
 * Matched against `mediaPartPath` rather than parsed with a pattern of its own, so
 * it cannot drift from the layout module that decides what a part file is called.
 * Position in `recording.json`'s list is deliberately not used: `finalizedVideoTrack`
 * pairs measurements to parts **by file** precisely because a part that was
 * announced and never opened leaves a hole in that list.
 */
function partIndexOf(file: string): number | null {
  for (let i = 0; i <= 999; i++) {
    if (mediaPartPath('screen', i) === file) return i;
  }
  return null;
}

async function readJson(doFetch: typeof fetch, url: string, what: string): Promise<unknown> {
  const response = await doFetch(url);
  if (!response.ok) {
    throw new Error(`${what} could not be read (HTTP ${String(response.status)})`);
  }
  return response.json();
}
