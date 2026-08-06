/**
 * §7.5's verification, branch by branch.
 *
 * Phase 9's gate is *"Fail the export at each of the five verification points;
 * sources survive every time"*. That gate is phase 9's to write, and it will be
 * written against this code — so what phase 8 owes it is a verifier where **each of
 * the five points can actually fail on its own**, with a named reason, rather than
 * one that reports a single opaque "not verified".
 *
 * Every case below is a real file or a real header: the movie is built by the
 * shipping `FastStartWriter` and then damaged, so the parser under test is reading
 * bytes it might really be handed rather than a hand-written stub of them.
 */

import { describe, expect, it } from 'vitest';
import { FastStartWriter, type FastStartPlan } from '@loom/mux';
import {
  DURATION_TOLERANCE_SEC,
  avcCodecString,
  planVerification,
  verifyExport,
  VerificationError,
  type VerificationIo,
} from '../src/export/verify.ts';

/** A plausible `avcC`: High profile, level 4.0, one SPS and one PPS. */
const AVCC = new Uint8Array([
  1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, 0x01, 0x00, 0x04, 0x68, 0xee,
  0x3c, 0x80,
]);

const TIMESCALE = 30_000;

/** A finished movie's header plus its `mdat`, as bytes. */
function buildMovie(options: { frames?: number; keyEvery?: number } = {}): {
  bytes: Uint8Array;
  plan: FastStartPlan;
  durationSec: number;
} {
  const frames = options.frames ?? 90;
  const keyEvery = options.keyEvery ?? 30;
  const writer = new FastStartWriter({
    video: { width: 640, height: 360, timescale: TIMESCALE, avcC: AVCC },
  });
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    const byteLength = 64 + (i % 7);
    payloads.push(new Uint8Array(byteLength).fill(i & 0xff));
    writer.addVideoSample({
      byteLength,
      durationUnits: 1000,
      isKey: i % keyEvery === 0,
      timestampUs: Math.round((i * 1e6) / 30),
    });
  }
  const plan = writer.plan();
  const bytes = new Uint8Array(plan.totalBytes);
  bytes.set(plan.header, 0);
  let at = plan.header.byteLength;
  // One chunk per second of media, video only — so the copy is the payloads in order.
  const flat = payloads.flatMap((p) => [...p]);
  bytes.set(Uint8Array.from(flat), at);
  at += flat.length;
  expect(at).toBe(plan.totalBytes);
  return { bytes, plan, durationSec: plan.durationSec };
}

/** An in-memory `VerificationIo` over one file. */
function ioOver(
  bytes: Uint8Array,
  decode: VerificationIo['decode'] = () => Promise.resolve({ ok: true }),
): VerificationIo {
  return {
    size: () => Promise.resolve(bytes.byteLength),
    readHead: (_path, byteLength) => Promise.resolve(bytes.subarray(0, byteLength)),
    readRanges: (_path, ranges) =>
      Promise.resolve(ranges.map((r) => bytes.subarray(r.offset, r.offset + r.byteLength))),
    hash: () => Promise.resolve('a'.repeat(64)),
    decode,
  };
}

