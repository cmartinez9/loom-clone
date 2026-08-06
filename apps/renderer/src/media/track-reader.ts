/**
 * One video *track* — the parts of it — behind the one-part seam preview and export
 * already speak.
 *
 * `SourceReader` (`@loom/decode`) owns one media part: a byte-range reader, a
 * `loom.index/1` sidecar and a `VideoDecoderConfig`, and nothing above it. But a
 * track is a **list** of parts from day one (§2.3): a camera unplugged mid-recording
 * produces `webcam.001.mp4` with a `startTimeSec` of its own, and the hole between
 * the parts lives in `recording.json` and is never concatenated out of the media
 * (§5.4 mechanism 5). Something has to turn "source time in this track" into "part,
 * and time inside it", and this is that something.
 *
 * It implements {@link PreviewSource} exactly, so the preview loop and the export
 * loop drive a track through the same interface they already drive a part through —
 * which is the point. §4.5 puts *"which source frame is selected for a given time"*
 * on the list preview and export may never disagree about, and the selection here is
 * one `#partAt` plus `SourceReader.frameAt`, called identically by both.
 *
 * ## What happens between parts, and before the first one
 *
 * `frameAt` returns `null`. That is not a failure mode — `Compositor.render` holds
 * the previous composite when it is handed no frame (§4.3), so a gap in a camera
 * track shows the last picture the camera produced, which is exactly §5.4's
 * "reproduce the gap, never close it" applied to pictures. The exporter counts those
 * frames rather than waiting for one, and {@link TrackReader.hasSourceFrameAt} is
 * what tells a stall apart from a hole.
 */

import type { Seconds } from '@loom/format';
import { DemuxIndex, SourceReader, type ByteRangeReader } from '@loom/decode';
import type { PreviewSource } from '../preview/index.ts';
import { fetchFrameIndex, loomByteReader, readVideoDecoderConfig } from './loom-media.ts';

/** One part of a track: its reader and where it sits on the recording clock. */
export interface TrackPart {
  reader: SourceReader;
  /** §2.3's `startTimeSec` — an offset on the one recording clock. */
  startTimeSec: Seconds;
  durationSec: Seconds;
}

export class TrackReader implements PreviewSource {
  readonly parts: readonly TrackPart[];
  #closed = false;

  /** Parts are sorted by `startTimeSec`; overlapping parts are a malformed track. */
  constructor(parts: readonly TrackPart[]) {
    this.parts = [...parts].sort((a, b) => a.startTimeSec - b.startTimeSec);
  }

  /** Where the track ends on the recording clock. */
  get durationSec(): Seconds {
    const last = this.parts.at(-1);
    return last === undefined ? 0 : last.startTimeSec + last.durationSec;
  }

  get liveFrames(): number {
    let live = 0;
    for (const part of this.parts) live += part.reader.liveFrames;
    return live;
  }

  get ringCapacity(): number {
    // The bound §4.2 sets is per source, and every part has its own ring. The
    // number a caller asserts against is therefore the sum, not one ring's cap —
    // reporting one part's would make the phase-6 assertion vacuous on a two-part
    // track and wrong on a one-part one.
    let capacity = 0;
    for (const part of this.parts) capacity += part.reader.ringCapacity;
    return capacity;
  }

  frameAt(t: Seconds): VideoFrame | null {
    const part = this.#partAt(t);
    return part === null ? null : part.reader.frameAt(t - part.startTimeSec);
  }

  hasSourceFrameAt(t: Seconds): boolean {
    const part = this.#partAt(t);
    return part?.reader.hasSourceFrameAt(t - part.startTimeSec) ?? false;
  }

  /**
   * Timestamp of the frame the index puts on screen at `t`, in the covering part's
   * own microsecond domain — which is the domain the `VideoFrame` it hands back is
   * stamped in, so the two are directly comparable.
   *
   * `-Infinity` in a hole or before the track starts. See
   * `SourceReader.selectionMicros` for why an exporter asks.
   */
  selectionMicros(t: Seconds): number {
    const part = this.#partAt(t);
    return part === null
      ? Number.NEGATIVE_INFINITY
      : part.reader.selectionMicros(t - part.startTimeSec);
  }

