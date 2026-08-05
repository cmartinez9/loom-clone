/**
 * `FrameRing` and `FrameLedger` — the §10.2 half of phase 6's gate.
 *
 * The gate is *"the live `VideoFrame` count never exceeds the ring cap"*. That is
 * asserted for real against a 4K fixture and a real `VideoDecoder` in
 * `test/gate/`; these tests establish the property it rests on, one exit path at a
 * time, and — the part that matters — include a **control**: a consumer that
 * forgets a `close()` must make the ledger trip. Without that, "the assertion never
 * fired" and "the assertion cannot fire" look identical.
 */

import { describe, expect, it } from 'vitest';
import { FrameLeakError, FrameLedger } from '../src/frames.ts';
import { DEFAULT_RING_CAPACITY, FrameRing } from '../src/frame-ring.ts';
import { FrameCensus, type FakeFrame } from './helpers/fake-decoder.ts';

function ring(capacity = 4): { ring: FrameRing<FakeFrame>; census: FrameCensus } {
  return { ring: new FrameRing<FakeFrame>(capacity), census: new FrameCensus() };
}

describe('FrameRing capacity', () => {
  it('defaults to §4.2’s 20 frames per source', () => {
    expect(DEFAULT_RING_CAPACITY).toBe(20);
    expect(new FrameRing<FakeFrame>().capacity).toBe(20);
  });

  it('closes the oldest frame to make room, and never holds capacity + 1', () => {
    const { ring: r, census } = ring(4);
    for (let i = 0; i < 10; i++) {
      r.push(census.make(i * 1000, i));
      expect(r.ledger.live).toBeLessThanOrEqual(4);
    }
    expect(r.size).toBe(4);
    expect(r.ledger.peak).toBe(4);
    expect(r.stats.evicted).toBe(6);
    // The six evicted frames are closed, the four held are not.
    expect(census.closedCount).toBe(6);
    expect(census.open.map((f) => f.payload)).toEqual([6, 7, 8, 9]);
    expect(census.doubleClosed).toEqual([]);
  });

  it('closes a stale push rather than storing it out of order', () => {
    const { ring: r, census } = ring(4);
    r.push(census.make(1000, 0));
    r.push(census.make(2000, 1));
    const stale = census.make(1500, 99);
    expect(r.push(stale)).toBe(false);
    expect(stale.closed).toBe(true);
    expect(r.stats.rejected).toBe(1);
    expect(r.size).toBe(2);
    // Duplicate timestamps count as stale too: two frames on the same microsecond
    // would break the ascending order the search relies on.
    const duplicate = census.make(2000, 98);
    expect(r.push(duplicate)).toBe(false);
    expect(duplicate.closed).toBe(true);
  });

  it('closes a push into a closed ring', () => {
    const { ring: r, census } = ring(4);
    r.close();
    const late = census.make(1000, 0);
    expect(r.push(late)).toBe(false);
    expect(late.closed).toBe(true);
  });
});

describe('FrameRing.frameAtMicros', () => {
  it('is hold-last-frame, borrowed not owned', () => {
    const { ring: r, census } = ring(8);
    for (const [i, micros] of [0, 100_000, 133_000, 633_000].entries()) {
      r.push(census.make(micros, i));
    }
    expect(r.frameAtMicros(0)?.payload).toBe(0);
    expect(r.frameAtMicros(99_000)?.payload).toBe(0);
    expect(r.frameAtMicros(100_000)?.payload).toBe(1);
    expect(r.frameAtMicros(400_000)?.payload).toBe(2);
    expect(r.frameAtMicros(633_000)?.payload).toBe(3);
    expect(r.frameAtMicros(99_000_000)?.payload).toBe(3);
    // Borrowed: reading never closes.
    expect(census.closedCount).toBe(0);
  });

  it('returns null before the oldest frame it holds', () => {
    const { ring: r, census } = ring(4);
    r.push(census.make(5_000_000, 0));
    expect(r.frameAtMicros(4_999_000)).toBeNull();
    expect(r.frameAtMicros(5_000_000)).not.toBeNull();
  });

  it('is exact in microseconds, so it cannot disagree with the index that fed it', () => {
    // The index resolves `t` to a frame and hands the ring that frame's own
    // timestamp; anything looser here would be a second frame-selection rule,
    // agreeing with `DemuxIndex.frameAtTime` only at one timescale (§4.5).
    const { ring: r, census } = ring(4);
    r.push(census.make(1_000_000, 0));
    r.push(census.make(1_000_011, 1));
    expect(r.frameAtMicros(1_000_010)?.payload).toBe(0);
    expect(r.frameAtMicros(1_000_011)?.payload).toBe(1);
  });
});