describe('planVerification', () => {
  it('reads a finished movie and plans the last GOP', () => {
    const { bytes, durationSec } = buildMovie();
    const plan = planVerification(bytes, durationSec);
    expect(plan.movie.fastStart).toBe(true);
    expect(plan.codedWidth).toBe(640);
    expect(plan.codedHeight).toBe(360);
    expect(Array.from(plan.description)).toEqual(Array.from(AVCC));
    expect(plan.codec).toBe('avc1.640028');
    // Keyframes every 30 of 90 frames: the last GOP is samples 60..89.
    expect(plan.ranges).toHaveLength(30);
    expect(plan.samples[0]?.isKey).toBe(true);
    expect(plan.samples.slice(1).every((s) => !s.isKey)).toBe(true);
    // And the plan's byte ranges land on the samples the file really holds.
    const last = plan.ranges[plan.ranges.length - 1];
    expect((last?.offset ?? 0) + (last?.byteLength ?? 0)).toBe(bytes.byteLength);
  });

  it('refuses a file whose moov does not come first', () => {
    const { bytes, durationSec } = buildMovie();
    // A real non-faststart layout — `ftyp | mdat | moov` — rather than a corrupted
    // box. That is the file a writer that streamed straight into the output would
    // produce, and it is legal, playable and exactly what §1.3 says export must not
    // write: a player has to seek to the end before it can show a frame.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ftypSize = view.getUint32(0, false);
    const moovSize = view.getUint32(ftypSize, false);
    const reordered = new Uint8Array(bytes.byteLength);
    reordered.set(bytes.subarray(0, ftypSize), 0);
    reordered.set(bytes.subarray(ftypSize + moovSize), ftypSize);
    reordered.set(bytes.subarray(ftypSize, ftypSize + moovSize), bytes.byteLength - moovSize);

    expect(() => planVerification(reordered, durationSec)).toThrow(VerificationError);
    try {
      planVerification(reordered, durationSec);
      expect.unreachable('a moov after the mdat must fail');
    } catch (error) {
      expect((error as VerificationError).failure).toBe('not-faststart');
    }
  });

  it('refuses a header that was read short', () => {
    const { bytes, durationSec } = buildMovie();
    expect(() => planVerification(bytes.subarray(0, 200), durationSec)).toThrow(/only 200/);
  });

  it('refuses a duration outside §7.5’s 100 ms', () => {
    const { bytes, durationSec } = buildMovie();
    // Just inside is fine; just outside is not. The boundary is the assertion.
    expect(() => planVerification(bytes, durationSec + DURATION_TOLERANCE_SEC * 0.9)).not.toThrow();
    try {
      planVerification(bytes, durationSec + DURATION_TOLERANCE_SEC * 2);
      expect.unreachable('a two-tolerance drift must fail');
    } catch (error) {
      expect((error as VerificationError).failure).toBe('duration');
    }
  });

  it('refuses a video track with no sync sample before its last frame', () => {
    // A file whose only keyframe is the first sample, and a GOP longer than the cap.
    const { bytes, durationSec } = buildMovie({ frames: 700, keyEvery: 10_000 });
    try {
      planVerification(bytes, durationSec);
      expect.unreachable('a 700-frame GOP must fail');
    } catch (error) {
      expect((error as VerificationError).failure).toBe('gop-too-long');
    }
  });

  it('derives the codec string from the avcC rather than assuming one', () => {
    expect(avcCodecString(new Uint8Array([1, 0x42, 0xe0, 0x1f]))).toBe('avc1.42e01f');
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x34]))).toBe('avc1.640034');
  });
});

describe('verifyExport', () => {
  it('records all five checks when they pass', async () => {
    const { bytes, durationSec } = buildMovie();
    const outcome = await verifyExport('/tmp/Export.mp4', durationSec, ioOver(bytes));
    expect(outcome.failure).toBeNull();
    expect(outcome.error).toBeNull();
    expect(outcome.verified).toEqual({
      exists: true,
      bytes: bytes.byteLength,
      durationSec,
      lastFrameDecodable: true,
      sha256: 'a'.repeat(64),
    });
  });

  it('reports a missing file without touching anything else', async () => {
    const io = ioOver(new Uint8Array(0));
    const outcome = await verifyExport('/tmp/gone.mp4', 1, {
      ...io,
      size: () => Promise.resolve(null),
    });
    expect(outcome.failure).toBe('missing');
    expect(outcome.verified.exists).toBe(false);
    expect(outcome.verified.sha256).toBe('');
  });

  it('reports an empty file', async () => {
    const io = ioOver(new Uint8Array(0));
    const outcome = await verifyExport('/tmp/empty.mp4', 1, {
      ...io,
      size: () => Promise.resolve(0),
    });
    expect(outcome.failure).toBe('empty');
    expect(outcome.verified.exists).toBe(true);
    expect(outcome.verified.bytes).toBe(0);
  });

  it('reports a last frame that will not decode, and keeps the checks that passed', async () => {
    const { bytes, durationSec } = buildMovie();
    const outcome = await verifyExport(
      '/tmp/Export.mp4',
      durationSec,
      ioOver(bytes, () => Promise.resolve({ ok: false, error: 'the decoder produced no frames' })),
    );
    expect(outcome.failure).toBe('last-frame');
    // §7.5 requires the partial record: which checks *did* pass has to survive into
    // `project.json`, or a failed export is indistinguishable from a missing one.
    expect(outcome.verified.exists).toBe(true);
    expect(outcome.verified.bytes).toBe(bytes.byteLength);
    expect(outcome.verified.durationSec).toBeCloseTo(durationSec, 6);
    expect(outcome.verified.lastFrameDecodable).toBe(false);
    // And no hash: hashing a file that failed would record a checksum of something
    // phase 9 must not act on.
    expect(outcome.verified.sha256).toBe('');
  });

  it('hands the decoder the last GOP, starting at a sync sample', async () => {
    const { bytes, durationSec } = buildMovie();
    let seen: { isKey: boolean }[] = [];
    let expectLast = -1;
    await verifyExport(
      '/tmp/Export.mp4',
      durationSec,
      ioOver(bytes, (request) => {
        seen = request.chunks;
        expectLast = request.expectLastTimestampUs;
        return Promise.resolve({ ok: true });
      }),
    );
    expect(seen[0]?.isKey).toBe(true);
    expect(seen).toHaveLength(30);
    // 89 frames of 1000 units at a 30000 timescale.
    expect(expectLast).toBe(Math.round((89 * 1000 * 1e6) / TIMESCALE));
  });
});
