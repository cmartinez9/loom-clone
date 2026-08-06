/**
 * Seam S4, as a test: `SourceReader` knows one part in part-relative time,
 * `ResolvedState.sourceTime` is the whole recording on the recording clock, and
 * `ScreenSource` is the only thing that bridges them.
 *
 * The mismatch is invisible on every recording this app makes today, because a
 * screen track that produced one part has `startTimeSec: 0` and the two numbers are
 * equal. So the fixture here has **two** parts with a hole between them — §7.4's
 * shape, which the format explicitly permits for any track — and the assertions are
 * about which part answers and what time it is asked about.
 *
 * Nothing real is decoded. `frameAt` needs a `VideoDecoder`, which Node does not
 * have; `hasSourceFrameAt` and `prime` go through the same part selection and the
 * same conversion, and what they touch is observable — one is the index, the other is
 * a byte read against a named URL. The two `release` tests are the exception and use
 * a decoder that echoes its chunks back as frames, because what they are about is
 * which part's *ring* a call reaches, and an empty ring answers every version of that
 * the same way.
 */

import { describe, expect, it } from 'vitest';
import { currentSchemaId, type VideoPart } from '@loom/format';
import { initSegment } from '@loom/mux';
import type { DecoderFactory } from '@loom/decode';
import { ScreenSource } from '../src/editor/screen-source.ts';

/** A minimal but real `avcC`: one SPS and one PPS, enough for `parseInitSegment`. */
const AVCC = Uint8Array.from([
  0x01, 0x64, 0x00, 0x0d, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x0d, 0x01, 0x00, 0x04, 0x68,
  0xee, 0x3c, 0x80,
]);

const TIMESCALE = 1_000_000;
/** Frames per part, at 10 fps, so a part is a round two seconds long. */
const FRAMES = 20;
const FRAME_US = 100_000;

/**
 * One part's bytes and sidecar, with the real `initSegment` at the head so the
 * `avcC` this source reads back is one a real writer produced.
 */
function buildPart(): { bytes: Uint8Array; doc: Record<string, unknown> } {
  const init = initSegment({ width: 320, height: 180, timescale: TIMESCALE, avcC: AVCC });
  const payload = 64;
  const bytes = new Uint8Array(init.byteLength + FRAMES * payload);
  bytes.set(init, 0);
  return {
    bytes,
    doc: {
      schema: currentSchemaId('loom.index'),
      timescale: TIMESCALE,
      keyframes: [0],
      pts: Array.from({ length: FRAMES }, (_, i) => i * FRAME_US),
      sizes: Array.from({ length: FRAMES }, () => payload),
      offsets: Array.from({ length: FRAMES }, (_, i) => init.byteLength + i * payload),
    },
  };
}

function videoPart(index: number, startTimeSec: number): VideoPart {
  return {
    file: `media/screen.${String(index).padStart(3, '0')}.mp4`,
    index: `media/screen.${String(index).padStart(3, '0')}.index.json`,
    codec: 'avc1.64000d',
    size: [320, 180],
    startTimeSec,
    durationSec: (FRAMES * FRAME_US) / 1e6,
    frameCount: FRAMES,
    rate: { mode: 'variable', nominalFps: 10, observedFps: 10 },
    endedEarly: false,
  };
}

interface Harness {
  source: ScreenSource;
  /** Byte reads, by part index, in order. */
  reads: { part: number; start: number; end: number }[];
}

/**
 * Two parts: `screen.000` covering 0–2 s, `screen.001` covering 5–7 s.
 *
 * The three seconds between them are a §7.4 hole — a device that went away and came
 * back — and §5.4 mechanism 5 forbids closing it up, which is exactly why a source
 * time of 3.5 s has to mean something and cannot mean "part 0, frame 35".
 */