describe('FrameRing.releaseBeforeMicros', () => {
  it('keeps the frame covering t and closes everything older', () => {
    const { ring: r, census } = ring(8);
    for (let i = 0; i < 6; i++) r.push(census.make(i * 100_000, i));

    expect(r.releaseBeforeMicros(200_000)).toBe(2);
    expect(r.size).toBe(4);
    // Frame 2 is the one on screen at 0.2 s and survives; 0 and 1 are gone.
    expect(r.frameAtMicros(200_000)?.payload).toBe(2);
    expect(census.open.map((f) => f.payload)).toEqual([2, 3, 4, 5]);
  });

  it('never empties the ring, so hold-last-frame survives a release past the end', () => {
    const { ring: r, census } = ring(8);
    for (let i = 0; i < 4; i++) r.push(census.make(i * 100_000, i));
    r.releaseBeforeMicros(1_000_000_000);
    expect(r.size).toBe(1);
    expect(r.frameAtMicros(1_000_000_000)?.payload).toBe(3);
  });
});

describe('FrameRing teardown', () => {
  it('close() closes every held frame exactly once and is idempotent', () => {
    const { ring: r, census } = ring(8);
    for (let i = 0; i < 5; i++) r.push(census.make(i * 1000, i));
    r.close();
    r.close();
    expect(census.open).toEqual([]);
    expect(census.doubleClosed).toEqual([]);
    expect(r.ledger.live).toBe(0);
    expect(r.ledger.acquired).toBe(r.ledger.released);
  });

  it('survives a frame whose close() throws', () => {
    const { ring: r, census } = ring(4);
    const hostile = census.make(1000, 0);
    hostile.close = () => {
      throw new Error('already closed by someone else');
    };
    r.push(hostile);
    r.push(census.make(2000, 1));
    expect(() => {
      r.close();
    }).not.toThrow();
    // The frame after the hostile one still got closed, and the ledger balanced.
    expect(r.ledger.live).toBe(0);
  });
});

describe('FrameLedger', () => {
  it('trips on the first leak, not the hundredth — §10.2', () => {
    const ledger = new FrameLedger(3);
    ledger.acquire();
    ledger.acquire();
    ledger.acquire();
    expect(() => {
      ledger.acquire();
    }).toThrow(FrameLeakError);
    expect(ledger.live).toBe(4);
  });

  it('CONTROL: a consumer that forgets a close makes the ring trip it', () => {
    // If this ever stops throwing, the assertion in the gate is decorative: a
    // leaked frame would sail past it and the preview would freeze in the field
    // with no error anywhere, which is exactly the §10.2 failure.
    const census = new FrameCensus();
    const r = new FrameRing<FakeFrame>(4);
    const leaky = (frame: FakeFrame): void => {
      // The bug: taking a frame out of the decoder callback and holding it
      // *outside* the ring, so the ring's eviction never sees it.
      r.ledger.acquire();
      void frame;
    };
    for (let i = 0; i < 4; i++) leaky(census.make(i * 1000, i));
    expect(() => {
      leaky(census.make(5000, 5));
    }).toThrow(FrameLeakError);
  });

  it('refuses a release it never acquired, so an unbalanced pair cannot hide', () => {
    const ledger = new FrameLedger(2);
    expect(() => {
      ledger.release();
    }).toThrow(/not balanced/);
  });

  it('refuses a ledger too small for its ring', () => {
    expect(() => new FrameRing<FakeFrame>(8, new FrameLedger(4))).toThrow(/would trip/);
  });
});
