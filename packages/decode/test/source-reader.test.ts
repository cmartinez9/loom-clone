/**
 * `SourceReader` — the seek rule, the discard rule, cancellation, and lifetimes.
 *
 * Every test in this file ends by asserting the frame census is balanced, because
 * §10.2's failure mode is not a crash: *"it does not throw, it just stops producing
 * frames. Preview freezes or an export hangs at 40%, with no error anywhere."* A
 * leak that only shows up on the fourth error path is a leak that ships.
 *
 * The 4K gate against a real `VideoDecoder` lives in `test/gate/`. This file is
 * where the paths a real decoder will not reproduce on demand get exercised.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesReader, type ByteRangeReader } from '../src/byte-source.ts';
import { SourceReader } from '../src/source-reader.ts';
import type { DemuxIndex } from '../src/frame-index.ts';
import { fakeDecoderFactory, FrameCensus, type FakeFrame } from './helpers/fake-decoder.ts';
import { frameNumberOf, syntheticPart, type SyntheticPart } from './helpers/synthetic.ts';

const CONFIG: VideoDecoderConfig = { codec: 'avc1.640034', codedWidth: 3456, codedHeight: 2234 };

interface Harness {
  part: SyntheticPart;
  index: DemuxIndex;
  census: FrameCensus;
  reader: SourceReader<FakeFrame>;
  readCount: () => number;
}

function harness(
  options: {
    part?: SyntheticPart;
    ringCapacity?: number;
    failOn?: (chunk: { timestamp: number }, ordinal: number) => Error | null;
    bytes?: ByteRangeReader;
    onRead?: (start: number, end: number) => void;
  } = {},
): Harness {
  const part = options.part ?? syntheticPart({ frameCount: 120, gopSize: 30 });
  const census = new FrameCensus();
  let reads = 0;
  const inner = options.bytes ?? bytesReader(part.bytes);
  const counted: ByteRangeReader = {
    byteLength: inner.byteLength,
    read(start, end, signal) {
      reads += 1;
      options.onRead?.(start, end);
      return inner.read(start, end, signal);
    },
  };

  const reader = new SourceReader<FakeFrame>({
    bytes: counted,
    index: part.index,
    config: CONFIG,
    ...(options.ringCapacity === undefined ? {} : { ringCapacity: options.ringCapacity }),
    decoderFactory: fakeDecoderFactory({
      census,
      payloadOf: (chunk) => frameNumberOf(chunk.data),
      ...(options.failOn === undefined ? {} : { failOn: options.failOn }),
    }),
  });

  return { part, index: part.index, census, reader, readCount: () => reads };
}

const openReaders: SourceReader<FakeFrame>[] = [];
function track(h: Harness): Harness {
  openReaders.push(h.reader);
  return h;
}

afterEach(() => {
  for (const reader of openReaders.splice(0)) reader.close();
});

describe('SourceReader.prime', () => {
  it('decodes from the keyframe and lands the frame covering t', async () => {
    const h = track(harness());
    const t = h.index.ptsSec(47);
    await h.reader.prime(t, 0.2);

    const frame = h.reader.frameAt(t);
    expect(frame?.payload).toBe(47);
    expect(h.reader.stats.seeks).toBe(1);
    // Started at the keyframe before 47, which is 30.
    expect(h.reader.stats.discarded).toBeGreaterThanOrEqual(17);
    expect(h.census.doubleClosed).toEqual([]);
  });

  it('closes the frames it decoded on the way to the seek target — §4.2', async () => {
    const h = track(harness());
    await h.reader.prime(h.index.ptsSec(59), 0);
    // Frames 30..58 were decoded to reach 59 and must not still be alive.
    const alive = h.census.open.map((f) => f.payload).sort((a, b) => a - b);
    expect(alive).toEqual([59]);
    expect(h.reader.liveFrames).toBe(1);
  });

  it('reads a keyframe run as one range request — §2.4', async () => {
    const h = track(harness({ ringCapacity: 20 }));
    await h.reader.prime(h.index.ptsSec(30), 0.5);
    // One request covering the whole run, not one per frame.
    expect(h.readCount()).toBe(1);
    expect(h.reader.stats.bytesRead).toBeGreaterThan(0);
  });

  it('does not seek again when playback walks forward', async () => {
    const h = track(harness({ ringCapacity: 20 }));
    await h.reader.prime(h.index.ptsSec(30), 0.2);
    const seeks = h.reader.stats.seeks;
    for (let i = 31; i < 45; i++) {
      h.reader.release(h.index.ptsSec(i) - 0.05);
      await h.reader.prime(h.index.ptsSec(i), 0.2);
      expect(h.reader.frameAt(h.index.ptsSec(i))?.payload).toBe(i);
    }
    expect(h.reader.stats.seeks).toBe(seeks);
  });

  it('seeks backwards when the playhead moves behind what it decoded', async () => {
    const h = track(harness());
    await h.reader.prime(h.index.ptsSec(90), 0.1);
    expect(h.reader.stats.seeks).toBe(1);
    await h.reader.prime(h.index.ptsSec(5), 0.1);
    expect(h.reader.stats.seeks).toBe(2);
    expect(h.reader.frameAt(h.index.ptsSec(5))?.payload).toBe(5);
  });

  it('seeks rather than decoding through a long forward jump', async () => {
    const h = track(harness());
    await h.reader.prime(h.index.ptsSec(2), 0);
    const submittedBefore = h.reader.stats.submitted;
    await h.reader.prime(h.index.ptsSec(95), 0);
    // A jump past several GOPs starts at frame 90's keyframe, so it submits far
    // fewer chunks than the 93 it would take to decode through.
    expect(h.reader.stats.submitted - submittedBefore).toBeLessThan(20);
    expect(h.reader.stats.seeks).toBe(2);
    expect(h.reader.frameAt(h.index.ptsSec(95))?.payload).toBe(95);
  });

  it('re-seeks when the ring no longer holds t even though decode passed it', async () => {
    const h = track(harness({ ringCapacity: 4 }));
    await h.reader.prime(h.index.ptsSec(35), 0);
    // Play forward, releasing behind the playhead as the loop does. Frame 35 is
    // closed on the way and cannot be recovered by decoding forward.
    for (let i = 36; i <= 60; i++) {
      h.reader.release(h.index.ptsSec(i) - 0.001);
      await h.reader.prime(h.index.ptsSec(i), 0.02);
    }
    const seeks = h.reader.stats.seeks;
    expect(seeks).toBe(1);
    expect(h.reader.frameAt(h.index.ptsSec(35))).toBeNull();

    await h.reader.prime(h.index.ptsSec(35), 0);
    expect(h.reader.stats.seeks).toBe(seeks + 1);
    expect(h.reader.frameAt(h.index.ptsSec(35))?.payload).toBe(35);
  });

  it('never exceeds the ring cap however much lookahead it is asked for', async () => {
    const h = track(harness({ ringCapacity: 6 }));
    await h.reader.prime(h.index.ptsSec(0), 60);
    expect(h.reader.liveFrames).toBeLessThanOrEqual(6);
    expect(h.reader.stats.peakLive).toBeLessThanOrEqual(6);
    // And it still holds the frame it was asked for.
    expect(h.reader.frameAt(h.index.ptsSec(0))?.payload).toBe(0);
  });

  it('refuses an index with no keyframe to start from, instead of feeding garbage', async () => {
    const part = syntheticPart({ frameCount: 10, gopSize: 30 });
    const doc = { ...part.doc, keyframes: [5] };
    const h = track(
      harness({
        part: { ...part, index: (await import('../src/frame-index.ts')).DemuxIndex.fromDoc(doc) },
      }),
    );
    await expect(h.reader.prime(h.index.ptsSec(2), 0)).rejects.toThrow(/no keyframe/);
  });

  it('is a no-op on an empty index', async () => {
    const h = track(harness({ part: syntheticPart({ frameCount: 0 }) }));
    await expect(h.reader.prime(0, 1)).resolves.toBeUndefined();
    expect(h.reader.frameAt(0)).toBeNull();
  });
});

describe('SourceReader cancellation — §4.3, "prime() is cancelable"', () => {
  it('abandons the old seek, aborts its read, and closes nothing twice', async () => {
    let released: (() => void) | null = null;
    const part = syntheticPart({ frameCount: 120, gopSize: 30 });
    const inner = bytesReader(part.bytes);
    const gated: ByteRangeReader = {
      byteLength: inner.byteLength,
      read(start, end, signal) {
        return new Promise<Uint8Array>((resolve, reject) => {
          const finish = (): void => {
            inner.read(start, end, signal).then(resolve, reject);
          };
          if (released === null) {
            released = finish;
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          } else {
            finish();
          }
        });
      },
    };

    const h = track(harness({ bytes: gated }));
    const abandoned = h.reader.prime(h.index.ptsSec(95), 0.5);
    // Superseded before its byte read ever finishes.
    const kept = h.reader.prime(h.index.ptsSec(10), 0.2);

    await expect(abandoned).resolves.toBeUndefined();
    await kept;

    expect(h.reader.frameAt(h.index.ptsSec(10))?.payload).toBe(10);
    expect(h.reader.liveFrames).toBeLessThanOrEqual(h.reader.ringCapacity);
    expect(h.census.doubleClosed).toEqual([]);
    expect(h.census.open.length).toBe(h.reader.liveFrames);
  });

  it('survives a scrub storm without leaking or losing the last target', async () => {
    const h = track(harness({ ringCapacity: 8 }));
    const targets = [80, 3, 61, 17, 99, 42, 7, 110, 25];
    const pending = targets.map((frame) => h.reader.prime(h.index.ptsSec(frame), 0.2));
    await Promise.all(pending);

    const last = targets[targets.length - 1] ?? 0;
    expect(h.reader.frameAt(h.index.ptsSec(last))?.payload).toBe(last);
    expect(h.reader.liveFrames).toBeLessThanOrEqual(8);
    expect(h.census.open.length).toBe(h.reader.liveFrames);
    expect(h.census.doubleClosed).toEqual([]);
  });

  it('closes every frame on close(), including ones still arriving', async () => {
    const h = track(harness());
    const inflight = h.reader.prime(h.index.ptsSec(60), 0.5);
    h.reader.close();
    await expect(inflight).resolves.toBeUndefined();
    // Let any straggling output callback run.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.census.open).toEqual([]);
    expect(h.reader.liveFrames).toBe(0);
    expect(h.census.doubleClosed).toEqual([]);
  });

  it('close() is idempotent and prime() after it does nothing', async () => {
    const h = track(harness());
    await h.reader.prime(h.index.ptsSec(5), 0.1);
    h.reader.close();
    h.reader.close();
    await expect(h.reader.prime(h.index.ptsSec(5), 0.1)).resolves.toBeUndefined();
    expect(h.census.open).toEqual([]);
  });
});

describe('SourceReader stale outputs — §10.2', () => {
  it('closes an output that outlived the reset which abandoned it', async () => {
    // A real `VideoDecoder.reset()` drops its pending outputs, and so does the fake,
    // which is exactly why this has to be provoked by hand: the frame is delivered
    // through the seam after the seek that abandoned it. Left unguarded it is worse
    // than a leak — the ring would take it as its newest frame and then reject every
    // correct, older frame decoded behind it, and the preview would hold the wrong
    // picture with nothing to say about it.
    const part = syntheticPart({ frameCount: 120, gopSize: 30 });
    const census = new FrameCensus();
    const seam: { output: ((frame: FakeFrame) => void) | null } = { output: null };
    const build = fakeDecoderFactory({ census, payloadOf: (chunk) => frameNumberOf(chunk.data) });

    const reader = new SourceReader<FakeFrame>({
      bytes: bytesReader(part.bytes),
      index: part.index,
      config: CONFIG,
      decoderFactory: (callbacks) => {
        seam.output = callbacks.output;
        return build(callbacks);
      },
    });
    openReaders.push(reader);

    await reader.prime(part.index.ptsSec(95), 0);
    await reader.prime(part.index.ptsSec(5), 0);
    if (seam.output === null) throw new Error('the seam never handed over its output callback');

    const stale = census.make(part.index.ptsMicros(95), 95);
    seam.output(stale);

    expect(stale.closed).toBe(true);
    expect(reader.ring.newestMicros).toBe(part.index.ptsMicros(5));
    expect(reader.frameAt(part.index.ptsSec(5))?.payload).toBe(5);
    expect(census.doubleClosed).toEqual([]);
  });
});

describe('SourceReader failure paths', () => {
  it('propagates a byte-read failure instead of hanging', async () => {
    const failing: ByteRangeReader = {
      byteLength: null,
      read: () => Promise.reject(new Error('loom://: HTTP 404')),
    };
    const h = track(harness({ bytes: failing }));
    await expect(h.reader.prime(h.index.ptsSec(5), 0.1)).rejects.toThrow(/404/);
    expect(h.census.open).toEqual([]);
  });

  it('recovers from a transient decoder error by rebuilding and seeking again', async () => {
    let failures = 0;
    const h = track(
      harness({
        failOn: (_chunk, ordinal) => {
          if (ordinal === 3 && failures === 0) {
            failures += 1;
            return new Error('transient decode failure');
          }
          return null;
        },
      }),
    );

    await h.reader.prime(h.index.ptsSec(10), 0.1).catch(() => undefined);
    expect(h.reader.stats.decoderErrors).toBe(1);

    await h.reader.prime(h.index.ptsSec(10), 0.1);
    expect(h.reader.frameAt(h.index.ptsSec(10))?.payload).toBe(10);
    expect(h.census.doubleClosed).toEqual([]);
    expect(h.census.open.length).toBe(h.reader.liveFrames);
  });

  it('gives up loudly rather than retrying a broken file forever — §10.2', async () => {
    const h = track(harness({ failOn: () => new Error('this file is not decodable') }));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await h.reader.prime(h.index.ptsSec(10), 0.1);
      } catch (error) {
        lastError = error;
        break;
      }
    }
    expect(lastError).toBeInstanceOf(Error);
    expect((lastError as Error).message).toMatch(/not decodable/);
    expect(h.census.open).toEqual([]);
  });
});

describe('SourceReader.frameAt', () => {
  it('counts a miss and returns null rather than blocking — §4.3', () => {
    const h = track(harness());
    expect(h.reader.frameAt(1.0)).toBeNull();
    expect(h.reader.stats.misses).toBe(1);
    expect(h.reader.stats.hits).toBe(0);
  });

  it('does not allocate a stats object per frame', () => {
    const h = track(harness());
    // `liveFrames` and `ringCapacity` are the loop's accessors; `stats` is not.
    const spy = vi.spyOn(h.reader, 'stats', 'get');
    h.reader.frameAt(0);
    expect(h.reader.liveFrames).toBe(0);
    expect(h.reader.ringCapacity).toBe(20);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('knows whether the source has a frame at all, for the stall watchdog', async () => {
    const h = track(harness());
    expect(h.reader.hasSourceFrameAt(h.index.ptsSec(50))).toBe(true);
    expect(h.reader.hasSourceFrameAt(-1)).toBe(false);
    await h.reader.prime(h.index.ptsSec(50), 0);
    expect(h.reader.frameAt(h.index.ptsSec(50))).not.toBeNull();
  });
});
