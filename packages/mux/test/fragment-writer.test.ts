/**
 * The fragmented-MP4 writer and its reader, tested against each other and against
 * the byte layout the ISO base media file format specifies.
 *
 * These are the properties phase 6 will compile against and phase 1's crash gate
 * rests on, so they are asserted at the byte level rather than by round-tripping
 * through the writer's own assumptions where a round trip would prove only
 * self-consistency.
 */

import { describe, expect, it } from 'vitest';
import {
  FragmentWriter,
  Mp4ParseError,
  codecStringFromAvcC,
  frameIndexDoc,
  parseInitSegment,
  parseMoof,
  partDurationSec,
  readBoxHeader,
  type EmittedFragment,
  type EncodedSample,
} from '../src/index.ts';
import { validateFrameIndexDoc } from '@loom/format';
import { loadEncodedFixture } from './helpers/fixture.ts';

const AVCC = Uint8Array.from([
  1, 0x64, 0x00, 0x0d, 0xff, 0xe1, 0, 2, 0x67, 0x64, 1, 0, 2, 0x68, 0xee,
]);

function sample(timestampUs: number, isKey = false, bytes = 32): EncodedSample {
  return { data: new Uint8Array(bytes).fill(7), isKey, timestampUs, durationUs: null };
}

function writeAll(samples: readonly EncodedSample[]): {
  init: Uint8Array;
  fragments: EmittedFragment[];
  writer: FragmentWriter;
} {
  const writer = new FragmentWriter({ nominalFps: 30 });
  const init = writer.begin({ width: 320, height: 180, timescale: 1_000_000, avcC: AVCC });
  const fragments: EmittedFragment[] = [];
  for (const s of samples) {
    const emitted = writer.push(s);
    if (emitted !== null) fragments.push(emitted);
  }
  const last = writer.flush();
  if (last !== null) fragments.push(last);
  return { init, fragments, writer };
}

/** Every top-level box, in order, from a concatenated file. */
function topLevelTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let at = 0;
  for (;;) {
    const header = readBoxHeader(bytes, at);
    if (header === null || at + header.size > bytes.byteLength) break;
    types.push(header.type);
    at += header.size;
  }
  return types;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

describe('the initialisation segment', () => {
  it('is ftyp + an empty moov, so the file is readable before the first frame', () => {
    const writer = new FragmentWriter();
    const init = writer.begin({ width: 640, height: 360, timescale: 1_000_000, avcC: AVCC });
    expect(topLevelTypes(init)).toEqual(['ftyp', 'moov']);
    // A `mvex` is what says "samples arrive in fragments"; without it a reader is
    // entitled to believe the empty sample tables.
    expect(Buffer.from(init).includes(Buffer.from('mvex'))).toBe(true);
    expect(Buffer.from(init).includes(Buffer.from('trex'))).toBe(true);
  });

  it('round-trips the facts recovery needs', () => {
    const writer = new FragmentWriter();
    const init = writer.begin({ width: 1728, height: 1117, timescale: 1_000_000, avcC: AVCC });
    const facts = parseInitSegment(init);
    expect(facts).toMatchObject({ width: 1728, height: 1117, timescale: 1_000_000 });
    expect([...facts.avcC]).toEqual([...AVCC]);
  });

  it('names the codec from the avcC profile, compatibility and level bytes', () => {
    expect(codecStringFromAvcC(AVCC)).toBe('avc1.64000d');
  });

  it('refuses to begin twice', () => {
    const writer = new FragmentWriter();
    writer.begin({ width: 2, height: 2, timescale: 1_000_000, avcC: AVCC });
    expect(() => writer.begin({ width: 2, height: 2, timescale: 1_000_000, avcC: AVCC })).toThrow();
  });
});

