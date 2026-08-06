/**
 * Seam S4, as a test: `SourceReader` knows one part in part-relative time,
 * `ResolvedState.sourceTime` is the whole recording on the recording clock, and
 * `TrackReader` is the only thing that bridges them.
 *
 * The mismatch is invisible on every recording this app makes today, because a track
 * that produced one part has `startTimeSec: 0` and the two numbers are equal. So the
 * fixture here has **two** parts with a hole between them — §7.4's shape, which the
 * format explicitly permits for any track — and the assertions are about which part
 * answers and what time it is asked about.
 *
 * ## Why this file is here rather than beside the editor
 *
 * Phase 8 (export) and phase 14 (the editor) each wrote an adapter for this seam,
 * independently and with the same answers. §4.5 puts *"which source frame is selected
 * for a given time"* on the list preview and export may never disagree about, so two
 * implementations of that selection is that guarantee with a second answer beside it
 * waiting to drift — on a part boundary, most likely, where neither loop looks. The
 * editor's copy was deleted and both loops now open a track through `openVideoTrack`;
 * this is the editor's coverage, moved onto the adapter that survived, so the shared
 * one is the tested one.
 *
 * Nothing is decoded. `frameAt` needs a `VideoDecoder`, which Node does not have;
 * `hasSourceFrameAt`, `selectionMicros`, `prime` and `release` go through the same
 * part selection and the same conversion, and what they touch is observable — the
 * index, a byte read against a named URL, or the ring.
 */

import { describe, expect, it, vi } from 'vitest';
import { currentSchemaId } from '@loom/format';
import { initSegment } from '@loom/mux';
import { SourceReader, bytesReader, DemuxIndex, type DecoderFactory } from '@loom/decode';
import { TrackReader, openVideoTrack, type TrackPart } from '../src/media/track-reader.ts';

/** A minimal but real `avcC`: one SPS and one PPS, enough for `parseInitSegment`. */
const AVCC = Uint8Array.from([
  0x01, 0x64, 0x00, 0x0d, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x0d, 0x01, 0x00, 0x04, 0x68,
  0xee, 0x3c, 0x80,
]);

const TIMESCALE = 1_000_000;
/** Frames per part, at 10 fps, so a part is a round two seconds long. */
const FRAMES = 20;
const FRAME_US = 100_000;
const PART_SEC = (FRAMES * FRAME_US) / 1e6;

/**
 * A decoder that accepts chunks and emits nothing.
 *
 * Node has no WebCodecs, and this file is about *which part is asked* rather than
 * about decoding. Emitting nothing is also the honest model of a decoder that has
 * not caught up, which is the state `prime` leaves behind on its first call anyway.
 */
const inertDecoder: DecoderFactory<VideoFrame> = (() => ({
  state: 'configured' as const,
  configure: () => undefined,
  decode: () => undefined,
  reset: () => undefined,
  close: () => undefined,
})) as unknown as DecoderFactory<VideoFrame>;

/** One part's bytes, with the real `initSegment` at the head. */
function partBytes(): Uint8Array {
  const init = initSegment({ width: 320, height: 180, timescale: TIMESCALE, avcC: AVCC });
  const bytes = new Uint8Array(init.byteLength + FRAMES * 64);
  bytes.set(init, 0);
  return bytes;
}

function indexDoc(initBytes: number): Record<string, unknown> {
  return {
    schema: currentSchemaId('loom.index'),
    timescale: TIMESCALE,
    keyframes: [0],
    pts: Array.from({ length: FRAMES }, (_, i) => i * FRAME_US),
    sizes: Array.from({ length: FRAMES }, () => 64),
    offsets: Array.from({ length: FRAMES }, (_, i) => initBytes + i * 64),
  };
}

/** A `TrackReader` over parts at the given starts, built without any I/O. */
function trackAt(...starts: readonly number[]): TrackReader {
  const bytes = partBytes();
  const initBytes = bytes.byteLength - FRAMES * 64;
  const parts: TrackPart[] = starts.map((startTimeSec) => ({
    reader: new SourceReader({
      bytes: bytesReader(bytes),
      index: DemuxIndex.fromDoc(indexDoc(initBytes)),
      config: { codec: 'avc1.64000d', codedWidth: 320, codedHeight: 180 },
      decoderFactory: inertDecoder,
    }),
    startTimeSec,
    durationSec: PART_SEC,
  }));
  return new TrackReader(parts);
}