async function open(
  starts: readonly number[] = [0, 5],
  decoderFactory: DecoderFactory<VideoFrame> = inertDecoder,
): Promise<Harness> {
  const built = buildPart();
  const reads: Harness['reads'] = [];
  const parts = starts.map((start, i) => videoPart(i, start));

  const fetchImpl = ((input: string, init?: { headers?: Record<string, string> }) => {
    const partIndex = Number.parseInt(/screen\.(\d+)\./.exec(input)?.[1] ?? '-1', 10);
    if (input.endsWith('.json')) {
      return Promise.resolve(new Response(JSON.stringify(built.doc), { status: 200 }));
    }
    const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.['Range'] ?? '');
    const start = Number.parseInt(range?.[1] ?? '0', 10);
    const end = Number.parseInt(range?.[2] ?? '0', 10) + 1;
    reads.push({ part: partIndex, start, end });
    return Promise.resolve(
      new Response(built.bytes.slice(start, end), {
        status: 206,
        headers: { 'Content-Range': `bytes ${String(start)}-${String(end - 1)}/1` },
      }),
    );
  }) as unknown as typeof fetch;

  const source = await ScreenSource.open({
    parts,
    mediaUrl: (part) => Promise.resolve(`loom://recording/r/${part.file}`),
    indexUrl: (part) => `loom://recording/r/${part.index}`,
    fetchImpl,
    decoderFactory,
  });
  return { source, reads };
}

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

/**
 * A decoder that answers each chunk with a frame carrying its timestamp.
 *
 * Needed for one thing {@link inertDecoder} structurally cannot see: what `release`
 * does to a *ring*. With nothing decoded, releasing the wrong part's reader frees
 * nothing and is indistinguishable from releasing the right one, so the ordering
 * defect below would pass under the decoder every other test here uses. A frame is
 * only ever `{ timestamp, close }` to `@loom/decode` — `frames.ts` declares exactly
 * that and says why — so this is the whole of what a `VideoFrame` has to be here.
 */
const echoDecoder: DecoderFactory<VideoFrame> = ((callbacks: {
  output: (frame: { timestamp: number; close: () => void }) => void;
}) => ({
  state: 'configured' as const,
  configure: () => undefined,
  decode: (chunk: { timestamp: number }) => {
    callbacks.output({ timestamp: chunk.timestamp, close: () => undefined });
  },
  reset: () => undefined,
  close: () => undefined,
})) as unknown as DecoderFactory<VideoFrame>;