  /**
   * Prime the part covering `t`, and the next one if the lookahead reaches into it.
   *
   * Priming across the boundary matters at a part change: without it the first
   * frame of `webcam.001.mp4` is a miss, and at export a miss is a frame of the
   * previous part standing in for one that exists.
   */
  async prime(t: Seconds, aheadSec: number): Promise<void> {
    if (this.#closed) return;
    const here = this.#partAt(t);
    const ahead = this.#partAt(t + aheadSec);
    const work: Promise<void>[] = [];
    if (here !== null) work.push(here.reader.prime(t - here.startTimeSec, aheadSec));
    if (ahead !== null && ahead !== here) work.push(ahead.reader.prime(0, aheadSec));
    await Promise.all(work);
  }

  release(beforeT: Seconds): void {
    for (const part of this.parts) {
      // A part entirely behind the playhead is released wholesale; the part holding
      // it releases only what precedes the time asked for.
      const end = part.startTimeSec + part.durationSec;
      part.reader.release(end <= beforeT ? part.durationSec : beforeT - part.startTimeSec);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const part of this.parts) part.reader.close();
  }

  /**
   * The part covering `t`, or `null` in a hole or before the track starts.
   *
   * Linear, because a track has one part or a handful — a `devicechange` storm is
   * the pathological case and it is bounded by the recording's own part budget.
   */
  #partAt(t: Seconds): TrackPart | null {
    for (const part of this.parts) {
      if (t + TIME_EPSILON < part.startTimeSec) return null;
      if (t < part.startTimeSec + part.durationSec + TIME_EPSILON) return part;
    }
    return null;
  }
}

/**
 * Half a microsecond, in seconds.
 *
 * The recording clock is microseconds (§2.3), so two times that differ by less than
 * a tick are the same instant. Without this, a `t` landing exactly on a part
 * boundary can fall through both branches of `#partAt` and report a hole where the
 * media is contiguous.
 */
const TIME_EPSILON = 0.5e-6;

/** What {@link openVideoTrack} needs to know about one part. */
export interface VideoPartRef {
  mediaUrl: string;
  indexUrl: string;
  startTimeSec: Seconds;
  durationSec: Seconds;
}

export interface OpenVideoTrackOptions {
  parts: readonly VideoPartRef[];
  /** Injected so a test can serve bytes without a network. Defaults to `fetch`. */
  fetchLike?: typeof fetch;
  /** Builds the byte reader for one part. Defaults to a `loom://` range reader. */
  byteReaderFor?: (url: string) => ByteRangeReader;
  ringCapacity?: number;
}

/**
 * Open every part of a track for reading.
 *
 * The three things `SourceReader` needs are assembled here, and where each comes
 * from is the cross-phase contract `source-reader.ts` documents:
 *
 *  1. the **bytes** — a `loom://` range reader, the same one the editor uses;
 *  2. the **index** — the `loom.index/1` sidecar (§2.4), fetched as JSON;
 *  3. the **`VideoDecoderConfig`** — read out of the part's own initialisation
 *     segment. That is the answer to *"the one thing an adapter has to decide"*:
 *     `MetaMsg`'s config is long gone by the time an export runs, and the `avcC` is
 *     in the file, so the file is what is asked. Nothing is persisted twice and
 *     nothing can drift.
 */
export async function openVideoTrack(options: OpenVideoTrackOptions): Promise<TrackReader> {
  const fetchLike = options.fetchLike ?? fetch;
  const opened: TrackPart[] = [];
  try {
    for (const ref of options.parts) {
      const bytes =
        options.byteReaderFor?.(ref.mediaUrl) ?? loomByteReader(ref.mediaUrl, fetchLike);
      const index = new DemuxIndex(await fetchFrameIndex(ref.indexUrl, fetchLike));
      const config = await readVideoDecoderConfig(bytes);
      opened.push({
        reader: new SourceReader({
          bytes,
          index,
          config,
          ...(options.ringCapacity === undefined ? {} : { ringCapacity: options.ringCapacity }),
        }),
        startTimeSec: ref.startTimeSec,
        durationSec: ref.durationSec,
      });
    }
  } catch (error) {
    for (const part of opened) part.reader.close();
    throw error;
  }
  return new TrackReader(opened);
}