/**
 * Two parts: 0–2 s and 5–7 s.
 *
 * The three seconds between them are a §7.4 hole — a device that went away and came
 * back — and §5.4 mechanism 5 forbids closing it up, which is exactly why a source
 * time of 3.5 s has to mean something and cannot mean "part 0, frame 35".
 */
const GAPPED = () => trackAt(0, 5);

describe('a track reader bridges recording-clock time to part-relative time', () => {
  it('asks the part that covers the instant, in that part’s own time', () => {
    const track = GAPPED();
    // Part 0 covers 0–2 s and its sidecar has frames at 0…1.9 s of its own time.
    expect(track.hasSourceFrameAt(0)).toBe(true);
    expect(track.hasSourceFrameAt(1.9)).toBe(true);
    // Part 1 covers 5–7 s. Its sidecar is identical, so a source time of 5.0 s is
    // its frame 0 — which is the whole conversion, and the number that is wrong by
    // five seconds if the part offset is dropped.
    expect(track.hasSourceFrameAt(5)).toBe(true);
    expect(track.hasSourceFrameAt(6.9)).toBe(true);
    track.close();
  });

  it('hands frameAt the converted time, which is the line that decides the picture', () => {
    // `frameAt` carries its own copy of `t - part.startTimeSec`, and it is the one
    // the composite actually comes from — so it needs its own assertion rather than
    // riding on `selectionMicros`. It cannot be observed through its return value
    // here: that needs a real `VideoDecoder`, which Node has not got, so with an
    // inert decoder `frameAt` answers `null` whatever it is asked. Dropping the
    // offset on this exact line passed every other test in this file, which is what
    // "you ported a shim, not coverage" looks like from the inside.
    const track = GAPPED();
    const first = vi.spyOn(track.parts[0]!.reader, 'frameAt').mockReturnValue(null);
    const second = vi.spyOn(track.parts[1]!.reader, 'frameAt').mockReturnValue(null);

    track.frameAt(0.5);
    expect(first).toHaveBeenCalledWith(0.5);
    expect(second).not.toHaveBeenCalled();

    // Half a second into the second part is 5.5 s on the recording clock and 0.5 s
    // of that part's own — the five seconds that go missing if the offset is dropped.
    track.frameAt(5.5);
    expect(second).toHaveBeenCalledWith(0.5);

    // And in the hole, no part is asked at all.
    first.mockClear();
    second.mockClear();
    expect(track.frameAt(3.5)).toBeNull();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    track.close();
  });

  it('hands hasSourceFrameAt the converted time too', () => {
    // Its own copy of the same subtraction, and the behavioural assertions below
    // cannot see it: `DemuxIndex.frameAtTime` answers with the frame at *or before*
    // `t`, so asking a two-second part about second five returns its last frame
    // rather than "no frame". The watchdog reads this (§10.2), so a wrong answer
    // here is a stall reported for an instant that was never in question.
    const track = GAPPED();
    const second = vi.spyOn(track.parts[1]!.reader, 'hasSourceFrameAt').mockReturnValue(true);
    track.hasSourceFrameAt(5.5);
    expect(second).toHaveBeenCalledWith(0.5);
    track.close();
  });

  it('converts, rather than merely selecting: the same instant of two parts is the same frame', () => {
    // The assertion the `the-part-offset-is-dropped` mutation has to fail. Selecting
    // the right part but handing it the unconverted time still answers `true` above,
    // because part 1's index covers 0…1.9 s and 5.0 s is simply outside it — so the
    // *timestamp* is what pins the conversion down. Half a second into each part must
    // be the same frame of each part's own identical sidecar.
    const track = GAPPED();
    expect(track.selectionMicros(0.5)).toBe(500_000);
    expect(track.selectionMicros(5.5)).toBe(500_000);
    // ...and the second part's first frame is its own zero, not five seconds in.
    expect(track.selectionMicros(5)).toBe(0);
    track.close();
  });

  it('has no frame in the hole between two parts, and says so rather than inventing one', () => {
    const track = GAPPED();
    // §4.3's hold shows the last picture that was captured; §10.2's watchdog stays
    // quiet, because time in which nothing was captured is not a stall.
    for (const t of [2.5, 3.5, 4.9]) {
      expect(track.hasSourceFrameAt(t), `t=${String(t)}`).toBe(false);
      expect(track.selectionMicros(t), `t=${String(t)}`).toBe(Number.NEGATIVE_INFINITY);
    }
    track.close();
  });

  it('has no frame before the track starts', () => {
    const track = trackAt(1);
    expect(track.hasSourceFrameAt(0.5)).toBe(false);
    expect(track.hasSourceFrameAt(1)).toBe(true);
    track.close();
  });

  it('is the identity on the single-part recordings this app makes today', () => {
    // The control for the whole file: with one part starting at zero, part time and
    // source time are the same number — which is why the seam was invisible.
    const track = trackAt(0);
    expect(track.hasSourceFrameAt(0)).toBe(true);
    expect(track.hasSourceFrameAt(1.9)).toBe(true);
    expect(track.selectionMicros(1.5)).toBe(1_500_000);
    track.close();
  });

  it('puts its parts in recording-clock order however they arrive', () => {
    // The part search walks the list once and returns at the first part that could
    // cover `t`, so it is only correct over a sorted list. `recording.json` happens
    // to list parts in the order they were opened, which is also clock order — but
    // that is the document's habit, not a guarantee the reader may lean on, and an
    // unsorted list reports the earlier part as a hole rather than failing loudly.
    const bytes = partBytes();
    const initBytes = bytes.byteLength - FRAMES * 64;
    const part = (startTimeSec: number): TrackPart => ({
      reader: new SourceReader({
        bytes: bytesReader(bytes),
        index: DemuxIndex.fromDoc(indexDoc(initBytes)),
        config: { codec: 'avc1.64000d', codedWidth: 320, codedHeight: 180 },
        decoderFactory: inertDecoder,
      }),
      startTimeSec,
      durationSec: PART_SEC,
    });
    const track = new TrackReader([part(5), part(0)]);

    expect(track.parts.map((p) => p.startTimeSec)).toEqual([0, 5]);
    expect(track.hasSourceFrameAt(0.5)).toBe(true);
    expect(track.hasSourceFrameAt(5.5)).toBe(true);
    track.close();
  });

  it('reports a ring cap that covers every part, not one of them', () => {
    // §4.2's bound is per source and every part has its own ring, so a caller
    // asserting the cap on a two-part track has to be told the sum. Reporting one
    // part's would make the phase-6 assertion vacuous here and wrong on one part.
    const one = trackAt(0);
    const two = GAPPED();
    expect(two.ringCapacity).toBe(one.ringCapacity * 2);
    one.close();
    two.close();
  });
});