describe('fragments', () => {
  it('emits one moof + mdat pair per frame', () => {
    const { fragments } = writeAll([sample(0, true), sample(33_333), sample(66_666)]);
    expect(fragments).toHaveLength(3);
    for (const fragment of fragments) {
      expect(topLevelTypes(fragment.bytes)).toEqual(['moof', 'mdat']);
    }
  });

  it('holds one sample back so every duration is measured, not guessed', () => {
    const writer = new FragmentWriter({ nominalFps: 30 });
    writer.begin({ width: 320, height: 180, timescale: 1_000_000, avcC: AVCC });
    // The first push produces nothing: frame 0's duration is not knowable yet.
    expect(writer.push(sample(0, true))).toBeNull();
    expect(writer.pending).toBe(1);
    const first = writer.push(sample(40_000));
    expect(first?.frame.durationUnits).toBe(40_000);
  });

  it('measures variable-rate durations exactly', () => {
    // A screen track's real shape: long idle gaps, then a burst (research §5.1).
    const stamps = [0, 700_000, 733_333, 766_666, 3_000_000];
    const { fragments } = writeAll(stamps.map((t, i) => sample(t, i === 0)));
    expect(fragments.map((f) => f.frame.durationUnits)).toEqual([
      700_000, 33_333, 33_333, 2_233_334,
      // the last frame has no successor, so it takes the nominal 1/30 s
      33_333,
    ]);
  });

  it('stretches the last frame to the moment capture stopped', () => {
    // The case this exists for: a screen that stops changing four seconds before
    // the user stops recording. Without an end time the recording claims to be
    // 0.7 s long, because the last frame would take a nominal 1/30 s and the still
    // screen after it would simply not be in the file.
    const writer = new FragmentWriter({ nominalFps: 30 });
    writer.begin({ width: 320, height: 180, timescale: 1_000_000, avcC: AVCC });
    writer.push(sample(0, true));
    const first = writer.push(sample(666_000));
    const last = writer.flush(4_000_000);

    expect(first?.frame.durationUnits).toBe(666_000);
    expect(last?.frame.durationUnits).toBe(3_334_000);
    expect(
      partDurationSec(
        [first, last].filter((f) => f !== null).map((f) => f.frame),
        1_000_000,
      ),
    ).toBeCloseTo(4, 6);
  });

  it('falls back to the nominal rate when nobody knows when capture stopped', () => {
    // Which is the crash case: nothing was there to tell us.
    const { fragments } = writeAll([sample(0, true), sample(33_333)]);
    expect(fragments.at(-1)?.frame.durationUnits).toBe(33_333);
  });

  it('ignores an end time that precedes the last frame', () => {
    const writer = new FragmentWriter({ nominalFps: 30 });
    writer.begin({ width: 320, height: 180, timescale: 1_000_000, avcC: AVCC });
    writer.push(sample(1_000_000, true));
    expect(writer.flush(500_000)?.frame.durationUnits).toBe(33_333);
  });

  it('normalizes to a zero-based timeline whatever the encoder clock started at', () => {
    const { fragments } = writeAll([sample(9_000_000, true), sample(9_033_333)]);
    expect(fragments.map((f) => f.frame.ptsUnits)).toEqual([0, 33_333]);
    expect(parseMoof(topBox(fragments[0]!.bytes, 'moof')).baseMediaDecodeTime).toBe(0);
  });

  it('never emits a zero or negative duration, even from a non-monotonic encoder', () => {
    const { fragments } = writeAll([sample(1000, true), sample(1000), sample(900), sample(2000)]);
    for (const fragment of fragments) {
      expect(fragment.frame.durationUnits).toBeGreaterThan(0);
    }
  });

  it('marks sync samples so a reader can find keyframes without decoding', () => {
    const { fragments } = writeAll([sample(0, true), sample(33_333), sample(66_666, true)]);
    const parsed = fragments.map((f) => parseMoof(topBox(f.bytes, 'moof')));
    expect(parsed.map((p) => p.samples[0]?.isKey)).toEqual([true, false, true]);
    expect(parsed.map((p) => p.sequenceNumber)).toEqual([1, 2, 3]);
  });

  it('records byte offsets that point at the sample data itself', () => {
    const { init, fragments } = writeAll([sample(0, true, 11), sample(33_333, false, 23)]);
    const file = concat([init, ...fragments.map((f) => f.bytes)]);
    for (const fragment of fragments) {
      const { offsetBytes, sizeBytes } = fragment.frame;
      expect(file.subarray(offsetBytes, offsetBytes + sizeBytes)).toEqual(
        new Uint8Array(sizeBytes).fill(7),
      );
    }
  });

  it('costs about a hundred bytes a frame, which is the price of the crash gate', () => {
    const { fragments } = writeAll([sample(0, true, 50_000), sample(33_333, false, 50_000)]);
    for (const fragment of fragments) {
      const overhead = fragment.bytes.byteLength - fragment.frame.sizeBytes;
      expect(overhead).toBeGreaterThan(80);
      expect(overhead).toBeLessThan(140);
    }
  });
});