describe('the screen source bridges recording-clock time to part-relative time', () => {
  it('reads each part’s avcC out of its own initialisation segment', async () => {
    // The gap `source-reader.ts` names: `recording.json` does not carry the codec
    // description and `MetaMsg` is long gone. Opening at all proves it was found —
    // `parseInitSegment` throws otherwise, and the source reports the file.
    const { reads } = await open();
    expect(reads.filter((read) => read.start === 0)).toHaveLength(2);
  });

  it('asks the part that covers the instant, in that part’s own time', async () => {
    const { source } = await open();
    // Part 0 covers 0–2 s and its sidecar has frames at 0…1.9 s of its own time.
    expect(source.hasSourceFrameAt(0)).toBe(true);
    expect(source.hasSourceFrameAt(1.9)).toBe(true);
    // Part 1 covers 5–7 s. Its sidecar is identical, so a source time of 5.0 s is
    // its frame 0 — which is the whole conversion, and the number that is wrong by
    // five seconds if the part offset is dropped.
    expect(source.hasSourceFrameAt(5)).toBe(true);
    expect(source.hasSourceFrameAt(6.9)).toBe(true);
  });

  it('has no frame in the hole between two parts, and says so rather than inventing one', async () => {
    const { source } = await open();
    // Selecting the *next* part gives a negative part-relative time, which the
    // index has no frame at. `frameAt` is then null and the compositor holds
    // (§4.3); the watchdog stays quiet, because time in which nothing was captured
    // is not a stall.
    for (const t of [2.5, 3.5, 4.9]) {
      expect(source.hasSourceFrameAt(t), `t=${String(t)}`).toBe(false);
    }
  });

  it('primes the part playback is about to reach, not the one it just left', async () => {
    const { source, reads } = await open();
    reads.length = 0;
    await source.prime(4.9, 0.5);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map((read) => read.part))).toEqual(new Set([1]));
  });

  it('clamps past the end onto the last part rather than answering nothing', async () => {
    const { source } = await open();
    // Same reason `clipIndexAt` clamps: a playhead parked on the final frame still
    // has to have a frame under it.
    expect(source.hasSourceFrameAt(6.99)).toBe(true);
    expect(source.hasSourceFrameAt(1e6)).toBe(true);
  });

  it('is the identity on the single-part recordings this app makes today', async () => {
    // The control for the whole file: with one part starting at zero, part time and
    // source time are the same number — which is why the seam was invisible.
    const { source } = await open([0]);
    expect(source.hasSourceFrameAt(0)).toBe(true);
    expect(source.hasSourceFrameAt(1.9)).toBe(true);
    expect(source.hasSourceFrameAt(2.5)).toBe(true);
  });

  it('reports parts on the recording clock, for a caller drawing a lane', async () => {
    const { source } = await open();
    expect(source.parts).toEqual([
      { startTimeSec: 0, durationSec: 2 },
      { startTimeSec: 5, durationSec: 2 },
    ]);
  });

  it('does not let a release behind the playhead discard the ring ahead of it', async () => {
    // `PreviewLoop.#frame` makes three calls in this order, on one frame:
    // `frameAt(sourceTime)`, `prime(sourceTime, 0.5)`, then
    // `release(sourceTime - retainBehindSec)`. Just past a part boundary the first
    // two are about the new part while the third names an instant inside the old
    // one — so a `release` that also decided what is being read would hand the ring
    // `prime` had just filled a `release(+Infinity)`, sixty times a second for the
    // whole of `retainBehindSec`, holding a stale picture and re-seeking a GOP per
    // frame. Two adjoining parts, because that is the shape that puts the two
    // instants either side of a boundary.
    const { source, reads } = await open([0, 2], echoDecoder);
    const sourceTime = 2.05;
    const retainBehindSec = 0.1;

    source.frameAt(sourceTime);
    await source.prime(sourceTime, 0.5);
    const primed = source.liveFrames;
    // The control for the assertion below: with nothing decoded it would hold however
    // the release behaved, which is why this test does not use `inertDecoder`.
    expect(primed).toBeGreaterThan(1);

    reads.length = 0;
    source.release(sourceTime - retainBehindSec);
    expect(source.liveFrames).toBe(primed);

    // And the churn itself: the next frame's prime rides along with what is already
    // decoded rather than seeking and re-reading it.
    await source.prime(sourceTime, 0.5);
    expect(reads).toEqual([]);
    source.close();
  });

  it('releases against the part the instant belongs to, not the one being read', async () => {
    // The other half: a release must still reach a reader. Inside a part, the frames
    // behind the playhead are exactly what `retainBehindSec` is there to free.
    const { source } = await open([0, 2], echoDecoder);
    await source.prime(1.0, 0.5);
    const primed = source.liveFrames;
    expect(primed).toBeGreaterThan(1);
    source.release(1.5);
    expect(source.liveFrames).toBeLessThan(primed);
    source.close();
  });

  it('refuses a track with no frames rather than opening an empty source', async () => {
    await expect(
      ScreenSource.open({
        parts: [{ ...videoPart(0, 0), frameCount: 0 }],
        mediaUrl: () => Promise.resolve('loom://recording/r/x'),
        indexUrl: () => 'loom://recording/r/x.json',
        fetchImpl: () => Promise.reject(new Error('should not be read')),
      }),
    ).rejects.toThrow(/no screen part with any frames/);
  });
});