describe('the instant exactly on a part boundary', () => {
  // The recording clock is microseconds (§2.3), so two times closer than a tick are
  // the same instant. Without `TIME_EPSILON` a `t` landing exactly on a boundary
  // falls through both branches of the part search and reports a hole where the media
  // is contiguous — one wrong frame at a cut, which nobody reports and everybody
  // notices. These are the two boundaries a contiguous two-part track has.
  it('resolves into a part rather than into a hole', () => {
    const contiguous = trackAt(0, PART_SEC);
    // The end of part 0 and the start of part 1 are the same instant, and the
    // *earlier* part wins because it is reached first and its extent still covers
    // that instant. Which one wins matters less than that one of them does — the
    // defect is a hole reported between two parts that touch — but it has to be
    // decided rather than left to floating point, so it is pinned: part 0's own
    // last frame, not part 1's first.
    expect(contiguous.hasSourceFrameAt(PART_SEC)).toBe(true);
    expect(contiguous.selectionMicros(PART_SEC)).toBe((FRAMES - 1) * FRAME_US);
    // ...and one tick past it is unambiguously the second part's first frame.
    expect(contiguous.selectionMicros(PART_SEC + 1e-5)).toBe(0);
    contiguous.close();
  });

  it('resolves the last instant of a track rather than falling off it', () => {
    const track = trackAt(0);
    // A playhead parked on the final frame still has to have a frame under it.
    expect(track.hasSourceFrameAt(PART_SEC)).toBe(true);
    track.close();
  });

  it('survives a boundary that floating point does not land on exactly', () => {
    // `startTimeSec` comes off `recording.json` as a float, so a boundary is only
    // ever approximately a boundary. Half a microsecond either side of it must still
    // be inside the track.
    const contiguous = trackAt(0, PART_SEC);
    expect(contiguous.hasSourceFrameAt(PART_SEC - 1e-9)).toBe(true);
    expect(contiguous.hasSourceFrameAt(PART_SEC + 1e-9)).toBe(true);
    contiguous.close();
  });
});