describe('the frame index sidecar', () => {
  it('is a valid loom.index document with parallel arrays', () => {
    const { fragments, writer } = writeAll([
      sample(0, true),
      sample(33_333),
      sample(66_666, true),
      sample(100_000),
    ]);
    const doc = frameIndexDoc(
      fragments.map((f) => f.frame),
      writer.timescaleUnits,
    );
    const result = validateFrameIndexDoc(doc);
    expect(result.ok ? null : result.issues).toBeNull();
    expect(doc.keyframes).toEqual([0, 2]);
    expect(doc.pts).toEqual([0, 33_333, 66_666, 100_000]);
    expect(doc.sizes).toHaveLength(4);
    expect(doc.offsets).toHaveLength(4);
  });

  it('reports a duration that reaches the end of the last frame, not its start', () => {
    const { fragments, writer } = writeAll([sample(0, true), sample(500_000)]);
    expect(
      partDurationSec(
        fragments.map((f) => f.frame),
        writer.timescaleUnits,
      ),
    ).toBeCloseTo(0.533_333, 5);
  });
});

describe('the scanner refuses what it cannot account for', () => {
  it('rejects a moof that is not wholly present', () => {
    const { fragments } = writeAll([sample(0, true), sample(33_333)]);
    const moof = topBox(fragments[0]!.bytes, 'moof');
    expect(() => parseMoof(moof.subarray(0, moof.byteLength - 4))).toThrow(Mp4ParseError);
  });

  it('reads no header from fewer bytes than a header', () => {
    expect(readBoxHeader(new Uint8Array(4))).toBeNull();
    // A declared size smaller than the header itself is a torn tail, not a box.
    expect(readBoxHeader(Uint8Array.from([0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x66]))).toBeNull();
  });

  it('parses real encoder output, not just its own', () => {
    // The fixture came from libx264 through ffmpeg, so the sample bytes in these
    // fragments are somebody else's H.264, framed the way WebCodecs frames it.
    const fixture = loadEncodedFixture();
    const { fragments } = writeAll(
      fixture.frames.slice(0, 40).map((f) => ({
        data: f.data,
        isKey: f.isKey,
        timestampUs: f.timestampUs,
        durationUs: null,
      })),
    );
    expect(fragments).toHaveLength(40);
    const parsed = parseMoof(topBox(fragments[0]!.bytes, 'moof'));
    expect(parsed.samples[0]?.sizeBytes).toBe(fixture.frames[0]?.data.byteLength);
    expect(parsed.samples[0]?.isKey).toBe(true);
  });
});

/** The first box of `type` in `bytes`, as its own view. */
function topBox(bytes: Uint8Array, type: string): Uint8Array {
  let at = 0;
  for (;;) {
    const header = readBoxHeader(bytes, at);
    if (header === null) throw new Error(`no ${type} box`);
    if (header.type === type) return bytes.subarray(at, at + header.size);
    at += header.size;
  }
}