describe('priming and releasing across parts', () => {
  it('primes the covering part in that part’s own time', () => {
    // Deliberately a part that does *not* start at zero: `prime` carries its own
    // copy of `t - part.startTimeSec`, and against a first part the subtraction is
    // invisible, so a test that primes into part 0 cannot see it dropped.
    const track = GAPPED();
    const second = vi.spyOn(track.parts[1]!.reader, 'prime').mockResolvedValue();
    void track.prime(5.5, 0.25);
    expect(second).toHaveBeenCalledWith(0.5, 0.25);
    track.close();
  });

  it('primes the part the lookahead reaches into, not only the one under the playhead', () => {
    // Without this the first frame of the next part is a miss, and at export a miss
    // is a frame of the previous part standing in for one that exists.
    const track = trackAt(0, PART_SEC);
    const here = vi.spyOn(track.parts[0]!.reader, 'prime').mockResolvedValue();
    const next = vi.spyOn(track.parts[1]!.reader, 'prime').mockResolvedValue();

    void track.prime(PART_SEC - 0.1, 0.5);

    expect(here).toHaveBeenCalledWith(PART_SEC - 0.1, 0.5);
    // The next part is primed from its own beginning, in its own time.
    expect(next).toHaveBeenCalledWith(0, 0.5);
    track.close();
  });

  it('releases a part behind the playhead wholesale, and the current one only up to it', () => {
    const track = trackAt(0, PART_SEC);
    const first = vi.spyOn(track.parts[0]!.reader, 'release');
    const second = vi.spyOn(track.parts[1]!.reader, 'release');

    track.release(PART_SEC + 0.5);

    expect(first).toHaveBeenCalledWith(PART_SEC);
    expect(second).toHaveBeenCalledWith(0.5);
    track.close();
  });
});

describe('openVideoTrack', () => {
  it('reads each part’s codec description out of its own initialisation segment', async () => {
    // The gap `source-reader.ts` names: `recording.json` does not carry the codec
    // description and `MetaMsg` is long gone by the time an editor or an exporter
    // opens a bundle. Opening at all proves it was found in the file.
    const bytes = partBytes();
    const initBytes = bytes.byteLength - FRAMES * 64;
    const reads: string[] = [];
    const fetchLike = ((url: string) => {
      reads.push(url);
      return Promise.resolve(new Response(JSON.stringify(indexDoc(initBytes)), { status: 200 }));
    }) as unknown as typeof fetch;

    const track = await openVideoTrack({
      parts: [
        {
          mediaUrl: 'loom://recording/r/media/screen.000.mp4',
          indexUrl: 'loom://recording/r/media/screen.000.index.json',
          startTimeSec: 0,
          durationSec: PART_SEC,
        },
      ],
      fetchLike,
      byteReaderFor: () => bytesReader(bytes),
    });

    expect(reads).toEqual(['loom://recording/r/media/screen.000.index.json']);
    expect(track.parts).toHaveLength(1);
    expect(track.durationSec).toBeCloseTo(PART_SEC, 9);
    track.close();
  });
});
